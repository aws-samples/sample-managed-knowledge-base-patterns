"""Tests for the runtime entry point."""

from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import MagicMock

import pytest
from bedrock_agentcore.runtime import RequestContext
from conftest import make_jwt

from kb_agent import app as app_module
from kb_agent.sessions import ConversationStore

pytestmark = pytest.mark.asyncio


class FakeAgent:
    """Agent stand-in that streams fixed events."""

    def __init__(self, events: list[dict[str, Any]], messages: list[Any]) -> None:
        self._events = events
        self.messages = messages
        self.prompts: list[str] = []

    async def stream_async(self, prompt: str) -> AsyncIterator[dict[str, Any]]:
        self.prompts.append(prompt)
        self.messages = [
            *self.messages,
            {"role": "user", "content": [{"text": prompt}]},
        ]
        for event in self._events:
            yield event


async def _collect(payload: dict[str, Any], context: RequestContext) -> list[Any]:
    return [event async for event in app_module.invoke(payload, context)]


def _context(sub: str = "sub-a", session_id: str = "session-1") -> RequestContext:
    token = make_jwt({"sub": sub})
    return RequestContext(
        session_id=session_id,
        request_headers={"Authorization": f"Bearer {token}"},
        request=None,
    )


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    monkeypatch.setenv("GATEWAY_URL", "https://gateway.example.com/mcp")
    monkeypatch.setenv("MODEL_ID", "model")
    monkeypatch.setattr(app_module, "conversations", ConversationStore())
    state: dict[str, Any] = {"tokens": [], "histories": []}

    def gateway_mcp_client(url: str, token: str) -> MagicMock:
        state["tokens"].append(token)
        return MagicMock()

    def create_agent(client: Any, model_id: str, messages: list[Any]) -> FakeAgent:
        state["histories"].append(messages)
        return FakeAgent([{"data": "answer"}], messages)

    monkeypatch.setattr(app_module, "gateway_mcp_client", gateway_mcp_client)
    monkeypatch.setattr(app_module, "create_agent", create_agent)
    return state


async def test_streams_events_and_forwards_the_callers_token(
    fake: dict[str, Any],
) -> None:
    context = _context()

    events = await _collect({"prompt": "hi"}, context)

    assert events == [{"type": "text", "data": "answer"}]
    assert context.request_headers is not None
    assert [f"Bearer {t}" for t in fake["tokens"]] == [
        context.request_headers["Authorization"]
    ]


async def test_keeps_history_per_subject_and_session(fake: dict[str, Any]) -> None:
    await _collect({"prompt": "first"}, _context("sub-a"))
    await _collect({"prompt": "second"}, _context("sub-a"))
    await _collect({"prompt": "other"}, _context("sub-b"))

    first, second, other = fake["histories"]
    assert first == []
    assert second == [{"role": "user", "content": [{"text": "first"}]}]
    assert other == []


async def test_rejects_missing_prompt(fake: dict[str, Any]) -> None:
    events = await _collect({}, _context())

    assert events == [{"type": "error", "message": "The request has no prompt."}]
    assert fake["tokens"] == []


async def test_rejects_missing_token(fake: dict[str, Any]) -> None:
    events = await _collect(
        {"prompt": "hi"},
        RequestContext(session_id="s", request_headers=None, request=None),
    )

    assert events == [
        {"type": "error", "message": "The request has no valid access token."}
    ]
    assert fake["tokens"] == []


async def test_hides_internal_errors(
    fake: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    def failing_agent(*args: Any) -> FakeAgent:
        raise RuntimeError("secret detail")

    monkeypatch.setattr(app_module, "create_agent", failing_agent)

    events = await _collect({"prompt": "hi"}, _context())

    assert events == [
        {"type": "error", "message": "The agent could not complete the request."}
    ]
