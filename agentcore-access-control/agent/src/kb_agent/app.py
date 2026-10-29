"""AgentCore Runtime entry point."""

import logging
import os
from collections.abc import AsyncIterator
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext

from kb_agent.agent import create_agent, gateway_mcp_client
from kb_agent.identity import IdentityError, caller_from_headers
from kb_agent.sessions import ConversationStore
from kb_agent.streaming import error_event, to_ui_events

logger = logging.getLogger(__name__)

app = BedrockAgentCoreApp()
conversations = ConversationStore()


@app.entrypoint
async def invoke(
    payload: dict[str, Any], context: RequestContext
) -> AsyncIterator[dict[str, Any]]:
    """Run one conversation turn and stream frontend events.

    Args:
        payload: The request body, ``{"prompt": str}``.
        context: The runtime request context with the forwarded headers.

    Yields:
        Frontend events (see ``kb_agent.streaming``).
    """
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        yield error_event("The request has no prompt.")
        return
    try:
        caller = caller_from_headers(context.request_headers)
    except IdentityError:
        logger.warning("Rejected invocation without a usable bearer token")
        yield error_event("The request has no valid access token.")
        return

    session_id = context.session_id or ""
    history = conversations.get(caller.subject, session_id)
    mcp_client = gateway_mcp_client(os.environ["GATEWAY_URL"], caller.access_token)
    try:
        with mcp_client:
            agent = create_agent(mcp_client, os.environ["MODEL_ID"], history)
            async for event in agent.stream_async(prompt):
                for ui_event in to_ui_events(event):
                    yield ui_event
            conversations.put(caller.subject, session_id, agent.messages)
    except Exception:
        logger.exception("Agent turn failed")
        yield error_event("The agent could not complete the request.")
