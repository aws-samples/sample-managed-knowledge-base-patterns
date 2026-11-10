# AnyCompany Laptop Setup Guide

All AnyCompany laptops are managed devices. Both macOS and Windows laptops are managed with the AnyCompany device management service.

## First boot

1. Connect to Wi-Fi and sign in with your SSO credentials when prompted. The device enrolls automatically.
2. Wait for the baseline applications to install: the chat app, the video conferencing client, a web browser, the password manager, and the VPN client. This takes 15 to 30 minutes.
3. Turn on disk encryption if it is not already enabled. FileVault is enforced on macOS and BitLocker on Windows.

## Installing software

- macOS: use the Self Service app for approved applications. Homebrew is permitted for engineers; install it from Self Service so the managed configuration is applied.
- Windows: use the Company Portal app. Administrator rights are granted on request through #it-help for engineering roles.

## Developer tools

Engineers get a container runtime, a code editor, and the AWS CLI through Self Service or Company Portal. The AnyCompany CLI (anycompany-cli) is installed with `brew install anycompany/tap/anycompany-cli` on macOS or `winget install AnyCompany.CLI` on Windows.

## Replacement and refresh

Laptops are refreshed every three years. To request a repair or replacement, open a ticket in #it-help. Frankfurt employees can also visit the IT desk on the 4th floor between 10:00 and 16:00. Seattle employees can visit the IT desk on floor 12.

## Lost or stolen devices

Report a lost or stolen laptop immediately in #it-help or by calling the security hotline. IT will remotely lock and wipe the device.
