"""Tests for the numbered scripts and for the files they read."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import boto3
import pytest
from botocore.stub import Stubber

import common
from tests.conftest import HERE, load_script

check_file_types = load_script("01_check_file_types.py")
ask = load_script("02_ask.py")
conversation = load_script("03_conversation.py")

KB, DS, JOB = "1234567890", "ABCDEFGHIJ", "KLMNOPQRST"
NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


# ---------------------------------------------------------------- questions.json


def test_questions_have_unique_ids_and_expected_answers() -> None:
    questions = common.load_questions()
    ids = [q["id"] for q in questions]
    assert len(ids) == len(set(ids))
    for q in questions:
        assert q["title"]
        if "turns" in q:
            assert q["turns"]
            assert all(turn["question"] and turn["expected"] for turn in q["turns"])
        else:
            assert q["question"] and q["expected"]


def test_conversation_exists_for_03_conversation() -> None:
    assert common.find_question("conversation") is not None


def test_the_sample_files_include_tables_and_documents() -> None:
    files = sorted(p.name for p in (HERE / "data" / "finance").iterdir())
    tables = [f for f in files if f.endswith(tuple(common.TABLE_EXTENSIONS))]
    assert tables == ["anycompany-pnl-fy2026-draft.xlsx", "anycompany-pnl-fy2026.xlsx"]
    assert len(files) == 5


# ---------------------------------------------------------------- 01_check_file_types.py


def job(status: str) -> dict[str, Any]:
    return {
        "ingestionJob": {
            "knowledgeBaseId": KB,
            "dataSourceId": DS,
            "ingestionJobId": JOB,
            "status": status,
            "startedAt": NOW,
            "updatedAt": NOW,
            "statistics": {
                "numberOfDocumentsScanned": 5,
                "numberOfNewDocumentsIndexed": 5,
            },
        }
    }


@pytest.mark.usefixtures("no_sleep")
def test_waits_for_the_ingestion_job_that_cdk_deploy_started(
    capsys: pytest.CaptureFixture[str],
) -> None:
    agent = boto3.client("bedrock-agent")
    ids = {"knowledgeBaseId": KB, "dataSourceId": DS}
    with Stubber(agent) as stub:
        summary = {k: v for k, v in job("IN_PROGRESS")["ingestionJob"].items()}
        stub.add_response(
            "list_ingestion_jobs",
            {"ingestionJobSummaries": [summary]},
            {
                **ids,
                "sortBy": {"attribute": "STARTED_AT", "order": "DESCENDING"},
                "maxResults": 1,
            },
        )
        stub.add_response(
            "get_ingestion_job", job("IN_PROGRESS"), {**ids, "ingestionJobId": JOB}
        )
        stub.add_response(
            "get_ingestion_job", job("COMPLETE"), {**ids, "ingestionJobId": JOB}
        )
        check_file_types.wait_for_sync(agent, KB, DS, start=False)
        stub.assert_no_pending_responses()
    out = capsys.readouterr().out
    assert f"Ingestion job {JOB}" in out
    assert "Scanned 5, indexed 5, skipped 0, failed 0" in out


def test_sync_starts_a_new_ingestion_job() -> None:
    agent = boto3.client("bedrock-agent")
    ids = {"knowledgeBaseId": KB, "dataSourceId": DS}
    with Stubber(agent) as stub:
        # No list_ingestion_jobs call: --sync doesn't wait for the last job.
        stub.add_response("start_ingestion_job", job("STARTING"), ids)
        stub.add_response(
            "get_ingestion_job", job("COMPLETE"), {**ids, "ingestionJobId": JOB}
        )
        check_file_types.wait_for_sync(agent, KB, DS, start=True)
        stub.assert_no_pending_responses()


def test_uploaded_keys_skips_folder_markers() -> None:
    s3 = boto3.client("s3")
    with Stubber(s3) as stub:
        stub.add_response(
            "list_objects_v2",
            {
                "Contents": [
                    {"Key": "finance/"},
                    {"Key": "finance/b.md"},
                    {"Key": "finance/a.xlsx"},
                ]
            },
            {"Bucket": "amzn-s3-demo-bucket", "Prefix": "finance/"},
        )
        keys = check_file_types.uploaded_keys(s3, "amzn-s3-demo-bucket", "finance/")
    assert keys == ["finance/a.xlsx", "finance/b.md"]


def test_file_types_reads_passages_from_that_file_only() -> None:
    runtime = boto3.client("bedrock-agent-runtime")
    title = "anycompany-pnl-fy2026.xlsx"
    with Stubber(runtime) as stub:
        stub.add_response(
            "retrieve",
            {
                "retrievalResults": [
                    {
                        "content": {"text": "x"},
                        "metadata": {
                            "_document_title": title,
                            "_file_type": "MS_EXCEL",
                        },
                    },
                    {
                        "content": {"text": "y"},
                        "metadata": {
                            "_document_title": "other.pdf",
                            "_file_type": "PDF",
                        },
                    },
                ]
            },
            {
                "knowledgeBaseId": KB,
                "retrievalQuery": {"text": title},
                "retrievalConfiguration": {
                    "managedSearchConfiguration": {
                        "numberOfResults": 5,
                        "filter": {
                            "equals": {"key": "_document_title", "value": title}
                        },
                    }
                },
            },
        )
        types = check_file_types.file_types(
            runtime, KB, "amzn-s3-demo-bucket", f"finance/{title}"
        )
    assert types == ["MS_EXCEL"]


# ---------------------------------------------------------------- argument handling


@pytest.mark.parametrize("script", [check_file_types, ask, conversation])
def test_every_script_defaults_to_the_stack_that_cdk_deploy_creates(
    script: Any, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("sys.argv", ["script", "--help"])
    with pytest.raises(SystemExit) as exit_info:
        script.main()
    assert exit_info.value.code == 0
    assert common.DEFAULT_STACK_NAME in capsys.readouterr().out


def test_ask_lists_questions_without_calling_aws(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("sys.argv", ["02_ask.py", "--list"])
    ask.main()
    out = capsys.readouterr().out
    for q in common.load_questions():
        assert q["id"] in out


def test_ask_sends_conversations_to_03(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sys.argv", ["02_ask.py", "conversation", "--kb-id", KB])
    with pytest.raises(SystemExit, match="03_conversation.py"):
        ask.main()
