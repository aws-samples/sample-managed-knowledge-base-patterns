"""One function per command. The text each command prints comes from formats.py.

Every AWS-calling command except teardown runs the preflight first: credentials, the stack and its outputs,
and the state file's account and Region. release show, set, and route read only the state file.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError, NoCredentialsError

from ri_sample import state as state_file
from ri_sample.abac import ClientFactory, default_other, verify_abac
from ri_sample.ask import StreamResult, ask_as_tenant, build_request, send_request
from ri_sample.cloudtrail import Lookup, lookup
from ri_sample.deployment import STACK_NAME, Deployment, describe, stack_missing
from ri_sample.errors import AwsError, SampleError, UsageError, aws_error, error_code
from ri_sample.filters import REGIONS
from ri_sample.formats import (
    TeardownOutcome,
    applied_text,
    format_answer,
    format_cloudtrail,
    format_create,
    format_isolation,
    format_multi_kb,
    format_release_route,
    format_release_show,
    format_status,
    format_structured_json,
    format_support_v2,
    format_teardown_line,
    format_teardown_plan,
    format_teardown_summary,
    format_verify_abac,
)
from ri_sample.instructions import (
    CreateOutcome,
    candidates,
    create_instructions,
    delete,
    inspect,
    list_instructions,
    quota_check,
    support_v2,
)
from ri_sample.output import out, progress, utc
from ri_sample.paths import STATE_FILE
from ri_sample.release import VERSION_RE, ReleaseConfig, checked_release, describe_release, version_for
from ri_sample.specs import STRUCTURED_JSON_KEY, combined_specs, default_specs, instruction_name, tenant_specs
from ri_sample.specs import support_v2 as support_v2_spec
from ri_sample.state import State
from ri_sample.tenancy import TenantFilter, south_retriever_filters, tenant_request, tenant_scope

INGESTION_RUNNING = ("STARTING", "IN_PROGRESS", "STOPPING")
INGESTION_POLL_S, INGESTION_TIMEOUT_S = 10.0, 1800.0
CLOUDTRAIL_POLL_S, CLOUDTRAIL_TIMEOUT_S = 60.0, 900.0
NO_CREDENTIALS = "no valid AWS credentials; configure a profile or sign in"
NO_ANSWER = "error: the response has no answer"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Context:
    """The AWS clients and the side effects a command uses, so tests can replace them."""

    agent: Any
    runtime: Any
    sts: Any
    cloudformation: Any
    cloudtrail: Any
    region: str
    client_factory: ClientFactory
    state_path: Path = STATE_FILE
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    now: Callable[[], datetime] = field(default=_utc_now)


def default_context() -> Context:
    """Clients from config.py: AWS_REGION, else us-east-1."""
    import boto3

    from ri_sample import config

    def factory(service: str, credentials: dict[str, str]) -> Any:
        extra = {"config": config.RUNTIME_CONFIG} if service == "bedrock-agent-runtime" else {}
        return boto3.client(service, region_name=config.region, **credentials, **extra)

    return Context(
        config.agent, config.runtime, config.sts, config.cloudformation, config.cloudtrail, config.region, factory
    )


# ----------------------------------------------------------------------------------------------------------
# Preflight and input validation


@dataclass(frozen=True)
class Preflight:
    account: str
    deployment: Deployment
    state: State | None


def caller_account(ctx: Context) -> str:
    try:
        return str(ctx.sts.get_caller_identity()["Account"])
    except (ClientError, NoCredentialsError) as err:
        raise SampleError(NO_CREDENTIALS) from err


def load_state(ctx: Context, account: str) -> State | None:
    loaded = state_file.load(ctx.state_path)
    if loaded is not None:
        state_file.check_environment(loaded, account, ctx.region)
    return loaded


def preflight(ctx: Context) -> Preflight:
    account = caller_account(ctx)
    deployment = describe(ctx.cloudformation, ctx.region)
    return Preflight(account, deployment, load_state(ctx, account))


def check_question(question: str) -> str:
    text = question.strip()
    if not text or len(text) > 1000:
        raise UsageError("--question must be 1 to 1,000 characters")
    return text


def check_version(version: str | None) -> None:
    if version is not None and version != "DRAFT" and not VERSION_RE.match(version):
        raise UsageError("--version must be DRAFT or a version number such as 1 or 2")


def check_range(name: str, value: int | None, low: int, high: int | None = None) -> None:
    if value is None:
        return
    if value < low or (high is not None and value > high):
        raise UsageError(f"{name} must be {low} or more" if high is None else f"{name} must be {low} to {high}")


def check_ask_tenant(tenant: str, state: State | None) -> None:
    """ask, baseline, and isolation: a tenant key, or a combined key already in the state file."""
    tenants = [spec.key for spec in tenant_specs()]
    combined = [spec.key for spec in combined_specs()]
    if tenant in combined:
        if state is None or tenant not in state.instructions:
            raise UsageError(f"{tenant} isn't in sample-state.json; run create-instructions --combined first")
        return
    if tenant not in tenants:
        raise UsageError(f"--tenant must be one of {', '.join(tenants)}, or a combined key: {', '.join(combined)}")


def release_config(state: State | None, tenant: str) -> ReleaseConfig:
    cfg = state.release.get(tenant) if state else None
    if cfg is None:
        hint = "run create-instructions --combined first" if "." in tenant else "run create-instructions first"
        raise UsageError(f"no instruction for {tenant} in sample-state.json; {hint}")
    return cfg


def stream_failed(result: StreamResult) -> None:
    if result.error is not None:
        raise AwsError(result.error[0], result.error[1])


def _send(fn: Callable[..., StreamResult], *args: Any) -> StreamResult:
    try:
        return fn(*args)
    except ClientError as err:
        hint = "check release show" if error_code(err) == "ValidationException" else None
        raise aws_error(err, hint) from err


def _release_view(cfg: ReleaseConfig | None) -> tuple[str | None, dict[str, Any] | None]:
    if cfg is None:
        return None, None
    canary = {"version": cfg.canary.version, "every": cfg.canary.every} if cfg.canary else None
    return cfg.live, canary


# ----------------------------------------------------------------------------------------------------------
# Commands


def cmd_status(ctx: Context, wait: bool, quota: int) -> int:
    check_range("--quota", quota, 1, 10_000)
    pre = preflight(ctx)
    dep = pre.deployment
    kbs = [("shared", dep.shared_knowledge_base_id, dep.shared_data_source_id)]
    if dep.south_knowledge_base_id and dep.south_data_source_id:
        kbs.append(("south", dep.south_knowledge_base_id, dep.south_data_source_id))

    def latest_jobs() -> list[dict[str, Any] | None]:
        jobs: list[dict[str, Any] | None] = []
        for _, kb, ds in kbs:
            page = ctx.agent.list_ingestion_jobs(
                knowledgeBaseId=kb,
                dataSourceId=ds,
                sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
                maxResults=1,
            )
            summaries = page.get("ingestionJobSummaries", [])
            jobs.append(summaries[0] if summaries else None)
        return jobs

    rows: list[dict[str, Any]] = []
    try:
        jobs = latest_jobs()
        start = ctx.clock()
        while wait and any(j is None or j.get("status") in INGESTION_RUNNING for j in jobs):
            if ctx.clock() - start >= INGESTION_TIMEOUT_S:
                break
            states = ", ".join(str(j.get("status")) if j else "none" for j in jobs)
            progress(f"waiting for ingestion: {states}, {int(ctx.clock() - start)} s")
            ctx.sleep(INGESTION_POLL_S)
            jobs = latest_jobs()
        listed = list_instructions(ctx.agent)
        current = pre.state
        for key, entry in current.instructions.items() if current else []:
            status: str | None = None
            latest: str | None = None
            try:
                got = ctx.agent.get_retrieval_instruction(retrievalInstructionId=entry.id)
                status, latest = str(got.get("status")), got.get("latestVersion") or entry.latest
            except ClientError as err:
                if error_code(err) != "ResourceNotFoundException":
                    raise
            live, canary = _release_view(current.release.get(key) if current else None)
            rows.append(
                {
                    "key": key,
                    "name": entry.name,
                    "status": status,
                    "latestVersion": latest,
                    "live": live,
                    "canary": canary,
                }
            )
    except ClientError as err:
        raise aws_error(err) from err
    kb_views = [
        {"label": label, "knowledgeBaseId": kb, "dataSourceId": ds, "job": _job_view(job)}
        for (label, kb, ds), job in zip(kbs, jobs, strict=True)
    ]
    view: dict[str, Any] = {
        "region": ctx.region,
        "stackStatus": dep.status,
        "tenantRoles": dep.tenant_role_tenants or None,
        "knowledgeBases": kb_views,
        "instructionCount": len(listed),
        "quota": quota,
        "instructions": rows,
    }
    out(format_status(view))
    bad = [str(v["label"]) for v in kb_views if not _ingestion_ok(v["job"])]
    if bad:
        progress(f"error: ingestion isn't complete for the {', '.join(bad)} knowledge base")
        return 1
    return 0


def _job_view(job: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if job is None:
        return None
    stats = job.get("statistics") or {}
    started = job.get("startedAt")
    indexed = int(stats.get("numberOfNewDocumentsIndexed", 0)) + int(stats.get("numberOfModifiedDocumentsIndexed", 0))
    return {
        "status": str(job.get("status")),
        "startedAt": utc(started) if isinstance(started, datetime) else str(started or "-"),
        "scanned": int(stats.get("numberOfDocumentsScanned", 0)),
        "indexed": indexed,
        "failed": int(stats.get("numberOfDocumentsFailed", 0)),
    }


def _ingestion_ok(job: Any) -> bool:
    return isinstance(job, dict) and job["status"] == "COMPLETE" and job["failed"] == 0


def cmd_create_instructions(ctx: Context, combined: bool, quota: int) -> int:
    check_range("--quota", quota, 1, 10_000)
    pre = preflight(ctx)
    current = pre.state or State(pre.account, ctx.region)
    specs = list(default_specs() + (combined_specs() if combined else ()))
    outcomes: list[CreateOutcome] = []

    def save(s: State) -> None:
        state_file.save(s, ctx.state_path)

    try:
        listed = list_instructions(ctx.agent)
        needed = quota_check(listed, current, specs, quota)
    except ClientError as err:
        raise aws_error(err) from err
    try:
        create_instructions(ctx.agent, current, specs, outcomes, save)
    finally:
        view = {
            "region": ctx.region,
            "instructionCount": len(listed),
            "quota": quota,
            "needed": needed,
            "results": [
                {"key": o.key, "name": o.name, "id": o.id, "result": o.result, "versions": o.versions, "live": o.live}
                for o in outcomes
            ],
        }
        out(format_create(view))
    return 0


def cmd_baseline(ctx: Context, question: str, tenant: str | None, region: str | None) -> int:
    question = check_question(question)
    if tenant is None and region is not None:
        raise UsageError("--region works only with a team tenant")
    pre = preflight(ctx)
    line: str | None = None
    tenant_filter: TenantFilter | None = None
    if tenant is not None:
        check_ask_tenant(tenant, pre.state)
        line, tenant_filter = tenant_scope(tenant, region)
    kb = pre.deployment.shared_knowledge_base_id
    request = build_request(
        question=question, retrievers=[(kb, tenant_filter)], tenant_line=line, instruction_id=None, version=None
    )
    result = _send(send_request, ctx.runtime, request)
    out(
        format_answer(
            tenant=tenant,
            instruction=None,
            version=None,
            request_index=None,
            trace=False,
            tenant_line=line,
            tenant_filter=tenant_filter,
            question=question,
            result=result,
        )
    )
    stream_failed(result)
    if result.answer is None:
        progress(NO_ANSWER)
        return 1
    return 0


def cmd_ask(
    ctx: Context,
    tenant: str,
    question: str,
    region: str | None,
    version: str | None,
    request_index: int | None,
    trace: bool,
) -> int:
    question = check_question(question)
    check_version(version)
    check_range("--request-index", request_index, 0)
    if region is not None and region not in REGIONS:
        raise UsageError(f"--region must be one of {', '.join(REGIONS)}")
    if version is not None and request_index is not None:
        raise UsageError("--version and --request-index can't be used together")
    pre = preflight(ctx)
    check_ask_tenant(tenant, pre.state)
    routed = version is None and request_index is not None
    if version is None:
        cfg = release_config(pre.state, tenant)
        version = version_for(cfg, request_index) if request_index is not None else cfg.live
    req = tenant_request(pre.state, tenant, region, version)
    kb = pre.deployment.shared_knowledge_base_id
    if req.tenant_line is not None and req.version is not None:
        result = _send(ask_as_tenant, ctx.runtime, req, kb, question)
    else:
        request = build_request(
            question=question,
            retrievers=[(kb, req.tenant_filter)],
            tenant_line=req.tenant_line,
            instruction_id=req.instruction_id,
            version=req.version,
        )
        result = _send(send_request, ctx.runtime, request)
    out(
        format_answer(
            tenant=tenant,
            instruction=instruction_name(tenant),
            version=version,
            request_index=request_index if routed else None,
            trace=trace,
            tenant_line=req.tenant_line,
            tenant_filter=req.tenant_filter,
            question=question,
            result=result,
        )
    )
    stream_failed(result)
    if result.answer is None:
        progress(NO_ANSWER)
        return 1
    applied = result.applied or {}
    if applied.get("id") != req.instruction_id or applied.get("version") != (req.version or "DRAFT"):
        progress(
            f"error: the applied instruction ({applied_text(result.applied)}) differs from the requested one "
            f"({req.instruction_id} version {req.version or 'DRAFT'})"
        )
        return 1
    return 0


def cmd_isolation(ctx: Context, tenant: str, question: str, region: str | None) -> int:
    question = check_question(question)
    pre = preflight(ctx)
    check_ask_tenant(tenant, pre.state)
    req = tenant_request(pre.state, tenant, region, release_config(pre.state, tenant).live)
    kb = pre.deployment.shared_knowledge_base_id
    results = []
    for tenant_filter in (None, req.tenant_filter):
        request = build_request(
            question=question,
            retrievers=[(kb, tenant_filter)],
            tenant_line=req.tenant_line,
            instruction_id=req.instruction_id,
            version=req.version,
            generate_response=False,
        )
        result = _send(send_request, ctx.runtime, request)
        stream_failed(result)
        results.append(result)
    text, ok = format_isolation(
        tenant=tenant, region=region, question=question, unfiltered=results[0], filtered=results[1]
    )
    out(text)
    return 0 if ok else 1


def cmd_structured_json(ctx: Context, question: str) -> int:
    question = check_question(question)
    pre = preflight(ctx)
    version = release_config(pre.state, STRUCTURED_JSON_KEY).live
    req = tenant_request(pre.state, STRUCTURED_JSON_KEY, None, version)
    request = build_request(
        question=question,
        retrievers=[(pre.deployment.shared_knowledge_base_id, req.tenant_filter)],
        tenant_line=None,
        instruction_id=req.instruction_id,
        version=req.version,
    )
    result = _send(send_request, ctx.runtime, request)
    stream_failed(result)
    text, ok = format_structured_json(
        instruction=instruction_name(STRUCTURED_JSON_KEY),
        version=version,
        tenant_filter=req.tenant_filter,
        question=question,
        result=result,
    )
    out(text)
    return 0 if ok else 1


def cmd_multi_kb(ctx: Context, question: str, version: str | None, no_filters: bool) -> int:
    question = check_question(question)
    check_version(version)
    pre = preflight(ctx)
    south_id = pre.deployment.south_knowledge_base_id
    if south_id is None:
        raise UsageError("this stack has no Sales Region South knowledge base; deploy with -c southKnowledgeBase=true")
    tenant = "sales-region-south"
    version = version or release_config(pre.state, tenant).live
    req = tenant_request(pre.state, tenant, None, version)
    shared_id = pre.deployment.shared_knowledge_base_id
    f_shared, f_south = (None, None) if no_filters else south_retriever_filters()
    request = build_request(
        question=question,
        retrievers=[(shared_id, f_shared), (south_id, f_south)],
        tenant_line=req.tenant_line,
        instruction_id=req.instruction_id,
        version=req.version,
    )
    result = _send(send_request, ctx.runtime, request)
    stream_failed(result)
    text, outside = format_multi_kb(
        instruction=instruction_name(tenant),
        version=version,
        shared_id=shared_id,
        south_id=south_id,
        shared_filter=f_shared,
        south_filter=f_south,
        tenant_line=req.tenant_line or "",
        question=question,
        result=result,
    )
    out(text)
    if result.answer is None:
        progress(NO_ANSWER)
        return 1
    if outside and not no_filters:
        progress("error: the filtered request retrieved documents outside the tenant's entitlement")
        return 1
    return 0


def cmd_support_v2(ctx: Context) -> int:
    pre = preflight(ctx)
    spec = support_v2_spec()
    current = pre.state
    if current is None:
        raise UsageError(f"no instruction for {spec.key} in sample-state.json; run create-instructions first")

    def save(s: State) -> None:
        state_file.save(s, ctx.state_path)

    version = support_v2(ctx.agent, current, spec.key, spec.answer_format, save)
    entry = current.instructions[spec.key]
    rows = []
    for key, e in current.instructions.items():
        live, canary = _release_view(current.release.get(key))
        rows.append({"key": key, "name": e.name, "latestVersion": e.latest, "live": live, "canary": canary})
    view = {"name": entry.name, "id": entry.id, "version": version, "change": spec.change, "rows": rows}
    out(format_support_v2(view))
    return 0


def _recorded(current: State | None, tenant: str) -> State:
    if current is None or tenant not in current.instructions:
        keys = ", ".join(current.instructions) if current else ""
        raise UsageError(f"--tenant must be a key in sample-state.json{': ' + keys if keys else ''}")
    return current


def cmd_release_show(state_path: Path) -> int:
    out(format_release_show(state_file.load(state_path)))
    return 0


def cmd_release_set(state_path: Path, tenant: str, live: str, canary: str | None, every: int | None) -> int:
    current = _recorded(state_file.load(state_path), tenant)
    entry = current.instructions[tenant]
    cfg = checked_release(entry.name, entry.versions, live, canary, every)
    state_file.set_release(current, tenant, cfg)
    state_file.save(current, state_path)
    out(f"Release for {tenant}: {describe_release(cfg)}\n")
    return 0


def cmd_release_route(state_path: Path, tenant: str, requests: int) -> int:
    check_range("--requests", requests, 1, 1000)
    current = _recorded(state_file.load(state_path), tenant)
    cfg = current.release.get(tenant)
    if cfg is None:
        raise UsageError(f"{tenant} has no release configuration; run release set first")
    out(format_release_route(tenant, cfg, requests))
    return 0


def cmd_cloudtrail(ctx: Context, since: int, wait: bool) -> int:
    check_range("--since", since, 1, 1440)
    pre = preflight(ctx)
    if pre.state is None or not pre.state.instructions:
        raise UsageError("no instructions in sample-state.json; run create-instructions first")
    id_to_key = {entry.id: key for key, entry in pre.state.instructions.items()}
    client = Lookup(ctx.cloudtrail, ctx.sleep)
    start = ctx.clock()
    try:
        rows, streams = lookup(client, id_to_key, since, ctx.now())
        while wait and not rows and ctx.clock() - start < CLOUDTRAIL_TIMEOUT_S:
            progress(f"waiting for CloudTrail event history: {int(ctx.clock() - start)} s")
            ctx.sleep(CLOUDTRAIL_POLL_S)
            rows, streams = lookup(client, id_to_key, since, ctx.now())
    except ClientError as err:
        raise aws_error(err) from err
    out(format_cloudtrail(since, rows, streams))
    if wait and not rows:
        progress("error: no matching GetRetrievalInstruction event within 15 minutes")
        return 1
    return 0


def cmd_verify_abac(ctx: Context, tenant: str | None, other: str | None) -> int:
    pre = preflight(ctx)
    roles = pre.deployment.tenant_role_tenants
    tenant = tenant or (roles[0] if roles else "sales-region-north")
    other = other or default_other(tenant)
    if other not in REGIONS or other == tenant:
        raise UsageError(f"--other must be a sales region key other than {tenant}: {', '.join(REGIONS)}")
    if pre.state is None:
        raise UsageError("no instructions in sample-state.json; run create-instructions first")
    checks = verify_abac(
        sts=ctx.sts,
        agent=ctx.agent,
        deployment=pre.deployment,
        state=pre.state,
        tenant=tenant,
        other=other,
        client_factory=ctx.client_factory,
    )
    out(format_verify_abac(tenant, other, checks))
    return 0 if all(c.passed for c in checks) else 1


def cmd_teardown(ctx: Context, yes: bool) -> int:
    account = caller_account(ctx)
    try:
        ctx.cloudformation.describe_stacks(StackName=STACK_NAME)
    except ClientError as err:
        if stack_missing(err):
            progress(f"stack {STACK_NAME} not found in {ctx.region}; deleting sample instructions anyway")
        else:
            progress(f"warning: DescribeStacks failed ({error_code(err)}); continuing without the stack")
    current = load_state(ctx, account)
    try:
        cands = [inspect(ctx.agent, c) for c in candidates(ctx.agent, current)]
    except ClientError as err:
        raise aws_error(err) from err
    if not yes:
        out(format_teardown_plan(cands))
        return 0
    outcomes: list[TeardownOutcome] = []
    for cand in cands:
        if cand.action == "skip":
            outcome = TeardownOutcome(cand.name, "skipped", reason=cand.reason)
        elif cand.action == "already deleted":
            outcome = TeardownOutcome(cand.name, "already deleted")
        else:
            result = delete(ctx.agent, cand, sleep=ctx.sleep, clock=ctx.clock)
            outcome = TeardownOutcome(cand.name, result, tuple(cand.versions or ()) if result == "deleted" else ())
        if current is not None and cand.key is not None and outcome.result in ("deleted", "already deleted"):
            state_file.remove_instruction(current, cand.key)
            state_file.save(current, ctx.state_path)
        outcomes.append(outcome)
        out(format_teardown_line(outcome))
    removed = False
    if current is not None and not current.instructions:
        state_file.delete(ctx.state_path)
        removed = True
    out(format_teardown_summary(outcomes, removed))
    return 1 if any(o.result == "unconfirmed" for o in outcomes) else 0
