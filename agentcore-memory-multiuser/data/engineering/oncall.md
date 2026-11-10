# AnyCompany On-Call Guide

On-call is organized per team in the paging tool. Every engineer joins their team's rotation after completing onboarding and at least four weeks of shadowing.

## Rotation

Rotations are one week long and start on Monday at 10:00 in the team's primary office time zone. The Platform team runs a follow-the-sun rotation between Frankfurt and Seattle: Frankfurt covers 08:00 to 20:00 CET and Seattle covers 08:00 to 20:00 Pacific, so no engineer is paged overnight.

## Severity levels

- SEV1: customer-facing outage. Page immediately, open an incident channel, and start a bridge call. Update the status page within 15 minutes.
- SEV2: degraded service with a workaround. Page during business hours; otherwise handle at the start of the next shift.
- SEV3: no customer impact. Create a ticket; no page.

## Responding to a page

1. Acknowledge within five minutes.
2. Check the service dashboards and recent deployments in the developer portal.
3. If a recent deployment is the likely cause, roll back first and investigate afterwards.
4. Escalate to the secondary on-call if you cannot make progress within 30 minutes.

## Compensation

On-call weeks are compensated with a fixed stipend of 500 USD or 450 EUR per week, plus time off in lieu for any SEV1 handled outside business hours.

## Handover

Hold a 15-minute handover at the end of each rotation covering open incidents and known risks.
