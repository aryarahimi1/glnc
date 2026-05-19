# Security Policy

## Reporting a Vulnerability

If you've found a security vulnerability in glnc, please report it privately.

**Email:** rahimiarya13@gmail.com

Please include:
- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- Affected version(s) and platform(s)
- Any suggested mitigation, if you have one

**Do not** open a public GitHub issue or pull request for security reports.

## What to Expect

- Acknowledgement within **72 hours** of your report.
- An initial assessment and triage within **7 days**.
- Coordinated disclosure: I'll work with you on a fix and timeline before any public disclosure.

## Scope

In scope:
- The `glnc` CLI binary and its installation paths (Homebrew tap, install script).
- Webhook delivery (`glnc alert`) — including SSRF, request smuggling, or signature forgery.
- JSON/NDJSON output envelopes consumed by downstream automation.
- Build and release artifacts published under this repository's GitHub Releases.

Out of scope:
- Vulnerabilities in upstream RPC providers or third-party APIs.
- Issues that require physical access to the user's machine.
- Reports that depend on already-compromised credentials or the user knowingly running malicious input.

## Webhook redirect policy

`glnc alert` webhook delivery uses `redirect: 'error'` on the underlying HTTP client: **redirects are never followed**. A 3xx response is treated as a failed delivery and may be retried (for 5xx-style retry rules), not chased to a new host. This closes SSRF rebinding via redirect-to-internal-IP.

Thanks for helping keep glnc and its users safe.
