# Responsible Use

ditto.site compiles observed public web pages into self-contained application
code. That capability is useful for migration, testing, research, preservation,
accessibility review, and design-system analysis, but it can also be misused.

Use this project only where you have the right to inspect, copy, transform, and
operate on the target content.

## Acceptable Use

- Clone sites you own, maintain, or have permission to analyze.
- Use public examples for research, benchmarking, compatibility tests, or bug
  reports when the output is not represented as the original publisher's
  official site.
- Respect robots, rate limits, terms of service, trademarks, and copyright.
- Keep generated output clearly separated from the original brand or publisher
  unless you are authorized to represent them.
- Remove private data, credentials, customer information, and internal URLs from
  captures, artifacts, logs, and issues before sharing them.

## Prohibited Use

- Do not use ditto.site for phishing, impersonation, credential capture, fraud,
  malware delivery, or brand confusion.
- Do not bypass authentication, paywalls, access controls, bot protections, or
  technical restrictions.
- Do not clone private, confidential, or personal data without authorization.
- Do not run high-volume capture jobs against third-party sites without
  permission.
- Do not use generated output to infringe copyrights, trademarks, or licenses.

## Public Service Deployments

A hosted clone endpoint is a fetch-any-URL system. Keep the protections described
in [SECURITY.md](../SECURITY.md) enabled:

- SSRF protection stays on in production.
- API keys and rate limits are configured.
- Worker concurrency is sized so capture jobs do not overload targets or your
  own infrastructure.
- Artifacts have an expiration, access policy, or deletion path appropriate for
  the data they may contain.

Maintainers may close issues, remove examples, or decline changes that would
make misuse materially easier.
