"""Identity: verify the Cognito ID token and derive every user-scoped identifier from it.

This module is the security boundary of the application. Nothing that scopes memory
(actorId, namespace) or document access (userContext.userId) may come from the request
body; it is all derived here from claims that Cognito signed.

In production the token is usually validated by an API Gateway JWT authorizer and the
claims arrive in the request context. Running locally, this module performs the same
validation so the handler code is identical in both deployments.
"""

from __future__ import annotations

import dataclasses
import time

import httpx
import jwt
from jwt import PyJWKClient


@dataclasses.dataclass(frozen=True)
class Principal:
    """The verified end user. Two claims, two jobs."""

    sub: str       # Cognito user ID: stable, never reassigned -> memory actorId
    email: str     # verified, immutable in this pool -> userContext.userId (document ACLs)
    username: str

    @property
    def actor_id(self) -> str:
        # actorId is the isolation boundary for short-term memory and the {actorId}
        # placeholder in long-term memory namespaces. It must be stable for the life of
        # the user and never reused. The sub is both; an email can be changed or, after
        # someone leaves, given to a new person, who would then inherit the old memory.
        return self.sub

    @property
    def acl_user_id(self) -> str:
        # Managed knowledge bases match document ACLs on the user's email address.
        return self.email

    def namespace_path(self, root: str) -> str:
        # Resolved literal for retrievalConfigs. Because every strategy in the memory
        # puts {actorId} directly under the root, one namespacePath reaches all
        # long-term records about this user and none about anyone else. The trailing
        # slash matches the IAM condition /anycompany/${aws:PrincipalTag/userId}/*.
        return f"{root}/{self.sub}/"


class CognitoVerifier:
    def __init__(self, issuer: str, client_id: str):
        self.issuer = issuer
        self.client_id = client_id
        self._jwks = PyJWKClient(f"{issuer}/.well-known/jwks.json", cache_keys=True)

    def verify(self, token: str) -> Principal:
        """Validate an ID token and return the Principal.

        Checks the signature against the user pool's public keys, the issuer, the expiry,
        the audience (this app client), that it is an ID token (only ID tokens carry
        email), and that the email is verified. Raises jwt.PyJWTError on any failure; the
        caller maps that to HTTP 401.
        """
        signing_key = self._jwks.get_signing_key_from_jwt(token)
        claims = jwt.decode(token, signing_key.key, algorithms=["RS256"],
                            issuer=self.issuer, audience=self.client_id,
                            options={"require": ["sub", "exp", "iat", "iss", "aud", "token_use"]})
        if claims.get("token_use") != "id":
            raise jwt.InvalidTokenError("an ID token is required (access tokens carry no email)")
        email = claims.get("email")
        if not email or claims.get("email_verified") is not True:
            raise jwt.InvalidTokenError("a verified email claim is required")
        return Principal(
            sub=claims["sub"],
            email=email.lower(),
            username=claims.get("cognito:username") or claims["sub"],
        )


def _log_safe(value: object, limit: int) -> str:
    # Truncate, then escape newlines, ANSI escapes and other non-printables so a crafted
    # token cannot forge or garble log lines.
    return str(value)[:limit].encode("unicode_escape").decode("ascii")


def rejection_detail(token: str, exc: Exception) -> str:
    """Log text for a rejected token. The kid comes from the unverified header and PyJWT
    error messages can echo it, so both are escaped and truncated."""
    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError:
        kid = None
    return f"kid={_log_safe(kid, 64)}: {_log_safe(exc, 200)}"


def sign_in(region: str, client_id: str, username: str, password: str) -> dict:
    """Test helper: USER_PASSWORD_AUTH sign-in that returns the token set.

    Real applications use Cognito managed login or Amplify; this keeps the local demo
    and the end-to-end test self-contained.
    """
    url = f"https://cognito-idp.{region}.amazonaws.com/"
    body = {
        "AuthFlow": "USER_PASSWORD_AUTH",
        "ClientId": client_id,
        "AuthParameters": {"USERNAME": username, "PASSWORD": password},
    }
    headers = {"Content-Type": "application/x-amz-json-1.1",
               "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth"}
    resp = httpx.post(url, json=body, headers=headers, timeout=20)
    resp.raise_for_status()
    result = resp.json()["AuthenticationResult"]
    result["obtained_at"] = time.time()
    return result
