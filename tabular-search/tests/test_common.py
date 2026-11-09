from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import boto3
import pytest
from botocore.stub import Stubber
from botocore.validate import validate_parameters

import common

BUCKET = "amzn-s3-demo-bucket"
FINAL = f"s3://{BUCKET}/finance/anycompany-pnl-fy2026.xlsx"
POLICY = f"s3://{BUCKET}/finance/anycompany-finance-variance-policy.pdf"


def trace(step: str, status: str, **attributes: Any) -> dict[str, Any]:
    return {
        "traceEvent": {"attributes": {"step": step, "status": status, **attributes}}
    }


def planning_with_code(*documents: str) -> dict[str, Any]:
    action = {"codeExecution": {"documents": [{"documentId": d} for d in documents]}}
    return trace("Planning", "SUCCEEDED", actions=[{"retrieve": {}}, action])


def result_event(answer: str, sources: list[str], cited: list[int]) -> dict[str, Any]:
    return {
        "result": {
            "generatedResponse": {
                "answer": answer,
                "citations": [
                    {"startIndex": 0, "endIndex": 1, "references": [{"resultIndex": i}]}
                    for i in cited
                ],
            },
            "results": [{"metadata": {"_document_id": s}} for s in sources],
        }
    }


# ---------------------------------------------------------------- agentic_request


def test_agentic_request_sends_managed_models_and_no_filter() -> None:
    messages = [{"role": "user", "content": {"text": "q"}}]
    request = common.agentic_request("1234567890", messages)
    assert request == {
        "messages": messages,
        "retrievers": [
            {"configuration": {"knowledgeBase": {"knowledgeBaseId": "1234567890"}}}
        ],
        "agenticRetrieveConfiguration": {
            "foundationModelType": "MANAGED",
            "rerankingModelType": "MANAGED",
        },
    }


def test_agentic_request_only_file_filters_on_document_title() -> None:
    request = common.agentic_request(
        "1234567890", [], only_file="anycompany-pnl-fy2026.xlsx"
    )
    knowledge_base = request["retrievers"][0]["configuration"]["knowledgeBase"]
    assert knowledge_base["retrievalOverrides"] == {
        "filter": {
            "equals": {"key": "_document_title", "value": "anycompany-pnl-fy2026.xlsx"}
        }
    }


def test_agentic_request_does_not_share_the_configuration() -> None:
    first = common.agentic_request("1234567890", [])
    first["agenticRetrieveConfiguration"]["maxAgentIteration"] = 5
    assert (
        "maxAgentIteration"
        not in common.agentic_request("1234567890", [])["agenticRetrieveConfiguration"]
    )


def test_requests_match_the_boto3_model() -> None:
    """A wrong field name or a missing required field fails here instead of in AWS."""
    runtime = boto3.client("bedrock-agent-runtime")
    request = common.agentic_request(
        "1234567890", [{"role": "user", "content": {"text": "q"}}], only_file="a.xlsx"
    )
    # A Stubber can't return an event stream, so validate the request on its own.
    shape = runtime.meta.service_model.operation_model(
        "AgenticRetrieveStream"
    ).input_shape
    assert shape is not None
    validate_parameters(request, shape)


# ---------------------------------------------------------------- print_stream


def test_print_stream_reports_code_files_answer_and_citations(
    capsys: pytest.CaptureFixture[str],
) -> None:
    events = [
        trace("SpeculativeRetrieval", "SUCCEEDED"),
        planning_with_code(FINAL),
        trace(
            "CodeExecution", "IN_PROGRESS", message="Running code over 1 document(s)"
        ),
        trace(
            "CodeExecution",
            "SUCCEEDED",
            message="Code execution completed successfully",
        ),
        {"responseEvent": {"text": "CC-3010 "}},
        {"responseEvent": {"text": "is over."}},
        result_event("CC-3010 is over.", [POLICY, FINAL, FINAL], cited=[1, 0, 2]),
    ]
    outcome = common.print_stream(events)
    out = capsys.readouterr().out
    assert outcome.code_ran
    assert outcome.code_files == [FINAL]
    assert outcome.answer == "CC-3010 is over."
    # In citation order, without repeats.
    assert outcome.cited_files == [FINAL, POLICY]
    assert f"code will read: {FINAL}" in out
    assert "CodeExecution SUCCEEDED: Code execution completed successfully" in out
    assert "\nAnswer:\nCC-3010 is over.\n" in out


def test_print_stream_collapses_repeated_progress_events(
    capsys: pytest.CaptureFixture[str],
) -> None:
    running = trace("CodeExecution", "IN_PROGRESS", message="Running code")
    common.print_stream([running, running, running])
    out = capsys.readouterr().out
    assert out.count("CodeExecution IN_PROGRESS") == 1
    assert out.count("CodeExecution still running") == 2


def test_print_stream_prints_failures(capsys: pytest.CaptureFixture[str]) -> None:
    failed = trace(
        "CodeExecution",
        "FAILED",
        message="Code execution failed",
        failures=[{"message": "The code raised an error or exceeded a sandbox limit"}],
    )
    outcome = common.print_stream([failed])
    assert outcome.code_ran
    assert "failure: The code raised an error" in capsys.readouterr().out


def test_print_stream_without_code_or_result() -> None:
    outcome = common.print_stream(
        [trace("Planning", "SUCCEEDED"), {"responseEvent": {"text": "x"}}]
    )
    assert not outcome.code_ran
    assert outcome.code_files == []
    # Without a result event, the answer is the streamed text.
    assert outcome.answer == "x"
    assert outcome.cited_files == []


def test_print_stream_saves_every_event(tmp_path: Path) -> None:
    events = [trace("Planning", "SUCCEEDED"), {"responseEvent": {"text": "x"}}]
    trace_file = tmp_path / "traces" / "q.jsonl"
    common.print_stream(events, trace_file)
    lines = [json.loads(line) for line in trace_file.read_text().splitlines()]
    assert [line["event"] for line in lines] == events
    assert all(isinstance(line["t_ms"], int) for line in lines)


def test_cited_files_ignores_out_of_range_indexes() -> None:
    result = result_event("a", [FINAL], cited=[0, 3, -1])["result"]
    assert common.cited_files(result) == [FINAL]


def test_source_of_falls_back_to_document_id_and_source_uri() -> None:
    assert common.source_of({"documentId": FINAL}) == FINAL
    assert (
        common.source_of({"metadata": {"_source_uri": "https://b/k"}}) == "https://b/k"
    )
    assert common.source_of({}) is None


# ---------------------------------------------------------------- file types


@pytest.mark.parametrize(
    ("key", "types", "verdict", "needs_a_look"),
    [
        ("finance/anycompany-pnl-fy2026.xlsx", ["MS_EXCEL"], "yes", False),
        ("finance/orders.csv", ["CSV"], "yes", False),
        ("finance/ORDERS.XLS", ["MS_EXCEL"], "yes", False),
        ("finance/orders.csv", ["PLAIN_TEXT"], "no: expected CSV or MS_EXCEL", True),
        ("finance/policy.pdf", ["PDF"], "no, a document", False),
        ("finance/memo.docx", [], "not found yet", True),
    ],
)
def test_file_type_verdict(
    key: str, types: list[str], verdict: str, needs_a_look: bool
) -> None:
    text, flagged = common.file_type_verdict(key, types)
    assert text.startswith(verdict)
    assert flagged is needs_a_look


# ---------------------------------------------------------------- stack outputs


OUTPUTS = {
    "KnowledgeBaseId": "1234567890",
    "DataSourceId": "ABCDEFGHIJ",
    "BucketName": BUCKET,
    "DocumentPrefix": "finance/",
}


def describe_stacks_response(outputs: dict[str, str]) -> dict[str, Any]:
    return {
        "Stacks": [
            {
                "StackName": common.DEFAULT_STACK_NAME,
                "CreationTime": "2026-01-01T00:00:00Z",
                "StackStatus": "CREATE_COMPLETE",
                "Outputs": [
                    {"OutputKey": k, "OutputValue": v} for k, v in outputs.items()
                ],
            }
        ]
    }


def test_stack_outputs_reads_every_output() -> None:
    cloudformation = boto3.client("cloudformation")
    with Stubber(cloudformation) as stub:
        stub.add_response(
            "describe_stacks",
            describe_stacks_response(OUTPUTS),
            {"StackName": common.DEFAULT_STACK_NAME},
        )
        assert (
            common.stack_outputs(cloudformation, common.DEFAULT_STACK_NAME) == OUTPUTS
        )


def test_stack_outputs_stops_when_the_stack_is_missing() -> None:
    cloudformation = boto3.client("cloudformation")
    with Stubber(cloudformation) as stub:
        stub.add_client_error(
            "describe_stacks",
            "ValidationError",
            "Stack with id tabular-search-finance does not exist",
        )
        with pytest.raises(SystemExit, match="isn't deployed in us-east-1"):
            common.stack_outputs(cloudformation, common.DEFAULT_STACK_NAME)


def test_stack_outputs_stops_when_an_output_is_missing() -> None:
    cloudformation = boto3.client("cloudformation")
    partial = {k: v for k, v in OUTPUTS.items() if k != "DataSourceId"}
    with Stubber(cloudformation) as stub:
        stub.add_response("describe_stacks", describe_stacks_response(partial))
        with pytest.raises(SystemExit, match="has no DataSourceId output"):
            common.stack_outputs(cloudformation, common.DEFAULT_STACK_NAME)


def test_make_session_also_reads_aws_region(monkeypatch: pytest.MonkeyPatch) -> None:
    # Boto3 reads only AWS_DEFAULT_REGION. The CDK CLI reads AWS_REGION.
    monkeypatch.delenv("AWS_DEFAULT_REGION")
    monkeypatch.setenv("AWS_REGION", "eu-west-1")
    assert common.make_session().region_name == "eu-west-1"
    assert common.make_session("us-west-2").region_name == "us-west-2"


def test_make_session_stops_without_a_region(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AWS_DEFAULT_REGION")
    with pytest.raises(SystemExit, match="Set a Region first"):
        common.make_session()


def test_knowledge_base_id_prefers_kb_id_without_calling_aws() -> None:
    # No Stubber: a call to CloudFormation would fail with the fake credentials.
    assert (
        common.knowledge_base_id(boto3.Session(), "any", "0987654321") == "0987654321"
    )


# ---------------------------------------------------------------- wait_until


@pytest.mark.usefixtures("no_sleep")
def test_wait_until_returns_the_detail_when_done() -> None:
    statuses = iter([("IN_PROGRESS", 1), ("COMPLETE", 2)])
    assert (
        common.wait_until(lambda: next(statuses), label="job", done={"COMPLETE"}) == 2
    )


def test_wait_until_stops_on_failure() -> None:
    with pytest.raises(SystemExit, match="job is FAILED: boom"):
        common.wait_until(
            lambda: ("FAILED", "boom"),
            label="job",
            done={"COMPLETE"},
            failed={"FAILED"},
        )
