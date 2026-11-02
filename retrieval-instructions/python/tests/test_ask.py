"""Request shapes for every sender path, and what read_stream takes from the stream."""

from __future__ import annotations

import dataclasses
from typing import Any

import botocore.session
import pytest
from botocore.validate import validate_parameters

from ri_sample import state as state_file
from ri_sample.ask import RetrievedDocument, ask_as_tenant, build_request, read_stream, send_request
from ri_sample.corpus import classify, key_from_expansion_message, key_from_source_uri
from ri_sample.filters import filter_for
from ri_sample.formats import document_rows, format_isolation
from ri_sample.tenancy import TenantFilter, south_retriever_filters, tenant_request, tenant_scope
from support import FakeRuntime, fixture, stream_response

INPUT = (
    botocore.session.get_session()
    .get_service_model("bedrock-agent-runtime")
    .operation_model("AgenticRetrieveStream")
    .input_shape
)
KB, SOUTH_KB = "ABCDE12345", "FGHIJ67890"
STATE = state_file.parse(fixture("state.json"))
Q = "How many days do I have to return an opened AnySmartProduct-5?"


def kb_config(request: dict[str, Any], i: int = 0) -> dict[str, Any]:
    config: dict[str, Any] = request["retrievers"][i]["configuration"]["knowledgeBase"]
    return config


def filter_of(request: dict[str, Any], i: int = 0) -> Any:
    return kb_config(request, i).get("retrievalOverrides", {}).get("filter")


def test_every_call_graph_row_carries_the_filter_it_lists() -> None:
    req = tenant_request(STATE, "sales-region-north", None, "1")
    team = tenant_request(STATE, "team-support", None, "2")
    base_line, base_filter = tenant_scope("sales-region-central", None)
    f_shared, f_south = south_retriever_filters()
    rows: dict[str, tuple[dict[str, Any], list[Any]]] = {
        "ask without a tenant line": (
            build_request(
                question=Q,
                retrievers=[(KB, team.tenant_filter)],
                tenant_line=None,
                instruction_id=team.instruction_id,
                version=team.version,
            ),
            [filter_for(team="team-support")],
        ),
        "baseline": (
            build_request(question=Q, retrievers=[(KB, None)], tenant_line=None, instruction_id=None, version=None),
            [None],
        ),
        "baseline --tenant": (
            build_request(
                question=Q, retrievers=[(KB, base_filter)], tenant_line=base_line, instruction_id=None, version=None
            ),
            [filter_for(region="sales-region-central")],
        ),
        "isolation unfiltered": (
            build_request(
                question=Q,
                retrievers=[(KB, None)],
                tenant_line=req.tenant_line,
                instruction_id=req.instruction_id,
                version=req.version,
                generate_response=False,
            ),
            [None],
        ),
        "isolation filtered": (
            build_request(
                question=Q,
                retrievers=[(KB, req.tenant_filter)],
                tenant_line=req.tenant_line,
                instruction_id=req.instruction_id,
                version=req.version,
                generate_response=False,
            ),
            [filter_for(region="sales-region-north")],
        ),
        "multi-kb": (
            build_request(
                question=Q,
                retrievers=[(KB, f_shared), (SOUTH_KB, f_south)],
                tenant_line="Customer sales region: Sales Region South.",
                instruction_id="uvwxy12345",
                version="1",
            ),
            [f_shared, f_south],
        ),
    }
    for name, (request, filters) in rows.items():
        validate_parameters(request, INPUT)
        assert [filter_of(request, i) for i in range(len(filters))] == filters, name
    assert rows["isolation filtered"][0]["generateResponse"] is False
    assert "generateResponse" not in rows["baseline"][0]
    assert "retrievalInstructionConfiguration" not in rows["baseline"][0]


def test_both_senders_send_the_same_request_for_the_same_tenant_request() -> None:
    req = tenant_request(STATE, "team-support", "sales-region-north", "2")
    snippet, general = FakeRuntime("ask-team.json"), FakeRuntime("ask-team.json")
    ask_as_tenant(snippet, req, KB, Q)
    send_request(
        general,
        build_request(
            question=Q,
            retrievers=[(KB, req.tenant_filter)],
            tenant_line=req.tenant_line,
            instruction_id=req.instruction_id,
            version=req.version,
        ),
    )
    assert snippet.calls == general.calls
    validate_parameters(snippet.calls[0], INPUT)
    assert snippet.calls[0]["messages"][0]["content"]["text"] == f"Customer sales region: Sales Region North.\n{Q}"
    assert snippet.calls[0]["retrievalInstructionConfiguration"] == {
        "retrievalInstructionId": "fghij67890",
        "version": "2",
    }


def test_ask_as_tenant_refuses_no_tenant_line_or_draft() -> None:
    with pytest.raises(ValueError):
        ask_as_tenant(FakeRuntime(), tenant_request(STATE, "team-support", None, "1"), KB, Q)
    with pytest.raises(ValueError):
        ask_as_tenant(FakeRuntime(), tenant_request(STATE, "sales-region-north", None, "DRAFT"), KB, Q)


def test_draft_omits_the_version() -> None:
    req = tenant_request(STATE, "sales-region-north", None, "DRAFT")
    request = build_request(
        question=Q,
        retrievers=[(KB, req.tenant_filter)],
        tenant_line=req.tenant_line,
        instruction_id=req.instruction_id,
        version=req.version,
    )
    assert request["retrievalInstructionConfiguration"] == {"retrievalInstructionId": "abcde12345"}


def test_multi_kb_without_filters_differs_only_by_the_overrides() -> None:
    f_shared, f_south = south_retriever_filters()
    common: dict[str, Any] = {
        "question": Q,
        "tenant_line": "Customer sales region: Sales Region South.",
        "instruction_id": "uvwxy12345",
        "version": "1",
    }
    filtered = build_request(retrievers=[(KB, f_shared), (SOUTH_KB, f_south)], **common)
    unfiltered = build_request(retrievers=[(KB, None), (SOUTH_KB, None)], **common)
    for i in range(2):
        del kb_config(filtered, i)["retrievalOverrides"]
    assert filtered == unfiltered
    assert [kb_config(unfiltered, i)["knowledgeBaseId"] for i in range(2)] == [KB, SOUTH_KB]


def test_more_than_five_retrievers_is_refused() -> None:
    retrievers: list[tuple[str, TenantFilter | None]] = [(f"KB{i:08d}", None) for i in range(6)]
    with pytest.raises(ValueError):
        build_request(question=Q, retrievers=retrievers, tenant_line=None, instruction_id=None, version=None)


def test_read_stream_fills_every_field() -> None:
    result = read_stream(stream_response("ask-region.json"))
    assert result.applied == {"id": "klmno12345", "version": "1"}
    assert result.answer is not None and result.answer.endswith("Source: central-returns-addendum.md")
    assert result.response_text.startswith("Si compró")
    assert result.planning is not None and result.planning["message"] == "Agent planning started (devolución)"
    assert result.documents[0] == RetrievedDocument(
        "SpeculativeRetrieval", "docs/sales-region-central/central-returns-addendum.md", KB
    )
    assert [d.step for d in result.documents][-1] == "result"
    assert result.error is None


def test_an_empty_answer_is_none() -> None:
    result = read_stream(stream_response("empty-answer.json"))
    assert result.answer is None and result.response_text == "  "


def test_full_document_expansion_names_the_key_from_the_in_progress_message() -> None:
    result = read_stream(stream_response("full-document-expansion.json"))
    assert result.documents == [
        RetrievedDocument("FullDocumentExpansion", "docs/sales-region-north/north-returns-addendum.md", KB),
        RetrievedDocument("FullDocumentExpansion", None, KB),
    ]


def test_an_in_stream_exception_is_stored_with_the_exception_name() -> None:
    result = read_stream(stream_response("midstream-error.json"))
    assert result.error == ("AccessDeniedException", "The caller is not authorized to use this retrieval instruction.")
    assert result.applied == {"id": "fghij67890", "version": "1"}
    assert len(result.documents) == 1


def test_source_uri_keys() -> None:
    assert (
        key_from_source_uri("https://amzn-s3-demo-bucket.s3.amazonaws.com/docs/global/a%20b.md") == "docs/global/a b.md"
    )
    assert key_from_source_uri("https://s3.us-east-1.amazonaws.com/amzn-s3-demo-bucket/docs/global/x.md") == (
        "docs/global/x.md"
    )
    assert key_from_source_uri("https://amzn-s3-demo-bucket.s3.amazonaws.com/other/x.md") is None
    assert key_from_source_uri(None) is None
    assert key_from_expansion_message("Starting full document expansion for document: s3://b/docs/x.md") == "docs/x.md"
    assert key_from_expansion_message("Starting full document expansion") is None


def test_unknown_documents_fail_the_isolation_check() -> None:
    assert classify("docs/global/not-in-the-manifest.md", "sales-region-north").entitled == "unknown"
    assert classify(None, "sales-region-north").document == "unknown"
    unfiltered = read_stream(stream_response("isolation-unfiltered.json"))
    filtered = dataclasses.replace(
        read_stream(stream_response("isolation-filtered.json")),
        documents=[RetrievedDocument("Retrieval", "docs/global/not-in-the-manifest.md", KB)],
    )
    _, ok = format_isolation(
        tenant="sales-region-north", region=None, question=Q, unfiltered=unfiltered, filtered=filtered
    )
    assert not ok
    rows, outside, total = document_rows(filtered, "sales-region-north", None)
    assert (rows, outside, total) == ([["Retrieval", "unknown", "unknown", "unknown"]], 1, 1)


def test_isolation_passes_on_the_filtered_fixture() -> None:
    _, ok = format_isolation(
        tenant="sales-region-north",
        region=None,
        question=Q,
        unfiltered=read_stream(stream_response("isolation-unfiltered.json")),
        filtered=read_stream(stream_response("isolation-filtered.json")),
    )
    assert ok
