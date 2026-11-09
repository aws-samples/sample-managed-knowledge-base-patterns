"""Errors the commands raise, each with its exit code.

Exit codes: 0 success, 1 a check the command performs failed, 2 a usage error or a guard refused,
3 an AWS error that isn't a check result (including credential and network errors).
"""

from __future__ import annotations

from typing import Any


class SampleError(Exception):
    """An error the CLI prints as one `error: ...` line on stderr before it exits."""

    exit_code = 3

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class CheckFailed(SampleError):
    """A check the command performs failed (exit 1)."""

    exit_code = 1


class UsageError(SampleError):
    """A bad option, a refused guard, or a missing prerequisite (exit 2)."""

    exit_code = 2


class AwsError(SampleError):
    """An AWS error that isn't a check result (exit 3)."""

    exit_code = 3

    def __init__(self, code: str, message: str, request_id: str | None = None, hint: str | None = None) -> None:
        text = f"{code}: {message}"
        if request_id:
            text += f" (request ID {request_id})"
        if hint:
            text += f". {hint}"
        super().__init__(text)
        self.code = code
        self.request_id = request_id


def error_code(err: Any) -> str:
    """The error code of a botocore ClientError, or an empty string."""
    response = getattr(err, "response", None) or {}
    return str(response.get("Error", {}).get("Code", ""))


def aws_error(err: Any, hint: str | None = None) -> AwsError:
    """Convert a botocore ClientError into an AwsError with its code, message, and request ID."""
    response = getattr(err, "response", None) or {}
    error = response.get("Error", {})
    request_id = response.get("ResponseMetadata", {}).get("RequestId")
    return AwsError(str(error.get("Code", "Error")), str(error.get("Message", err)), request_id, hint)
