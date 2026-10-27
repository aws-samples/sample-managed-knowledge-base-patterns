"""Shared test helpers for the agent."""

import base64
import json
from typing import Any


def make_jwt(claims: dict[str, Any]) -> str:
    """Return an unsigned JWT with the given claims."""

    def segment(data: dict[str, Any]) -> str:
        raw = json.dumps(data).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{segment({'alg': 'RS256'})}.{segment(claims)}.signature"
