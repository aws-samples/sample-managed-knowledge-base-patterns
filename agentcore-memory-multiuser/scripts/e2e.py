#!/usr/bin/env python3
"""Headless end-to-end test against the running backend, asserting the behavior described in README.md.

    python scripts/e2e.py [--base http://127.0.0.1:8765]

Scenario
  1. Document-level access control, enforced by the knowledge base from userContext.userId:
     the engineering on-call guide reaches Maya but not Sofia, the sales commission plan
     reaches Sofia but not Maya. An access token (no email claim) is rejected with 401, and
     a malformed token gets a generic 401 with a correlation ID and no validation detail.
  2. Maya (engineering) starts a conversation; trace shows SessionHistoryLoad with 0 items and
     the exchange is persisted (the conversation appears in /api/conversations, history has 2 turns).
  3. Maya continues the same conversation with a follow-up; SessionHistoryLoad restores >= 1 event;
     the request body carried only the new question.
  4. Maya opens a NEW conversation and asks an office-dependent question; the trace shows
     long-term memory being retrieved (SpeculativeRetrieval with BedrockAgentCoreMemory items,
     or a Retrieval event with BedrockAgentCoreMemory items) -- requires extraction to have run.
  5. Liam asks the same question in a new conversation; every memory lookup is in his own
     namespace (needs at least one long-term record for Liam) and his answer is not
     personalized to Frankfurt.
  6. Liam cannot read Maya's conversation: /api/conversations/<maya-session> as Liam is empty.
     An over-long sessionId is rejected with 422.

Prints PASS/FAIL per check and exits non-zero on any failure.
"""

import argparse
import json
import pathlib
import re
import sys
import time

import httpx

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from identity import sign_in  # noqa: E402

CFG = json.loads((ROOT / "config.json").read_text())
COG = CFG["cognito"]
RESULTS = []
# "you", "you're", "your", "you've" ... followed by "frankfurt" in the same clause.
PERSONAL_FRANKFURT = re.compile(r"\byou(?:['\u2019]re|['\u2019]ve|r| are| have)?\b[^.\n|]{0,80}\bfrankfurt", re.IGNORECASE)


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))


def tokens_for(user: str) -> dict:
    return sign_in(CFG["region"], COG["clientId"], user, COG["testPassword"])


def token_for(user: str) -> str:
    return tokens_for(user)["IdToken"]


def chat(client: httpx.Client, token: str, question: str, session_id=None, probe=False) -> dict:
    """Consume the SSE stream; return session id, answer, sources, and the trace rows.

    probe=True sends persist=false and useLongTermMemory=false so access-control probes
    leave no trace in the users' memory."""
    body = {"question": question}
    if session_id:
        body["sessionId"] = session_id
    if probe:
        body.update(persist=False, useLongTermMemory=False)
    out = {"status": None, "sessionId": None, "answer": None, "sources": [], "trace": [], "error": None, "ms": None}
    t0 = time.monotonic()
    with client.stream("POST", "/api/chat", json=body, headers={"Authorization": f"Bearer {token}"}, timeout=240) as r:
        out["status"] = r.status_code
        if r.status_code != 200:
            out["error"] = r.read().decode()
            return out
        event = None
        for line in r.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: ") and event:
                data = json.loads(line[6:])
                if event == "session":
                    out["sessionId"] = data["sessionId"]
                elif event == "trace":
                    out["trace"].append(data)
                elif event == "result":
                    out["answer"] = data["answer"]
                    out["sources"] = [s.get("document") or "" for s in data.get("sources", [])]
                elif event == "error":
                    out["error"] = f"{data.get('message')} (correlationId {data.get('correlationId')})"
                event = None
    out["ms"] = round((time.monotonic() - t0) * 1000)
    return out


def memory_rows(trace, step=None):
    rows = [t for t in trace if "BedrockAgentCoreMemory" in (t.get("sources") or []) or t["step"] == "SessionHistoryLoad"]
    return [t for t in rows if step is None or t["step"] == step]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8765")
    ap.add_argument("--skip-ltm", action="store_true", help="skip the long-term memory check (extraction not yet run)")
    args = ap.parse_args()
    client = httpx.Client(base_url=args.base, timeout=60)

    print("\n[1] Document ACLs: the knowledge base filters by the verified email")
    sofia_tokens = tokens_for("sofia")
    sofia = sofia_tokens["IdToken"]
    me = client.get("/api/me", headers={"Authorization": f"Bearer {sofia}"}).json()
    check("/api/me shows sofia's verified email", me.get("email") == "sofia@example.com", f"email={me.get('email')}")
    at = client.get("/api/me", headers={"Authorization": f"Bearer {sofia_tokens['AccessToken']}"})
    check("access token (no email claim) is rejected", at.status_code == 401, f"status={at.status_code}")
    bad = client.get("/api/me", headers={"Authorization": "Bearer not.a.token"})
    bad_detail = bad.json().get("detail") if bad.headers.get("content-type", "").startswith("application/json") else None
    check("a malformed token gets a generic 401",
          bad.status_code == 401 and isinstance(bad_detail, dict)
          and bad_detail.get("message") == "invalid token" and "correlationId" in bad_detail,
          f"status={bad.status_code} body={bad.text[:120]}")

    maya = token_for("maya")
    q_oncall = "What is the weekly on-call stipend?"
    q_comm = "What commission rate do I earn above 100% of quota?"
    m1 = chat(client, maya, q_oncall, probe=True)
    s1 = chat(client, sofia, q_oncall, probe=True)
    check("maya (engineer) gets the on-call stipend", "500" in (m1["answer"] or ""),
          (m1["answer"] or "")[:90].replace("\n", " "))
    check("sofia (sales) never receives engineering documents",
          s1["status"] == 200 and not any(d.startswith("engineering/") for d in s1["sources"]) and "500 USD" not in (s1["answer"] or ""),
          f"sources={sorted(set(s1['sources']))}")
    s2 = chat(client, sofia, q_comm, probe=True)
    m2 = chat(client, maya, q_comm, probe=True)
    check("sofia gets the commission accelerator", "12%" in (s2["answer"] or ""),
          (s2["answer"] or "")[:90].replace("\n", " "))
    check("maya never receives the sales commission plan",
          m2["status"] == 200 and not any(d.startswith("sales/") for d in m2["sources"]) and "12%" not in (m2["answer"] or ""),
          f"sources={sorted(set(m2['sources']))}")

    print("\n[2] Maya: new conversation is persisted")
    t1 = chat(client, maya, "How do I set up the VPN on my Mac? I'm in the Frankfurt office.")
    check("turn 1 answered", bool(t1["answer"]) and t1["status"] == 200, f"{t1['ms']} ms; error={t1['error']}")
    shl = memory_rows(t1["trace"], "SessionHistoryLoad")
    check("turn 1 SessionHistoryLoad restored 0 items", any(r["status"] == "SUCCEEDED" and r["items"] == 0 for r in shl))
    sess = t1["sessionId"]
    time.sleep(2)
    convs = client.get("/api/conversations", headers={"Authorization": f"Bearer {maya}"}).json()
    check("conversation listed from memory", any(c["sessionId"] == sess for c in convs), f"{len(convs)} conversation(s)")
    hist = client.get(f"/api/conversations/{sess}", headers={"Authorization": f"Bearer {maya}"}).json()
    check("history has USER + ASSISTANT from memory", [h["role"] for h in hist] == ["user", "assistant"], f"roles={[h['role'] for h in hist]}")

    print("\n[3] Maya: follow-up in the same conversation (only the new question is sent)")
    t2 = chat(client, maya, "It disconnects every few minutes. What should I try?", session_id=sess)
    shl2 = memory_rows(t2["trace"], "SessionHistoryLoad")
    restored = next((r for r in shl2 if r["status"] == "SUCCEEDED"), None)
    check("turn 2 restored prior history", bool(restored and restored["items"] >= 1),
          f"memory={restored and restored.get('memory')}")
    check("turn 2 answer resolves the referent (mentions Private Relay / macOS)",
          bool(t2["answer"]) and ("Private Relay" in t2["answer"] or "macOS" in t2["answer"] or "Mac" in t2["answer"]),
          (t2["answer"] or "")[:100].replace("\n", " "))
    check("warm session: speculative retrieval did not query memory",
          all("BedrockAgentCoreMemory" not in (t.get("sources") or []) for t in t2["trace"] if t["step"] == "SpeculativeRetrieval"))

    if not args.skip_ltm:
        print("\n[4] Maya: NEW conversation, office-dependent question, no office stated")
        t3 = chat(client, maya, "How many days of PTO do I get, and do unused days carry over?")
        ltm_rows = [r for r in memory_rows(t3["trace"]) if r["step"] != "SessionHistoryLoad" and r["status"] == "SUCCEEDED" and r["items"] > 0]
        check("long-term memory retrieved for Maya", bool(ltm_rows),
              "; ".join(f"{r['step']} items={r['items']}" for r in ltm_rows) or "no memory items (extraction pending?)")
        check("answer personalized to Frankfurt", bool(t3["answer"]) and "Frankfurt" in t3["answer"] and "30 days" in t3["answer"],
              (t3["answer"] or "")[:120].replace("\n", " "))
        planning_mem = [a for r in t3["trace"] for a in (r.get("actions") or []) if a["type"] == "memoryRetrieve"]
        print(f"        planner memoryRetrieve actions: {[a['query'] for a in planning_mem]}")

        print("\n[5] Liam: same question, new conversation -> only HIS memory, never Maya's")
        liam = token_for("liam")
        t4 = chat(client, liam, "How many days of PTO do I get, and do unused days carry over?")
        liam_sub = COG["testUsers"]["liam"]["sub"]
        maya_sub = COG["testUsers"]["maya"]["sub"]
        mem_meta = [r["memory"] for r in memory_rows(t4["trace"]) if r["step"] != "SessionHistoryLoad" and r.get("memory")]
        paths = [m.get("_memory_namespace_path", "") for m in mem_meta]
        check("every memory lookup for liam is scoped to liam's namespace",
              bool(paths) and all(liam_sub in p and maya_sub not in p for p in paths),
              f"namespacePaths={paths}" if paths else
              "no long-term records returned for liam; run scripts/wait_for_extraction.py --user liam after turn 4")
        # Heuristic. A generic answer lists several offices or none. An answer personalized from
        # Maya's memory either names only Frankfurt or ties Frankfurt to the reader in one clause
        # ("Since you're based in the Frankfurt office", "you've been working on ... the Frankfurt
        # office"), often next to a table of all three offices.
        low = (t4["answer"] or "").lower()
        offices = [o for o in ("seattle", "frankfurt", "toronto") if o in low]
        second_person = PERSONAL_FRANKFURT.search(low)
        check("liam's answer is not personalized to Frankfurt",
              bool(t4["answer"]) and offices != ["frankfurt"] and not second_person,
              f"offices={offices}; second_person={second_person.group(0) if second_person else None!r}; "
              + (t4["answer"] or "")[:100].replace("\n", " "))
    else:
        liam = token_for("liam")

    print("\n[6] Liam cannot read Maya's conversation")
    cross = client.get(f"/api/conversations/{sess}", headers={"Authorization": f"Bearer {liam}"})
    check("cross-user history read is empty", cross.status_code == 200 and cross.json() == [], f"status={cross.status_code} body={cross.text[:80]}")
    long_id = client.get("/api/conversations/" + "a" * 150, headers={"Authorization": f"Bearer {liam}"})
    check("an over-long sessionId is rejected with 422", long_id.status_code == 422, f"status={long_id.status_code}")

    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    (ROOT / "runs").mkdir(exist_ok=True)
    (ROOT / "runs" / "e2e-results.json").write_text(json.dumps([{"check": n, "ok": ok, "detail": d} for n, ok, d in RESULTS], indent=2) + "\n")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
