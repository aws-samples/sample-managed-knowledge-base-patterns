"""Cognito pre token generation trigger (event version V2_0).

Copies the user's email into the access token as the ``email`` claim. The
gateway request interceptor reads it to build ``userContext``, and AgentCore
Policy reads it as ``principal.getTag("email")``.

The claim is added only for verified emails. Without it, the interceptor
rejects tool calls and the Cedar policy does not match (fail closed).
"""

import logging
from typing import Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Entry point for the pre token generation V2_0 event.

    Args:
        event: Pre token generation V2_0 event.
        context: Lambda context (unused).

    Returns:
        The event with ``claimsAndScopeOverrideDetails`` set when the user
        has a verified email.
    """
    attributes = event.get("request", {}).get("userAttributes", {})
    email = attributes.get("email")
    verified = attributes.get("email_verified") == "true"
    if isinstance(email, str) and email and verified:
        event.setdefault("response", {})["claimsAndScopeOverrideDetails"] = {
            "accessTokenGeneration": {"claimsToAddOrOverride": {"email": email}}
        }
    logger.info(
        "triggerSource=%s emailClaimAdded=%s",
        event.get("triggerSource"),
        bool(email) and verified,
    )
    return event
