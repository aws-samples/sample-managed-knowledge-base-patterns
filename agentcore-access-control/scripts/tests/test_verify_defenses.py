"""Tests for the response parsing helpers of the verification script."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from verify_defenses import Response, contains, parse_messages


def test_parses_json_bodies() -> None:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"content": []}})

    assert parse_messages(body) == [
        {"jsonrpc": "2.0", "id": 1, "result": {"content": []}}
    ]


def test_parses_server_sent_events() -> None:
    body = 'event: message\ndata: {"a": 1}\n\ndata: not json\ndata: {"b": 2}\n'

    assert parse_messages(body) == [{"a": 1}, {"b": 2}]


def test_detects_rejections() -> None:
    error = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000}})
    tool_error = json.dumps({"result": {"isError": True, "content": []}})
    success = json.dumps({"result": {"isError": False, "content": []}})

    assert Response(200, error).rejected()
    assert Response(200, tool_error).rejected()
    assert Response(403, "").rejected()
    assert not Response(200, success).rejected()


def test_reports_canaries() -> None:
    assert contains("code KINGFISHER-1101", "KINGFISHER-1101", "HAWKEAGLE-2202") == {
        "KINGFISHER-1101": True,
        "HAWKEAGLE-2202": False,
    }
