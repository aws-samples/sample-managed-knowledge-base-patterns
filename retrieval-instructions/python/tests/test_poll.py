"""Waiting for the content review."""

from __future__ import annotations

from typing import Any

import pytest
from botocore.stub import Stubber

from ri_sample.poll import reasons, wait_for_review
from support import NOW, Clock, no_sleep

ID = "abcde12345"
ARN = f"arn:aws:bedrock:us-east-1:123456789012:retrieval-instruction/{ID}"
REASONS = [{"fieldName": "persona", "code": "CONTENT_FLAGGED", "message": "content flagged"}]


def get(status: str, transition: str, **extra: Any) -> dict[str, Any]:
    return {
        "retrievalInstructionId": ID,
        "retrievalInstructionArn": ARN,
        "name": "assistant-sales-region-north",
        "status": status,
        "lastTransitionStatus": transition,
        "createdAt": NOW,
        "updatedAt": NOW,
        **extra,
    }


def queue(stubber: Stubber, *responses: dict[str, Any]) -> None:
    for response in responses:
        stubber.add_response("get_retrieval_instruction", response, {"retrievalInstructionId": ID})


def test_polls_until_the_review_finishes(agent: tuple[Any, Stubber], capsys: pytest.CaptureFixture[str]) -> None:
    client, stubber = agent
    queue(stubber, get("INACTIVE", "CREATING"), get("INACTIVE", "CREATING"), get("ACTIVE", "CREATE_SUCCESSFUL"))
    review = wait_for_review(client, ID, sleep=no_sleep, clock=Clock())
    assert (review.status, review.transition, review.timed_out) == ("ACTIVE", "CREATE_SUCCESSFUL", False)
    assert "waiting for review: CREATING" in capsys.readouterr().err


def test_times_out(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    queue(stubber, get("INACTIVE", "UPDATING"), get("INACTIVE", "UPDATING"))
    review = wait_for_review(client, ID, timeout_s=3, sleep=no_sleep, clock=Clock(2.0))
    assert review.timed_out


def test_surfaces_the_reasons(agent: tuple[Any, Stubber]) -> None:
    client, stubber = agent
    queue(stubber, get("INACTIVE", "CREATE_FAILED", lastTransitionStatusReasons=REASONS))
    review = wait_for_review(client, ID, sleep=no_sleep, clock=Clock())
    assert reasons(review.final) == ["persona: CONTENT_FLAGGED: content flagged"]
