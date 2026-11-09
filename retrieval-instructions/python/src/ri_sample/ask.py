"""AgenticRetrieveStream requests and the stream reader.

There are two senders. `ask_as_tenant()` is the post's snippet, for a request with a tenant line and a
pinned version. `send_request(build_request(...))` sends everything else. Both take a filter only as a
`TenantFilter` from tenancy.py, and both return a `StreamResult` from `read_stream()`.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from botocore.exceptions import EventStreamError

from ri_sample.corpus import key_from_expansion_message, key_from_source_uri
from ri_sample.tenancy import TenantFilter, TenantRequest

MAX_RETRIEVERS = 5


@dataclass(frozen=True)
class RetrievedDocument:
    step: str  # "SpeculativeRetrieval", "Retrieval", "FullDocumentExpansion", or "result"
    key: str | None  # S3 key such as "docs/global/global-returns-policy-v2-0.md"; None when the event names none
    retriever: str | None  # knowledge base ID that returned it; None when the event doesn't say


@dataclass
class StreamResult:
    applied: dict[str, str] | None = None  # appliedInstruction of the first Planning trace event
    answer: str | None = None  # result.generatedResponse.answer; None when absent or empty
    response_text: str = ""  # responseEvent.text chunks, joined in order
    documents: list[RetrievedDocument] = field(default_factory=list)  # in stream order
    error: tuple[str, str] | None = None  # (code, message) of an exception event raised mid-stream
    planning: dict[str, Any] | None = None  # attributes of the first Planning trace event, for ask --trace


def build_request(
    *,
    question: str,
    retrievers: Sequence[tuple[str, TenantFilter | None]],
    tenant_line: str | None,
    instruction_id: str | None,
    version: str | None,
    generate_response: bool = True,
) -> dict[str, Any]:
    """One request: the tenant line before the question, a filter per retriever, and the pinned instruction."""
    if not 1 <= len(retrievers) <= MAX_RETRIEVERS:
        raise ValueError(f"a request takes 1 to {MAX_RETRIEVERS} retrievers")
    text = f"{tenant_line}\n{question}" if tenant_line else question
    knowledge_base_ids = [kb for kb, _ in retrievers]
    request: dict[str, Any] = {
        "messages": [{"role": "user", "content": {"text": text}}],
        "retrievers": [{"configuration": {"knowledgeBase": {"knowledgeBaseId": kb}}} for kb in knowledge_base_ids],
        "agenticRetrieveConfiguration": {"foundationModelType": "MANAGED", "rerankingModelType": "MANAGED"},
    }
    for retriever, (_, tenant_filter) in zip(request["retrievers"], retrievers, strict=True):
        if tenant_filter is not None:
            retriever["configuration"]["knowledgeBase"]["retrievalOverrides"] = {"filter": tenant_filter}
    if instruction_id is not None:
        instruction_config = {"retrievalInstructionId": instruction_id}
        if version is not None:  # omit version for DRAFT
            instruction_config["version"] = version
        request["retrievalInstructionConfiguration"] = instruction_config
    if not generate_response:
        request["generateResponse"] = False
    return request


def send_request(runtime: Any, request: dict[str, Any]) -> StreamResult:
    response = runtime.agentic_retrieve_stream(**request)
    return read_stream(response)


def ask_as_tenant(runtime: Any, req: TenantRequest, knowledge_base_id: str, question: str) -> StreamResult:
    """Answer as the tenant: its instruction at the pinned version, its tenant line, and its filter."""
    tenant_filter, tenant_line = req.tenant_filter, req.tenant_line
    instruction_id, version = req.instruction_id, req.version
    if tenant_line is None or version is None:
        raise ValueError("ask_as_tenant needs a tenant line and a pinned version; use send_request(build_request())")
    knowledge_base = {"knowledgeBaseId": knowledge_base_id, "retrievalOverrides": {"filter": tenant_filter}}
    response = runtime.agentic_retrieve_stream(
        messages=[{"role": "user", "content": {"text": f"{tenant_line}\n{question}"}}],
        retrievers=[{"configuration": {"knowledgeBase": knowledge_base}}],
        agenticRetrieveConfiguration={"foundationModelType": "MANAGED", "rerankingModelType": "MANAGED"},
        # omit version for DRAFT
        retrievalInstructionConfiguration={"retrievalInstructionId": instruction_id, "version": version},
    )
    return read_stream(response)


def _collect(out: StreamResult, event: dict[str, Any], attrs: dict[str, Any]) -> None:
    """Record the documents a trace event or the result names, in stream order."""
    step = attrs.get("step")
    if step:
        for item in attrs.get("retrievalResponse") or []:
            uri = (item.get("metadata") or {}).get("_source_uri")
            retriever = (item.get("sourceRetriever") or {}).get("identifier")
            out.documents.append(RetrievedDocument(str(step), key_from_source_uri(uri), retriever))
        if step == "FullDocumentExpansion" and attrs.get("status") == "IN_PROGRESS":
            metadata = attrs.get("retrievalMetadata") or [{}]
            key = key_from_expansion_message(attrs.get("message"))
            out.documents.append(RetrievedDocument(str(step), key, metadata[0].get("identifier")))
    for item in event.get("result", {}).get("results") or []:
        uri = (item.get("metadata") or {}).get("_source_uri")
        retriever = (item.get("sourceRetriever") or {}).get("identifier")
        out.documents.append(RetrievedDocument("result", key_from_source_uri(uri), retriever))


def read_stream(response: Any) -> StreamResult:
    """Read the applied instruction, the answer, the documents, and any in-stream exception."""
    out = StreamResult()
    applied = answer = None
    try:
        for event in response["stream"]:
            attrs = event.get("traceEvent", {}).get("attributes", {})
            if attrs.get("step") == "Planning" and applied is None:
                applied = attrs.get("appliedInstruction")  # log with the tenant ID
            if "result" in event:
                answer = event["result"].get("generatedResponse", {}).get("answer")
            if attrs.get("step") == "Planning" and out.planning is None:
                out.planning = attrs
            if "responseEvent" in event:
                out.response_text += event["responseEvent"].get("text", "")
            _collect(out, event, attrs)
    except EventStreamError as err:
        error = err.response.get("Error", {})
        code = str(error.get("Code", ""))
        # botocore names the event (accessDeniedException); store the exception name (AccessDeniedException).
        out.error = (code[:1].upper() + code[1:], str(error.get("Message", "")))
    out.applied = applied
    out.answer = answer if isinstance(answer, str) and answer.strip() else None
    return out
