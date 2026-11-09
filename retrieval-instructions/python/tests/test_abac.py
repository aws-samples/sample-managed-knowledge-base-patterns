"""verify-abac: the five checks, denial classification, restores, and no credential in any output."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from ri_sample import state as state_file
from ri_sample.abac import CHECK_APP_VALUE, verify_abac
from ri_sample.deployment import Deployment
from ri_sample.errors import UsageError
from ri_sample.formats import format_verify_abac
from ri_sample.state import State
from support import ACCOUNT, FakeRuntime, client_error, fixture

ROLE = f"arn:aws:iam::{ACCOUNT}:role/"
OUTPUTS = {
    "SharedKnowledgeBaseId": "ABCDE12345",
    "SharedDataSourceId": "KLMNO12345",
    "CorpusBucketName": "amzn-s3-demo-bucket",
    "TenantRoleTenants": "sales-region-north",
    "ApplierRoleArnSalesRegionNorth": ROLE + "ExampleApplierRole",
    "TenantAdminRoleArnSalesRegionNorth": ROLE + "ExampleTenantAdminRole",
    "PlatformAdminRoleArn": ROLE + "ExamplePlatformAdminRole",
}
SECRET = "example-secret-value"


def state_with_central() -> State:
    raw: dict[str, Any] = fixture("state.json")
    raw["instructions"]["sales-region-central"] = {
        "name": "assistant-sales-region-central",
        "id": "klmno12345",
        "arn": f"arn:aws:bedrock:us-east-1:{ACCOUNT}:retrieval-instruction/klmno12345",
        "versions": ["1"],
        "createdBy": "python",
    }
    raw["release"]["sales-region-central"] = {"live": "1"}
    return state_file.parse(raw)


class FakeSts:
    def __init__(self, deny: bool = False) -> None:
        self.deny = deny
        self.calls: list[dict[str, Any]] = []

    def assume_role(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.deny:
            raise client_error("AccessDenied")
        role = kwargs["RoleArn"].rsplit("/", 1)[1]
        return {"Credentials": {"AccessKeyId": role, "SecretAccessKey": SECRET, "SessionToken": SECRET + "-token"}}


class FakeAgent:
    def __init__(self, allow_tags: bool = False) -> None:
        self.allow_tags = allow_tags
        self.tag_calls: list[dict[str, Any]] = []
        self.get_calls: list[dict[str, Any]] = []

    def tag_resource(self, **kwargs: Any) -> dict[str, Any]:
        self.tag_calls.append(kwargs)
        if not self.allow_tags:
            raise client_error("AccessDeniedException", "not authorized", "TagResource")
        return {}

    def get_retrieval_instruction(self, **kwargs: Any) -> dict[str, Any]:
        self.get_calls.append(kwargs)
        return {}


class Roles:
    def __init__(self, applier: FakeRuntime, tenant_admin: FakeAgent, platform_admin: FakeAgent) -> None:
        self.by_role = {
            "ExampleApplierRole": applier,
            "ExampleTenantAdminRole": tenant_admin,
            "ExamplePlatformAdminRole": platform_admin,
        }
        self.credentials: list[dict[str, str]] = []

    def __call__(self, service: str, credentials: dict[str, str]) -> Any:
        self.credentials.append(credentials)
        return self.by_role[credentials["aws_access_key_id"]]


def run(
    applier: FakeRuntime,
    tenant_admin: FakeAgent,
    reader: FakeAgent | None = None,
    outputs: dict[str, str] | None = None,
) -> tuple[list[Any], Roles, FakeAgent]:
    roles = Roles(applier, tenant_admin, FakeAgent())
    reader = reader or FakeAgent(allow_tags=True)
    checks = verify_abac(
        sts=FakeSts(),
        agent=reader,
        deployment=Deployment("CREATE_COMPLETE", outputs or OUTPUTS),
        state=state_with_central(),
        tenant="sales-region-north",
        other="sales-region-central",
        client_factory=roles,
    )
    return checks, roles, reader


def test_the_five_checks_pass_when_the_tag_conditions_hold() -> None:
    applier = FakeRuntime("isolation-filtered.json", client_error("AccessDeniedException", "denied"))
    tenant_admin = FakeAgent()
    checks, roles, reader = run(applier, tenant_admin)
    assert [(c.role, c.expected, c.observed) for c in checks] == [
        ("applier", "allow", "allow"),
        ("applier", "deny", "deny"),
        ("tenant admin", "deny", "deny"),
        ("tenant admin", "deny", "deny"),
        ("platform admin", "allow", "allow"),
    ]
    assert all(c.passed for c in checks)
    own, other = applier.calls
    assert own["retrievalInstructionConfiguration"] == {"retrievalInstructionId": "abcde12345", "version": "1"}
    assert other["retrievalInstructionConfiguration"] == {"retrievalInstructionId": "klmno12345", "version": "1"}
    assert own["retrievers"] == other["retrievers"]  # the filter stays the authenticated tenant's
    assert own["generateResponse"] is False
    retag, app_tag = tenant_admin.tag_calls
    assert retag["tags"] == {"tenant": "sales-region-north"} and retag["resourceArn"].endswith("klmno12345")
    assert app_tag["tags"] == {"tenant": "sales-region-north", "app": CHECK_APP_VALUE}
    assert app_tag["resourceArn"].endswith("abcde12345")
    assert reader.tag_calls == []


def test_an_in_stream_access_denied_counts_as_deny() -> None:
    checks, _, _ = run(FakeRuntime("isolation-filtered.json", "midstream-error.json"), FakeAgent())
    assert checks[1].observed == "deny"


def test_unexpected_allows_are_restored_and_fail() -> None:
    applier = FakeRuntime("isolation-filtered.json", "isolation-filtered.json")
    checks, _, reader = run(applier, FakeAgent(allow_tags=True))
    assert [c.passed for c in checks] == [True, False, False, False, True]
    assert [call["tags"] for call in reader.tag_calls] == [
        {"tenant": "sales-region-central"},
        {"app": "retrieval-instructions-sample"},
    ]
    assert "FAIL" in format_verify_abac("sales-region-north", "sales-region-central", checks)


def test_a_failed_restore_prints_the_fix_command(capsys: pytest.CaptureFixture[str]) -> None:
    applier = FakeRuntime("isolation-filtered.json", client_error("AccessDeniedException", "denied"))
    run(applier, FakeAgent(allow_tags=True), reader=FakeAgent(allow_tags=False))
    assert "aws bedrock-agent tag-resource --resource-arn" in capsys.readouterr().err


def test_a_stack_without_tenant_roles_is_exit_2() -> None:
    outputs = {k: v for k, v in OUTPUTS.items() if "Role" not in k}
    with pytest.raises(UsageError, match="trustedPrincipalArn") as err:
        run(FakeRuntime(), FakeAgent(), outputs=outputs)
    assert err.value.exit_code == 2


def test_an_untrusted_caller_is_exit_2() -> None:
    with pytest.raises(UsageError, match="trusted principal"):
        verify_abac(
            sts=FakeSts(deny=True),
            agent=FakeAgent(),
            deployment=Deployment("CREATE_COMPLETE", OUTPUTS),
            state=state_with_central(),
            tenant="sales-region-north",
            other="sales-region-central",
            client_factory=Roles(FakeRuntime(), FakeAgent(), FakeAgent()),
        )


def test_no_credential_reaches_output_or_the_state_file(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    applier = FakeRuntime("isolation-filtered.json", client_error("AccessDeniedException", "denied"))
    checks, roles, _ = run(applier, FakeAgent(allow_tags=True), reader=FakeAgent(allow_tags=False))
    assert roles.credentials[0]["aws_secret_access_key"] == SECRET  # the sessions did use the credentials
    text = format_verify_abac("sales-region-north", "sales-region-central", checks)
    path = tmp_path / "sample-state.json"
    state_file.save(state_with_central(), path)
    captured = capsys.readouterr()
    for output in (text, captured.out, captured.err, path.read_text(encoding="utf-8")):
        assert SECRET not in output
