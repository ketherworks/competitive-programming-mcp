# NowCoder MCP Server

[English](README.md)

面向牛客 ACM 题目页面的只读 MCP 适配器。本项目并非牛客官方项目，也不使用或声称拥有牛客官方 API。

## 工具

- `oj_capabilities`：报告已审计的导题能力、当前认证模式，以及明确不支持的操作。
- `oj_health`：根据最近一次导题结果报告被动健康状态，不主动请求牛客。
- `oj_fetch_problem`：通过白名单页面 URL 或规范题目 ID 返回 `OjProblemDocument`。
- `nowcoder_auth_status`：检查启动时注入的本地会话是否有效，不返回账号身份或 Cookie 数据。

当前不提供 `oj_search_problems`，因为还没有经过审计的稳定题目搜索契约。浏览器导入、用户资料、提交、运行和判题也尚未开放；配置登录态不会自动启用这些操作。

## 本地登录态

登录态是可选的。未配置会话时，服务读取牛客公开提供的页面；配置会话后，同一组白名单页面请求会携带用户提供的 Cookie 请求头，能力报告会标记为 `session_cookie` 和 `R1_private_read` 风险。

服务仅在进程启动时读取 `NOWCODER_SESSION_COOKIE`，其值应为完整的 Cookie 请求头。可信启动器应从密钥管理器中取得该值，例如 VS Code `SecretStorage`，并且只注入本地 stdio 子进程。

不要把 Cookie 放入 MCP 工具参数、`mcp.json`、VS Code 设置、命令行参数、Shell 历史、日志、Issue 或提交到 Git 的文件中。本适配器不会自动提取浏览器 Cookie；会话轮换后需要重启进程。

`nowcoder_auth_status` 只检查固定地址 `https://ac.nowcoder.com/`，并返回下列脱敏状态之一：

- `not_configured`
- `authenticated`
- `expired`
- `challenge`
- `unknown`

状态结果不包含 Cookie、账号身份或响应 HTML。

## 支持的地址

只接受精确主机 `ac.nowcoder.com` 上的 HTTPS 地址：

```text
https://ac.nowcoder.com/acm/problem/<数字题号>
https://ac.nowcoder.com/acm/contest/<数字比赛号>/<题目序号>
```

查询参数和片段会被丢弃。其他牛客产品及旧版地址暂不支持，除非后续完成独立审计。

`nativeId` 只接受以下确定形式：

```text
NC<正整数题号>                  -> /acm/problem/<题号>
<正整数比赛号>/<大写或数字序号> -> /acm/contest/<比赛号>/<序号>
```

裸数字、前导零、小写序号、额外路径，以及同时提供 `url` 和 `nativeId` 的请求都会被拒绝。

## 安全边界

- 每次请求和重定向前都会校验 URL 协议、主机名、端口、凭据和路径。
- 可选 Cookie 仅在目标通过 `ac.nowcoder.com` 精确白名单后附加；重定向目标必须先通过校验，才能收到后续请求。
- DNS A/AAAA 查询、响应读取和全部重定向共享 10 秒截止时间。经过校验的公网地址会固定到 TLS 连接，同时保留主机名验证和 SNI。
- 最多允许两次白名单内重定向；响应上限为 2 MiB UTF-8 HTML；Cookie 上限为 16 KiB，并拒绝控制字符。
- 遇到反爬挑战时返回 `challenge.required`，不使用浏览器自动化，也不尝试绕过挑战。
- 题面从官方 ACM DOM 规范化，保留来源、文本块 SHA-256 哈希，并强制检查输入输出段落；页面结构漂移会返回 `upstream.schema_changed`。
- MCP 工具没有 Cookie 或凭据字段，错误和登录状态输出均经过脱敏。

## 传输方式

本包只提供本地 stdio。启用会话转发时不得部署为共享 HTTP 服务，以免成为凭据转发或页面抓取中继，同时保留 Node 传输层的 DNS 与 TLS 固定能力。

## 开发

需要 Node.js 22、TypeScript ESM/NodeNext、MCP SDK 1.29.0 和 Zod 4.3.6。

```powershell
npm run build
npm run typecheck
npm run typecheck:test
npm test
npm run pack:check
npm start
```

测试只使用合成会话、静态页面夹具和本机回环 TLS 服务，不请求牛客、不访问浏览器密钥，也不部署远程服务。
