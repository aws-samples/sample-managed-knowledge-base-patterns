"""Step 1: wait for the sync that cdk deploy started, then check each file's type.

Tabular search runs code over files whose _file_type is CSV (.csv) or MS_EXCEL (.xlsx and .xls),
so check the file types after the first sync. Pass --sync to start a new sync first, for
example after you change files in the bucket outside of cdk deploy.
"""

from __future__ import annotations

import argparse
import sys
from typing import TYPE_CHECKING, Any

import common

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agent import AgentsforBedrockClient
    from mypy_boto3_bedrock_agent_runtime import AgentsforBedrockRuntimeClient
    from mypy_boto3_s3 import S3Client


def latest_job_id(agent: AgentsforBedrockClient, kb_id: str, ds_id: str) -> str | None:
    jobs = agent.list_ingestion_jobs(
        knowledgeBaseId=kb_id,
        dataSourceId=ds_id,
        sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
        maxResults=1,
    )["ingestionJobSummaries"]
    return jobs[0]["ingestionJobId"] if jobs else None


def wait_for_sync(
    agent: AgentsforBedrockClient, kb_id: str, ds_id: str, start: bool
) -> None:
    job_id = None if start else latest_job_id(agent, kb_id, ds_id)
    if job_id:
        print(f"Ingestion job {job_id}")
    else:
        job_id = agent.start_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id)[
            "ingestionJob"
        ]["ingestionJobId"]
        print(f"Started ingestion job {job_id}")

    def job_status() -> tuple[str, dict[str, Any]]:
        job = agent.get_ingestion_job(
            knowledgeBaseId=kb_id, dataSourceId=ds_id, ingestionJobId=job_id
        )["ingestionJob"]
        return job["status"], dict(job)

    job = common.wait_until(
        job_status,
        label="ingestion job",
        done={"COMPLETE"},
        failed={"FAILED", "STOPPED"},
        timeout=3600,
        interval=15,
    )
    stats = job.get("statistics") or {}
    indexed = stats.get("numberOfNewDocumentsIndexed", 0) + stats.get(
        "numberOfModifiedDocumentsIndexed", 0
    )
    print(
        f"Scanned {stats.get('numberOfDocumentsScanned', 0)}, indexed {indexed}, "
        f"skipped {stats.get('numberOfDocumentsSkipped', 0)}, "
        f"failed {stats.get('numberOfDocumentsFailed', 0)}"
    )
    for reason in job.get("failureReasons") or []:
        print(f"  failure: {reason}")
    if stats.get("numberOfDocumentsSkipped"):
        print(
            "  A skipped file is often larger than maxFileSizeInMegaBytes. Deploy again with "
            "a larger -c maxFileSizeMb=<MB>, which also starts a new sync."
        )


def uploaded_keys(s3: S3Client, bucket: str, prefix: str) -> list[str]:
    keys: list[str] = []
    for page in s3.get_paginator("list_objects_v2").paginate(
        Bucket=bucket, Prefix=prefix
    ):
        keys.extend(item["Key"] for item in page.get("Contents", []) if "Key" in item)
    return sorted(key for key in keys if not key.endswith("/"))


def file_types(
    runtime: AgentsforBedrockRuntimeClient, kb_id: str, bucket: str, key: str
) -> list[str]:
    """Return the _file_type values of the passages that come from one file."""
    title = key.rsplit("/", 1)[-1]
    uri = f"s3://{bucket}/{key}"
    response = runtime.retrieve(
        knowledgeBaseId=kb_id,
        retrievalQuery={"text": title},
        retrievalConfiguration={
            "managedSearchConfiguration": {
                "numberOfResults": 5,
                # The API takes any JSON value here. The stubs type it as a mapping.
                "filter": {"equals": {"key": "_document_title", "value": title}},  # type: ignore[typeddict-item]
            }
        },
    )
    found = set()
    for result in response["retrievalResults"]:
        metadata: dict[str, Any] = dict(result.get("metadata") or {})
        from_this_file = (
            uri in (result.get("documentId"), metadata.get("_source_uri"))
            or metadata.get("_document_title") == title
        )
        if from_this_file and metadata.get("_file_type"):
            found.add(str(metadata["_file_type"]))
    return sorted(found)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Wait for the sync to finish and check each file's _file_type."
    )
    parser.add_argument(
        "--sync",
        action="store_true",
        help="Start a new sync instead of waiting for the last one.",
    )
    parser.add_argument(
        "--skip-sync", action="store_true", help="Only check the file types."
    )
    common.add_stack_arguments(parser)
    args = parser.parse_args()

    session = common.make_session(args.region)
    outputs = common.stack_outputs(session.client("cloudformation"), args.stack_name)
    kb_id, ds_id = outputs["KnowledgeBaseId"], outputs["DataSourceId"]
    bucket, prefix = outputs["BucketName"], outputs["DocumentPrefix"]

    if not args.skip_sync:
        wait_for_sync(session.client("bedrock-agent"), kb_id, ds_id, start=args.sync)

    keys = uploaded_keys(session.client("s3"), bucket, prefix)
    if not keys:
        sys.exit(
            f"No files under s3://{bucket}/{prefix}. Check the dataDir you deployed with."
        )

    runtime = session.client("bedrock-agent-runtime")
    print(f"\n{'File':<45} {'_file_type':<12} Tabular search")
    problems = 0
    for key in keys:
        types = file_types(runtime, kb_id, bucket, key)
        verdict, needs_a_look = common.file_type_verdict(key, types)
        problems += needs_a_look
        print(f"{key.rsplit('/', 1)[-1]:<45} {', '.join(types) or '-':<12} {verdict}")
    if problems:
        sys.exit(f"\n{problems} file(s) to review before you ask questions.")
    print("\nNext: uv run python 02_ask.py overspend")


if __name__ == "__main__":
    main()
