# NowCoder MCP Server

[简体中文](README.zh-CN.md)

Read-only MCP adapter for official NowCoder/牛客 ACM problem pages. It is an unofficial page adapter and does not use or claim an official NowCoder API.

## Tools

- `oj_capabilities`: reports the audited fetch capability, its active authentication mode, and every unsupported operation.
- `oj_health`: reports passive health from the last fetch without making a network probe.
- `oj_fetch_problem`: returns an `OjProblemDocument` from one allowlisted page URL or canonical native ID.
- `nowcoder_auth_status`: checks whether the startup-injected local session is accepted without returning account identity or Cookie data.

`oj_search_problems` is intentionally absent because no stable problem-search contract has been audited. Browser import, profiles, submissions, execution, and judging are also absent. Configuring a session does not enable those operations.

## Local Session

Authentication is optional. Without a session, the server reads pages that NowCoder exposes publicly. With a session, the same allowlisted page requests include the user-provided Cookie header and capabilities report `session_cookie` with `R1_private_read` risk.

The server reads a complete Cookie request-header value from `NOWCODER_SESSION_COOKIE` once at process startup. A trusted launcher should obtain the value from a secret manager, such as VS Code `SecretStorage`, and inject it only into the local stdio child process.

Do not put the Cookie in MCP tool arguments, `mcp.json`, VS Code settings, command-line arguments, shell history, logs, issues, or committed files. This adapter does not extract browser cookies automatically. Restart the process after rotating the session.

`nowcoder_auth_status` checks the fixed URL `https://ac.nowcoder.com/` and returns one redacted state:

- `not_configured`
- `authenticated`
- `expired`
- `challenge`
- `unknown`

The status result never contains the Cookie, account identity, or response HTML.

## Accepted URLs

Only HTTPS URLs on the exact host `ac.nowcoder.com` are accepted:

```text
https://ac.nowcoder.com/acm/problem/<numeric-id>
https://ac.nowcoder.com/acm/contest/<numeric-contest-id>/<problem-index>
```

Query strings and fragments are discarded. Other NowCoder products and legacy URL shapes are rejected until independently audited.

The alternative `nativeId` input accepts exactly these deterministic forms:

```text
NC<positive-numeric-id>                         -> /acm/problem/<id>
<positive-numeric-contest-id>/<uppercase-index> -> /acm/contest/<contest-id>/<index>
```

Numeric contest indexes are also accepted. Bare numbers, leading zeroes, lowercase indexes, path segments, and requests containing both `url` and `nativeId` are rejected.

## Safety

- URL scheme, hostname, port, credentials, and path are allowlisted before every request and redirect.
- The optional Cookie is attached only after the destination passes the exact `ac.nowcoder.com` allowlist. A redirect is validated before any follow-up request can receive it.
- DNS A and AAAA queries use a cancellation-capable Node resolver under the shared deadline. Every answer must be public unicast; validated addresses are pinned into TLS fallback while preserving hostname verification and SNI.
- Redirects are manual and limited to two allowlisted hops.
- One 10-second deadline covers DNS, response-body transfer, and every redirect hop. Responses are capped at 2 MiB of UTF-8 HTML; the startup Cookie is capped at 16 KiB and control characters are rejected.
- Anti-bot pages produce `challenge.required`; the adapter does not use browser automation or attempt to bypass them.
- Responses are normalized from the official ACM DOM with required input/output sections, source provenance, and SHA-256 hashes on text blocks. Missing required sections fail as `upstream.schema_changed`.
- Tool inputs have no Cookie or credential field, and errors and status results are deliberately redacted.

## Transport Choice

The package exposes local stdio only. It must not be deployed as a shared HTTP service while session forwarding is enabled. Keeping authenticated requests local prevents the server from becoming a credential-forwarding or page-fetch relay and preserves the Node transport's DNS and TLS pinning controls.

## Development

Node.js 22, TypeScript ESM/NodeNext, MCP SDK 1.29.0, and Zod 4.3.6 are required.

```powershell
npm run build
npm run typecheck
npm run typecheck:test
npm test
npm run pack:check
npm start
```

Tests use synthetic sessions, static fixtures, and loopback-only TLS servers. They do not contact NowCoder, access browser secrets, or deploy any service.
