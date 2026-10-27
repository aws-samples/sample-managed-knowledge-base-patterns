"""AgentCore Gateway REQUEST interceptor that injects ``userContext``.

The gateway JWT authorizer verifies the access token (signature, expiration,
and client ID) before this function runs, and ``passRequestHeaders`` forwards
the verified ``Authorization`` header. The function reads the ``email`` claim
that the Cognito pre token generation trigger added to the token and
overwrites ``arguments.userContext`` of every ``tools/call`` request. Whatever
the MCP client or the LLM put in ``userContext`` never reaches the knowledge
base.

Requests that cannot be attributed to a verified email are rejected with a
JSON-RPC error (fail closed). AgentCore Policy evaluates the transformed
request afterwards and denies it if ``userContext.userId`` still differs from
the token's ``email`` claim.
"""

import base64
import binascii
import json
import logging
from typing import Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

INTERCEPTOR_OUTPUT_VERSION = "1.0"


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Entry point for interceptor input version 1.0.

    Args:
        event: Interceptor input with ``mcp.gatewayRequest``.
        context: Lambda context (unused).

    Returns:
        ``transformedGatewayRequest`` with the injected ``userContext``, or
        ``transformedGatewayResponse`` with a 403 JSON-RPC error.
    """
    gateway_request = event.get("mcp", {}).get("gatewayRequest", {})
    body = gateway_request.get("body") or {}
    if not (isinstance(body, dict) and body.get("method") == "tools/call"):
        return _pass_through(body)

    # The JWT authorizer already verified the token, so decoding is enough.
    token = _bearer_token(gateway_request.get("headers") or {})
    email = _email_from_token(token) if token else None
    if not email:
        logger.warning("Rejected tools/call: no verified email claim")
        return _error_response("Access token has no email claim", body)

    params = body.setdefault("params", {})
    if not isinstance(params, dict):
        return _error_response("Invalid tools/call params", body)
    args = params.setdefault("arguments", {})
    if not isinstance(args, dict):
        return _error_response("Invalid tools/call arguments", body)

    supplied = args.get("userContext")
    # Always overwrite the value sent by the client or the agent.
    args["userContext"] = {"userId": email}
    logger.info(
        json.dumps(
            {
                "tool": params.get("name"),
                "userContextSupplied": supplied is not None,
                # True when the client or the LLM asked for another identity.
                "userContextReplaced": supplied is not None
                and supplied != args["userContext"],
            }
        )
    )
    return _pass_through(body)


def _bearer_token(headers: dict[str, Any]) -> str | None:
    """Return the bearer token from the ``Authorization`` header, if any."""
    value = next((v for k, v in headers.items() if k.lower() == "authorization"), None)
    if not isinstance(value, str):
        return None
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def _email_from_token(token: str) -> str | None:
    """Return the ``email`` claim of a verified access token, or None.

    Only access tokens are accepted. Cognito ID tokens always carry the
    ``email`` attribute, verified or not, while the pre token generation
    trigger adds ``email`` to access tokens only for verified addresses.
    """
    claims = _decode_payload(token)
    if not claims or claims.get("token_use") != "access":
        return None
    email = claims.get("email")
    return email if isinstance(email, str) and email else None


def _decode_payload(token: str) -> dict[str, Any] | None:
    """Decode the JWT payload without verifying the signature."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (binascii.Error, ValueError):
        return None
    return claims if isinstance(claims, dict) else None


def _pass_through(body: Any) -> dict[str, Any]:
    """Forward the (possibly transformed) request body to the target."""
    return {
        "interceptorOutputVersion": INTERCEPTOR_OUTPUT_VERSION,
        "mcp": {"transformedGatewayRequest": {"body": body}},
    }


def _error_response(message: str, body: dict[str, Any]) -> dict[str, Any]:
    """Return a 403 JSON-RPC error instead of calling the target."""
    return {
        "interceptorOutputVersion": INTERCEPTOR_OUTPUT_VERSION,
        "mcp": {
            "transformedGatewayResponse": {
                "statusCode": 403,
                "headers": {"Content-Type": "application/json"},
                "body": {
                    "jsonrpc": "2.0",
                    "id": body.get("id"),
                    "error": {"code": -32000, "message": message},
                },
            }
        },
    }
