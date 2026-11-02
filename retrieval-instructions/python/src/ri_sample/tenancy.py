"""The filter boundary: the only module that builds a request filter for a tenant.

Every filter comes from a tenant key that the command line names and the spec files and the state file
confirm. No filter is read from user input or from the question text. `tenant_scope()` is the only caller
of `filter_for()`, and `tenant_scope()` and `south_retriever_filters()` are the only code outside
filters.py that calls `eq()` or creates a `TenantFilter`. The request builders accept a filter only as a
`TenantFilter`, so mypy rejects a plain dict. See SECURITY.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, NewType

from ri_sample.errors import UsageError
from ri_sample.filters import REGIONS, TEAMS, eq, filter_for, parse_cell
from ri_sample.labels import tenant_line
from ri_sample.specs import STRUCTURED_JSON_KEY, combined_specs, tenant_specs
from ri_sample.state import State

TenantFilter = NewType("TenantFilter", dict[str, Any])


@dataclass(frozen=True)
class TenantRequest:
    tenant: str  # spec key, for example "team-support" or "sales-region-north.team-support"
    instruction_id: str  # from the state file
    version: str | None  # None applies DRAFT: the request omits "version"
    tenant_line: str | None  # None for a team tenant without --region, and for structured-json
    tenant_filter: TenantFilter


def tenant_scope(tenant: str, region: str | None) -> tuple[str | None, TenantFilter]:
    """The tenant line and the filter for a tenant key, plus a region for a team tenant."""
    tenants = [spec.key for spec in tenant_specs()]
    combined = [spec.key for spec in combined_specs()]
    if tenant in tenants and tenant in REGIONS:
        if region is not None:
            raise UsageError("--region works only with a team tenant")
        return tenant_line(tenant), TenantFilter(filter_for(region=tenant))
    if tenant in tenants and tenant in TEAMS:
        if region is None:
            return None, TenantFilter(filter_for(team=tenant))
        if region not in REGIONS:
            raise UsageError(f"--region must be one of {', '.join(REGIONS)}")
        return tenant_line(region), TenantFilter(filter_for(region=region, team=tenant))
    if tenant in combined:
        if region is not None:
            raise UsageError("--region works only with a team tenant")
        cell_region, team = parse_cell(tenant)
        if cell_region is None or team is None:
            raise UsageError(f"{tenant} isn't a combined key")
        return tenant_line(cell_region), TenantFilter(filter_for(region=cell_region, team=team))
    if tenant == STRUCTURED_JSON_KEY and region is None:
        return None, TenantFilter(filter_for())
    raise UsageError(f"--tenant must be one of {', '.join(tenants)}, or a combined key: {', '.join(combined)}")


def tenant_request(state: State | None, tenant: str, region: str | None, version: str | None) -> TenantRequest:
    """The tenant's instruction from the state file, the version the caller chose, and its line and filter."""
    line, tenant_filter = tenant_scope(tenant, region)
    entry = state.instructions.get(tenant) if state else None
    if entry is None:
        hint = "run create-instructions --combined" if "." in tenant else "run create-instructions"
        raise UsageError(f"no instruction for {tenant} in sample-state.json; {hint} first")
    return TenantRequest(tenant, entry.id, None if version == "DRAFT" else version, line, tenant_filter)


def south_retriever_filters() -> tuple[TenantFilter, TenantFilter]:
    """Filters for sales-region-south across two knowledge bases: (shared, South).

    Their union selects exactly what `filter_for(region="sales-region-south")` selects on one knowledge base.
    """
    audience = eq("audience_team", "all")
    shared = TenantFilter({"andAll": [audience, eq("region", "global")]})
    south = TenantFilter({"andAll": [audience, eq("region", "sales-region-south")]})
    return shared, south
