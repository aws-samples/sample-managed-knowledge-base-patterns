"""Caller identity from the request headers forwarded by AgentCore Runtime.

AgentCore Runtime validates the bearer token with the Cognito discovery URL
and the allowed client ID before it invokes the agent, and forwards the
``Authorization`` header because it is in the runtime's request header
allowlist. The agent only decodes the token to key conversation history and
forwards the header to the gateway unchanged. Access control decisions are
made by the gateway and the knowledge base, never by this module.
"""

import base64
import binascii
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


class IdentityError(Exception):
    """Raised when the request carries no usable bearer token."""


@dataclass(frozen=True)
class Caller:
    """The authenticated caller of the current invocation.

    Attributes:
        access_token: The bearer token to forward to the gateway.
        subject: The ``sub`` claim of the token.
    """

    access_token: str
    subject: str


def caller_from_headers(headers: Mapping[str, str] | None) -> Caller:
    """Build the caller from the forwarded ``Authorization`` header.

    Args:
        headers: Request headers from the runtime request context.

    Returns:
        The caller with its access token and subject.

    Raises:
        IdentityError: If the header is missing, is not a bearer token, or
            the token has no ``sub`` claim.
    """
    value = next(
        (v for k, v in (headers or {}).items() if k.lower() == "authorization"),
        None,
    )
    if not value:
        raise IdentityError("Authorization header is missing")
    scheme, _, token = value.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise IdentityError("Authorization header is not a bearer token")
    subject = _decode_payload(token).get("sub")
    if not isinstance(subject, str) or not subject:
        raise IdentityError("Access token has no sub claim")
    return Caller(access_token=token, subject=subject)


def _decode_payload(token: str) -> dict[str, Any]:
    """Decode the JWT payload without verifying the signature."""
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (binascii.Error, ValueError):
        return {}
    return claims if isinstance(claims, dict) else {}
