"""Convert Strands stream events into the event stream the frontend reads.

The frontend receives a small, framework independent set of events instead of
raw Strands events:

- ``{"type": "text", "data": str}``: a text delta of the answer
- ``{"type": "tool_use", "toolUseId": str, "name": str, "input": Any}``: the
  tool arguments that the LLM generated, before the gateway interceptor
  overwrites ``userContext``
- ``{"type": "tool_result", "toolUseId": str, "status": str, "text": str,
  "sources": list[str]}``: what the gateway returned
- ``{"type": "error", "message": str}``: the turn failed
"""

import json
import re
from collections.abc import Iterator, Mapping
from typing import Any

MAX_RESULT_TEXT = 4000
_S3_URI = re.compile(r"s3://[^\s\"'\\,}\]]+")


def to_ui_events(event: Mapping[str, Any]) -> Iterator[dict[str, Any]]:
    """Yield frontend events for one Strands stream event.

    Args:
        event: An event from ``Agent.stream_async``.

    Yields:
        Zero or more frontend events.
    """
    data = event.get("data")
    if isinstance(data, str) and data:
        yield {"type": "text", "data": data}
        return

    message = event.get("message")
    if not isinstance(message, Mapping):
        return
    for block in message.get("content") or []:
        if not isinstance(block, Mapping):
            continue
        tool_use = block.get("toolUse")
        if isinstance(tool_use, Mapping):
            yield {
                "type": "tool_use",
                "toolUseId": tool_use.get("toolUseId"),
                "name": tool_use.get("name"),
                "input": tool_use.get("input"),
            }
        tool_result = block.get("toolResult")
        if isinstance(tool_result, Mapping):
            text = _result_text(tool_result.get("content") or [])
            yield {
                "type": "tool_result",
                "toolUseId": tool_result.get("toolUseId"),
                "status": tool_result.get("status", "success"),
                "text": text[:MAX_RESULT_TEXT],
                "sources": extract_sources(text),
            }


def error_event(message: str) -> dict[str, Any]:
    """Return a frontend error event.

    Args:
        message: A message that is safe to show to the user.

    Returns:
        The error event.
    """
    return {"type": "error", "message": message}


def extract_sources(text: str) -> list[str]:
    """Return the unique S3 URIs of the documents cited in a tool result.

    Managed Knowledge Base results carry the document as ``documentId``
    (``s3://bucket/key``), while ``location.s3Location.uri`` is an HTTPS URL,
    so matching ``s3://`` yields one URI per document.

    Args:
        text: The tool result text, usually a JSON document.

    Returns:
        S3 URIs in order of first appearance.
    """
    return list(dict.fromkeys(_S3_URI.findall(text)))


def _result_text(content: list[Any]) -> str:
    """Join the text and JSON parts of a tool result."""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, Mapping):
            continue
        if isinstance(item.get("text"), str):
            parts.append(item["text"])
        elif "json" in item:
            parts.append(json.dumps(item["json"], ensure_ascii=False))
    return "\n".join(parts)
