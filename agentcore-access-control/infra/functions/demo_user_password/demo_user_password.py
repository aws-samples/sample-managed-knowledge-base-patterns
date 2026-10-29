"""CloudFormation custom resource that sets the password of the demo users.

The resource properties carry only the secret ARN, the user pool ID, and the
user names. The function reads the password from AWS Secrets Manager and sets
it with ``AdminSetUserPassword``, so the password never becomes a resource
property, a response field, or a log line. A value passed as a property would
appear in the stack events and in the logs of the custom resource provider.
"""

import logging
from typing import Any

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

PHYSICAL_RESOURCE_ID = "demo-user-password"


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Entry point for the custom resource provider framework.

    Args:
        event: Custom resource event with ``SecretArn``, ``UserPoolId``, and
            ``Usernames`` in ``ResourceProperties``.
        context: Lambda context (unused).

    Returns:
        The physical resource ID, without any data.
    """
    request_type = event["RequestType"]
    properties = event["ResourceProperties"]
    usernames: list[str] = properties["Usernames"]
    # Deleting the user pool deletes the users, so Delete has nothing to undo.
    if request_type in ("Create", "Update"):
        password = boto3.client("secretsmanager").get_secret_value(
            SecretId=properties["SecretArn"]
        )["SecretString"]
        cognito = boto3.client("cognito-idp")
        for username in usernames:
            cognito.admin_set_user_password(
                UserPoolId=properties["UserPoolId"],
                Username=username,
                Password=password,
                Permanent=True,
            )
    logger.info("requestType=%s users=%d", request_type, len(usernames))
    return {"PhysicalResourceId": PHYSICAL_RESOURCE_ID}
