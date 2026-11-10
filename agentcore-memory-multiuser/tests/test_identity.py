"""Unit tests for backend/identity.py: ID token verification with a local RSA key.

The user pool's JWKS endpoint is stubbed, so these tests make no network calls.
"""

import base64
import hashlib
import hmac
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from identity import CognitoVerifier, Principal, rejection_detail

ISS = "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_EXAMPLE"
AUD = "exampleclientid"
KID = "test-kid"
SUB = "11111111-2222-3333-4444-555555555555"

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@pytest.fixture
def verifier(monkeypatch) -> CognitoVerifier:
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key()))
    jwk.update(kid=KID, alg="RS256", use="sig")
    # Stub only the HTTP fetch, so the real key selection in PyJWKClient runs.
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", lambda self: {"keys": [jwk]})
    return CognitoVerifier(ISS, AUD)


def claims(**overrides) -> dict:
    now = int(time.time())
    c = {"sub": SUB, "iss": ISS, "aud": AUD, "token_use": "id", "iat": now, "exp": now + 3600,
         "email": "maya@example.com", "email_verified": True, "cognito:username": "maya"}
    c.update(overrides)
    return {k: v for k, v in c.items() if v is not None}


def token(payload: dict, key=KEY, alg: str = "RS256", kid: str = KID) -> str:
    return jwt.encode(payload, key, algorithm=alg, headers={"kid": kid})


def test_valid_token(verifier):
    p = verifier.verify(token(claims(email="Maya@Example.com")))
    assert p == Principal(sub=SUB, email="maya@example.com", username="maya")
    assert p.actor_id == SUB
    assert p.acl_user_id == "maya@example.com"
    assert p.namespace_path("/anycompany") == f"/anycompany/{SUB}/"


def test_wrong_audience(verifier):
    with pytest.raises(jwt.InvalidAudienceError):
        verifier.verify(token(claims(aud="other")))


def test_wrong_issuer(verifier):
    with pytest.raises(jwt.InvalidIssuerError):
        verifier.verify(token(claims(iss="https://cognito-idp.us-west-2.amazonaws.com/us-west-2_OTHER")))


def test_expired(verifier):
    now = int(time.time())
    with pytest.raises(jwt.ExpiredSignatureError):
        verifier.verify(token(claims(iat=now - 7200, exp=now - 120)))


@pytest.mark.parametrize("claim", ["sub", "exp", "iat", "iss", "aud", "token_use"])
def test_missing_required_claim(verifier, claim):
    with pytest.raises(jwt.MissingRequiredClaimError):
        verifier.verify(token(claims(**{claim: None})))


def test_signed_with_another_key(verifier):
    with pytest.raises(jwt.InvalidSignatureError):
        verifier.verify(token(claims(), key=OTHER_KEY))


def test_unknown_kid(verifier):
    with pytest.raises(jwt.PyJWKClientError):
        verifier.verify(token(claims(), kid="nope"))


def test_alg_none(verifier):
    header = b64url(json.dumps({"alg": "none", "kid": KID}).encode())
    payload = b64url(json.dumps(claims()).encode())
    with pytest.raises(jwt.PyJWTError):
        verifier.verify(f"{header}.{payload}.")


def test_alg_confusion_hs256_with_public_key(verifier):
    # The classic RS256 -> HS256 confusion: HMAC keyed with the RSA public key.
    pem = KEY.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT", "kid": KID}).encode())
    payload = b64url(json.dumps(claims()).encode())
    sig = b64url(hmac.new(pem, f"{header}.{payload}".encode(), hashlib.sha256).digest())
    with pytest.raises(jwt.PyJWTError):
        verifier.verify(f"{header}.{payload}.{sig}")


def test_hs256_with_random_secret(verifier):
    with pytest.raises(jwt.PyJWTError):
        verifier.verify(token(claims(), key="a-random-secret-of-at-least-32-bytes!", alg="HS256"))


def test_access_token_rejected(verifier):
    with pytest.raises(jwt.InvalidTokenError):
        verifier.verify(token(claims(token_use="access")))


def test_missing_email(verifier):
    with pytest.raises(jwt.InvalidTokenError):
        verifier.verify(token(claims(email=None)))


@pytest.mark.parametrize("value", [False, "true", None])
def test_unverified_email(verifier, value):
    c = claims()
    if value is None:
        c.pop("email_verified")
    else:
        c["email_verified"] = value
    with pytest.raises(jwt.InvalidTokenError):
        verifier.verify(token(c))


def test_deeply_nested_payload_is_a_token_error(verifier):
    # CVE-2026-101918: PyJWT before 2.15.0 raised RecursionError here (HTTP 500).
    header = b64url(json.dumps({"alg": "RS256", "kid": KID}).encode())
    payload = b64url(("[" * 10_000 + "]" * 10_000).encode())
    with pytest.raises(jwt.PyJWTError):
        verifier.verify(f"{header}.{payload}.{b64url(bytes(256))}")


def test_garbage(verifier):
    with pytest.raises(jwt.DecodeError):
        verifier.verify("not-a-jwt")
    assert rejection_detail("not-a-jwt", jwt.DecodeError("x")) == "kid=None: x"


def test_hostile_kid_is_logged_escaped(verifier):
    # The kid is attacker-controlled and PyJWKClientError echoes it in its message.
    kid = "evil\n2026-01-01 INFO forged line \x1b[31mred\x1b[0m" + "A" * 100
    bad = token(claims(), kid=kid)
    with pytest.raises(jwt.PyJWKClientError) as exc:
        verifier.verify(bad)
    detail = rejection_detail(bad, exc.value)
    assert "\n" not in detail and "\x1b" not in detail
    assert "evil\\n2026" in detail and "\\x1b[31m" in detail
    logged_kid = detail.split(": ", 1)[0].removeprefix("kid=")
    assert logged_kid == kid[:64].encode("unicode_escape").decode("ascii")
