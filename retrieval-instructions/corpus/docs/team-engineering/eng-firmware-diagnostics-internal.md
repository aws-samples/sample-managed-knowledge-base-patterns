# Firmware diagnostics, internal
Doc ID: MT-D32
Version: 0.9
Effective date: 2026-09-20
Status: Draft as of 2026-10-01
Owner: Paulo Santos
Scope: Engineering only (restricted test content)
---
## Restricted
This page is restricted to the engineering team. It is not customer guidance.

## Reading the restart counter
The AnySmartProduct-6 keeps a restart counter that engineering can read through the diagnostics mode of the AnySmartProduct-5. A rising counter on 5.3.2 with a low battery reading points to KI-4471, the watchdog timer issue.

## Battery voltage log
The diagnostics mode shows the last 50 battery voltage readings. Readings below 2.4 V during radio wake-up match the KI-4471 pattern.

## When to ask for a unit back
Engineering asks for a unit back only when restarts continue on 5.3.3 with a battery reading above the threshold. These cases arrive through support escalation ESC-2.

## Lab notes
Lab tests on 5.3.3 used a bench supply stepped down in small increments. No restarts were seen at any tested voltage.
---
Synthetic demo content. AnyCompany is a fictitious company. Not a real policy.
