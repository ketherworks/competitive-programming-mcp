# Documentation Index

## Repository Docs (`docs/`)

| Document | Purpose | Status |
| --- | --- | --- |
| [deployment/production-endpoints.md](deployment/production-endpoints.md) | Canonical public MCP/health endpoints, hosting topology, retired shared Workers, and release smoke requirements. | Active |
| [providers/leetcode.md](providers/leetcode.md) | Compatibility, security, and local stdio boundary for integrating upstream `jinzcdev/leetcode-mcp-server` v1.3.0 with OJ v1 contracts. | Active |
| [CLEANUP_CHANGELOG.md](CLEANUP_CHANGELOG.md) | Code-vs-docs audit log recording verified docs, endpoint clarifications, and out-of-scope drift notes. | Historical |

## Package Guides (`packages/`)

| Document | Purpose | Status |
| --- | --- | --- |
| [packages/codeforces/README.md](../packages/codeforces/README.md) ([zh-CN](../packages/codeforces/README.zh-CN.md)) | Official Codeforces metadata adapter (4 tools), Durable Object caching, Worker limits, and CLI/CI commands. | Active |
| [packages/atcoder/README.md](../packages/atcoder/README.md) ([zh-CN](../packages/atcoder/README.zh-CN.md)) | Anonymous past-problem AtCoder HTML adapter (4 tools), contest rules, security bounds, and dev commands. | Active |
| [packages/luogu/README.md](../packages/luogu/README.md) ([zh-CN](../packages/luogu/README.zh-CN.md)) | Anonymous 4-tool Luogu OJ v1 adapter, fixed-origin policy, sessionless cancellation rules, and upstream audit table. | Active |
| [packages/luogu/THIRD_PARTY_NOTICES.md](../packages/luogu/THIRD_PARTY_NOTICES.md) | Upstream MIT attribution and audited revision provenance (`Kaiserunix/luogu-mcp-server@9d3f5bc`). | Reference |
| [packages/nowcoder/README.md](../packages/nowcoder/README.md) ([zh-CN](../packages/nowcoder/README.zh-CN.md)) | Local stdio NowCoder adapter (14 tools): search, Competitive Companion import, profile, sample run, and confirmed submission. | Active |
| [packages/node-http-host/README.md](../packages/node-http-host/README.md) | Node 22 HTTP container host for `atcoder` and `luogu` workers, Docker run example, and `OJ_MCP_INTERNAL_KEY` configuration. | Active |

## Top-Level Guides & Schemas (Reference)

- [README.md](../README.md) / [README.zh-CN.md](../README.zh-CN.md) — Monorepo entry overview, platform links, and workspace commands (`Active`).
- `packages/contracts/schema/v1/*.schema.json` — Generated JSON Schemas for the shared `oj.*/v1` contracts (regenerated via `npm run sync:contracts`, `Reference`).
