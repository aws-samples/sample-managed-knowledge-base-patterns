"""Text formatters for every command. Both languages produce the same bytes (test-fixtures/expected/).

Values are filled in from the command's results; answers print verbatim. Tables use output.table().
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ri_sample.abac import Check
from ri_sample.ask import StreamResult
from ri_sample.cloudtrail import CallRow
from ri_sample.corpus import UNKNOWN, classify
from ri_sample.deployment import STACK_NAME
from ri_sample.filters import describe_filter
from ri_sample.instructions import Candidate
from ri_sample.output import dumps_compact, plural, table, versions_text
from ri_sample.release import ReleaseConfig, canary_text, describe_release, version_for
from ri_sample.state import State
from ri_sample.structured_json import ANSWER_KEYS, validate_reply


def applied_text(applied: Mapping[str, Any] | None) -> str:
    if not applied:
        return "none"
    return f"{applied.get('id')} version {applied.get('version', 'unknown')}"


def _message(tenant_line: str | None, question: str) -> list[str]:
    text = f"{tenant_line}\n{question}" if tenant_line else question
    return ["Message:", *(f"  {line}" for line in text.split("\n"))]


def format_answer(
    *,
    tenant: str | None,
    instruction: str | None,
    version: str | None,
    request_index: int | None,
    trace: bool,
    tenant_line: str | None,
    tenant_filter: Mapping[str, Any] | None,
    question: str,
    result: StreamResult,
) -> str:
    """ask and baseline (baseline passes instruction=None)."""
    label = "none" if instruction is None else f"{instruction} version {version or 'DRAFT'}"
    if instruction is not None and request_index is not None:
        label += f" (routed by the release configuration, request {request_index})"
    lines = [f"Tenant: {tenant or 'none'}", f"Instruction: {label}", f"Applied: {applied_text(result.applied)}"]
    if trace:
        lines += ["Planning trace event:", "  " + (dumps_compact(result.planning) if result.planning else "none")]
    lines += [f"Filter: {describe_filter(tenant_filter)}", *_message(tenant_line, question), "Answer:"]
    lines.append(result.answer if result.answer is not None else "(no answer)")
    return "\n".join(lines) + "\n"


def _label(retriever: str | None, labels: Mapping[str, str]) -> str:
    return labels.get(retriever or "", retriever or UNKNOWN)


def document_rows(
    result: StreamResult,
    tenant: str,
    region: str | None,
    by_retriever: Mapping[str, str] | None = None,
) -> tuple[list[list[str]], int, int]:
    """Rows of (step or retriever, document, scope, entitled), then (outside, total) by the 8.5 counting rule."""
    rows: list[list[str]] = []
    seen: set[tuple[str, str | None]] = set()
    known: set[str] = set()
    outside_keys: set[str] = set()
    unknown_rows = 0
    for doc in result.documents:
        group = doc.step if by_retriever is None else _label(doc.retriever, by_retriever)
        c = classify(doc.key, tenant, region)
        ident = (group, doc.key if c.document != UNKNOWN else None)
        if ident in seen:
            continue
        seen.add(ident)
        rows.append([group, c.document, c.scope, c.entitled])
        if c.document == UNKNOWN:
            unknown_rows += 1
        elif doc.key is not None:
            known.add(doc.key)
            if c.outside:
                outside_keys.add(doc.key)
    return rows, len(outside_keys) + unknown_rows, len(known) + unknown_rows


def _documents(rows: list[list[str]], header: list[str], outside: int, total: int) -> list[str]:
    lines = table([header, *rows]) if rows else ["  no documents"]
    noun = "document" if total == 1 else "documents"
    return [*lines, f"  Outside the tenant's entitlement: {outside} of {total} {noun}"]


def format_isolation(
    *, tenant: str, region: str | None, question: str, unfiltered: StreamResult, filtered: StreamResult
) -> tuple[str, bool]:
    """The isolation report and whether the filtered request stayed inside the entitlement."""
    header = ["step", "document", "scope", "entitled"]
    lines = [f"Tenant: {tenant}", f"Question: {question}", "", "Without the tenant filter:"]
    rows, outside, total = document_rows(unfiltered, tenant, region)
    lines += _documents(rows, header, outside, total)
    if outside == 0:
        lines.append("  This call retrieved nothing outside the entitlement; the filter is what guarantees it.")
    lines += ["", "With the tenant filter:"]
    rows, outside, total = document_rows(filtered, tenant, region)
    lines += _documents(rows, header, outside, total)
    if outside == 0:
        lines.append("Result: PASS (the filtered request retrieved only documents the tenant is entitled to)")
    else:
        lines.append(
            f"Result: FAIL (the filtered request retrieved {plural(outside, 'document')} the tenant isn't entitled "
            f"to or that couldn't be identified)"
        )
    return "\n".join(lines) + "\n", outside == 0


def format_multi_kb(
    *,
    instruction: str,
    version: str | None,
    shared_id: str,
    south_id: str,
    shared_filter: Mapping[str, Any] | None,
    south_filter: Mapping[str, Any] | None,
    tenant_line: str,
    question: str,
    result: StreamResult,
) -> tuple[str, int]:
    """The multi-kb report and how many documents fall outside the entitlement."""

    def described(f: Mapping[str, Any] | None) -> str:
        return describe_filter(f) if f is not None else "none (--no-filters)"

    lines = [
        "Tenant: sales-region-south",
        f"Instruction: {instruction} version {version or 'DRAFT'}",
        f"Applied: {applied_text(result.applied)}",
        "Retrievers:",
        *table(
            [
                ["retriever", "knowledge base", "filter"],
                ["shared", shared_id, described(shared_filter)],
                ["south", south_id, described(south_filter)],
            ]
        ),
        *_message(tenant_line, question),
        "Answer:",
        result.answer if result.answer is not None else "(no answer)",
        "",
        "Documents:",
    ]
    rows, outside, total = document_rows(
        result, "sales-region-south", None, by_retriever={shared_id: "shared", south_id: "south"}
    )
    lines += _documents(rows, ["retriever", "document", "scope", "entitled"], outside, total)
    return "\n".join(lines) + "\n", outside


def _value(value: Any) -> str:
    """A string as is, a list of strings joined, and any other JSON value as JSON, the same in both languages."""
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return ", ".join(value) if value else "none"
    return json.dumps(value, ensure_ascii=False)


def format_structured_json(
    *,
    instruction: str,
    version: str | None,
    tenant_filter: Mapping[str, Any],
    question: str,
    result: StreamResult,
) -> tuple[str, bool]:
    check = validate_reply(result.answer)
    lines = [
        f"Instruction: {instruction} version {version or 'DRAFT'}",
        f"Applied: {applied_text(result.applied)}",
        f"Filter: {describe_filter(tenant_filter)}",
        f"Question: {question}",
        "Reply:",
        result.answer if result.answer is not None else "(no reply)",
    ]
    if check.strict_valid and check.value is not None:
        lines.append("Validation: PASS (one JSON object with exactly the five keys)")
        lines += [f"  {key}: {_value(check.value[key])}" for key in ANSWER_KEYS]
    else:
        lines.append(f"Validation: FAIL ({check.parse_class})")
        lines += [f"  - {error}" for error in check.errors]
    return "\n".join(lines) + "\n", check.strict_valid


def _canary(canary: Mapping[str, Any] | None) -> str:
    return f"{canary['version']} (1 in {canary['every']})" if canary else "none"


def format_status(view: Mapping[str, Any]) -> str:
    roles = view["tenantRoles"]
    lines = [
        f"Region: {view['region']}",
        f"Stack: {STACK_NAME} ({view['stackStatus']})",
        f"Tenant roles: {', '.join(roles) if roles else 'none'}",
        "Knowledge bases:",
    ]
    rows = [["knowledge base", "id", "data source", "latest ingestion", "started", "scanned", "indexed", "failed"]]
    for kb in view["knowledgeBases"]:
        job = kb["job"]
        if job is None:
            rows.append([kb["label"], kb["knowledgeBaseId"], kb["dataSourceId"], "none", "-", "-", "-", "-"])
        else:
            rows.append(
                [kb["label"], kb["knowledgeBaseId"], kb["dataSourceId"], job["status"], job["startedAt"]]
                + [str(job[k]) for k in ("scanned", "indexed", "failed")]
            )
    lines += table(rows)
    count, quota = view["instructionCount"], view["quota"]
    lines.append(
        f"Retrieval instructions in this account and Region: {count} of {quota} ({max(quota - count, 0)} free)"
    )
    if not view["instructions"]:
        lines.append("Sample instructions: none (run create-instructions)")
    else:
        lines.append("Sample instructions:")
        rows = [["key", "name", "status", "latest version", "live", "canary"]]
        for i in view["instructions"]:
            rows.append(
                [
                    i["key"],
                    i["name"],
                    i["status"] or "not found",
                    i["latestVersion"] or "-",
                    i["live"] or "none",
                    _canary(i["canary"]),
                ]
            )
        lines += table(rows)
    return "\n".join(lines) + "\n"


def format_create(view: Mapping[str, Any]) -> str:
    count, quota, results = view["instructionCount"], view["quota"], view["results"]
    lines = [
        f"Region: {view['region']}",
        f"Retrieval instructions in this account and Region: {count} of {quota} before this run, "
        f"{view['needed']} to create",
    ]
    rows = [["key", "name", "id", "result", "versions", "live"]]
    rows += [
        [r["key"], r["name"], r["id"], r["result"], versions_text(r["versions"]), r["live"] or "none"] for r in results
    ]
    if results:
        lines += table(rows)
    created = sum(1 for r in results if r["result"] == "created")
    lines.append(f"Retrieval instructions in this account and Region: {count + created} of {quota} after this run")
    return "\n".join(lines) + "\n"


def format_support_v2(view: Mapping[str, Any]) -> str:
    lines = [
        f"Updated {view['name']} ({view['id']}) and created version {view['version']}.",
        f"Change: {view['change']}",
        "Release pins are unchanged:",
    ]
    rows = [["key", "name", "latest version", "live", "canary"]]
    rows += [
        [r["key"], r["name"], r["latestVersion"] or "-", r["live"] or "none", _canary(r["canary"])]
        for r in view["rows"]
    ]
    lines += table(rows)
    key = next((r["key"] for r in view["rows"] if r["name"] == view["name"]), "")
    live = next((r["live"] for r in view["rows"] if r["name"] == view["name"]), None) or view["version"]
    lines.append(
        f"To send one request in five to version {view['version']}, run: release set --tenant {key} --live {live} "
        f"--canary {view['version']} --every 5"
    )
    return "\n".join(lines) + "\n"


def format_release_show(state: State | None) -> str:
    if state is None or not state.instructions:
        return "No sample instructions recorded. Run create-instructions first.\n"
    rows = [["key", "name", "versions", "live", "canary"]]
    for key, entry in state.instructions.items():
        cfg = state.release.get(key)
        rows.append([key, entry.name, versions_text(entry.versions), cfg.live if cfg else "none", canary_text(cfg)])
    return "\n".join(["Release configuration in sample-state.json:", *table(rows)]) + "\n"


def format_release_route(tenant: str, cfg: ReleaseConfig, requests: int) -> str:
    routes = [version_for(cfg, i) for i in range(requests)]
    counts = {v: routes.count(v) for v in sorted(set(routes), key=int)}
    lines = [f"Tenant: {tenant}", f"Release: {describe_release(cfg)}"]
    lines += table([["request", "version"], *([str(i), v] for i, v in enumerate(routes))])
    lines.append("Requests per version: " + ", ".join(f"{v} = {n}" for v, n in counts.items()))
    return "\n".join(lines) + "\n"


def format_cloudtrail(since: int, rows: Sequence[CallRow], stream_count: int) -> str:
    lines = [f"GetRetrievalInstruction calls made by Amazon Bedrock in the last {since} minutes:"]
    if rows:
        lines += table(
            [["time", "tenant", "version", "caller role", "error"]]
            + [[r.time, r.tenant, r.version, r.role, r.error] for r in rows]
        )
    else:
        lines.append(
            "  No matching events yet. Event history can take about 5 minutes to show an event; "
            "run cloudtrail --wait to poll."
        )
    count_line = f"AgenticRetrieveStream events in event history for the same window: {stream_count}"
    if stream_count == 0:
        count_line += " (a data event: only a trail that records data events has it)"
    lines.append(count_line)
    return "\n".join(lines) + "\n"


def format_verify_abac(tenant: str, other: str, checks: Sequence[Check]) -> str:
    rows = [["check", "role", "action", "expected", "observed", "result"]]
    rows += [
        [str(n), c.role, c.action, c.expected, c.observed, "PASS" if c.passed else "FAIL"]
        for n, c in enumerate(checks, 1)
    ]
    passed = sum(1 for c in checks if c.passed)
    result = "PASS" if passed == len(checks) else "FAIL"
    lines = [f"Tenant: {tenant}", f"Other tenant: {other}", *table(rows)]
    lines.append(f"Result: {result} ({passed} of {len(checks)} checks as expected)")
    return "\n".join(lines) + "\n"


def format_teardown_plan(cands: Sequence[Candidate]) -> str:
    if not cands:
        return "No sample instructions found in this Region.\n"
    rows = [["name", "id", "versions", "action"]]
    for c in cands:
        action = f"skip ({c.reason})" if c.action == "skip" else c.action
        rows.append([c.name, c.id, versions_text(c.versions) if c.action == "delete" else "-", action])
    n = sum(1 for c in cands if c.action == "delete")
    lines = ["Teardown plan (nothing is deleted without --yes):", *table(rows)]
    if n:
        lines.append(f"Run teardown --yes to delete {plural(n, 'instruction')} and their versions.")
    elif any(c.action == "already deleted" for c in cands):
        lines.append("Nothing to delete. Run teardown --yes to remove the deleted entries from sample-state.json.")
    else:
        lines.append("Nothing to delete.")
    return "\n".join(lines) + "\n"


@dataclass(frozen=True)
class TeardownOutcome:
    name: str
    result: str  # deleted, already deleted, skipped, or unconfirmed
    versions: tuple[str, ...] = ()
    reason: str | None = None


def format_teardown_line(o: TeardownOutcome) -> str:
    if o.result == "deleted":
        detail = f"versions {', '.join(o.versions)}" if o.versions else "no versions"
        return f"{o.name} deleted ({detail})\n"
    if o.result == "skipped":
        return f"{o.name} skipped ({o.reason})\n"
    if o.result == "unconfirmed":
        return f"{o.name} deletion not confirmed after 60 s; run teardown --yes again\n"
    return f"{o.name} already deleted\n"


def format_teardown_summary(outcomes: Sequence[TeardownOutcome], state_removed: bool) -> str:
    deleted = sum(1 for o in outcomes if o.result == "deleted")
    text = f"Deleted {plural(deleted, 'instruction')}."
    if state_removed:
        text += " Removed sample-state.json."
    return text + "\n"
