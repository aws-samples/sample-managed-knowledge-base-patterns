"""Shared helpers for the tabular search sample.

The scripts use the default AWS credential and Region chain (environment variables,
AWS_PROFILE, or the AWS CLI configuration). They find the knowledge base in the outputs
of the CloudFormation stack that `cdk deploy` creates, or take its ID from --kb-id.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, EventStreamError

if TYPE_CHECKING:
    from mypy_boto3_cloudformation import CloudFormationClient

HERE = Path(__file__).resolve().parent
QUESTIONS_FILE = HERE / "questions.json"

# The stack is named tabular-search-<name>, and the default name is finance.
DEFAULT_STACK_NAME = "tabular-search-finance"
STACK_OUTPUTS = ("KnowledgeBaseId", "DataSourceId", "BucketName", "DocumentPrefix")

TABLE_EXTENSIONS = {".csv", ".xlsx", ".xls"}
TABLE_FILE_TYPES = {"CSV", "MS_EXCEL"}

# A question that runs code can take a minute or more. While code runs, the stream sends
# progress events, so a long read timeout keeps the connection open.
STREAM_CONFIG = Config(
    read_timeout=600, retries={"max_attempts": 3, "mode": "standard"}
)

# Managed models plan the work, rerank passages, and write the answer.
AGENTIC_CONFIGURATION = {
    "foundationModelType": "MANAGED",
    "rerankingModelType": "MANAGED",
}

T = TypeVar("T")


# ---------------------------------------------------------------- session and stack


def make_session(region: str | None = None) -> boto3.Session:
    session = boto3.Session(region_name=region)
    # Boto3 reads AWS_DEFAULT_REGION but not AWS_REGION, which the AWS CDK CLI and other
    # SDKs read. Fall back to it so that either variable works.
    if not session.region_name and os.environ.get("AWS_REGION"):
        session = boto3.Session(region_name=os.environ["AWS_REGION"])
    if not session.region_name:
        sys.exit(
            "Set a Region first: export AWS_DEFAULT_REGION=<region>, or pass --region."
        )
    return session


def add_stack_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--stack-name",
        default=DEFAULT_STACK_NAME,
        help=f"The stack that cdk deploy created (default: {DEFAULT_STACK_NAME}). "
        "With cdk deploy -c name=<name>, it's tabular-search-<name>.",
    )
    parser.add_argument(
        "--region", help="AWS Region (default: your configured Region)."
    )


def stack_outputs(
    cloudformation: CloudFormationClient, stack_name: str
) -> dict[str, str]:
    """Return the outputs of the deployed stack, and stop with a hint if it isn't there."""
    try:
        stacks = cloudformation.describe_stacks(StackName=stack_name)["Stacks"]
    except ClientError as error:
        if "does not exist" in error.response.get("Error", {}).get("Message", ""):
            region = cloudformation.meta.region_name
            sys.exit(
                f"Stack {stack_name} isn't deployed in {region}. Deploy it first "
                "(see README.md), or pass --stack-name, --region, or --kb-id."
            )
        raise
    outputs = {
        output["OutputKey"]: output["OutputValue"]
        for output in stacks[0].get("Outputs", [])
        if "OutputKey" in output and "OutputValue" in output
    }
    missing = [key for key in STACK_OUTPUTS if key not in outputs]
    if missing:
        sys.exit(
            f"Stack {stack_name} has no {', '.join(missing)} output. "
            "Is it the tabular search stack, and did the deploy finish?"
        )
    return outputs


def knowledge_base_id(
    session: boto3.Session, stack_name: str, kb_id: str | None
) -> str:
    """Return --kb-id if given, otherwise the knowledge base of the stack."""
    if kb_id:
        return kb_id
    return stack_outputs(session.client("cloudformation"), stack_name)[
        "KnowledgeBaseId"
    ]


def wait_until(
    fetch: Callable[[], tuple[str, T]],
    *,
    label: str,
    done: set[str],
    failed: frozenset[str] | set[str] = frozenset(),
    timeout: int = 900,
    interval: int = 10,
) -> T:
    """Call fetch() until it returns a status in done. fetch returns (status, detail)."""
    start = time.monotonic()
    while True:
        status, detail = fetch()
        elapsed = int(time.monotonic() - start)
        # Flush, so progress shows up when output goes to a file or a pipe.
        print(f"  {label}: {status} ({elapsed} s)", flush=True)
        if status in done:
            return detail
        if status in failed:
            sys.exit(f"{label} is {status}: {detail}")
        if elapsed > timeout:
            sys.exit(f"Stopped waiting for {label} after {timeout} s.")
        time.sleep(interval)


# ---------------------------------------------------------------- questions


def load_questions(path: Path = QUESTIONS_FILE) -> list[dict[str, Any]]:
    questions: list[dict[str, Any]] = json.loads(path.read_text())["questions"]
    return questions


def find_question(question_id: str) -> dict[str, Any] | None:
    return next((q for q in load_questions() if q["id"] == question_id), None)


# ---------------------------------------------------------------- file types


def file_type_verdict(key: str, types: list[str]) -> tuple[str, bool]:
    """Say whether tabular search can run code over a file. Returns (verdict, needs_a_look)."""
    if not types:
        return "not found yet (sync, then check again)", True
    if Path(key).suffix.lower() not in TABLE_EXTENSIONS:
        return "no, a document", False
    if set(types) <= TABLE_FILE_TYPES:
        return "yes", False
    return "no: expected CSV or MS_EXCEL. Check the file format.", True


# ---------------------------------------------------------------- agentic retrieval


def agentic_request(
    knowledge_base_id: str, messages: list[dict[str, Any]], only_file: str | None = None
) -> dict[str, Any]:
    """Build an AgenticRetrieveStream request. There is no field to turn tabular search on.

    Response generation (generateResponse) is on by default, and tabular search runs as part
    of it. only_file adds a metadata filter, so retrieval, and therefore the code, can use only
    that file.
    """
    knowledge_base: dict[str, Any] = {"knowledgeBaseId": knowledge_base_id}
    if only_file:
        knowledge_base["retrievalOverrides"] = {
            "filter": {"equals": {"key": "_document_title", "value": only_file}}
        }
    return {
        "messages": messages,
        "retrievers": [{"configuration": {"knowledgeBase": knowledge_base}}],
        "agenticRetrieveConfiguration": dict(AGENTIC_CONFIGURATION),
    }


def source_of(result: Mapping[str, Any]) -> str | None:
    """Return the file a passage came from, as s3://bucket/key when the service provides it."""
    metadata = result.get("metadata") or {}
    source = (
        metadata.get("_document_id")
        or result.get("documentId")
        or metadata.get("_source_uri")
    )
    return str(source) if source else None


def cited_files(result: Mapping[str, Any]) -> list[str]:
    """Return the files that the answer's citations point to, in order, without repeats."""
    generated = result.get("generatedResponse") or {}
    results = result.get("results") or []
    cited: list[str] = []
    for citation in generated.get("citations") or []:
        for reference in citation.get("references") or []:
            index = reference.get("resultIndex")
            if isinstance(index, int) and 0 <= index < len(results):
                source = source_of(results[index])
                if source and source not in cited:
                    cited.append(source)
    return cited


@dataclass
class StreamOutcome:
    answer: str = ""
    code_ran: bool = False
    code_files: list[str] = field(default_factory=list)
    cited_files: list[str] = field(default_factory=list)
    result: dict[str, Any] = field(default_factory=dict)


def print_stream(
    stream: Iterable[Mapping[str, Any]],
    trace_file: Path | None = None,
    request_id: str | None = None,
) -> StreamOutcome:
    """Print the trace steps, the files the code reads, and the answer as they arrive.

    With trace_file, every raw event is also written as one JSON line with its arrival time.
    request_id goes into the error message if the stream fails partway.
    """
    start = time.monotonic()
    raw = None
    if trace_file:
        trace_file.parent.mkdir(parents=True, exist_ok=True)
        raw = trace_file.open("w", encoding="utf-8")
    outcome = StreamOutcome()
    text_parts: list[str] = []
    previous: tuple[Any, ...] | None = None
    try:
        for event in stream:
            seconds = time.monotonic() - start
            if raw:
                record = {"t_ms": round(seconds * 1000), "event": event}
                raw.write(json.dumps(record, default=str) + "\n")
            if "traceEvent" in event:
                attributes = event["traceEvent"].get("attributes", {})
                step, status = attributes.get("step"), attributes.get("status")
                message = attributes.get("message", "")
                current = (step, status, message)
                if current == previous and status == "IN_PROGRESS":
                    # Long code runs repeat the IN_PROGRESS event as a progress signal.
                    print(f"[{seconds:6.1f} s] {step} still running")
                    continue
                previous = current
                line = f"[{seconds:6.1f} s] {step} {status}"
                if step == "CodeExecution":
                    outcome.code_ran = True
                    if message:
                        line += f": {message}"
                print(line)
                for failure in attributes.get("failures") or []:
                    print(f"           failure: {failure.get('message')}")
                # A Planning event names the files the code will read.
                for action in attributes.get("actions") or []:
                    for document in (action.get("codeExecution") or {}).get(
                        "documents", []
                    ):
                        outcome.code_files.append(document["documentId"])
                        print(f"           code will read: {document['documentId']}")
            elif "responseEvent" in event:
                if not text_parts:
                    print("\nAnswer:")
                chunk = event["responseEvent"].get("text", "")
                text_parts.append(chunk)
                print(chunk, end="", flush=True)
            elif "result" in event:
                outcome.result = dict(event["result"])
    except EventStreamError as error:
        detail = error.response.get("Error", {})
        suffix = f" (request ID {request_id})" if request_id else ""
        sys.exit(
            f"\nThe stream returned an error: {detail.get('Code')}: {detail.get('Message')}{suffix}"
        )
    finally:
        if raw:
            raw.close()
    if text_parts:
        print()

    generated = outcome.result.get("generatedResponse") or {}
    outcome.answer = generated.get("answer") or "".join(text_parts)
    outcome.cited_files = cited_files(outcome.result)
    if outcome.cited_files:
        print("\nCited files:")
        for source in outcome.cited_files:
            print(f"  {source}")
    return outcome


def print_retrieve_results(results: Iterable[Mapping[str, Any]]) -> None:
    for number, item in enumerate(results, 1):
        metadata = item.get("metadata") or {}
        text = " ".join(((item.get("content") or {}).get("text") or "").split())
        print(f"{number:>2}. {metadata.get('_file_type', '-'):<10} {source_of(item)}")
        print(f"    {text[:160]}{'...' if len(text) > 160 else ''}")


def explain(error: ClientError) -> str:
    detail = error.response.get("Error", {})
    request_id = error.response.get("ResponseMetadata", {}).get("RequestId")
    suffix = f" (request ID {request_id})" if request_id else ""
    return f"{detail.get('Code')}: {detail.get('Message')}{suffix}"
