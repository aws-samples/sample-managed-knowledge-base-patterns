# AnyCompany Platform Deployment Runbook

This runbook describes how services owned by the Platform organization are deployed. It applies to all teams that deploy through the shared pipelines in the developer portal.

## Environments

Every service has three environments: dev, staging, and prod. Deployments promote through them in order. Prod deployments to the EU region (eu-central-1) and the US region (us-west-2) roll out in that order, with a 30-minute bake time between regions.

## Deploying a change

1. Merge your pull request to main. The pipeline builds the container image and deploys to dev automatically.
2. Run the integration test suite against dev with `anycompany-cli test integration --env dev`.
3. Promote to staging in the developer portal. A second engineer from your team must approve the promotion.
4. Promote to prod. Prod promotions are blocked during the change freeze windows listed in the Release Calendar and outside business hours (08:00 to 18:00 in the deploying engineer's local time) unless the change is a hotfix.

## Rollback

Use `anycompany-cli deploy rollback --service <name> --env prod` to roll back to the previous image. Rollbacks do not require approval and complete within five minutes.

## Feature flags

Use the feature flag service for gradual rollouts. New features should ship behind a flag that is off in prod and enabled for internal users first.

## Database migrations

Migrations run as a separate pipeline step before the application deploys. Migrations must be backward compatible with the previous application version because the two run side by side during rollout.
