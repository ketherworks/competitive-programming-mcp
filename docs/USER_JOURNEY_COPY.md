# User Journey Copy & Bilingual Microcopy Playbook — `ketherworks/competitive-programming-mcp`

This companion playbook provides **ready-to-use bilingual product copy (English & 简体中文), editor-labeled MCP client JSON configurations, exact JSON-RPC `tools/call` payload templates, and step-by-step user checklists** for `ketherworks/competitive-programming-mcp` and its standalone exported repositories (`codeforces-mcp-server`, `atcoder-mcp-server`, `luogu-mcp-server`, `nowcoder-mcp-server`, and `leetcode-mcp-server`).

---

## 1. Canonical Onboarding Copy & Editor-Specific MCP Client Configs

### 1.1 Hero Positioning Copy (Bilingual)

- **English**:
  > **Competitive Programming MCP (`oj.*/v1` Contract Suite)**
  > Connect any MCP-enabled IDE or AI coding agent to **Codeforces, AtCoder, Luogu, NowCoder, and LeetCode** through a single security-bounded contract (`oj.*/v1`). Use zero-install hosted HTTP endpoints for anonymous problem lookup (`R0_public_read`), or run the local `stdio` servers for browser task import, profile history, sample self-tests, and two-phase confirmed submissions (`R1`–`R4`).
- **简体中文**:
  > **算法竞赛与刷题统一契约底座 (`Competitive Programming MCP · oj.*/v1`)**
  > 用同一套类型化、安全受限的 `oj.*/v1` 契约将 **Codeforces、AtCoder、洛谷、牛客与 LeetCode** 接入支持 MCP 的编辑器或 AI 教练。公共 HTTP 端点提供零配置匿名查题与读题面（`R0_public_read`）；登录态、源码快照、平台自测与二次确认交题严格隔离在本机 `stdio` 进程内（`R1`–`R4`）。

### 1.2 Hosted Read-Only MCP Configs (`R0_public_read` — Labeled by Editor Format)

> [!WARNING]
> Always use `https://api.ksrnyx.top/oj-mcp/luogu/mcp` for Luogu and `https://api.ksrnyx.top/oj-mcp/atcoder/mcp` for AtCoder. The legacy Cloudflare Worker URL (`https://luogu-mcp-server.lantangtang54.workers.dev/mcp`) was retired because upstream judges block shared Worker egress IPs (`docs/deployment/production-endpoints.md`).

#### Format A: VS Code Workspace (`.vscode/mcp.json`) — Root Key: `"servers"`
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

#### Format B: Cursor (`.cursor/mcp.json`) & Claude Desktop (`claude_desktop_config.json`) — Root Key: `"mcpServers"`
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

#### Format C: VS Code User Settings (`settings.json`) — Root Key: `"mcp"`
```json
{
  "mcp": {
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
}
```

### 1.3 Local Stdio Config (Monorepo Checkout + NowCoder Session + LeetCode Global/CN)

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "nowcoder-cookie",
      "description": "NowCoder ac.nowcoder.com Cookie request-header value (leave blank for anonymous public reads)",
      "password": true
    }
  ],
  "servers": {
    "codeforces-local": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/competitive-programming-mcp/packages/codeforces/dist/index.js"]
    },
    "atcoder-local": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/competitive-programming-mcp/packages/atcoder/dist/index.js"]
    },
    "luogu-local": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/competitive-programming-mcp/packages/luogu/dist/index.js"]
    },
    "nowcoder": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/competitive-programming-mcp/packages/nowcoder/dist/index.js"],
      "env": {
        "NOWCODER_SESSION_COOKIE": "${input:nowcoder-cookie}",
        "COMPETITIVE_COMPANION_PORT": "10043"
      }
    },
    "leetcode-global": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@jinzcdev/leetcode-mcp-server@1.3.0", "--site", "global"]
    }
  }
}
```

---

## 2. Copy-Pasteable `tools/call` Payload Templates (Developer & Agent Reference)

Because `oj.*/v1` enforces strict Zod validation on every tool input, developers testing via MCP Inspector, `curl`, or custom IDE clients can copy these exact payloads:

### 2.1 `oj_search_problems` (`oj.search-request/v1`)

- **Codeforces Single-Keyword / Tag Search** (`packages/codeforces/src/provider.ts:28-36` — *Note: Pass a single tag or title keyword like `"implementation"` or `"dp"` until multi-token rating tokenization lands*):
  ```json
  {
    "name": "oj_search_problems",
    "arguments": {
      "schemaVersion": "oj.search-request/v1",
      "requestId": "req-cf-search-01",
      "platform": "codeforces",
      "query": "implementation",
      "limit": 5
    }
  }
  ```
- **Luogu Keyword Search with Pagination Cursor** (`packages/luogu/src/provider.ts:31-41`):
  ```json
  {
    "name": "oj_search_problems",
    "arguments": {
      "schemaVersion": "oj.search-request/v1",
      "requestId": "req-lg-search-01",
      "platform": "luogu",
      "query": "动态规划",
      "locale": "zh-CN",
      "limit": 10
    }
  }
  ```
- **AtCoder Exact Contest/Task Resolution** (`packages/atcoder/src/provider.ts:49-58,280-289` — *Note: `query` must be `<contestId>/<taskId>`, `atcoder:<contestId>/<taskId>`, or canonical task URL*):
  ```json
  {
    "name": "oj_search_problems",
    "arguments": {
      "schemaVersion": "oj.search-request/v1",
      "requestId": "req-at-resolve-01",
      "platform": "atcoder",
      "query": "abc086/abc086_a",
      "locale": "en",
      "limit": 1
    }
  }
  ```
- **NowCoder ACM Catalog Search** (`packages/nowcoder/src/provider.ts:40-45` — *Note: `cursor` is a numeric page string `"1"`, `"2"`, etc.*):
  ```json
  {
    "name": "oj_search_problems",
    "arguments": {
      "schemaVersion": "oj.search-request/v1",
      "requestId": "req-nc-search-01",
      "platform": "nowcoder",
      "query": "二分图",
      "locale": "zh-CN",
      "cursor": "1",
      "limit": 10
    }
  }
  ```

### 2.2 `oj_fetch_problem` & `codeforces_get_problem_metadata` Across All Platforms

- **Codeforces Official Metadata Lookup** (`packages/codeforces/src/server.ts:25` — *Returns title, rating, tags, solved count only*):
  ```json
  {
    "name": "codeforces_get_problem_metadata",
    "arguments": {
      "nativeId": "71/A"
    }
  }
  ```
- **AtCoder Statement & Samples Fetch** (`packages/atcoder/src/provider.ts:33-47` — *Pass `{ contestId, taskId, locale? }` or `{ url, locale? }`*):
  ```json
  {
    "name": "oj_fetch_problem",
    "arguments": {
      "contestId": "abc086",
      "taskId": "abc086_a",
      "locale": "en"
    }
  }
  ```
- **Luogu Statement & Samples Fetch** (`packages/luogu/src/provider.ts:43-49`):
  ```json
  {
    "name": "oj_fetch_problem",
    "arguments": {
      "nativeId": "P1001",
      "locale": "zh-CN",
      "maxContentChars": 20000
    }
  }
  ```
- **NowCoder Statement & Samples Fetch** (`packages/nowcoder/src/server.ts:51-60` — *Provide `nativeId` OR `url`, never both*):
  ```json
  {
    "name": "oj_fetch_problem",
    "arguments": {
      "nativeId": "NC218144"
    }
  }
  ```

---

## 3. NowCoder End-to-End Contestant Checklist (Copy for UI / Docs)

### Step 1: Verify Local Login Session (`nowcoder_auth_status`)
- **Action**: Call `nowcoder_auth_status` with `{}`.
- **Expected Status Copy**:
  - `state: "authenticated"` → `"NowCoder accepted the configured local session."` (`🟢 牛客本地会话已就绪，可执行平台自测与确认提交`)
  - `state: "not_configured"` → `"No local NowCoder session is configured."` (`⚪ 当前为匿名只读模式；搜题、读题面与 Competitive Companion 导题可用，自测与交题需配置 NOWCODER_SESSION_COOKIE`)
  - `state: "expired"` → `"NowCoder rejected the configured local session or reported it as expired."` (`🟠 牛客 Cookie 已过期，请重新复制浏览器 ac.nowcoder.com Cookie 并重启 MCP 服务`)

### Step 2: Import Contest Task via Competitive Companion (`127.0.0.1:10043`)
1. Call `oj_open_import_window`:
   ```json
   {
     "schemaVersion": "oj.import-window-request/v1",
     "requestId": "req-nc-import-01",
     "allowedPlatforms": ["nowcoder"],
     "expiresInMs": 60000
   }
   ```
2. Within **60 seconds**, click the Competitive Companion green `+` button on the NowCoder problem tab in Chrome/Firefox (configured to port `10043`).
3. Call `oj_complete_import` with `{ "windowId": "<windowId from step 1>" }` to receive the normalized sample cases, time/memory limits, and canonical `OjProblemRef`.
4. *(Tip)* Because Competitive Companion does not transmit problem prose (`statement.text` is `""`), call `oj_fetch_problem({ "nativeId": "<ref.nativeId>" })` whenever the task is on a public ACM page and you want the full statement markdown/HTML.

### Step 3: Run Platform Sample Self-Test (`oj_platform_run`)
1. **Save your file on disk first** (`Ctrl+S` — `sourceWasDirty` must be `false`, file size `<= 1 MiB`).
2. Call `oj_platform_run` with the saved `file://` URI, exact UTF-8 byte count, SHA-256 hash, and one `sampleOrdinals` entry (e.g. `[1]`) using a valid NowCoder `platformLanguageId` (`"2"` for C++, `"11"` for Python 3, `"4"` for Java, `"25"` for PyPy 3, `"27"` for Rust).
3. Accept the MCP confirmation dialog (`确认平台自测`) to upload and run the sample once. If still `running` (`verdict: "judging"`), poll with `oj_poll_run({ "requestId": "..." })`.

### Step 4: Two-Phase Confirmed Submission (`oj_prepare_submission` → `oj_commit_submission` → `oj_poll_submission`)
1. Call `oj_prepare_submission` to verify the on-disk file hash, signed-in account/team target, and problem language support.
2. Inspect the returned `OjSubmitPreview` (`warnings` will highlight if you are submitting as a team: `"提交主体为团队 <teamId>"`).
3. Within **2 minutes** (`expiresAt`), call `oj_commit_submission` and check `[x] 确认真实提交` in the MCP confirmation prompt.
4. Poll verdict safely with `oj_poll_submission({ "requestId": "...", "submissionOperationId": "..." })`. If a post-dispatch network drop returns `state: "outcome_unknown"`, **do not re-submit**; check `oj_list_submissions({})` first to avoid duplicate-submission penalties.
