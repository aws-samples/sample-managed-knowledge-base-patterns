"""The filter boundary: every tenant's line and filter, the request from the state file, the South filters."""

from __future__ import annotations

from typing import Any

import pytest

from ri_sample import state as state_file
from ri_sample.errors import UsageError
from ri_sample.filters import filter_for, matches
from ri_sample.tenancy import south_retriever_filters, tenant_request, tenant_scope
from support import fixture

CASES: list[dict[str, Any]] = fixture("filters.json")
DOCS: list[dict[str, Any]] = fixture("..", "corpus", "manifest.json")["docs"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c['tenant']}+{c['region']}")
def test_tenant_scope_equals_the_fixture(case: dict[str, Any]) -> None:
    assert tenant_scope(case["tenant"], case["region"]) == (case["tenantLine"], case["filter"])


@pytest.mark.parametrize(
    ("tenant", "region"),
    [
        ("sales-region-north", "sales-region-south"),
        ("sales-region-north.team-support", "sales-region-north"),
        ("team-support", "sales-region-west"),
        ("structured-json", "sales-region-north"),
        ("team-engineering", None),
        ("sales-region-west", None),
    ],
)
def test_invalid_tenant_and_region_combinations_are_exit_2(tenant: str, region: str | None) -> None:
    with pytest.raises(UsageError):
        tenant_scope(tenant, region)


def test_tenant_request_reads_the_state_file_and_maps_draft() -> None:
    state = state_file.parse(fixture("state.json"))
    req = tenant_request(state, "team-support", "sales-region-north", "2")
    assert (req.instruction_id, req.version) == ("fghij67890", "2")
    assert req.tenant_line == "Customer sales region: Sales Region North."
    assert req.tenant_filter == filter_for(region="sales-region-north", team="team-support")
    assert tenant_request(state, "sales-region-north", None, "DRAFT").version is None


def test_tenant_request_without_an_instruction_is_exit_2() -> None:
    state = state_file.parse(fixture("state.json"))
    with pytest.raises(UsageError, match="run create-instructions first"):
        tenant_request(state, "sales-region-central", None, "1")
    with pytest.raises(UsageError, match="--combined"):
        tenant_request(None, "sales-region-north.team-support", None, "1")


def test_south_filters_together_select_what_the_single_knowledge_base_filter_selects() -> None:
    shared, south = south_retriever_filters()
    assert shared == {
        "andAll": [
            {"equals": {"key": "audience_team", "value": "all"}},
            {"equals": {"key": "region", "value": "global"}},
        ]
    }
    assert south["andAll"][1] == {"equals": {"key": "region", "value": "sales-region-south"}}
    single = filter_for(region="sales-region-south")
    for doc in DOCS:
        assert (matches(shared, doc) or matches(south, doc)) == matches(single, doc), doc["path"]
