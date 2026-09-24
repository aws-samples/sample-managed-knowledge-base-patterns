#!/usr/bin/env bash
#
# Asserts that the backend's import boundaries are actually enforced.
#
# Two restrictions are declared in `backend/eslint.config.mjs`:
#
#   1. Bedrock SDK clients may only be imported under `src/providers/`. This keeps
#      SDK types out of the rest of the application and, because the provider
#      layer is where the user's identity is attached to outbound calls, keeps
#      the security-relevant call sites reviewable. See SECURITY.md.
#
#   2. Test doubles under `src/domain/testing/` may only be imported by specs, so
#      fixture data can never ship in a production build.
#
# Both live in a config file and can be weakened by editing it, so this script
# probes the full matrix of (location, import kind) and fails if any cell differs
# from the expectation.
#
# Run from anywhere:
#   ./scripts/check-import-boundaries.sh
#
# Implementation notes, each load-bearing:
#
#  * ESLint runs with the backend as its working directory. It discovers flat
#    config relative to cwd, so invoking it from the repository root — where
#    there is no config — applies no rules and reports no violations, making
#    every check pass while verifying nothing.
#
#  * Output is parsed as JSON, not grepped. Both text approaches produce false
#    passes: grepping the rule id matches an ESLint *config error* naming the
#    rule, and grepping the rule's message matches the config dump ESLint prints
#    in a crash stack trace. Unparseable output is therefore treated as "the rule
#    did not fire".
#
#  * Output is captured into a variable rather than piped, because ESLint exits
#    non-zero whenever it reports anything and under `pipefail` a pipeline adopts
#    that failure even when the matcher succeeds.
#
#  * Flat config *replaces* rule options rather than merging them, so two blocks
#    matching one file cannot each contribute a pattern. That is the specific
#    mistake this matrix is designed to catch.

set -u

RULE_ID='no-restricted-imports'
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../backend" && pwd)"
cd "$BACKEND_DIR" || exit 1

PROBES=()
cleanup() {
  local probe
  for probe in "${PROBES[@]:-}"; do
    [ -n "$probe" ] && rm -f "$probe"
  done
}
trap cleanup EXIT

# Prints "BLOCKED" if the restriction fired, "allowed" if it did not.
rule_fired() {
  local report
  report="$(npx eslint --format json "$1" 2>/dev/null || true)"
  RULE_ID="$RULE_ID" node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const results = JSON.parse(raw);
        const fired = results
          .flatMap((r) => r.messages ?? [])
          .some((m) => m.ruleId === process.env.RULE_ID);
        process.stdout.write(fired ? "BLOCKED" : "allowed");
      } catch {
        process.stdout.write("allowed");
      }
    });
  ' <<< "$report"
}

# check <description> <probe-path> <import-statement> <BLOCKED|allowed>
status=0
check() {
  local description="$1" probe="$2" statement="$3" expected="$4"
  mkdir -p "$(dirname "$probe")"
  printf '%s\nexport const probe = 1;\n' "$statement" > "$probe"
  PROBES+=("$probe")

  local actual
  actual="$(rule_fired "$probe")"
  rm -f "$probe"

  if [ "$actual" = "$expected" ]; then
    printf '  ok    %-46s %s\n' "$description" "$actual"
  else
    printf '  FAIL  %-46s expected %s, got %s\n' "$description" "$expected" "$actual"
    status=1
  fi
}

VENDOR="import '@aws-sdk/client-bedrock-agent-runtime';"
DOUBLE_FROM_MODULES="import '../domain/testing/in-memory-retrieval-provider.js';"
DOUBLE_FROM_PROVIDERS="import '../../domain/testing/in-memory-retrieval-provider.js';"
DOUBLE_FROM_SELF="import './in-memory-retrieval-provider.js';"

echo 'Import boundary matrix:'

# Bedrock SDK: permitted only under src/providers/.
check 'Bedrock SDK from application code' \
  'src/modules/__boundary_probe.ts' "$VENDOR" BLOCKED
check 'Bedrock SDK from the provider layer' \
  'src/providers/bedrock/__boundary_probe.ts' "$VENDOR" allowed
check 'Bedrock SDK from a test double' \
  'src/domain/testing/__boundary_probe.ts' "$VENDOR" BLOCKED
check 'Bedrock SDK from an application spec' \
  'src/modules/__boundary_probe.spec.ts' "$VENDOR" BLOCKED
check 'Bedrock SDK from a provider spec' \
  'src/providers/bedrock/__boundary_probe.spec.ts' "$VENDOR" allowed

# Test doubles: permitted only from specs (and from within domain/testing itself).
check 'test double from application code' \
  'src/modules/__boundary_probe.ts' "$DOUBLE_FROM_MODULES" BLOCKED
check 'test double from the provider layer' \
  'src/providers/bedrock/__boundary_probe.ts' "$DOUBLE_FROM_PROVIDERS" BLOCKED
check 'test double from a sibling test double' \
  'src/domain/testing/__boundary_probe.ts' "$DOUBLE_FROM_SELF" allowed
check 'test double from an application spec' \
  'src/modules/__boundary_probe.spec.ts' "$DOUBLE_FROM_MODULES" allowed

if [ "$status" -eq 0 ]; then
  echo 'Import boundaries enforced.'
else
  echo
  echo 'One or more import boundaries are not enforced as intended.'
  echo 'See SECURITY.md and the block comments in backend/eslint.config.mjs.'
fi

exit "$status"
