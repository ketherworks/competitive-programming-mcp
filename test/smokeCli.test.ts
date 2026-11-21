import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";
import { createAtCoderWorker } from "../packages/atcoder/src/worker.js";
import { createNodeHttpServer } from "../packages/node-http-host/src/bridge.js";
import {
  formatSmokeSummaryText,
  getProviderDescriptor,
  parseCliArgs,
  runCli,
  runSmokeChecks,
  SUPPORTED_PLATFORMS,
  validateCapabilitiesPayload,
  validateErrorResult,
  validateProblemDocumentPayload,
  validateToolCatalog,
  type SmokeRunSummary
} from "../tools/oj-health/src/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const closeables: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((close) => close()));
});

describe("oj-health smoke-check CLI and wire-level compliance", () => {
  test("verifies all four built packages over real stdio and Worker transports", async () => {
    const summary = await runSmokeChecks({
      platforms: [...SUPPORTED_PLATFORMS],
      modes: ["stdio", "worker"],
      repoRoot,
      timeoutMs: 10_000,
      live: false,
      failOnDegraded: false
    });

    expect(summary.schemaVersion).toBe("oj.smoke-report/v1");
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(7);
    expect(summary.skipped).toBe(1);
    expect(summary.targets.find((target) => target.platform === "nowcoder" && target.mode === "worker")?.outcome).toBe("skip");

    const text = formatSmokeSummaryText(summary);
    expect(text).toContain("[PASS] codeforces (stdio)");
    expect(text).toContain("[PASS] atcoder (worker)");
    expect(text).toContain("[SKIP] nowcoder (worker)");
    expect(text).toContain("[PASS] luogu (worker)");
  }, 30_000);

  test("executes compiled tools/oj-health/dist/cli.js as a real Node CLI returning JSON", async () => {
    const cliPath = join(repoRoot, "tools", "oj-health", "dist", "cli.js");
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "--platforms", "atcoder,nowcoder", "--json"], {
      cwd: repoRoot,
      timeout: 20_000
    });
    const report = JSON.parse(stdout) as SmokeRunSummary;
    expect(report.schemaVersion).toBe("oj.smoke-report/v1");
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(3);
    expect(report.skipped).toBe(1);
  }, 25_000);

  test("probes a live loopback node-http-host endpoint with X-OJ-MCP-Key authentication", async () => {
    const internalKey = "smoke-test-internal-key-0123456789";
    const server = createNodeHttpServer({
      worker: createAtCoderWorker(),
      internalKey
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeables.push(
      () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP address for loopback HTTP host.");
    }
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitOk = await runCli(
      ["--url", mcpUrl, "--platform", "atcoder", "--internal-key-env", "TEST_OJ_KEY", "--json"],
      {
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
        env: { TEST_OJ_KEY: internalKey }
      }
    );
    expect(exitOk).toBe(0);
    expect(stderrLines).toEqual([]);
    const okReport = JSON.parse(stdoutLines.join("\n")) as SmokeRunSummary;
    expect(okReport.passed).toBe(1);
    expect(okReport.failed).toBe(0);
    expect(okReport.targets[0]?.mode).toBe("http");

    const unauthStdout: string[] = [];
    const exitDenied = await runCli(["--url", mcpUrl, "--platform", "atcoder", "--json"], {
      stdout: (line) => unauthStdout.push(line),
      stderr: () => undefined,
      env: {}
    });
    expect(exitDenied).toBe(1);
    const deniedReport = JSON.parse(unauthStdout.join("\n")) as SmokeRunSummary;
    expect(deniedReport.failed).toBe(1);
  });

  test("enforces --fail-on-degraded, --help, and strict CLI flag validation", async () => {
    const helpLines: string[] = [];
    expect(
      await runCli(["--help"], {
        stdout: (line) => helpLines.push(line),
        stderr: () => undefined
      })
    ).toBe(0);
    expect(helpLines.join("\n")).toContain("--fail-on-degraded");

    const badArgErrors: string[] = [];
    expect(
      await runCli(["--url", "https://example.com/mcp"], {
        stdout: () => undefined,
        stderr: (line) => badArgErrors.push(line)
      })
    ).toBe(2);
    expect(badArgErrors.join("\n")).toContain("--url requires selecting exactly one platform");

    expect(() => parseCliArgs(["--platforms", "unknown"], repoRoot)).toThrow(/Unsupported platform/);
    expect(() => parseCliArgs(["--mode", "http"], repoRoot)).toThrow(/requires --url/);
    expect(() => parseCliArgs(["--timeout-ms", "10"], repoRoot)).toThrow(/--timeout-ms/);

    const degradedExit = await runCli(["--platforms", "luogu", "--mode", "worker", "--fail-on-degraded"], {
      stdout: () => undefined,
      stderr: () => undefined
    });
    expect(degradedExit).toBe(1);

    const shortKeyErr: string[] = [];
    expect(
      await runCli(["--url", "https://example.com/mcp", "--platform", "atcoder", "--internal-key-env", "SHORT_KEY"], {
        stdout: () => undefined,
        stderr: (line) => shortKeyErr.push(line),
        env: { SHORT_KEY: "too-short" }
      })
    ).toBe(2);
    expect(shortKeyErr.join("\n")).toContain("at least 24 characters");
  });

  test("supports live HTTP probe mocking via custom http runner and validates contract failures", async () => {
    const descriptor = getProviderDescriptor("atcoder");

    // 1. Tampered SHA-256 in problem document is rejected
    expect(() =>
      validateProblemDocumentPayload(
        {
          schemaVersion: "oj.problem-document/v1",
          ref: {
            schemaVersion: "oj.problem-ref/v1",
            platform: "atcoder",
            nativeId: "abc086/abc086_a",
            canonicalId: "atcoder:abc086/abc086_a",
            url: "https://atcoder.jp/contests/abc086/tasks/abc086_a",
            source: {
              kind: "page_adapter",
              adapterId: "atcoder-page-adapter",
              adapterVersion: "0.1.0",
              fetchedAt: "2026-07-15T12:00:00.000Z",
              sourceUrl: "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=en",
              confidence: "derived"
            }
          },
          title: "Product",
          locale: "en",
          access: "public",
          tags: [],
          content: {
            statement: {
              text: "Hello",
              format: "text",
              locale: "en",
              truncated: false,
              sha256: "0".repeat(64)
            }
          },
          constraints: [],
          samples: [],
          limits: {},
          io: { mode: "stdin_stdout" },
          starterCode: [],
          source: {
            kind: "page_adapter",
            adapterId: "atcoder-page-adapter",
            adapterVersion: "0.1.0",
            fetchedAt: "2026-07-15T12:00:00.000Z",
            sourceUrl: "https://atcoder.jp/contests/abc086/tasks/abc086_a?lang=en",
            confidence: "derived"
          }
        },
        descriptor
      )
    ).toThrow(/does not match UTF-8 text digest/);

    // 2. Capability pointing to unregistered tool is rejected
    const fakeCaps = {
      schemaVersion: "oj.capabilities/v1",
      providerId: descriptor.providerId,
      providerVersion: "0.1.0",
      platform: "atcoder",
      protocolVersion: "2025-11-25",
      operations: Object.fromEntries(
        Object.keys(descriptor.expectedCapabilities).map((name) => [
          name,
          {
            name,
            status: name === "searchProblems" ? "available" : "unsupported",
            ...(name === "searchProblems" ? { toolName: "oj_search_problems" } : {}),
            transport: "local_stdio",
            auth: "none",
            risk: "R0_public_read",
            compliance: "unofficial",
            checkedAt: "2026-07-15T12:00:00.000Z"
          }
        ])
      ),
      languages: [],
      source: {
        kind: "page_adapter",
        adapterId: descriptor.providerId,
        adapterVersion: "0.1.0",
        fetchedAt: "2026-07-15T12:00:00.000Z",
        sourceUrl: "https://atcoder.jp/",
        confidence: "derived"
      }
    };
    expect(() =>
      validateCapabilitiesPayload(fakeCaps, descriptor, "local_stdio", ["oj_capabilities", "oj_health"])
    ).toThrow(/missing MCP tool 'oj_search_problems'/);

    // 3. Tool catalog missing oj.error/v1 output schema is rejected
    const brokenTools: Tool[] = descriptor.expectedTools.map((name) => ({
      name,
      inputSchema: { type: "object" },
      outputSchema: { type: "object", anyOf: [{ type: "object" }, { type: "object" }] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    }));
    expect(() => validateToolCatalog(brokenTools, descriptor)).toThrow(/oj\.error\/v1/);

    // 4. Error envelope leaking forbidden secret is rejected
    expect(() =>
      validateErrorResult(
        {
          isError: true,
          structuredContent: {
            schemaVersion: "oj.error/v1",
            code: "upstream.unavailable",
            layer: "upstream",
            message: "Leaked SECRET_TOKEN_123",
            retryPolicy: "safe_read",
            userAction: "retry",
            platform: "atcoder",
            providerId: descriptor.providerId
          }
        },
        descriptor,
        { forbiddenSubstrings: ["SECRET_TOKEN_123"] }
      )
    ).toThrow(/leaked forbidden substring/);
  });

  test("executes --live search and problem fetch checks against a fixture-backed loopback HTTP host", async () => {
    const html = await readFile(join(repoRoot, "packages", "atcoder", "test", "fixtures", "abc086-a-en.html"), "utf8");
    const server = createNodeHttpServer({
      worker: createAtCoderWorker({
        fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
        nowIso: () => "2026-07-15T12:00:00.000Z"
      })
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeables.push(
      () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");

    const stdoutLines: string[] = [];
    const exitCode = await runCli(
      ["--url", `http://127.0.0.1:${address.port}/mcp`, "--platform", "atcoder", "--live", "--json"],
      { stdout: (line) => stdoutLines.push(line), stderr: () => undefined }
    );
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdoutLines.join("\n")) as SmokeRunSummary;
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    const checkNames = report.targets[0]?.checks.map((check) => check.name) ?? [];
    expect(checkNames).toContain("mcp/live-search");
    expect(checkNames).toContain("mcp/live-read");
    expect(report.targets[0]?.checks.find((check) => check.name === "mcp/live-read")?.detail).toContain("atcoder:abc086/abc086_a");
  });

  test("handles unreachable HTTP endpoints cleanly without throwing unhandled exceptions", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeables.push(
      () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");

    const summary = await runSmokeChecks({
      platforms: ["luogu"],
      modes: ["http"],
      url: `http://127.0.0.1:${address.port}/mcp`,
      repoRoot,
      timeoutMs: 2_000,
      live: false,
      failOnDegraded: false
    });
    expect(summary.failed).toBe(1);
    expect(summary.targets[0]?.outcome).toBe("fail");
  });
});
