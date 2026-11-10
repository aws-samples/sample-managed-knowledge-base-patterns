"""AWS credentials, one set per end user.

The backend has one identity of its own (a Lambda execution role in production, the
developer's profile locally). It uses that identity for exactly one thing: AssumeRole of
the application role, once per end user, with three user markers:

  RoleSessionName  user-<sub>   appears in the ARN of every CloudTrail record for the call
  SourceIdentity   <sub>        recorded on every call and cannot be changed by the holder
  session tag      userId=<sub> read by IAM: the memory statements of the role compare
                                bedrock-agentcore:actorId / namespacePath against it

Every AWS call made for a user, including the memory calls that AgenticRetrieveStream
makes on the caller's behalf, therefore runs as that user's session. If application code
put another user's actorId on a request, IAM would deny the memory operations.

The role's trust policy (infra/setup.py) accepts only the backend's own principal and
requires the tag and the SourceIdentity, both in Cognito sub form.
"""

from __future__ import annotations

import datetime as dt
import os
import threading

import boto3

from identity import Principal

_REFRESH_MARGIN = dt.timedelta(minutes=5)


def base_session(region: str) -> boto3.Session:
    """The backend's own identity. AWS_PROFILE if set, else the default credential chain."""
    profile = os.environ.get("AWS_PROFILE")
    return boto3.Session(profile_name=profile, region_name=region) if profile else boto3.Session(region_name=region)


class UserSessions:
    def __init__(self, role_arn: str, region: str, base: boto3.Session | None = None):
        self.role_arn = role_arn
        self.region = region
        self._sts = (base or base_session(region)).client("sts")
        self._cache: dict[str, tuple[boto3.Session, dt.datetime]] = {}
        self._lock = threading.Lock()

    def for_user(self, principal: Principal) -> boto3.Session:
        with self._lock:
            hit = self._cache.get(principal.sub)
            if hit and hit[1] - _REFRESH_MARGIN > dt.datetime.now(dt.timezone.utc):
                return hit[0]
            c = self._sts.assume_role(
                RoleArn=self.role_arn,
                RoleSessionName=f"user-{principal.sub}"[:64],
                SourceIdentity=principal.sub,
                Tags=[{"Key": "userId", "Value": principal.sub}],
                DurationSeconds=3600,
            )["Credentials"]
            session = boto3.Session(aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
                                    aws_session_token=c["SessionToken"], region_name=self.region)
            self._cache[principal.sub] = (session, c["Expiration"])
            return session
