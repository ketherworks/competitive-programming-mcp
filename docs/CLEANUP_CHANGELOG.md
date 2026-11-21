# Documentation Cleanup Changelog

Audit performed across all 14 existing markdown files against `packages/*/src/`, `packages/*/package.json`, `packages/*/wrangler.jsonc`, `scripts/export-standalone.mjs`, `.github/workflows/ci.yml`, and test suites on branch `swarm/doc-cleanup`.

## Audit Findings & Actions

- **Updated [deployment/production-endpoints.md](deployment/production-endpoints.md):**
  - Linked [`packages/node-http-host/README.md`](../packages/node-http-host/README.md) and clarified that `AtCoder` and `Luogu` public endpoints run on `packages/node-http-host`, while `Codeforces` runs on Cloudflare Workers with `CodeforcesCoordinator` Durable Object.
  - Explained why `packages/atcoder/wrangler.jsonc` and `packages/luogu/wrangler.jsonc` remain in the repo (CI `wrangler deploy --dry-run` checks) even though shared Cloudflare Worker deployments (including retired `*.workers.dev` URLs) were removed due to upstream egress blocking.
  - Disambiguated this monorepo's 4-tool `packages/luogu` OJ v1 adapter (`https://api.ksrnyx.top/oj-mcp/luogu/mcp`) from the separate 11-tool standalone repository `Kaiserunix/luogu-mcp-server` (`https://luogu-mcp.ksrnyx.top/mcp`).
- **Added [INDEX.md](INDEX.md):**
  - Central index mapping every surviving document in `docs/` and `packages/` with status (`Active` / `Reference` / `Historical`).
- **Preserved verbatim (code-verified, zero GPT fluff):**
  - [providers/leetcode.md](providers/leetcode.md): verified `OjCapabilities`, `OjProblemDocument`, `OjSearchResult`, `OjProviderHealth`, `OjError`, and `secretRefs` boundary against `packages/contracts/src/`.
  - `packages/{atcoder,codeforces,luogu,node-http-host,nowcoder}/README*.md` and `packages/luogu/THIRD_PARTY_NOTICES.md`: verified every tool name, schema bound, timeout, byte limit, env var, and script against `packages/*/src/` and `packages/*/package.json`. These files are also contract-tested by `test/exportStandalone.test.ts`, `packages/atcoder/test/package.test.ts`, and `packages/luogu/test/package.test.ts`.

## Out-of-Scope Notes (Not Modified Here)

- Top-level `README.md` (line 38) and `README.zh-CN.md` (line 38) still list the retired `https://luogu-mcp-server.lantangtang54.workers.dev/mcp` URL for Luogu instead of `https://api.ksrnyx.top/oj-mcp/luogu/mcp` (used in `docs/deployment/production-endpoints.md`, `packages/luogu/README.md`, and `scripts/export-standalone.mjs`). Top-level READMEs were intentionally not edited on this branch and are flagged for the README maintainer.
