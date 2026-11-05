"""The deployed stack: its status and outputs, read with DescribeStacks every time (never cached)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from botocore.exceptions import ClientError

from ri_sample.errors import UsageError, aws_error

STACK_NAME = "RetrievalInstructionsSample"
OUTPUT_KEYS = {
    "sharedKnowledgeBaseId": "SharedKnowledgeBaseId",
    "sharedKnowledgeBaseArn": "SharedKnowledgeBaseArn",
    "sharedDataSourceId": "SharedDataSourceId",
    "southKnowledgeBaseId": "SouthKnowledgeBaseId",
    "southKnowledgeBaseArn": "SouthKnowledgeBaseArn",
    "southDataSourceId": "SouthDataSourceId",
    "corpusBucketName": "CorpusBucketName",
    "tenantRoleTenants": "TenantRoleTenants",
    "platformAdminRoleArn": "PlatformAdminRoleArn",
}
TENANT_OUTPUT_PREFIXES = {"applierRoleArn": "ApplierRoleArn", "tenantAdminRoleArn": "TenantAdminRoleArn"}
REQUIRED_OUTPUTS = ("SharedKnowledgeBaseId", "SharedDataSourceId", "CorpusBucketName")
NO_ROLES = (
    "this stack has no tenant roles; deploy with -c trustedPrincipalArn=<your role ARN> "
    "(README: Check the tenant roles)"
)


def pascal(key: str) -> str:
    """`sales-region-north` -> `SalesRegionNorth`."""
    return "".join(part[:1].upper() + part[1:] for part in key.split("-"))


def stack_missing(err: ClientError) -> bool:
    error = err.response.get("Error", {})
    return error.get("Code") == "ValidationError" and "does not exist" in str(error.get("Message", ""))


@dataclass(frozen=True)
class Deployment:
    status: str
    outputs: dict[str, str]

    @property
    def shared_knowledge_base_id(self) -> str:
        return self.outputs["SharedKnowledgeBaseId"]

    @property
    def shared_data_source_id(self) -> str:
        return self.outputs["SharedDataSourceId"]

    @property
    def south_knowledge_base_id(self) -> str | None:
        return self.outputs.get("SouthKnowledgeBaseId")

    @property
    def south_data_source_id(self) -> str | None:
        return self.outputs.get("SouthDataSourceId")

    @property
    def tenant_role_tenants(self) -> list[str]:
        value = self.outputs.get("TenantRoleTenants", "")
        return [key for key in value.split(",") if key]

    def role_arn(self, prefix: str, tenant: str | None = None) -> str:
        key = prefix + pascal(tenant) if tenant else prefix
        if key not in self.outputs:
            raise UsageError(NO_ROLES)
        return self.outputs[key]


def describe(cloudformation: Any, region: str) -> Deployment:
    """Stack status and outputs. Exit 2 when the stack is missing, busy, failed, or missing an output."""
    try:
        stacks = cloudformation.describe_stacks(StackName=STACK_NAME)["Stacks"]
    except ClientError as err:
        if stack_missing(err):
            raise UsageError(
                f"stack {STACK_NAME} not found in {region}; deploy it first, or set AWS_REGION to the Region "
                f"you deployed to"
            ) from err
        raise aws_error(err) from err
    stack = stacks[0]
    status = str(stack["StackStatus"])
    if status.endswith("_IN_PROGRESS") or status.endswith("_FAILED"):
        raise UsageError(f"stack {STACK_NAME} is {status}; wait for it to finish or deploy again")
    outputs = {str(o["OutputKey"]): str(o["OutputValue"]) for o in stack.get("Outputs", [])}
    for key in REQUIRED_OUTPUTS:
        if not outputs.get(key):
            raise UsageError(f"stack outputs are missing {key}; deploy again")
    return Deployment(status, outputs)
