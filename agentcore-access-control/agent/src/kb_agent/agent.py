"""Strands agent that searches the knowledge base through AgentCore Gateway."""

from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient
from strands.types.content import Messages

SYSTEM_PROMPT = (
    "You are the internal assistant of AnyCompany, a fictional company. "
    "Answer questions about internal documents by searching the knowledge base "
    "with the available tools. Use the Retrieve tool for focused lookups and "
    "the AgenticRetrieveStream tool for questions that need several searches. "
    "Base your answer only on the documents that the tools return, and name "
    "the source documents. If the tools return no relevant documents, say that "
    "you could not find the information."
)


def gateway_mcp_client(gateway_url: str, access_token: str) -> MCPClient:
    """Create an MCP client that calls the gateway as the signed-in user.

    The user's access token is the only credential. The gateway verifies it,
    and its request interceptor derives ``userContext`` from it, so the agent
    never handles ``userContext`` itself.

    Args:
        gateway_url: The MCP endpoint of the gateway.
        access_token: The caller's access token, forwarded unchanged.

    Returns:
        An MCP client that is not started yet.
    """
    return MCPClient(
        url=gateway_url,
        headers={"Authorization": f"Bearer {access_token}"},
    )


def create_agent(mcp_client: MCPClient, model_id: str, messages: Messages) -> Agent:
    """Create the agent for one turn.

    Args:
        mcp_client: A started gateway MCP client.
        model_id: The Amazon Bedrock model or inference profile ID.
        messages: The conversation history of the caller's session.

    Returns:
        The agent with the gateway tools.
    """
    return Agent(
        model=BedrockModel(model_id=model_id),
        tools=mcp_client.list_tools_sync(),
        system_prompt=SYSTEM_PROMPT,
        messages=messages,
        callback_handler=None,
    )
