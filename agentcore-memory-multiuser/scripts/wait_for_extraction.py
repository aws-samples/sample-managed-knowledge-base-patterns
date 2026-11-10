#!/usr/bin/env python3
"""Poll long-term memory until records exist for a user, and report how long it took.

    python scripts/wait_for_extraction.py --user maya [--timeout 1800] [--min-records 1]

Long-term memory extraction is asynchronous. A fact stated in this conversation is not
guaranteed to be available in the next one immediately; this script measures that lag
and tells you when turn 3 of the E2E test may run.
"""

import argparse
import datetime as dt
import json
import pathlib
import sys
import time

import boto3

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--interval", type=int, default=20)
    ap.add_argument("--min-records", type=int, default=1)
    args = ap.parse_args()

    cfg = json.loads((ROOT / "config.json").read_text())
    actor = cfg["cognito"]["testUsers"][args.user]["sub"]
    ns_path = f"{cfg['memory']['namespaceRoot']}/{actor}/"
    mem = boto3.client("bedrock-agentcore", region_name=cfg["region"])

    start = time.time()
    seen = set()
    print(f"polling namespacePath={ns_path} every {args.interval}s (timeout {args.timeout}s) ...")
    while True:
        try:
            jobs = mem.list_memory_extraction_jobs(memoryId=cfg["memory"]["id"], maxResults=20).get("extractionJobs", [])
        except Exception as e:  # noqa: BLE001 - API may not be available in all regions
            jobs = []
            jobs_err = str(e)[:80]
        else:
            jobs_err = None
        resp = mem.list_memory_records(memoryId=cfg["memory"]["id"], namespacePath=ns_path, maxResults=50)
        records = resp.get("memoryRecordSummaries", [])
        elapsed = time.time() - start
        new = [r for r in records if r["memoryRecordId"] not in seen]
        for r in new:
            seen.add(r["memoryRecordId"])
            print(f"  [{elapsed:6.0f}s] NEW record ns={r.get('namespaces')} :: {(r.get('content') or {}).get('text','')[:140]!r}")
        job_desc = ""
        if jobs:
            recent = jobs[:3]
            job_desc = " jobs=" + ",".join(f"{j.get('status')}" for j in recent)
        elif jobs_err:
            job_desc = f" (extraction jobs API: {jobs_err})"
        print(f"  [{elapsed:6.0f}s] {len(records)} record(s){job_desc}")
        if len(records) >= args.min_records:
            print(f"\nextraction visible after {elapsed:.0f}s ({dt.timedelta(seconds=int(elapsed))}) with {len(records)} record(s)")
            out = ROOT / "runs" / f"ltm-{args.user}.json"
            out.parent.mkdir(exist_ok=True)
            out.write_text(json.dumps({"elapsedSeconds": elapsed, "records": records}, indent=2, default=str) + "\n")
            print(f"written to {out}")
            return
        if elapsed > args.timeout:
            sys.exit("timed out waiting for extraction")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
