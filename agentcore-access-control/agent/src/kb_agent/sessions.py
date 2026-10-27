"""In-memory conversation history scoped to the token subject.

The client chooses the runtime session ID, so history is keyed by the
``sub`` claim of the validated token as well. A caller who reuses another
user's session ID starts an empty conversation instead of receiving that
user's retrieved content.
"""

import copy
from collections import OrderedDict

from strands.types.content import Messages


class ConversationStore:
    """Least recently used store of conversation messages."""

    def __init__(self, max_conversations: int = 32) -> None:
        """Create an empty store.

        Args:
            max_conversations: Number of conversations to keep before the
                least recently used one is dropped.
        """
        self._max = max_conversations
        self._items: OrderedDict[tuple[str, str], Messages] = OrderedDict()

    def get(self, subject: str, session_id: str) -> Messages:
        """Return a copy of the messages of a conversation.

        Args:
            subject: The ``sub`` claim of the caller's token.
            session_id: The runtime session ID.

        Returns:
            The stored messages, or an empty list for a new conversation.
        """
        key = (subject, session_id)
        if key not in self._items:
            return []
        self._items.move_to_end(key)
        return copy.deepcopy(self._items[key])

    def put(self, subject: str, session_id: str, messages: Messages) -> None:
        """Store the messages of a conversation.

        Args:
            subject: The ``sub`` claim of the caller's token.
            session_id: The runtime session ID.
            messages: The full message history after the latest turn.
        """
        key = (subject, session_id)
        self._items[key] = copy.deepcopy(messages)
        self._items.move_to_end(key)
        while len(self._items) > self._max:
            self._items.popitem(last=False)
