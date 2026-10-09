# Payments Service Deployment Runbook (Engineering - Restricted)

## Pre-deployment checks

1. Confirm the release candidate has passed integration tests in staging.
2. Confirm no active Sev-1 or Sev-2 incidents on the payments service.
3. Confirm the on-call engineer has acknowledged the deployment window.

## Deployment

Deployments run region by region, never in parallel. Wait for the bake period to complete
in each region before promoting to the next.

- Bake period: 30 minutes in the pilot region, 15 minutes thereafter.
- Rollback trigger: error rate above 0.5 percent, or p99 latency above 800 ms.

## Rollback

Promote the previous known-good version through the same pipeline. Do not hand-edit
production configuration to force a rollback; this desynchronizes the deployment state and
has caused longer outages than the original defect on two prior occasions.
