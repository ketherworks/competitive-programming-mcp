# Competitive Programming MCP — Product Strategy, Canonical Endpoints & Roadmap

> **Status**: Pod A Cross-Functional Consensus (Tech Lead + Marketing & Growth + Simulated Competitive Programming Student)
> **Scope**: Canonical multi-OJ positioning, endpoint truth reconciliation, honest per-platform capability boundaries, and P0–P2 decoupling roadmap for `ketherworks/competitive-programming-mcp`.

---

## 1. Strategic Positioning: The Canonical `OJ v1` Multi-Platform Contract Suite

This monorepo is the **standardized multi-OJ MCP backbone** under the `ketherworks` organization — providing one strongly-typed `OJ v1` contract (`packages/contracts`) across Codeforces, AtCoder, Luogu, NowCoder, and LeetCode interoperability, alongside standalone repo export (`scripts/export-standalone.mjs`) and a Node 22 HTTP host (`packages/node-http-host`).

### Clear Separation from `Kaiserunix/luogu-mcp-server`

| Repository | Contract & Tool Surface | When to Choose |
| :--- | :--- | :--- |
| **`ketherworks/competitive-programming-mcp`** *(this monorepo)* | **`OJ v1` Contract Suite**: strict 4-tool anonymous read (`oj_capabilities`, `oj_health`, `oj_search_problems`, `oj_fetch_problem`) for Codeforces / AtCoder / Luogu + **14-tool local `stdio` NowCoder runner** (`R0`–`R4` including two-phase human-confirmed submit) + LeetCode interoperability guide. | You want one uniform typed schema across multiple OJs, standalone platform servers, or local NowCoder browser import, code execution, and human-confirmed submission. |
| **[`Kaiserunix/luogu-mcp-server`](https://github.com/Kaiserunix/luogu-mcp-server)** | **Luogu Deep Pedagogy Edition (`luogu-v0.2`, 11 `luogu_*` tools)**: 100-topic bilingual alias catalog, official + user-shared training sets (`题单`), beginner pain-point recommender, public user profile, and offline topic-pack exporter. | You are focused deeply on Luogu practice and need training sets, 100-topic discovery, or `npx -y luogu-mcp-server` + Official MCP Registry installation. |

---

## 2. P0 Endpoint Reconciliation & Platform Capability Truth Table

### P0 Incident Resolved in `README.md` & `README.zh-CN.md`
- Previously, root `README.md` / `README.zh-CN.md` instructed users to connect Luogu to `https://luogu-mcp-server.lantangtang54.workers.dev/mcp`.
- Per [`docs/deployment/production-endpoints.md`](deployment/production-endpoints.md), **shared Cloudflare Workers for AtCoder and Luogu were retired** because upstream egress blocking broke real problem reads despite passing `/healthz` and MCP handshakes.
- Root READMEs are now 100% aligned with the verified production endpoints:
  - **Codeforces**: `https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp` (Cloudflare Worker)
  - **AtCoder**: `https://api.ksrnyx.top/oj-mcp/atcoder/mcp` (Node 22 container behind HTTPS)
  - **Luogu (`OJ v1`)**: `https://api.ksrnyx.top/oj-mcp/luogu/mcp` (Node 22 container behind HTTPS + private tunnel)
  - **NowCoder / LeetCode**: Local `stdio` only (zero public endpoint; credentials & source code never leave the local process).

### Honest Per-Platform Capability Boundaries (Anti-Overpromise Contract)

| Platform | Hosted Anonymous Read | Search Behavior | Statement / Samples | Run / Submit |
| :--- | :--- | :--- | :--- | :--- |
| **Codeforces** | ✅ Public HTTP | ✅ Official API search (title, ID, rating, tag) | ❌ **Metadata-only** (no statements/samples; use Competitive Companion) | ❌ Not exposed |
| **AtCoder** | ✅ Public HTTP | ⚠️ **Exact `contestId/taskId` or URL resolution only** (free-text search rejected with `request.invalid`) | ✅ Sanitized HTML statements, samples & limits (`en`/`ja`) | ❌ Not exposed |
| **Luogu (`OJ v1`)** | ✅ Public HTTP | ✅ Anonymous keyword search (cursor-paginated) | ✅ Public statements & samples (bounded by `maxContentChars`) | ❌ Disabled by policy |
| **NowCoder** | ❌ Local `stdio` only | ✅ Search + `127.0.0.1:10043` Competitive Companion import | ✅ Statements & profile | ✅ Two-phase confirmed submit (`oj_prepare_submission` → 2-min `intentId` → `oj_commit_submission` → `oj_poll_submission`, no auto-retry) |
| **LeetCode** | ❌ Local `stdio` only | Via audited upstream MCP (`docs/providers/leetcode.md`) | Via upstream MCP | See local provider guide |

---

## 3. Prioritized Engineering & Decoupling Roadmap

### P0 — Namespace Hygiene & Cross-Repo Endpoint Consistency
1. **Migrate Internal Package Scope to `@ketherworks/*`**: Replace residual `@kaiserunix/oj-mcp-contracts` internal references with `@ketherworks/*` so standalone exports and org branding are consistent.
2. **Release Smoke Gate Enforcement**: Keep automated verification checking `tools/list` + one live anonymous read (never `/healthz`-only) across all 3 hosted endpoints before updating `production-endpoints.md`.

### P1 — Shared Core Extraction & Developer DX
1. **Extract Shared `luogu-lentille-core` Adapter**: Consolidate the Luogu Lentille payload normalizer shared conceptually with `Kaiserunix/luogu-mcp-server` so upstream Luogu schema changes require one fix instead of two.
2. **Actionable Schema-Validation Error Messages**: Upgrade generic `"input did not match its strict bounded schema"` errors on `oj.search-request/v1` (`packages/codeforces`, `packages/luogu`) to cite the exact missing/invalid field (e.g. `requestId`, `schemaVersion`, `platform`) plus a minimal valid example.
3. **Cross-Provider Contract Compliance Suite**: Maintain deterministic automated contract compliance tests verifying capability declarations, timestamps, error codes, and anonymous read-only boundaries across every package in `packages/`.

### P2 — Client Ergonomics & Ecosystem Integration
1. **Align Downstream Clients (`student-autocomplete-lab`)**: Ensure downstream consumers pull canonical default endpoint constants from a single documented table rather than hardcoding stale hostnames.
2. **Self-Hosting Node 22 Container Guide**: Expand `packages/node-http-host` self-hosting documentation so operators deploying AtCoder or Luogu endpoints avoid shared Cloudflare Worker egress blocks on day one.
