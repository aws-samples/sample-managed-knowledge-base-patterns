# AnyCompany VPN Setup Guide

AnyCompany uses the AnyCompany VPN client for VPN access to internal systems. The setup steps differ by operating system.

## macOS

1. Open the Self Service app from the Applications folder and install the VPN client.
2. Launch the VPN client and enter the gateway for your office: vpn-fra.anycompany.example for Frankfurt or vpn-sea.anycompany.example for Seattle and Toronto.
3. Sign in with your AnyCompany single sign-on (SSO) credentials. Approve the sign-in push notification or tap your hardware key.
4. On first connection, macOS asks to allow the VPN client's system extension. Approve it in System Settings under Privacy and Security, then reconnect.

## Windows

1. Open the Company Portal app and install the VPN client.
2. Launch the client and enter the gateway for your office (see above).
3. Sign in with SSO. If the SSO prompt does not appear, clear the client's saved profile under Preferences and try again.

## Common problems

- Error "Login denied, unauthorized connection mechanism": your account is not in the VPN access group. Open a ticket in #it-help.
- Repeated disconnects on macOS: disable the Private Relay feature in iCloud settings, which conflicts with the VPN tunnel.
- Slow connection from Frankfurt: make sure you use the vpn-fra gateway. The Seattle gateway adds about 150 ms of latency from Europe.

## Split tunneling

Only traffic to internal address ranges goes through the VPN. Internet traffic uses your local connection. This cannot be changed by users.
