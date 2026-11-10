"""Unit tests for the IAM documents and principal resolution in infra/setup.py. No AWS calls."""

import importlib.util
import json
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("anycompany_setup", ROOT / "infra" / "setup.py")
setup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(setup)

ACCOUNT = "123456789012"
KB_ARN = f"arn:aws:bedrock:us-west-2:{ACCOUNT}:knowledge-base/KB_ID"
MEMORY_ARN = f"arn:aws:bedrock-agentcore:us-west-2:{ACCOUNT}:memory/MEMORY_ID"
BACKEND_ARN = f"arn:aws:iam::{ACCOUNT}:role/BACKEND_ROLE"


class FakeIam:
    def __init__(self):
        self.calls = []

    def get_role(self, RoleName):  # boto3 parameter name
        self.calls.append(RoleName)
        return {"Role": {"Arn": f"arn:aws:iam::{ACCOUNT}:role/aws-reserved/sso.amazonaws.com/{RoleName}"}}


def test_assumed_role_resolves_to_role_arn_with_path():
    iam = FakeIam()
    arn = setup.resolve_backend_principal_arn(
        iam, ACCOUNT, f"arn:aws:sts::{ACCOUNT}:assumed-role/AWSReservedSSO_Admin_abc/dev@example.com")
    assert arn == f"arn:aws:iam::{ACCOUNT}:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_abc"
    assert iam.calls == ["AWSReservedSSO_Admin_abc"]


@pytest.mark.parametrize("arn", [
    f"arn:aws:iam::{ACCOUNT}:role/service-role/backend-lambda-role",
    f"arn:aws:iam::{ACCOUNT}:user/developer",
])
def test_iam_role_or_user_passes_through(arn):
    iam = FakeIam()
    assert setup.resolve_backend_principal_arn(iam, ACCOUNT, arn) == arn
    assert iam.calls == []


@pytest.mark.parametrize("arn", [
    f"arn:aws:iam::{ACCOUNT}:root",
    f"arn:aws:sts::{ACCOUNT}:federated-user/developer",
    "arn:aws:iam::210987654321:role/backend",
    "arn:aws:sts::210987654321:assumed-role/backend/session",
    "not-an-arn",
])
def test_unsupported_principal_exits(arn):
    with pytest.raises(SystemExit):
        setup.resolve_backend_principal_arn(FakeIam(), ACCOUNT, arn)


def test_trust_policy_document():
    sub = "????????-????-????-????-????????????"
    root = {"AWS": f"arn:aws:iam::{ACCOUNT}:root"}
    backend = {"aws:PrincipalArn": BACKEND_ARN}
    keys = {"aws:TagKeys": ["userId"]}
    assert setup.app_role_trust_policy(ACCOUNT, BACKEND_ARN) == {
        "Version": "2012-10-17",
        "Statement": [
            {"Sid": "BackendAssumesRolePerUser", "Effect": "Allow", "Principal": root, "Action": "sts:AssumeRole",
             "Condition": {"ArnEquals": backend,
                           "StringLike": {"aws:RequestTag/userId": sub, "sts:SourceIdentity": sub},
                           "ForAllValues:StringEquals": keys}},
            {"Sid": "BackendTagsSessionWithUserId", "Effect": "Allow", "Principal": root, "Action": "sts:TagSession",
             "Condition": {"ArnEquals": backend, "StringLike": {"aws:RequestTag/userId": sub},
                           "ForAllValues:StringEquals": keys}},
            {"Sid": "BackendSetsSourceIdentity", "Effect": "Allow", "Principal": root,
             "Action": "sts:SetSourceIdentity",
             "Condition": {"ArnEquals": backend, "StringLike": {"sts:SourceIdentity": sub}}},
        ],
    }


def test_permissions_policy_has_no_model_invocation():
    policy = setup.app_role_policy(KB_ARN, MEMORY_ARN)
    actions = [a for s in policy["Statement"] for a in ([s["Action"]] if isinstance(s["Action"], str) else s["Action"])]
    assert "bedrock:InvokeModelWithResponseStream" not in actions


def test_namespace_condition_has_separator():
    policy = setup.app_role_policy(KB_ARN, MEMORY_ARN)
    stmt = next(s for s in policy["Statement"] if s["Sid"] == "MemoryRecordsScopedToCaller")
    assert stmt["Condition"]["StringLike"]["bedrock-agentcore:namespacePath"].endswith("/${aws:PrincipalTag/userId}/*")


def test_reader_copies_match_the_code():
    # infra/*.json are the documents setup.py applies, with placeholder identifiers.
    policy = json.loads((ROOT / "infra" / "app-role-policy.json").read_text())
    trust = json.loads((ROOT / "infra" / "app-role-trust-policy.json").read_text())
    assert policy == setup.app_role_policy(KB_ARN, MEMORY_ARN)
    assert trust == setup.app_role_trust_policy(ACCOUNT, BACKEND_ARN)
