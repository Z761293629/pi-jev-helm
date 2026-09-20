# Security Policy

Pi Jev Helm is a **Public Preview**: an externally installable pre-stable
release. Support is **best-effort** — there is no response-time commitment and
no guaranteed fix timeline.

## Supported preview versions

| Version or ref | Status |
| --- | --- |
| Current `v0.1.x` tag (Public Preview) | Supported. Security fixes ship as a new patch tag. |
| Older published tags in the `v0.1.x` line | Superseded. Upgrade to the current patch tag. |
| `main` (unreleased) | Best-effort only. Testers following `main` accept unreleased changes. |

Within the `v0.1.x` preview line, patch releases preserve the user-facing
configuration schema and command grammar; breaking changes require a new minor
version and migration notes. Published tags are immutable: a release with a
security defect is superseded by a new patch version, never fixed by moving an
existing tag.

## Reporting a vulnerability

Report security vulnerabilities **privately through GitHub Private
Vulnerability Reporting**:

1. Open the repository's **Security** tab and choose **Report a
   vulnerability**, or go directly to
   <https://github.com/Z761293629/pi-jev-helm/security/advisories/new>.
2. Describe the issue, its impact, and reproduction steps.
3. Attach only sanitized evidence, following the prohibited-content rules
   below.

This is the only security intake. **Do not report vulnerabilities through any
other channel:**

- Do not open a public issue for a vulnerability — not even a redacted one.
- Do not contact maintainers by private email or social media. No such channel
  is monitored for security reports, and asking for one adds delay.

Public Preview support is best-effort: Private Vulnerability Reporting is the
monitored intake, but acknowledgment, triage decisions, and fixes carry no
response-time commitment.

## What belongs in a security report

Reports about the following are especially relevant to Pi Jev Helm:

- Exposure of API keys or other credentials in logs, session entries, error
  output, or the footer status.
- User message or prompt content leaking into records that are supposed to
  exclude it, such as Routing Explanations or session routing entries.
- Fail-open behavior that routes work to an unexpected model, or a Route
  Target that applies outside its Routed Run.
- Configuration or checkpoint state read from, written to, or transmitted to
  unexpected locations.

## Prohibited content in any report or issue

Never include the following in a security report, bug report, feature request,
or comment — public or private:

- **API keys, tokens, or other credentials**, including partial keys that
  still resemble real ones.
- **Raw sensitive prompts** — real user messages sent through the extension.
  Reproduce defects with synthetic placeholder text instead.
- **Unsanitized upstream payloads** — OpenRouter or TypeSafe request or
  response bodies, headers, provider error text, or captured network
  traffic.
- Personal data about yourself or others that the report does not need.

Sanitization rule: replace each redacted item with an obvious placeholder such
as `<redacted>`, keeping enough surrounding structure for the report to stay
reproducible. Maintainers may edit or remove reports that contain prohibited
content.
