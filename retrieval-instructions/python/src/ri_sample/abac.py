"""Check the tenant role tag conditions with five calls. Nothing is created.

The role sessions last 900 seconds, and their credentials stay in memory: nothing prints or writes them.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from botocore.exceptions import ClientError

from ri_sample.ask import build_request, send_request
from ri_sample.deployment import NO_ROLES, TENANT_OUTPUT_PREFIXES, Deployment
from ri_sample.errors import AwsError, UsageError, aws_error, error_code
from ri_sample.output import progress
from ri_sample.specs import SAMPLE_APP, SAMPLE_TAG_KEY, TENANT_TAG_KEY
from ri_sample.state import State
from ri_sample.tenancy import TenantRequest, tenant_request

SESSION_SECONDS = 900
SESSION_NAME = "retrieval-instructions-verify-abac"
CHECK_APP_VALUE = "verify-abac-check"
DENIED = "AccessDeniedException"
TRUST_HINT = "your identity isn't the trusted principal; deploy with -c trustedPrincipalArn=<your role ARN>"

ClientFactory = Callable[[str, dict[str, str]], Any]


@dataclass
class Check:
    role: str
    action: str
    expected: str  # allow or deny
    observed: str  # allow or deny

    @property
    def passed(self) -> bool:
        return self.expected == self.observed


def assume(sts: Any, role_arn: str) -> dict[str, str]:
    """Temporary credentials for one role, kept in memory only."""
    try:
        creds = sts.assume_role(RoleArn=role_arn, RoleSessionName=SESSION_NAME, DurationSeconds=SESSION_SECONDS)
    except ClientError as err:
        if error_code(err) in ("AccessDenied", DENIED):
            raise UsageError(TRUST_HINT) from err
        raise aws_error(err) from err
    c = creds["Credentials"]
    return {
        "aws_access_key_id": c["AccessKeyId"],
        "aws_secret_access_key": c["SecretAccessKey"],
        "aws_session_token": c["SessionToken"],
    }


def _is_denied(code: str) -> bool:
    return code in (DENIED, "AccessDenied")


def _apply(runtime: Any, req: TenantRequest, knowledge_base_id: str) -> str:
    """allow or deny for a planning-only request that applies the request's instruction."""
    request = build_request(
        question="What is the return window?",
        retrievers=[(knowledge_base_id, req.tenant_filter)],
        tenant_line=req.tenant_line,
        instruction_id=req.instruction_id,
        version=req.version,
        generate_response=False,
    )
    try:
        result = send_request(runtime, request)
    except ClientError as err:
        if _is_denied(error_code(err)):
            return "deny"
        raise aws_error(err) from err
    if result.error is None:
        return "allow"
    if _is_denied(result.error[0]):
        return "deny"
    raise AwsError(result.error[0], result.error[1])


def _call(fn: Callable[[], Any]) -> str:
    try:
        fn()
    except ClientError as err:
        if _is_denied(error_code(err)):
            return "deny"
        raise aws_error(err) from err
    return "allow"


def _restore(agent: Any, arn: str, tags: dict[str, str]) -> None:
    """Put a tag back with the reader's own credentials after an unexpected allow."""
    try:
        agent.tag_resource(resourceArn=arn, tags=tags)
        progress(f"restored the tag {', '.join(f'{k}={v}' for k, v in tags.items())}")
    except ClientError:
        tag_args = " ".join(f"{k}={v}" for k, v in tags.items())
        progress(
            f"could not restore the tag; run: aws bedrock-agent tag-resource --resource-arn {arn} --tags {tag_args}"
        )


def verify_abac(
    *,
    sts: Any,
    agent: Any,
    deployment: Deployment,
    state: State,
    tenant: str,
    other: str,
    client_factory: ClientFactory,
) -> list[Check]:
    """Run the five checks in order and return them with what was observed."""
    if not deployment.tenant_role_tenants:
        raise UsageError(NO_ROLES)
    if tenant not in deployment.tenant_role_tenants:
        raise UsageError(
            f"{tenant} has no tenant roles in this stack; deploy with -c trustedPrincipalArn=<your role ARN> "
            f"-c tenantRoles=<tenants>"
        )
    for key in (tenant, other):
        if key not in state.instructions or key not in state.release:
            raise UsageError(f"no instruction for {key} in sample-state.json; run create-instructions first")
    own, theirs = state.instructions[tenant], state.instructions[other]
    req = tenant_request(state, tenant, None, state.release[tenant].live)
    other_req = dataclasses.replace(req, instruction_id=theirs.id, version=state.release[other].live)

    applier = client_factory(
        "bedrock-agent-runtime", assume(sts, deployment.role_arn(TENANT_OUTPUT_PREFIXES["applierRoleArn"], tenant))
    )
    tenant_admin = client_factory(
        "bedrock-agent", assume(sts, deployment.role_arn(TENANT_OUTPUT_PREFIXES["tenantAdminRoleArn"], tenant))
    )
    platform_admin = client_factory("bedrock-agent", assume(sts, deployment.role_arn("PlatformAdminRoleArn")))
    kb = deployment.shared_knowledge_base_id

    checks = [Check("applier", f"apply {own.name}", "allow", _apply(applier, req, kb))]
    checks.append(Check("applier", f"apply {theirs.name}", "deny", _apply(applier, other_req, kb)))

    retag = {TENANT_TAG_KEY: tenant}
    observed = _call(lambda: tenant_admin.tag_resource(resourceArn=theirs.arn, tags=retag))
    checks.append(Check("tenant admin", f"tag {theirs.name} with {TENANT_TAG_KEY}={tenant}", "deny", observed))
    if observed == "allow":
        _restore(agent, theirs.arn, {TENANT_TAG_KEY: other})

    app_tags = {TENANT_TAG_KEY: tenant, SAMPLE_TAG_KEY: CHECK_APP_VALUE}
    observed = _call(lambda: tenant_admin.tag_resource(resourceArn=own.arn, tags=app_tags))
    checks.append(Check("tenant admin", f"tag {own.name} with {SAMPLE_TAG_KEY}={CHECK_APP_VALUE}", "deny", observed))
    if observed == "allow":
        _restore(agent, own.arn, {SAMPLE_TAG_KEY: SAMPLE_APP})

    observed = _call(lambda: platform_admin.get_retrieval_instruction(retrievalInstructionId=theirs.id))
    checks.append(Check("platform admin", f"read {theirs.name}", "allow", observed))
    return checks


def default_other(tenant: str) -> str:
    return "sales-region-north" if tenant == "sales-region-central" else "sales-region-central"
