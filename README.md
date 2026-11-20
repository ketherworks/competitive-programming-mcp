# Competitive Programming MCP | Algorithm Practice MCP

**[简体中文](README.zh-CN.md) | [Product Strategy & Roadmap](docs/PRODUCT_STRATEGY.md) | [Production Endpoints](docs/deployment/production-endpoints.md)**

Connect any MCP client (VS Code, Cursor, Claude, Windsurf, or custom AI agents) to **Codeforces, AtCoder, Luogu, NowCoder, and LeetCode** through one strongly-typed **`OJ v1`** contract. Use zero-install hosted read-only servers for anonymous problem lookup, or run the NowCoder server locally over `stdio` for browser import, profile, run, and two-phase human-confirmed submission workflows.

---

## Choose a Platform (Honest Capability Matrix)

| Platform | What Works Today | Search / Read Caveat | How to Connect |
| --- | --- | --- | --- |
| **[Codeforces](https://github.com/ketherworks/codeforces-mcp-server)** | Official API search & metadata (`title`, `id`, `rating`, `tags`, `solvedCount`) | **Metadata-only** — no problem statements or samples (use Competitive Companion for full statements) | Hosted HTTP (`workers.dev`) |
| **[AtCoder](https://github.com/ketherworks/atcoder-mcp-server)** | Fetch past-problem statements, samples & limits (`en`/`ja`) | `oj_search_problems` resolves **exact `contestId/taskId` or URLs** (not free-text search) | Hosted HTTP (Node 22 container) |
| **[Luogu / 洛谷 (`OJ v1`)](https://github.com/ketherworks/competitive-programming-mcp/tree/main/packages/luogu)** | Normalized 4-tool anonymous keyword search & statement fetch (`oj_*`) | Read-only; for 100-topic catalog, training sets (`题单`) & pain-point coaching use [`Kaiserunix/luogu-mcp-server`](https://github.com/Kaiserunix/luogu-mcp-server) | Hosted HTTP (Node 22 container) |
| **[NowCoder / 牛客](https://github.com/ketherworks/nowcoder-mcp-server)** | Search, Competitive Companion import (`127.0.0.1:10043`), profile, run & two-phase confirmed submit | **Local `stdio` only** — login state & source code stay strictly on your machine | Local `stdio` |
| **LeetCode Global/CN** | Use an audited upstream MCP through the shared `OJ v1` contract | Local setup required | [Local setup guide](docs/providers/leetcode.md) |

Each standalone platform repository can be installed on its own. This monorepo hosts the shared `OJ v1` contracts, adapters, tests, Node 22 HTTP host, and release exporter.

### Which Luogu / OJ Repo Should I Use?

- **Need one unified `OJ v1` schema across multiple OJs (or local NowCoder run/submit)?** → Use **`ketherworks/competitive-programming-mcp`** (this repo) and its hosted endpoints below.
- **Need deep Luogu pedagogy (11 `luogu_*` tools: 100 algorithm topics, official/selected training sets `题单`, beginner pain-point recommendations, or `npx -y luogu-mcp-server`)?** → Use **[`Kaiserunix/luogu-mcp-server`](https://github.com/Kaiserunix/luogu-mcp-server)** (`https://luogu-mcp.ksrnyx.top/mcp`).

---

## Quick Start

### Hosted Anonymous Problem Lookup (No API Key or OJ Account Required)

Keep only the platforms you need.

**VS Code (`.vscode/mcp.json`, uses `"servers"` + `"type": "http"`):**

```json
{
  "servers": {
    "codeforces": {
      "type": "http",
      "url": "https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp"
    },
    "atcoder": {
      "type": "http",
      "url": "https://api.ksrnyx.top/oj-mcp/atcoder/mcp"
    },
    "luogu": {
      "type": "http",
      "url": "https://api.ksrnyx.top/oj-mcp/luogu/mcp"
    }
  }
}
```

**Cursor / Windsurf / Clients using `"mcpServers"`:**

```json
{
  "mcpServers": {
    "codeforces": {
      "url": "https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp"
    },
    "atcoder": {
      "url": "https://api.ksrnyx.top/oj-mcp/atcoder/mcp"
    },
    "luogu": {
      "url": "https://api.ksrnyx.top/oj-mcp/luogu/mcp"
    }
  }
}
```

> **Deployment Note**: AtCoder and Luogu run on Node 22 containers (`packages/node-http-host`) behind HTTPS rather than shared Cloudflare Workers, because upstream egress blocking broke real problem reads on shared Workers. See [`docs/deployment/production-endpoints.md`](docs/deployment/production-endpoints.md).

### NowCoder Account & Confirmed Submission Workflows

Clone and run [NowCoder MCP Server](https://github.com/ketherworks/nowcoder-mcp-server#quick-start) locally. Login cookies and source files never leave the local `stdio` process, and every real submission requires a fresh two-phase confirmation (`oj_prepare_submission` → 2-minute `intentId` → `oj_commit_submission` → `oj_poll_submission`, with zero automatic retries).

---

## Try Asking Your AI Client

```text
Find five Codeforces implementation problems for beginners (rating 800-1200).
Fetch AtCoder problem abc086_a and show its statement and samples.
Search Luogu for dynamic-programming practice problems.
Import NowCoder problem NC218144 and prepare my saved main.cpp for submission.
```

---

## Shared `OJ v1` Contract & Trust Boundaries

- All bundled providers report capabilities and health through the same typed **`OJ v1`** contract (`packages/contracts`). Problem documents, search results, errors, run previews, and submission evidence preserve platform provenance and timestamps.
- **Public HTTP servers expose anonymous reads only.** Login state, source code, remote code runs, and submissions are restricted to local `stdio` processes.

## Repository Layout

- `packages/contracts`: shared `OJ v1` TypeScript types, codecs, and JSON Schemas.
- `packages/server-common`: shared MCP result formatting and error helpers.
- `packages/codeforces`, `packages/atcoder`, `packages/luogu`, `packages/nowcoder`: platform providers.
- `packages/node-http-host`: Node 22 HTTP host powering the hosted read-only AtCoder & Luogu adapters.
- `scripts/export-standalone.mjs`: exports the standalone platform repositories.

## Development

Requires **Node.js 22+**.

```powershell
npm ci
npm run check
```

Current deployments, health URLs, and release smoke requirements (`tools/list` + live read) are documented in [`docs/deployment/production-endpoints.md`](docs/deployment/production-endpoints.md). Product positioning and roadmap live in [`docs/PRODUCT_STRATEGY.md`](docs/PRODUCT_STRATEGY.md).

## License

Adapter source code is MIT licensed. Problem statements, platform names, and trademarks remain subject to their respective owners' terms.
