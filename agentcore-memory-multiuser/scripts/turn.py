#!/usr/bin/env python3
"""One turn from the command line, exactly as the backend would issue it.

    python scripts/turn.py --user maya --question "..." [--session conv-...]
                           [--no-persist] [--no-ltm] [--as-admin]

By default the call is made exactly as the backend makes it: the application role,
assumed for this one user with the session tag userId=<sub>, so the IAM policy in
infra/app-role-policy.json is what actually gets exercised. Every event is written to
runs/<timestamp>-<user>.jsonl for later inspection.
"""

import argparse
import datetime as dt
import json
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from assistant import Assistant, new_session_id  # noqa: E402
from aws_sessions import UserSessions, base_session  # noqa: E402
from identity import CognitoVerifier, sign_in  # noqa: E402


def _default(o):
    if isinstance(o, (dt.datetime, dt.date)):
        return o.isoformat()
    if isinstance(o, bytes):
        return o.decode("utf-8", "replace")
    return str(o)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--question", required=True)
    ap.add_argument("--session", help="continue this conversation; omit to start a new one")
    ap.add_argument("--no-persist", action="store_true")
    ap.add_argument("--no-ltm", action="store_true")
    ap.add_argument("--as-admin", action="store_true", help="skip the app role (debugging only)")
    args = ap.parse_args()

    cfg = json.loads((ROOT / "config.json").read_text())
    cog = cfg["cognito"]

    # 1. The client signs in with Cognito and presents a token ...
    tokens = sign_in(cfg["region"], cog["clientId"], args.user, cog["testPassword"])
    # 2. ... the server verifies it and derives the Principal.
    principal = CognitoVerifier(cog["issuer"], cog["clientId"]).verify(tokens["IdToken"])
    print(f"principal: username={principal.username} sub={principal.sub} email={principal.email}")

    if args.as_admin:
        admin = base_session(cfg["region"])
        session_for = lambda _p: admin  # noqa: E731
    else:
        session_for = UserSessions(cfg["appRoleArn"], cfg["region"]).for_user
    assistant = Assistant(cfg, session_for=session_for)

    session_id = args.session or new_session_id()
    request = assistant.build_request(principal, args.question, session_id,
                                      persist=not args.no_persist, use_long_term_memory=not args.no_ltm)
    print(f"session: {session_id}")
    print("userContext:", json.dumps(request["userContext"]))
    print("memoryConfiguration:", json.dumps(request["memoryConfiguration"], indent=2))

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S")
    out_path = ROOT / "runs" / f"{stamp}-{args.user}.jsonl"
    out_path.parent.mkdir(exist_ok=True)
    t0 = time.monotonic()
    first_text = None
    answer = None
    with out_path.open("w") as out:
        out.write(json.dumps({"request": request, "principal": principal.__dict__, "sessionId": session_id}, default=_default) + "\n")
        for ev in assistant.ask(principal, request):
            out.write(json.dumps(ev["raw"], default=_default) + "\n")
            if ev["type"] == "trace":
                rt = ",".join(sorted({m.get("retrievalType", "?") for m in (ev.get("retrievalMetadata") or [])}))
                extra = f" [{rt}]" if rt else ""
                n = len(ev.get("retrievalResponse") or [])
                acts = ev.get("actions") or []
                act_desc = ""
                if acts:
                    kinds = []
                    for a in acts:
                        if "memoryRetrieve" in a:
                            kinds.append(f"memoryRetrieve({a['memoryRetrieve'].get('inputQuery', {}).get('text', '')!r})")
                        elif "retrieve" in a:
                            kinds.append(f"retrieve({a['retrieve'].get('inputQuery', {}).get('text', '')!r})")
                        elif "fullDocumentExpansion" in a:
                            kinds.append("fullDocumentExpansion")
                    act_desc = " actions=" + "; ".join(kinds)
                print(f"  [{(time.monotonic()-t0)*1000:6.0f}ms] {ev['step']}/{ev['status']}{extra} items={n}{act_desc}"
                      + (f" failures={ev['failures']}" if ev.get("failures") else ""))
                if ev["step"] == "SessionHistoryLoad" or "BedrockAgentCoreMemory" in rt:
                    for item in ev.get("retrievalResponse") or []:
                        md = {k: v for k, v in (item.get("metadata") or {}).items() if k.startswith("_memory_")}
                        if md:
                            print(f"             {json.dumps(md)}")
            elif ev["type"] == "text":
                if first_text is None:
                    first_text = time.monotonic() - t0
            elif ev["type"] == "result":
                answer = ev["answer"]
                print(f"  [{(time.monotonic()-t0)*1000:6.0f}ms] result: {len(ev['results'])} passages, "
                      f"{len(ev.get('citations') or [])} citations")
            elif ev["type"] == "error":
                print("  ERROR EVENT:", json.dumps(ev["raw"], default=_default))
    total = time.monotonic() - t0
    print(f"\ntime to first token: {first_text*1000:.0f}ms   total: {total*1000:.0f}ms" if first_text else f"\ntotal: {total*1000:.0f}ms")
    print("\nANSWER:\n" + (answer or "<none>"))
    print(f"\nevents written to {out_path}")
    print(f"\nto continue this conversation:  --session {session_id}")


if __name__ == "__main__":
    main()
