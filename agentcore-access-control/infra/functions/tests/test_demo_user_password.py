"""Tests for the custom resource that sets the demo user password."""

import logging
from typing import Any

import boto3
import demo_user_password
import pytest

SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo"
PASSWORD = "value-of-the-secret"


class FakeClients:
    """Records the Secrets Manager and Cognito calls of the handler."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, service: str) -> "FakeClients":
        return self

    def get_secret_value(self, **kwargs: Any) -> dict[str, str]:
        self.calls.append(("get_secret_value", kwargs))
        return {"SecretString": PASSWORD}

    def admin_set_user_password(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("admin_set_user_password", kwargs))
        return {}


@pytest.fixture
def clients(monkeypatch: pytest.MonkeyPatch) -> FakeClients:
    fake = FakeClients()
    monkeypatch.setattr(boto3, "client", fake)
    return fake


def _event(request_type: str) -> dict[str, Any]:
    return {
        "RequestType": request_type,
        "ResourceProperties": {
            "ServiceToken": "arn:aws:lambda:us-east-1:123456789012:function:p",
            "SecretArn": SECRET_ARN,
            "UserPoolId": "us-east-1_pool",
            "Usernames": ["user-a@example.com", "user-b@example.com"],
        },
    }


@pytest.mark.parametrize("request_type", ["Create", "Update"])
def test_sets_the_secret_value_as_permanent_password(
    clients: FakeClients, request_type: str
) -> None:
    result = demo_user_password.handler(_event(request_type), None)

    assert clients.calls == [
        ("get_secret_value", {"SecretId": SECRET_ARN}),
        *[
            (
                "admin_set_user_password",
                {
                    "UserPoolId": "us-east-1_pool",
                    "Username": username,
                    "Password": PASSWORD,
                    "Permanent": True,
                },
            )
            for username in ("user-a@example.com", "user-b@example.com")
        ],
    ]
    assert result == {"PhysicalResourceId": "demo-user-password"}


def test_delete_makes_no_calls(clients: FakeClients) -> None:
    result = demo_user_password.handler(_event("Delete"), None)

    assert clients.calls == []
    assert result == {"PhysicalResourceId": "demo-user-password"}


def test_does_not_log_or_return_the_password(
    clients: FakeClients, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        result = demo_user_password.handler(_event("Create"), None)

    assert PASSWORD not in caplog.text
    assert PASSWORD not in str(result)
