"""Tests for caller identity extraction."""

import pytest
from conftest import make_jwt

from kb_agent.identity import IdentityError, caller_from_headers


def test_returns_token_and_subject() -> None:
    token = make_jwt({"sub": "sub-a", "email": "user-a@example.com"})

    caller = caller_from_headers({"Authorization": f"Bearer {token}"})

    assert caller.access_token == token
    assert caller.subject == "sub-a"


def test_matches_header_name_case_insensitively() -> None:
    token = make_jwt({"sub": "sub-a"})

    caller = caller_from_headers({"authorization": f"bearer {token}"})

    assert caller.subject == "sub-a"


@pytest.mark.parametrize(
    "headers",
    [
        None,
        {},
        {"Authorization": ""},
        {"Authorization": "Basic abc"},
        {"Authorization": "Bearer "},
        {"Authorization": "Bearer not-a-jwt"},
        {"Authorization": f"Bearer {make_jwt({'email': 'user-a@example.com'})}"},
    ],
)
def test_rejects_headers_without_a_usable_token(
    headers: dict[str, str] | None,
) -> None:
    with pytest.raises(IdentityError):
        caller_from_headers(headers)
