"""Tests for the response parsing helpers of the verification script."""

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import verify_defenses
from verify_defenses import (
    CANARY_A,
    CANARY_B,
    USER_A,
    USER_B,
    Response,
    Verifier,
    contains,
    judge_spoofed_turn,
    parse_messages,
)


def test_parses_json_bodies() -> None:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"content": []}})

    assert parse_messages(body) == [
        {"jsonrpc": "2.0", "id": 1, "result": {"content": []}}
    ]


def test_parses_server_sent_events() -> None:
    body = 'event: message\ndata: {"a": 1}\n\ndata: not json\ndata: {"b": 2}\n'

    assert parse_messages(body) == [{"a": 1}, {"b": 2}]


def test_detects_rejections() -> None:
    error = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000}})
    tool_error = json.dumps({"result": {"isError": True, "content": []}})
    success = json.dumps({"result": {"isError": False, "content": []}})

    assert Response(200, error).rejected()
    assert Response(200, tool_error).rejected()
    assert Response(403, "").rejected()
    assert not Response(200, success).rejected()


def test_reports_canaries() -> None:
    assert contains("code KINGFISHER-1101", "KINGFISHER-1101", "HAWKEAGLE-2202") == {
        "KINGFISHER-1101": True,
        "HAWKEAGLE-2202": False,
    }


def _stream(*events: dict[str, Any]) -> str:
    return "".join(f"data: {json.dumps(event)}\n\n" for event in events)


SPOOFED_CALL = {
    "type": "tool_use",
    "toolUseId": "t1",
    "name": "kb___Retrieve",
    "input": {"retrievalQuery": {"text": "plan"}, "userContext": {"userId": USER_B}},
}
OWN_RESULT = {
    "type": "tool_result",
    "toolUseId": "t1",
    "status": "success",
    "text": f"code {CANARY_A}",
    "sources": [],
}


def test_passes_when_the_spoofed_call_returns_no_user_b_document() -> None:
    body = _stream(SPOOFED_CALL, OWN_RESULT, {"type": "text", "data": "Not found."})

    passed, _ = judge_spoofed_turn(Response(200, body))

    assert passed is True


@pytest.mark.parametrize(
    "body",
    [
        _stream({"type": "error", "message": "The turn failed"}),
        _stream({"type": "text", "data": "I cannot search as another user."}),
        "",
        _stream(SPOOFED_CALL),
        _stream(SPOOFED_CALL, {**OWN_RESULT, "status": "error"}),
        _stream(
            {**SPOOFED_CALL, "input": {"retrievalQuery": {"text": "plan"}}},
            OWN_RESULT,
        ),
    ],
    ids=[
        "error only",
        "refusal",
        "empty stream",
        "no tool result",
        "tool error",
        "own identity",
    ],
)
def test_is_inconclusive_without_an_answered_spoofed_call(body: str) -> None:
    passed, detail = judge_spoofed_turn(Response(200, body))

    assert passed is None
    assert detail.startswith("inconclusive")


@pytest.mark.parametrize(
    "response",
    [
        Response(200, _stream({"type": "text", "data": f"The code is {CANARY_B}"})),
        Response(500, ""),
    ],
    ids=["user-b code leaked", "runtime failed"],
)
def test_fails_on_a_leak_or_a_failed_runtime_call(response: Response) -> None:
    passed, _ = judge_spoofed_turn(response)

    assert passed is False


def _tool_result(text: str, is_error: bool) -> Response:
    content = [{"type": "text", "text": text}]
    return Response(
        200, json.dumps({"result": {"content": content, "isError": is_error}})
    )


MASKED_DENIAL = _tool_result(
    "InternalServerException - An internal error occurred.", True
)
EXPLICIT_DENIAL = _tool_result(
    "DependencyFailedException - not authorized to perform: bedrock:Retrieve "
    "with an explicit deny in a resource-based policy",
    True,
)


@pytest.mark.parametrize(
    ("bypass", "control", "expected"),
    [
        (EXPLICIT_DENIAL, None, True),
        (MASKED_DENIAL, _tool_result(f"code {CANARY_A}", False), True),
        (MASKED_DENIAL, MASKED_DENIAL, None),
        (_tool_result(f"code {CANARY_B}", False), None, False),
        (_tool_result("no documents", False), None, False),
    ],
    ids=[
        "explicit denial",
        "masked denial, hardened gateway succeeds",
        "masked denial, hardened gateway fails",
        "user-b code leaked",
        "not rejected",
    ],
)
def test_judges_agentic_search_through_the_gateway_without_controls(
    monkeypatch: pytest.MonkeyPatch,
    bypass: Response,
    control: Response | None,
    expected: bool | None,
) -> None:
    calls: list[str] = []

    def agentic_retrieve(gateway_url: str, token: str, user_context: str) -> Response:
        calls.append(gateway_url)
        if gateway_url == "no-controls":
            return bypass
        assert control is not None, "unexpected call to the hardened gateway"
        return control

    monkeypatch.setattr(verify_defenses, "agentic_retrieve", agentic_retrieve)
    verifier = Verifier.__new__(Verifier)
    verifier.outputs = {"NoControlsGatewayUrl": "no-controls", "GatewayUrl": "hardened"}
    verifier.tokens = {USER_A: "token-a"}

    passed, _ = verifier.resource_policy_blocks_other_gateway_agentic()

    assert passed is expected
    assert calls == (
        ["no-controls"] if control is None else ["no-controls", "hardened"]
    )
