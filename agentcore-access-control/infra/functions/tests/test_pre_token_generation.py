"""Tests for the pre token generation trigger."""

from typing import Any

import pre_token_generation
import pytest


def _event(attributes: dict[str, str]) -> dict[str, Any]:
    return {
        "version": "2",
        "triggerSource": "TokenGeneration_HostedAuth",
        "request": {"userAttributes": attributes},
        "response": {"claimsAndScopeOverrideDetails": None},
    }


def test_adds_verified_email_to_access_token() -> None:
    event = _event({"email": "user-a@example.com", "email_verified": "true"})

    result = pre_token_generation.handler(event, None)

    assert result["response"]["claimsAndScopeOverrideDetails"] == {
        "accessTokenGeneration": {
            "claimsToAddOrOverride": {"email": "user-a@example.com"}
        }
    }


@pytest.mark.parametrize(
    "attributes",
    [
        {"email": "user-a@example.com", "email_verified": "false"},
        {"email": "user-a@example.com"},
        {"email": "", "email_verified": "true"},
        {"email_verified": "true"},
    ],
)
def test_does_not_add_unverified_or_missing_email(attributes: dict[str, str]) -> None:
    result = pre_token_generation.handler(_event(attributes), None)

    assert result["response"]["claimsAndScopeOverrideDetails"] is None
