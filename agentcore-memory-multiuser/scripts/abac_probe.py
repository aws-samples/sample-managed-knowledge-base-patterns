#!/usr/bin/env python3
"""Does IAM hold the per-user memory boundary even when application code gets it wrong?

The application role's trust policy accepts only the backend's principal, and only with a
userId session tag and a SourceIdentity shaped like a Cognito sub (infra/setup.py). Its
memory statements are conditioned on that tag (backend/aws_sessions.py):

    ListEvents / CreateEvent / ListSessions        bedrock-agentcore:actorId == ${aws:PrincipalTag/userId}
    RetrieveMemoryRecords / ListMemoryRecords      bedrock-agentcore:namespacePath like /anycompany/${aws:PrincipalTag/userId}/*

Run with the backend's own credentials. The script checks:
    1. malformed AssumeRole calls (no tag, empty tag, malformed tag, extra tag key,
       no SourceIdentity)                          -> all denied by the trust policy
    2. AssumeRole FOR MAYA, exactly as the backend does it -> allowed
    3. direct memory calls from Maya's session     -> Maya allowed, Liam denied, the root,
                                                      sibling-prefix and empty-tag namespaces
                                                      denied, and /anycompany/<maya> (no
                                                      trailing "/") returns only Maya's records
    4. AgenticRetrieveStream bound to Maya         -> memory works
    5. AgenticRetrieveStream bound to LIAM (the bug the policy guards against)
                                                   -> every memory operation denied
                                                      (AccessDenied in the trace failures) and
                                                      nothing written to Liam's memory

Prints PASS/FAIL per expectation, writes runs/abac-probe.json, and exits non-zero if IAM
allowed anything it should have denied.

    python scripts/abac_probe.py
"""

import json
import pathlib
import sys

from botocore.exceptions import ClientError

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNS = ROOT / "runs"
RUNS.mkdir(exist_ok=True)
sys.path.insert(0, str(ROOT / "backend"))
from assistant import Assistant, new_session_id  # noqa: E402
from aws_sessions import UserSessions, base_session  # noqa: E402
from identity import Principal  # noqa: E402

cfg = json.loads((ROOT / "config.json").read_text())
REGION = cfg["region"]
MEMORY_ID = cfg["memory"]["id"]
ROOT_NS = cfg["memory"]["namespaceRoot"]
users = cfg["cognito"]["testUsers"]
maya = Principal(sub=users["maya"]["sub"], email=users["maya"]["email"], username="maya")
liam = Principal(sub=users["liam"]["sub"], email=users["liam"]["email"], username="liam")

EXPECT = []


def expect(name: str, ok: bool, detail: str = "") -> None:
    EXPECT.append({"check": name, "ok": ok, "detail": detail})
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))


def direct(label: str, fn) -> str:
    try:
        fn()
        result = "ALLOWED"
    except ClientError as e:
        code = e.response["Error"]["Code"]
        # IAM let the call through; the actor or session simply does not exist yet.
        result = "ALLOWED (not found)" if code == "ResourceNotFoundException" else code
    print(f"    {label:55s} {result}")
    return result


def run(label: str, assistant: Assistant, caller: Principal, bound_to: Principal, persist: bool) -> dict:
    """Issue a turn with the caller's credentials but memory bound to `bound_to`."""
    req = assistant.build_request(caller, "What is the weekly on-call stipend?", new_session_id(), persist=persist)
    req["memoryConfiguration"]["sessionBinding"]["actorId"] = bound_to.actor_id
    req["memoryConfiguration"]["retrievalConfigs"] = [{"namespacePath": bound_to.namespace_path(ROOT_NS)}]
    summary = {"label": label, "memory_events": [], "answered": False, "error": None}
    print(f"\n--- {label}")
    try:
        for ev in assistant.ask(caller, req):
            if ev["type"] == "trace":
                rt = {m.get("retrievalType") for m in (ev.get("retrievalMetadata") or [])}
                if ev["step"] == "SessionHistoryLoad" or "BedrockAgentCoreMemory" in rt:
                    failures = [f.get("message", "") for f in (ev.get("failures") or [])]
                    summary["memory_events"].append({"step": ev["step"], "status": ev["status"], "failures": failures})
                    line = f"{ev['step']}/{ev['status']}"
                    if failures:
                        line += f" failures={[m[:120] for m in failures]}"
                    print("   ", line)
            elif ev["type"] == "result":
                summary["answered"] = True
                print("    answer:", (ev["answer"] or "")[:120].replace("\n", " "))
            elif ev["type"] == "error":
                summary["error"] = ev["raw"]
    except ClientError as e:
        summary["error"] = e.response["Error"]
        print("    ClientError:", e.response["Error"]["Code"], e.response["Error"]["Message"][:200])
    return summary


def trust_policy_cases(sts) -> None:
    """Each malformed AssumeRole must be refused by the trust policy."""
    cases = {
        "no session tag": {"SourceIdentity": maya.sub},
        "empty userId tag": {"SourceIdentity": maya.sub, "Tags": [{"Key": "userId", "Value": ""}]},
        "malformed userId tag": {"SourceIdentity": maya.sub, "Tags": [{"Key": "userId", "Value": "maya"}]},
        "extra tag key": {"SourceIdentity": maya.sub,
                          "Tags": [{"Key": "userId", "Value": maya.sub}, {"Key": "team", "Value": "x"}]},
        "no SourceIdentity": {"Tags": [{"Key": "userId", "Value": maya.sub}]},
    }
    for name, kwargs in cases.items():
        slug = name.replace(" ", "-")
        try:
            sts.assume_role(RoleArn=cfg["appRoleArn"], RoleSessionName=f"probe-{slug}", DurationSeconds=900, **kwargs)
            expect(f"AssumeRole with {name} is denied", False, "ALLOWED by the trust policy")
        except ClientError as e:
            code = e.response["Error"]["Code"]
            expect(f"AssumeRole with {name} is denied", code == "AccessDenied", code)


def main() -> None:
    print("Trust policy, with the backend's own credentials:")
    trust_policy_cases(base_session(REGION).client("sts"))

    sessions = UserSessions(cfg["appRoleArn"], REGION)
    try:
        as_maya = sessions.for_user(maya)
        expect("AssumeRole for maya, as the backend does it, is allowed", True, f"tag userId={maya.sub}")
    except ClientError as e:
        expect("AssumeRole for maya, as the backend does it, is allowed", False, e.response["Error"]["Code"])
        finish({})
        return
    mem = as_maya.client("bedrock-agentcore")

    def records(ns: str):
        return lambda: mem.list_memory_records(memoryId=MEMORY_ID, namespacePath=ns, maxResults=1)

    print("\nDirect memory calls from Maya's session:")
    allowed = {
        "ListSessions actorId=maya": lambda: mem.list_sessions(memoryId=MEMORY_ID, actorId=maya.sub, maxResults=1),
        "ListMemoryRecords namespacePath=/anycompany/<maya>/": records(maya.namespace_path(ROOT_NS)),
        "ListMemoryRecords namespacePath=/anycompany/<maya>/summaries/": records(f"{ROOT_NS}/{maya.sub}/summaries/"),
    }
    denied = {
        "ListSessions actorId=liam": lambda: mem.list_sessions(memoryId=MEMORY_ID, actorId=liam.sub, maxResults=1),
        "ListEvents actorId=liam": lambda: mem.list_events(memoryId=MEMORY_ID, actorId=liam.sub, sessionId="probe", maxResults=1),
        "ListMemoryRecords namespacePath=/anycompany/<liam>/": records(liam.namespace_path(ROOT_NS)),
        "ListMemoryRecords namespacePath=/anycompany/ (every user)": records(f"{ROOT_NS}/"),
        "ListMemoryRecords namespacePath=/anycompany/<maya>x (sibling prefix)": records(f"{ROOT_NS}/{maya.sub}x"),
        "ListMemoryRecords namespacePath=/anycompany/<maya>x/ (sibling prefix)": records(f"{ROOT_NS}/{maya.sub}x/"),
        "ListMemoryRecords namespacePath=/anycompany// (empty tag)": records(f"{ROOT_NS}//"),
    }
    checks = {}
    for label, fn in allowed.items():
        checks[label] = r = direct(label, fn)
        expect(f"{label} is allowed", r.startswith("ALLOWED"), r)
    for label, fn in denied.items():
        checks[label] = r = direct(label, fn)
        expect(f"{label} is denied", r == "AccessDeniedException", r)

    # The service treats a path without the trailing "/" as the same namespace, so IAM may
    # allow it. Either way it must never return anything outside Maya's namespace.
    label = "ListMemoryRecords namespacePath=/anycompany/<maya> (no separator)"
    try:
        recs = mem.list_memory_records(memoryId=MEMORY_ID, namespacePath=f"{ROOT_NS}/{maya.sub}",
                                       maxResults=50).get("memoryRecordSummaries", [])
        foreign = [n for r in recs for n in r.get("namespaces", []) if not n.startswith(maya.namespace_path(ROOT_NS))]
        checks[label] = f"ALLOWED ({len(recs)} record(s), {len(foreign)} outside maya's namespace)"
        expect(f"{label} returns only maya's records", not foreign, checks[label])
    except ClientError as e:
        checks[label] = code = e.response["Error"]["Code"]
        expect(f"{label} returns only maya's records", code in ("AccessDeniedException", "ResourceNotFoundException"), code)

    admin_mem = base_session(REGION).client("bedrock-agentcore")

    def liam_sessions() -> int:
        try:
            return len(admin_mem.list_sessions(memoryId=MEMORY_ID, actorId=liam.sub, maxResults=100).get("sessionSummaries", []))
        except admin_mem.exceptions.ResourceNotFoundException:
            return 0

    before = liam_sessions()

    assistant = Assistant(cfg, session_for=sessions.for_user)
    # persist=False so the probe leaves Maya's memory as it found it.
    own = run("Maya's session, memory bound to Maya (should work)", assistant, maya, maya, persist=False)
    # persist=True so the write path (CreateEvent) is exercised and must be denied too.
    misbound = run("Maya's session, memory bound to LIAM (must be denied)", assistant, maya, liam, persist=True)

    after = liam_sessions()
    print()
    expect("bound to maya: memory steps ran and none FAILED",
           bool(own["memory_events"]) and not own["error"] and all(e["status"] != "FAILED" for e in own["memory_events"]),
           json.dumps(own["memory_events"])[:200])
    # Terminal events only. SpeculativeRetrieval can finish SUCCEEDED (its knowledge base leg
    # worked) while reporting the memory leg's AccessDenied in its failures.
    done = [e for e in misbound["memory_events"] if e["status"] != "IN_PROGRESS"]
    expect("bound to liam: every memory step reports AccessDenied",
           bool(done) and not misbound["error"]
           and all(any("AccessDenied" in m for m in e["failures"]) for e in done),
           json.dumps(done)[:300])
    print(f"        bound to liam: answered from the knowledge base = {misbound['answered']} (information only)")
    expect("the mis-bound request added no session for liam", before == after, f"before={before} after={after}")

    finish({"direct": checks, "results": [own, misbound], "liamSessionsBefore": before, "liamSessionsAfter": after})


def finish(extra: dict) -> None:
    failed = [e for e in EXPECT if not e["ok"]]
    print(f"\n{len(EXPECT) - len(failed)}/{len(EXPECT)} expectations met")
    out = RUNS / "abac-probe.json"
    out.write_text(json.dumps({"expectations": EXPECT, **extra}, indent=2, default=str) + "\n")
    print("written", out)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
