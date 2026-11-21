# Production Endpoints

The public deployments expose anonymous, read-only MCP tools. End users do not
send `X-OJ-MCP-Key`; that header is private-origin authentication (`OJ_MCP_INTERNAL_KEY`)
between the HTTPS reverse proxy and a non-public backend (see
[`packages/node-http-host/README.md`](../../packages/node-http-host/README.md)).

| Platform | MCP endpoint | Health endpoint | Deployment |
| --- | --- | --- | --- |
| Codeforces | `https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp` | `https://codeforces-oj-mcp.lantangtang54.workers.dev/healthz` | Cloudflare Worker (`CodeforcesCoordinator` Durable Object) |
| AtCoder | `https://api.ksrnyx.top/oj-mcp/atcoder/mcp` | `https://api.ksrnyx.top/oj-mcp/atcoder/healthz` | Node 22 container (`packages/node-http-host`) behind HTTPS |
| Luogu (`packages/luogu`, OJ v1) | `https://api.ksrnyx.top/oj-mcp/luogu/mcp` | `https://api.ksrnyx.top/oj-mcp/luogu/healthz` | Node 22 container (`packages/node-http-host`) behind HTTPS and a private tunnel |

## Scope & Retired Workers

- **NowCoder and LeetCode** have no public endpoint. NowCoder remains local stdio;
  the separately audited LeetCode provider remains private local stdio (see
  [`docs/providers/leetcode.md`](../providers/leetcode.md)).
- **Retired shared Workers:** Shared Cloudflare Worker deployments for AtCoder
  and Luogu (including legacy `*.workers.dev` URLs such as
  `luogu-mcp-server.lantangtang54.workers.dev`) were removed after real reads
  showed upstream egress blocking despite successful MCP handshakes.
  `packages/atcoder/wrangler.jsonc` and `packages/luogu/wrangler.jsonc` remain
  in the workspace only for CI `wrangler deploy --dry-run` build verification.
- **Luogu server distinction:** `https://api.ksrnyx.top/oj-mcp/luogu/mcp` serves
  this monorepo's 4-tool `oj.*/v1` contract adapter (`packages/luogu`). The
  separate standalone [`Kaiserunix/luogu-mcp-server`](https://github.com/Kaiserunix/luogu-mcp-server)
  repository exposes 11 Luogu-specific tools at `https://luogu-mcp.ksrnyx.top/mcp`.

## Release Verification

Release smoke tests must call `tools/list` and one representative anonymous
read, not only `/healthz`.
