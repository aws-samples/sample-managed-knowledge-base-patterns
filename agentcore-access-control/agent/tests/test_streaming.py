"""Tests for the conversion of Strands events to frontend events."""

import json

from kb_agent.streaming import MAX_RESULT_TEXT, extract_sources, to_ui_events


def test_converts_text_deltas() -> None:
    assert list(to_ui_events({"data": "Hello"})) == [{"type": "text", "data": "Hello"}]


def test_ignores_empty_and_unrelated_events() -> None:
    assert list(to_ui_events({"data": ""})) == []
    assert list(to_ui_events({"init_event_loop": True})) == []
    assert list(to_ui_events({"message": "not a message"})) == []


def test_converts_tool_use_with_the_arguments_the_llm_generated() -> None:
    tool_input = {
        "retrievalQuery": {"text": "plan code"},
        "userContext": {"userId": "user-b@example.com"},
    }
    event = {
        "message": {
            "role": "assistant",
            "content": [
                {"text": "Let me search."},
                {
                    "toolUse": {
                        "toolUseId": "t1",
                        "name": "kb___Retrieve",
                        "input": tool_input,
                    }
                },
            ],
        }
    }

    assert list(to_ui_events(event)) == [
        {
            "type": "tool_use",
            "toolUseId": "t1",
            "name": "kb___Retrieve",
            "input": tool_input,
        }
    ]


def test_converts_tool_results_with_sources() -> None:
    # Shape of a real Managed Knowledge Base Retrieve result: the S3 URI is in
    # documentId, and location.s3Location.uri is an HTTPS URL.
    def retrieval_result(name: str, text: str) -> dict[str, object]:
        return {
            "content": {"type": "TEXT", "text": text},
            "documentId": f"s3://amzn-s3-demo-bucket/documents/{name}",
            "location": {
                "type": "S3",
                "s3Location": {
                    "uri": f"https://bucket.s3.amazonaws.com/documents/{name}"
                },
            },
            "metadata": {"_document_title": name, "department": "d001"},
            "score": 0.28,
        }

    retrieve_response = {
        "retrievalResults": [
            retrieval_result(
                "dept-a-plan.txt", "Plan management code: KINGFISHER-1101"
            ),
            retrieval_result("shared-notice.txt", "Notice code: FALCON-3303"),
        ]
    }
    event = {
        "message": {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [{"text": json.dumps(retrieve_response)}],
                    }
                }
            ],
        }
    }

    (result,) = to_ui_events(event)

    assert result["type"] == "tool_result"
    assert result["toolUseId"] == "t1"
    assert result["status"] == "success"
    assert result["sources"] == [
        "s3://amzn-s3-demo-bucket/documents/dept-a-plan.txt",
        "s3://amzn-s3-demo-bucket/documents/shared-notice.txt",
    ]
    assert "KINGFISHER-1101" in result["text"]


def test_truncates_long_tool_results_and_reads_json_content() -> None:
    event = {
        "message": {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t2",
                        "status": "error",
                        "content": [{"json": {"error": "x" * (MAX_RESULT_TEXT * 2)}}],
                    }
                }
            ],
        }
    }

    (result,) = to_ui_events(event)

    assert result["status"] == "error"
    assert len(result["text"]) == MAX_RESULT_TEXT
    assert result["sources"] == []


def test_extracts_unique_sources_from_plain_text() -> None:
    text = (
        "see s3://amzn-s3-demo-bucket/a.txt and s3://amzn-s3-demo-bucket/a.txt,"
        " then 's3://amzn-s3-demo-bucket/c.txt'"
    )

    assert extract_sources(text) == [
        "s3://amzn-s3-demo-bucket/a.txt",
        "s3://amzn-s3-demo-bucket/c.txt",
    ]
