"""Tests for the userContext request interceptor."""

import base64
import json
from typing import Any

import interceptor
import pytest


def _jwt(claims: dict[str, Any]) -> str:
    def segment(data: dict[str, Any]) -> str:
        raw = json.dumps(data).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{segment({'alg': 'RS256'})}.{segment(claims)}.signature"


def _event(body: Any, headers: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "interceptorInputVersion": "1.0",
        "mcp": {"gatewayRequest": {"headers": headers or {}, "body": body}},
    }


def _tools_call(arguments: Any) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/call",
        "params": {"name": "kb___Retrieve", "arguments": arguments},
    }


def _auth(
    email: str | None = "user-a@example.com", token_use: str = "access"
) -> dict[str, str]:
    claims: dict[str, Any] = {
        "sub": "sub-a",
        "client_id": "client",
        "token_use": token_use,
    }
    if email is not None:
        claims["email"] = email
    return {"Authorization": f"Bearer {_jwt(claims)}"}


def _forwarded_body(result: dict[str, Any]) -> dict[str, Any]:
    body = result["mcp"]["transformedGatewayRequest"]["body"]
    assert isinstance(body, dict)
    return body


def _error(result: dict[str, Any]) -> dict[str, Any]:
    response = result["mcp"]["transformedGatewayResponse"]
    assert response["statusCode"] == 403
    body = response["body"]
    assert isinstance(body, dict)
    return body


def test_overwrites_spoofed_user_context_with_token_email() -> None:
    body = _tools_call(
        {
            "retrievalQuery": {"text": "plan code"},
            "userContext": {"userId": "user-b@example.com"},
        }
    )

    result = interceptor.handler(_event(body, _auth()), None)

    args = _forwarded_body(result)["params"]["arguments"]
    assert args["userContext"] == {"userId": "user-a@example.com"}
    assert args["retrievalQuery"] == {"text": "plan code"}


def test_injects_user_context_when_missing() -> None:
    result = interceptor.handler(_event(_tools_call({}), _auth()), None)

    args = _forwarded_body(result)["params"]["arguments"]
    assert args == {"userContext": {"userId": "user-a@example.com"}}


def test_creates_arguments_when_params_have_none() -> None:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {}}

    result = interceptor.handler(_event(body, _auth()), None)

    args = _forwarded_body(result)["params"]["arguments"]
    assert args == {"userContext": {"userId": "user-a@example.com"}}


def test_reads_authorization_header_case_insensitively() -> None:
    headers = {"authorization": _auth()["Authorization"]}

    result = interceptor.handler(_event(_tools_call({}), headers), None)

    args = _forwarded_body(result)["params"]["arguments"]
    assert args["userContext"] == {"userId": "user-a@example.com"}


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": ""},
        {"Authorization": "Basic dXNlcjpwYXNz"},
        {"Authorization": "Bearer "},
        {"Authorization": "Bearer not-a-jwt"},
        {"Authorization": "Bearer a.%%%.c"},
    ],
)
def test_rejects_requests_without_a_usable_token(headers: dict[str, str]) -> None:
    result = interceptor.handler(_event(_tools_call({}), headers), None)

    error = _error(result)
    assert error["id"] == 7
    assert error["error"]["message"] == "Access token has no email claim"


@pytest.mark.parametrize("email", [None, ""])
def test_rejects_tokens_without_email_claim(email: str | None) -> None:
    result = interceptor.handler(_event(_tools_call({}), _auth(email)), None)

    _error(result)


def test_rejects_id_tokens_even_with_an_email_claim() -> None:
    headers = _auth(token_use="id")

    result = interceptor.handler(_event(_tools_call({}), headers), None)

    _error(result)


def test_rejects_non_object_arguments() -> None:
    result = interceptor.handler(_event(_tools_call(["x"]), _auth()), None)

    assert _error(result)["error"]["message"] == "Invalid tools/call arguments"


def test_rejects_non_object_params() -> None:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": "x"}

    result = interceptor.handler(_event(body, _auth()), None)

    assert _error(result)["error"]["message"] == "Invalid tools/call params"


@pytest.mark.parametrize("method", ["initialize", "tools/list", "ping"])
def test_passes_other_methods_through_unchanged(method: str) -> None:
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": {}}

    result = interceptor.handler(_event(body), None)

    assert _forwarded_body(result) == body
    assert result["interceptorOutputVersion"] == "1.0"


def test_passes_notifications_without_body_through() -> None:
    result = interceptor.handler(_event(None), None)

    assert result["mcp"]["transformedGatewayRequest"]["body"] == {}


@pytest.mark.parametrize(
    ("user_context", "supplied", "replaced"),
    [
        ({"userId": "user-b@example.com"}, True, True),
        ({"userId": "user-a@example.com"}, True, False),
        (None, False, False),
    ],
)
def test_logs_whether_a_different_identity_was_requested(
    caplog: pytest.LogCaptureFixture,
    user_context: dict[str, str] | None,
    supplied: bool,
    replaced: bool,
) -> None:
    arguments = {} if user_context is None else {"userContext": user_context}
    with caplog.at_level("INFO"):
        interceptor.handler(_event(_tools_call(arguments), _auth()), None)

    record = json.loads(caplog.records[-1].getMessage())
    assert record == {
        "tool": "kb___Retrieve",
        "userContextSupplied": supplied,
        "userContextReplaced": replaced,
    }
    assert "user-a@example.com" not in caplog.text
