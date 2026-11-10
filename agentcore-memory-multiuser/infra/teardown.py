#!/usr/bin/env python3
"""Delete everything infra/setup.py created. Asks for confirmation unless --yes.

    python infra/teardown.py [--yes] [--keep-memory]
"""

import argparse
import json
import pathlib
import sys
import time

import boto3
from botocore.exceptions import ClientError

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"


def quiet(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code in ("ResourceNotFoundException", "NoSuchEntity", "ResourceNotFound"):
            return None
        raise


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--keep-memory", action="store_true", help="keep the memory resource (and all user data)")
    args = ap.parse_args()
    if not CONFIG_PATH.exists():
        sys.exit("config.json not found; nothing to tear down")
    cfg = json.loads(CONFIG_PATH.read_text())
    region = cfg["region"]

    kbs = dict(cfg.get("knowledgeBases", {}))  # earlier layout of this sample
    if cfg.get("knowledgeBase"):
        kbs["docs"] = cfg["knowledgeBase"]
    print("Will delete:")
    for k, kb in kbs.items():
        print(f"  knowledge base {k}: {kb['id']}")
    if cfg.get("bucket"):
        print(f"  S3 bucket (and every object in it): {cfg['bucket']}")
    if not args.keep_memory and cfg.get("memory"):
        print(f"  memory: {cfg['memory']['id']}  (ALL conversation history and long-term records)")
    if cfg.get("cognito"):
        print(f"  cognito user pool: {cfg['cognito']['userPoolId']}")
    print("  IAM roles: anycompany-assistant-kb-service-role, anycompany-assistant-app-role")
    if not args.yes and input("Proceed? [y/N] ").strip().lower() != "y":
        sys.exit("aborted")

    s = boto3.Session(region_name=region)
    agent, control, idp, iam = s.client("bedrock-agent"), s.client("bedrock-agentcore-control"), s.client("cognito-idp"), s.client("iam")

    for k, kb in kbs.items():
        for ds in (quiet(agent.list_data_sources, knowledgeBaseId=kb["id"]) or {}).get("dataSourceSummaries", []):
            quiet(agent.delete_data_source, knowledgeBaseId=kb["id"], dataSourceId=ds["dataSourceId"])
        quiet(agent.delete_knowledge_base, knowledgeBaseId=kb["id"])
        print(f"[kb] deleted {kb['id']}")

    if cfg.get("bucket"):
        bucket = s.resource("s3").Bucket(cfg["bucket"])
        try:
            bucket.objects.all().delete()
            bucket.delete()
            print(f"[s3] deleted {cfg['bucket']}")
        except ClientError as e:
            if e.response["Error"]["Code"] != "NoSuchBucket":
                raise

    if not args.keep_memory and cfg.get("memory"):
        quiet(control.delete_memory, memoryId=cfg["memory"]["id"])
        print(f"[memory] deleting {cfg['memory']['id']}")

    if cfg.get("cognito"):
        quiet(idp.delete_user_pool, UserPoolId=cfg["cognito"]["userPoolId"])
        print(f"[cognito] deleted {cfg['cognito']['userPoolId']}")

    for role in ("anycompany-assistant-kb-service-role", "anycompany-assistant-app-role"):
        for pn in (quiet(iam.list_role_policies, RoleName=role) or {}).get("PolicyNames", []):
            quiet(iam.delete_role_policy, RoleName=role, PolicyName=pn)
        quiet(iam.delete_role, RoleName=role)
        print(f"[iam] deleted {role}")

    CONFIG_PATH.rename(ROOT / f"config.deleted-{int(time.time())}.json")
    print("done")


if __name__ == "__main__":
    main()
