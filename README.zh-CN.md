# 算法刷题 MCP | Competitive Programming MCP

**[English](README.md) | [产品策略与演进路线](docs/PRODUCT_STRATEGY.md) | [生产端点清单](docs/deployment/production-endpoints.md)**

通过统一的强类型 **`OJ v1`** 契约，将 **Codeforces、AtCoder、洛谷、牛客与 LeetCode** 接入任意支持 MCP 的编辑器或 Agent（VS Code、Cursor、Claude、Windsurf 等）。公开查题和读题面可直接连接零安装公共只读服务；牛客的浏览器导题、个人资料、代码运行与二阶段确认提交严格在本地 `stdio` 进程中完成。

---

## 选择平台（真实能力边界矩阵）

| 平台 | 当前已支持能力 | 搜索与读取边界说明 | 接入方式 |
| --- | --- | --- | --- |
| **[Codeforces](https://github.com/ketherworks/codeforces-mcp-server)** | 官方 API 搜题与元数据（标题、题号、难度分、标签、通过数） | **仅元数据**——不返回完整题面与样例（完整题面请配合 Competitive Companion） | 公共 HTTP（Cloudflare Worker） |
| **[AtCoder](https://github.com/ketherworks/atcoder-mcp-server)** | 读取历史题目的清洗后题面、样例与时空限制（`en`/`ja`） | `oj_search_problems` 仅支持**精确 `contestId/taskId` 或 URL 解析**（不支持自由文本搜索） | 公共 HTTP（Node 22 容器） |
| **[洛谷 (`OJ v1`)](https://github.com/ketherworks/competitive-programming-mcp/tree/main/packages/luogu)** | 4 工具标准化匿名关键词搜题与题面读取（`oj_*`） | 只读；若需 100 算法专题、洛谷题单（`题单`）与卡点推题，请用 [`Kaiserunix/luogu-mcp-server`](https://github.com/Kaiserunix/luogu-mcp-server) | 公共 HTTP（Node 22 容器） |
| **[牛客 / NowCoder](https://github.com/ketherworks/nowcoder-mcp-server)** | 搜题、Competitive Companion 导题（`127.0.0.1:10043`）、资料、运行与二阶段确认提交 | **仅本地 `stdio`**——登录态与源码严禁离开本机 | 本地 `stdio` |
| **LeetCode 国服/国际服** | 通过统一 `OJ v1` 契约接入经过审阅的成熟上游实现 | 需本地配置 | [本地接入说明](docs/providers/leetcode.md) |

只需要单个平台时，可直接进入对应的独立仓库安装。本 Monorepo 保存统一 `OJ v1` 契约、各平台适配器、测试、Node 22 HTTP 宿主与独立仓导出工具。

### 选型指南：何时用本仓库 vs. `Kaiserunix/luogu-mcp-server`？

- **需要跨多 OJ 的统一 `OJ v1` 强类型 Schema，或需要牛客本地导题/运行/二阶段确认提交** → 使用本仓库 **`ketherworks/competitive-programming-mcp`** 与下方公共端点。
- **专注洛谷深度练习，需要 11 工具教研版（100 算法专题双语检索、官方/精选用户题单 `题单`、入门痛点推荐或 `npx -y luogu-mcp-server`）** → 使用 **[`Kaiserunix/luogu-mcp-server`](https://github.com/Kaiserunix/luogu-mcp-server)**（`https://luogu-mcp.ksrnyx.top/mcp`）。

---

## 快速开始

### 公共匿名查题服务（免 API Key、免 OJ 账号）

在 MCP 配置中仅保留需要的平台即可。

**VS Code（`.vscode/mcp.json`，顶层字段为 `"servers"` 且需 `"type": "http"`）：**

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

**Cursor / Windsurf 等使用 `"mcpServers"` 的客户端：**

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

> **部署架构说明**：由于共享 Cloudflare Worker 出口易遭 AtCoder 与洛谷上游拦截（即使 `/healthz` 与握手成功也会导致真实读题失败），AtCoder 与洛谷的公共服务均已迁移至基于 `packages/node-http-host` 的 **Node 22 容器**。详见 [`docs/deployment/production-endpoints.md`](docs/deployment/production-endpoints.md)。

### 牛客账号操作与确认提交

按 [牛客 MCP Server 快速开始](https://github.com/ketherworks/nowcoder-mcp-server#快速开始) 在本机运行服务。登录 Cookie 与源码只留在本地 `stdio` 进程中，每次真实提交都必须经过全新二阶段确认（`oj_prepare_submission` → 2 分钟有效期 `intentId` → `oj_commit_submission` → `oj_poll_submission`，绝不自动重试）。

---

## 可以直接这样问

```text
在 Codeforces 找五道适合入门（800-1200 分）的 implementation 题。
获取 AtCoder abc086_a 的题面和样例。
在洛谷搜索动态规划练习题。
导入牛客 NC218144，并为已保存的 main.cpp 生成提交预览。
```

---

## 统一 `OJ v1` 契约与安全边界

- 仓库内的所有平台均使用同一套类型化 **`OJ v1`** 契约（`packages/contracts`）报告能力与健康状态；题目、搜索结果、错误、运行预览与提交证据均保留平台来源与时间戳。
- **公共 HTTP 服务仅开放匿名读取。** 登录态、源码、平台运行与真实提交严格限定在本地 `stdio` 进程内执行。

## 仓库结构

- `packages/contracts`：统一 `OJ v1` TypeScript 类型、编解码器与 JSON Schema。
- `packages/server-common`：通用 MCP 结果格式化与错误处理。
- `packages/codeforces`、`packages/atcoder`、`packages/luogu`、`packages/nowcoder`：各平台适配器实现。
- `packages/node-http-host`：承载公共只读 AtCoder / 洛谷适配器的 Node 22 HTTP 宿主。
- `scripts/export-standalone.mjs`：导出各平台独立仓库的发布脚本。

## 开发

需要 **Node.js 22 或更新版本**。

```powershell
npm ci
npm run check
```

当前线上端点、健康检查地址与发布前实测要求（必须覆盖 `tools/list` + 真实只读调用）见 [`docs/deployment/production-endpoints.md`](docs/deployment/production-endpoints.md)；产品定位与演进规划见 [`docs/PRODUCT_STRATEGY.md`](docs/PRODUCT_STRATEGY.md)。

## 许可证

适配器源码使用 MIT 许可证。题面、平台名称与商标仍遵循各平台自身条款。
