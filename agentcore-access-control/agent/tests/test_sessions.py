"""Tests for the conversation store."""

from strands.types.content import Messages

from kb_agent.sessions import ConversationStore


def _messages(text: str) -> Messages:
    return [{"role": "user", "content": [{"text": text}]}]


def test_history_is_scoped_to_the_subject() -> None:
    store = ConversationStore()
    store.put("sub-a", "session-1", _messages("from user-a"))

    assert store.get("sub-a", "session-1") == _messages("from user-a")
    assert store.get("sub-b", "session-1") == []


def test_returns_copies() -> None:
    store = ConversationStore()
    store.put("sub-a", "session-1", _messages("original"))

    store.get("sub-a", "session-1")[0]["content"].append({"text": "changed"})

    assert store.get("sub-a", "session-1") == _messages("original")


def test_drops_least_recently_used_conversation() -> None:
    store = ConversationStore(max_conversations=2)
    store.put("sub-a", "s1", _messages("1"))
    store.put("sub-a", "s2", _messages("2"))
    store.get("sub-a", "s1")
    store.put("sub-a", "s3", _messages("3"))

    assert store.get("sub-a", "s1") == _messages("1")
    assert store.get("sub-a", "s2") == []
    assert store.get("sub-a", "s3") == _messages("3")
