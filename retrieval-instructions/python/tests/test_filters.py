"""Entitlements and filters for every cell and every manifest document."""

from __future__ import annotations

from typing import Any

import pytest

from ri_sample.filters import describe_filter, entitled, eq, filter_for, matches, parse_cell
from support import fixture

DOCS: list[dict[str, Any]] = fixture("..", "corpus", "manifest.json")["docs"]
CASES: list[dict[str, Any]] = fixture("filters.json")


def case_id(case: dict[str, Any]) -> str:
    return f"{case['tenant']}+{case['region']}" if case["region"] else case["tenant"]


@pytest.mark.parametrize("case", CASES, ids=case_id)
def test_filter_expresses_exactly_the_entitlement(case: dict[str, Any]) -> None:
    for doc in DOCS:
        assert matches(case["filter"], doc) == entitled(case["tenant"], doc, case["region"]), doc["path"]


@pytest.mark.parametrize("case", CASES, ids=case_id)
def test_filter_for_and_describe_filter_equal_the_fixture(case: dict[str, Any]) -> None:
    region, team = parse_cell(case["tenant"])
    assert filter_for(region=case["region"] or region, team=team) == case["filter"]
    assert describe_filter(case["filter"]) == case["describe"]


@pytest.mark.parametrize("case", CASES, ids=case_id)
def test_restricted_engineering_documents_are_never_entitled(case: dict[str, Any]) -> None:
    restricted = [d for d in DOCS if d["sensitivity"] == "restricted"]
    assert len(restricted) == 2
    assert not any(entitled(case["tenant"], d, case["region"]) for d in restricted)


def test_entitlement_rules() -> None:
    north = {"region": "sales-region-north", "audience_team": "all"}
    support_doc = {"region": "global", "audience_team": "team-support"}
    south_sales = {"region": "sales-region-south", "audience_team": "team-field-sales"}
    assert entitled("sales-region-north", north)
    assert not entitled("sales-region-central", north)
    assert not entitled("sales-region-north", support_doc)
    assert entitled("team-support", north) and entitled("team-support", support_doc)
    assert entitled("sales-region-south.team-field-sales", south_sales)
    assert not entitled("sales-region-north.team-field-sales", south_sales)
    assert not entitled("team-field-sales", south_sales, region="sales-region-north")
    assert entitled("structured-json", north) and not entitled("structured-json", support_doc)


def test_parse_cell() -> None:
    assert parse_cell("sales-region-south.team-field-sales") == ("sales-region-south", "team-field-sales")
    assert parse_cell("team-support") == (None, "team-support")
    assert parse_cell("sales-region-central") == ("sales-region-central", None)
    assert parse_cell("structured-json") == (None, None)


def test_filter_structure() -> None:
    assert filter_for() == eq("audience_team", "all")
    assert filter_for(team="team-support") == {
        "orAll": [eq("audience_team", "all"), eq("audience_team", "team-support")]
    }


def test_matches_rejects_unsupported_operators() -> None:
    with pytest.raises(ValueError):
        matches({"in": {"key": "region", "value": ["global"]}}, DOCS[0])


def test_describe_filter() -> None:
    assert describe_filter(None) == "none"
    assert describe_filter({"andAll": [eq("audience_team", "all"), eq("region", "global")]}) == (
        "audience_team = all; region = global"
    )
    with pytest.raises(ValueError):
        describe_filter({"orAll": [eq("region", "global"), eq("audience_team", "all")]})
