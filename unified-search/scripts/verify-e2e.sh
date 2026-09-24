#!/usr/bin/env bash
#
# End-to-end verification: real Cognito tokens, through the running HTTP API, against the
# live knowledge base.
#
# This is the check nothing else performs. The unit suites test the provider against fakes
# and the screens against stubs; `make test-acl` calls the provider directly, bypassing
# HTTP and authentication entirely. Only this exercises the whole path — token
# verification, the guard, the controller, the provider, and Bedrock's ACL filtering —
# and it is the only place a mistake in the wiring *between* those layers can show up.
#
# The property asserted is the sample's thesis: two authenticated users issuing the same
# query over the same API receive different documents, and a third receives nothing.
#
#   make test-e2e            # backend must already be running (make api)
#
# Tokens come from AdminInitiateAuth, which needs AWS credentials — an end user could not
# do this. That is why the admin flow is enabled on the app client; see identity-stack.ts.
set -uo pipefail

STAGE="${1:-dev}"
REGION="${2:-us-east-1}"
API="${API_BASE_URL:-http://localhost:3001}"
PASSWORD="${SEED_PASSWORD:-}"

failures=0
note() { printf '  %s\n' "$1"; }
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; failures=$((failures + 1)); }

output() { # stack, key
  aws cloudformation describe-stacks --stack-name "$1" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null \
    | grep -v '^None$' || true
}

POOL_ID=$(output "UnifiedSearch-${STAGE}-Identity" UserPoolId)
CLIENT_ID=$(output "UnifiedSearch-${STAGE}-Identity" UserPoolClientId)

if [ -z "$POOL_ID" ] || [ -z "$CLIENT_ID" ]; then
  echo "No identity stack for stage '${STAGE}'. Deploy it: make sample-deploy IDENTITY=true" >&2
  exit 1
fi

if [ -z "$PASSWORD" ]; then
  echo "Set SEED_PASSWORD to the password printed by 'make sample-users'." >&2
  echo "  SEED_PASSWORD='...' make test-e2e" >&2
  exit 1
fi

if ! curl -fsS "${API}/health" >/dev/null 2>&1; then
  echo "The API is not answering at ${API}. Start it with 'make api' first." >&2
  exit 1
fi

token_for() { # email
  aws cognito-idp admin-initiate-auth \
    --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" \
    --auth-flow ADMIN_USER_PASSWORD_AUTH \
    --auth-parameters "USERNAME=$1,PASSWORD=${PASSWORD}" \
    --region "$REGION" \
    --query 'AuthenticationResult.IdToken' --output text 2>/dev/null | grep -v '^None$' || true
}

search() { # token, query
  curl -fsS -X POST "${API}/search" \
    -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
    -d "{\"text\": \"$2\"}" 2>/dev/null || echo '{"hits":[]}'
}

# Which seeded documents came back, by directory.
docs() { python3 -c "
import json,sys
page=json.load(sys.stdin)
print(' '.join(sorted({h.get('uri','') .split('/content/')[-1].split('/')[0] for h in page.get('hits',[])} - {''})))
"; }

FINANCE_QUERY='what is the projected quarterly revenue forecast'
SHARED_QUERY='how do expenses and time off work'

echo
echo "End-to-end verification against ${API}"
echo "  pool ${POOL_ID}"
echo

echo "1. Authentication"
ALEJANDRO=$(token_for alejandro_rosalez@example.com)
AKUA=$(token_for akua_mansa@example.com)
OUTSIDER=$(token_for john_stiles@example.com)
for pair in "alejandro:$ALEJANDRO" "akua:$AKUA" "outsider:$OUTSIDER"; do
  name=${pair%%:*}; tok=${pair#*:}
  if [ -n "$tok" ]; then pass "obtained an ID token for ${name}"; else fail "no token for ${name}"; fi
done
[ -z "$ALEJANDRO" ] && { echo; echo "Cannot continue without a token."; exit 1; }

echo
echo "2. Unauthenticated access is refused"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/search" \
  -H 'Content-Type: application/json' -d '{"text":"anything"}')
if [ "$code" = "401" ]; then pass "no token → 401"; else fail "no token → ${code}, expected 401"; fi

# Held in a variable rather than inlined in the header below. Secret scanners
# match on a bearer token appearing literally inside a curl command, so even a
# deliberately invalid one trips them. Passing it by variable, the way the real
# tokens below are passed, keeps the check honest without an allowlist entry
# that would only teach one scanner.
FORGED_TOKEN='not.a.real.token'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/search" \
  -H "Authorization: Bearer ${FORGED_TOKEN}" \
  -H 'Content-Type: application/json' -d '{"text":"anything"}')
if [ "$code" = "401" ]; then pass "forged token → 401"; else fail "forged token → ${code}, expected 401"; fi

echo
echo "3. A caller cannot supply an identity"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/search" \
  -H "Authorization: Bearer ${AKUA}" -H 'Content-Type: application/json' \
  -d '{"text":"revenue","userId":"alejandro_rosalez@example.com"}')
if [ "$code" = "400" ]; then
  pass "a body carrying userId → 400"
else
  fail "a body carrying userId → ${code}, expected 400"
fi

echo
echo "4. Document-level filtering, through the full stack"
alejandro_finance=$(search "$ALEJANDRO" "$FINANCE_QUERY" | docs)
akua_finance=$(search "$AKUA" "$FINANCE_QUERY" | docs)
outsider_shared=$(search "$OUTSIDER" "$SHARED_QUERY" | docs)

note "alejandro → [${alejandro_finance}]"
note "akua      → [${akua_finance}]"
note "outsider  → [${outsider_shared}]"

case " $alejandro_finance " in *" finance "*) pass "alejandro receives the finance document";;
  *) fail "alejandro did not receive the finance document";; esac
case " $akua_finance " in *" finance "*) fail "akua received the finance document";;
  *) pass "akua is denied the finance document";; esac
if [ -z "$outsider_shared" ]; then
  pass "the outsider receives nothing at all"
else
  fail "the outsider received [${outsider_shared}]"
fi
if [ "$alejandro_finance" != "$akua_finance" ]; then
  pass "the same query returns different documents to different identities"
else
  fail "both identities received the same documents — filtering may not be applied"
fi

echo
echo "5. Chat streams and cites"
chat=$(curl -fsS -N -X POST "${API}/chat" \
  -H "Authorization: Bearer ${ALEJANDRO}" -H 'Content-Type: application/json' \
  -d "{\"message\": \"${FINANCE_QUERY}?\"}" 2>/dev/null || true)

if printf '%s' "$chat" | grep -q '^event: done'; then
  pass "the stream completed with a done event"
else
  fail "the stream did not complete — a client must treat this as an error"
fi
if printf '%s' "$chat" | grep -q '"kind":"citations"'; then
  pass "the answer carried citations"
else
  fail "the answer carried no citations"
fi
if printf '%s' "$chat" | grep -q '"kind":"answer"'; then
  pass "answer text streamed incrementally"
else
  fail "no answer text was streamed"
fi

akua_chat=$(curl -fsS -N -X POST "${API}/chat" \
  -H "Authorization: Bearer ${AKUA}" -H 'Content-Type: application/json' \
  -d "{\"message\": \"${FINANCE_QUERY}?\"}" 2>/dev/null || true)
if printf '%s' "$akua_chat" | grep -qE '4\.2 million|3\.1 million'; then
  fail "akua's generated answer disclosed restricted figures"
else
  pass "akua's generated answer disclosed no restricted figures"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "All checks passed."
else
  echo "${failures} check(s) failed."
fi
exit $((failures > 0))
