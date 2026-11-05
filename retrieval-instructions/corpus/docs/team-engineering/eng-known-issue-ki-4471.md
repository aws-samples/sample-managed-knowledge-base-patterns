# Known issue KI-4471: AnySmartProduct-6 restarts on firmware 5.3.2
Doc ID: MT-D31
Version: 1.2
Effective date: 2026-09-15
Status: Resolved in 5.3.3 as of 2026-10-01
Owner: Arnav Desai
Scope: Engineering only (restricted test content)
---
## Restricted
This record is restricted to the engineering team. It must not be shared with customers, partners, support macros or sales material.

## Symptom
Some AnySmartProduct-6 room sensors restart unexpectedly after updating to firmware 5.3.2. Restarts happen at night, when the sensor wakes for a reading.

## Root cause
The watchdog timer in firmware 5.3.2 is set to 8 seconds. When the battery cell voltage drops below 2.4 V during the radio wake-up, the reading takes longer than the watchdog timer allows, and the sensor restarts.

## Fix
Firmware 5.3.3 lengthens the watchdog timer and staggers the radio wake-up. Field data after 5.3.3 shows no new restarts from this cause.

## Affected units
Sensors with older batteries are most affected. New batteries rarely drop below the threshold.

## Customer communication
Customers are told only that 5.3.3 fixes unexpected restarts. The root cause, the timer value and the voltage threshold are not shared outside engineering.
---
Synthetic demo content. AnyCompany is a fictitious company. Not a real policy.
