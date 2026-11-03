"""Every formatter against test-fixtures/expected/*.txt. The TypeScript tests read the same files."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from ri_sample import state as state_file
from ri_sample.abac import Check
from ri_sample.ask import StreamResult, read_stream
from ri_sample.cloudtrail import Lookup, lookup
from ri_sample.formats import (
    TeardownOutcome,
    format_answer,
    format_cloudtrail,
    format_create,
    format_isolation,
    format_multi_kb,
    format_release_route,
    format_release_show,
    format_status,
    format_structured_json,
    format_support_v2,
    format_teardown_line,
    format_teardown_plan,
    format_teardown_summary,
    format_verify_abac,
)
from ri_sample.instructions import Candidate
from ri_sample.labels import tenant_line
from support import FIXTURES, NOW, FakeCloudTrail, fixture, stream_response

CASES = sorted(p.stem for p in (FIXTURES / "expected").glob("*.txt"))


def stream(name: str) -> StreamResult:
    return read_stream(stream_response(name))


def render(inp: dict[str, Any]) -> str:
    command = inp["command"]
    if command in ("ask", "baseline"):
        return format_answer(
            tenant=inp["tenant"],
            instruction=inp.get("instruction"),
            version=inp.get("version"),
            request_index=inp.get("requestIndex"),
            trace=inp.get("trace", False),
            tenant_line=inp["tenantLine"],
            tenant_filter=inp["filter"],
            question=inp["question"],
            result=stream(inp["stream"]),
        )
    if command == "isolation":
        text, _ = format_isolation(
            tenant=inp["tenant"],
            region=None,
            question=inp["question"],
            unfiltered=stream(inp["unfiltered"]),
            filtered=stream(inp["filtered"]),
        )
        return text
    if command == "multi-kb":
        text, _ = format_multi_kb(
            instruction=inp["instruction"],
            version=inp["version"],
            shared_id=inp["sharedKnowledgeBaseId"],
            south_id=inp["southKnowledgeBaseId"],
            shared_filter=inp["sharedFilter"],
            south_filter=inp["southFilter"],
            tenant_line=tenant_line("sales-region-south"),
            question=inp["question"],
            result=stream(inp["stream"]),
        )
        return text
    if command == "structured-json":
        text, _ = format_structured_json(
            instruction=inp["instruction"],
            version=inp["version"],
            tenant_filter=inp["filter"],
            question=inp["question"],
            result=stream(inp["stream"]),
        )
        return text
    if command == "status":
        return format_status(inp)
    if command == "create-instructions":
        return format_create(inp)
    if command == "support-v2":
        return format_support_v2(inp)
    if command in ("release-show", "release-route", "cloudtrail"):
        recorded = state_file.load(FIXTURES / inp["state"])
        assert recorded is not None
        if command == "release-show":
            return format_release_show(recorded)
        if command == "release-route":
            return format_release_route(inp["tenant"], recorded.release[inp["tenant"]], inp["requests"])
        id_to_key = {e.id: key for key, e in recorded.instructions.items()}
        rows, streams = lookup(Lookup(FakeCloudTrail(inp["pages"]), lambda _: None), id_to_key, inp["since"], NOW)
        return format_cloudtrail(inp["since"], rows, streams)
    if command == "verify-abac":
        checks = [Check(c["role"], c["action"], c["expected"], c["observed"]) for c in inp["checks"]]
        return format_verify_abac(inp["tenant"], inp["other"], checks)
    if command == "teardown-plan":
        cands = [
            Candidate(None, c["name"], c["id"], "arn", c["versions"], c["action"], c["reason"])
            for c in inp["candidates"]
        ]
        return format_teardown_plan(cands)
    if command == "teardown":
        outcomes = [TeardownOutcome(o["name"], o["result"], tuple(o["versions"]), o["reason"]) for o in inp["outcomes"]]
        lines = "".join(format_teardown_line(o) for o in outcomes)
        return lines + format_teardown_summary(outcomes, inp["stateFileRemoved"])
    raise AssertionError(f"no formatter for {command}")


@pytest.mark.parametrize("case", CASES)
def test_formatter_output_equals_the_expected_file(case: str) -> None:
    expected = (FIXTURES / "expected" / f"{case}.txt").read_text(encoding="utf-8")
    assert render(fixture("inputs", f"{case}.json")) == expected


def test_every_expected_file_has_an_input_file() -> None:
    inputs = sorted(p.stem for p in Path(FIXTURES / "inputs").glob("*.json"))
    assert inputs == CASES
    assert len(CASES) == 21
