import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OjCapability, OjProviderHealth } from "@kaiserunix/oj-mcp-contracts";
import {
  validateCapabilitiesPayload,
  validateErrorResult,
  validateHealthPayload,
  validateProblemDocumentPayload,
  validateProblemSummaryPayload,
  validateSearchResultPayload,
  validateToolCatalog,
  type McpToolCallEnvelope
} from "./contractValidator.js";
import { resolvePackageArtifacts } from "./registry.js";
import type {
  ComplianceCheckResult,
  ProviderPackageDescriptor,
  ProviderTargetReport,
  SmokeMode,
  SmokeProbeOptions
} from "./types.js";

const SAFE_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR"
] as const;

export interface WorkerModuleShape {
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
  [exported: string]: unknown;
}

export function buildMinimalEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const clean: Record<string, string> = { NO_COLOR: "1" };
  for (const key of SAFE_ENV_KEYS) {
    const value = sourceEnv[key];
    if (typeof value === "string" && value.length > 0) {
      clean[key] = value;
    }
  }
  return clean;
}

export async function probeStdioPackage(
  descriptor: ProviderPackageDescriptor,
  options: SmokeProbeOptions
): Promise<ProviderTargetReport> {
  const startedAt = Date.now();
  const checks: ComplianceCheckResult[] = [];
  let overallHealth: OjProviderHealth["overall"] | undefined;
  let target = `${descriptor.packageDir}/dist/index.js`;

  const artifactsCheck = await runCheck("package-artifacts", async () => {
    const artifacts = await resolvePackageArtifacts(options.repoRoot, descriptor.platform);
    target = artifacts.stdioEntryPath;
    if (artifacts.unpublishedWorkspaceDeps.length > 0) {
      throw new Error(`Package declares unpublished workspace dependencies: ${artifacts.unpublishedWorkspaceDeps.join(", ")}`);
    }
    return {
      artifacts,
      detail: `${artifacts.manifestName}@${artifacts.version} (${artifacts.stdioEntryPath})`
    };
  });
  checks.push(artifactsCheck.result);

  if (!artifactsCheck.value) {
    return buildTargetReport(descriptor.platform, "stdio", target, checks, startedAt, overallHealth);
  }

  const client = new Client({ name: "oj-health-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [artifactsCheck.value.artifacts.stdioEntryPath],
    cwd: artifactsCheck.value.artifacts.packageDir,
    env: options.passEnv ? cleanDefinedEnv(process.env) : buildMinimalEnv(),
    stderr: "pipe"
  });

  try {
    const connectCheck = await runCheck("mcp-connect", async () => {
      await client.connect(transport, { signal: AbortSignal.timeout(options.timeoutMs) });
      return { detail: "Connected over local_stdio transport." };
    });
    checks.push(connectCheck.result);
    if (connectCheck.result.outcome === "fail") {
      return buildTargetReport(descriptor.platform, "stdio", target, checks, startedAt, overallHealth);
    }

    const sessionResult = await runMcpSessionComplianceChecks(client, descriptor, "local_stdio", options);
    checks.push(...sessionResult.checks);
    overallHealth = sessionResult.overallHealth;
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }

  return buildTargetReport(descriptor.platform, "stdio", target, checks, startedAt, overallHealth);
}

export async function probeWorkerPackage(
  descriptor: ProviderPackageDescriptor,
  options: SmokeProbeOptions
): Promise<ProviderTargetReport> {
  const startedAt = Date.now();
  if (!descriptor.supportsWorker) {
    return {
      platform: descriptor.platform,
      mode: "worker",
      target: "not-applicable",
      outcome: "skip",
      latencyMs: Date.now() - startedAt,
      checks: [
        {
          name: "worker-policy",
          outcome: "skip",
          durationMs: 0,
          detail: `${descriptor.displayName} is stdio-only by security policy; Worker HTTP transport is intentionally disabled.`
        }
      ]
    };
  }

  const checks: ComplianceCheckResult[] = [];
  let overallHealth: OjProviderHealth["overall"] | undefined;
  let target = `${descriptor.packageDir}/dist/worker.js`;

  const loadCheck = await runCheck("worker-module", async () => {
    const artifacts = await resolvePackageArtifacts(options.repoRoot, descriptor.platform);
    if (!artifacts.workerEntryPath || !artifacts.wranglerConfigPath) {
      throw new Error(`Missing Worker entry point or wrangler.jsonc for ${descriptor.platform}.`);
    }
    target = artifacts.workerEntryPath;
    const workerModule = (await import(`${pathToFileURL(artifacts.workerEntryPath).href}?smoke=${Date.now()}`)) as WorkerModuleShape;
    if (!workerModule?.default || typeof workerModule.default.fetch !== "function") {
      throw new Error(`Worker module ${artifacts.workerEntryPath} does not export default.fetch().`);
    }
    const env = await buildWorkerEnv(artifacts.wranglerConfigPath, workerModule);
    return { worker: workerModule.default, env, detail: `Loaded Worker module (${artifacts.workerEntryPath})` };
  });
  checks.push(loadCheck.result);

  if (!loadCheck.value) {
    return buildTargetReport(descriptor.platform, "worker", target, checks, startedAt, overallHealth);
  }

  const { worker, env } = loadCheck.value;
  const workerFetch = (request: Request) => worker.fetch(request, env);

  checks.push(
    (
      await runCheck("http-healthz", async () => {
        const response = await workerFetch(new Request("https://smoke.local/healthz"));
        if (response.status !== 200) {
          throw new Error(`GET /healthz returned HTTP ${response.status}.`);
        }
        const body = (await response.json()) as {
          mcpEndpoint?: unknown;
          authentication?: unknown;
          tools?: unknown;
        };
        if (body.mcpEndpoint !== "/mcp" || body.authentication !== "none") {
          throw new Error(`GET /healthz returned unexpected metadata: ${JSON.stringify(body)}.`);
        }
        const actualTools = Array.isArray(body.tools) ? [...body.tools].map(String).sort() : [];
        const expectedTools = [...descriptor.expectedTools].sort();
        if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
          throw new Error(`GET /healthz tool list mismatch: ${JSON.stringify(actualTools)}.`);
        }
        return { detail: `GET /healthz ok (${actualTools.length} tools advertised)` };
      })
    ).result
  );

  checks.push(...(await runWorkerSecurityChecks(workerFetch)));

  const client = new Client({ name: "oj-health-worker-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://smoke.local/mcp"), {
    fetch: (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return workerFetch(request);
    }
  });

  try {
    const connectCheck = await runCheck("mcp-connect", async () => {
      await client.connect(transport, { signal: AbortSignal.timeout(options.timeoutMs) });
      return { detail: "Connected to Worker over Streamable HTTP." };
    });
    checks.push(connectCheck.result);
    if (connectCheck.result.outcome !== "fail") {
      const sessionResult = await runMcpSessionComplianceChecks(client, descriptor, "remote_http", options);
      checks.push(...sessionResult.checks);
      overallHealth = sessionResult.overallHealth;
    }
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }

  return buildTargetReport(descriptor.platform, "worker", target, checks, startedAt, overallHealth);
}

export async function probeHttpEndpoint(
  endpointUrl: string,
  descriptor: ProviderPackageDescriptor,
  options: SmokeProbeOptions & { fetchImpl?: typeof fetch }
): Promise<ProviderTargetReport> {
  const startedAt = Date.now();
  const checks: ComplianceCheckResult[] = [];
  let overallHealth: OjProviderHealth["overall"] | undefined;
  const fetchImpl = options.fetchImpl ?? fetch;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpointUrl);
  } catch {
    return {
      platform: descriptor.platform,
      mode: "http",
      target: endpointUrl,
      outcome: "fail",
      latencyMs: Date.now() - startedAt,
      checks: [
        {
          name: "endpoint-url",
          outcome: "fail",
          durationMs: 0,
          detail: `Invalid HTTP MCP endpoint URL: ${endpointUrl}`
        }
      ]
    };
  }

  const extraHeaders: Record<string, string> = options.internalKey ? { "x-oj-mcp-key": options.internalKey } : {};
  if (parsedUrl.pathname.endsWith("/mcp")) {
    const healthUrl = new URL(parsedUrl.toString());
    healthUrl.pathname = `${parsedUrl.pathname.slice(0, -"/mcp".length)}/healthz`;
    checks.push(
      (
        await runCheck("http-healthz", async () => {
          const response = await fetchImpl(healthUrl.toString(), {
            method: "GET",
            headers: extraHeaders,
            signal: AbortSignal.timeout(options.timeoutMs)
          });
          if (response.status !== 200) {
            throw new Error(`GET ${healthUrl.pathname} returned HTTP ${response.status}.`);
          }
          const body = (await response.json()) as { mcpEndpoint?: unknown; authentication?: unknown };
          if (body.authentication !== undefined && body.authentication !== "none") {
            throw new Error(`Unexpected HTTP authentication mode: ${String(body.authentication)}.`);
          }
          return { detail: `GET ${healthUrl.pathname} returned HTTP 200.` };
        })
      ).result
    );
  }

  const client = new Client({ name: "oj-health-http-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(parsedUrl, {
    ...(Object.keys(extraHeaders).length > 0 ? { requestInit: { headers: extraHeaders } } : {}),
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {})
  });

  try {
    const connectCheck = await runCheck("mcp-connect", async () => {
      await client.connect(transport, { signal: AbortSignal.timeout(options.timeoutMs) });
      return { detail: `Connected to ${parsedUrl.origin}${parsedUrl.pathname} over Streamable HTTP.` };
    });
    checks.push(connectCheck.result);
    if (connectCheck.result.outcome !== "fail") {
      const sessionResult = await runMcpSessionComplianceChecks(client, descriptor, "remote_http", options);
      checks.push(...sessionResult.checks);
      overallHealth = sessionResult.overallHealth;
    }
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }

  return buildTargetReport(descriptor.platform, "http", parsedUrl.toString(), checks, startedAt, overallHealth);
}

export async function runMcpSessionComplianceChecks(
  client: Client,
  descriptor: ProviderPackageDescriptor,
  expectedTransport: OjCapability["transport"],
  options: Pick<SmokeProbeOptions, "timeoutMs" | "live" | "failOnDegraded">
): Promise<{ checks: ComplianceCheckResult[]; overallHealth?: OjProviderHealth["overall"] }> {
  const checks: ComplianceCheckResult[] = [];
  let listedToolNames: string[] = [];
  let overallHealth: OjProviderHealth["overall"] | undefined;

  const listCheck = await runCheck("mcp/tools-list", async () => {
    const listed = await client.listTools(undefined, { signal: AbortSignal.timeout(options.timeoutMs) });
    validateToolCatalog(listed.tools, descriptor);
    listedToolNames = listed.tools.map((tool) => tool.name);
    return { detail: `${listedToolNames.length} tools verified against policy and schemas.` };
  });
  checks.push(listCheck.result);

  checks.push(
    (
      await runCheck("mcp/capabilities", async () => {
        const result = await client.callTool(
          { name: "oj_capabilities", arguments: {} },
          undefined,
          { signal: AbortSignal.timeout(options.timeoutMs) }
        );
        if (result.isError) {
          throw new Error(`oj_capabilities failed unexpectedly: ${JSON.stringify(result)}`);
        }
        const capabilities = validateCapabilitiesPayload(
          "structuredContent" in result ? result.structuredContent : undefined,
          descriptor,
          expectedTransport,
          listedToolNames.length > 0 ? listedToolNames : descriptor.expectedTools
        );
        return { detail: `oj.capabilities/v1 valid (transport=${expectedTransport}, provider=${capabilities.providerId})` };
      })
    ).result
  );

  checks.push(
    (
      await runCheck("mcp/health", async () => {
        const result = await client.callTool(
          { name: "oj_health", arguments: {} },
          undefined,
          { signal: AbortSignal.timeout(options.timeoutMs) }
        );
        if (result.isError) {
          throw new Error(`oj_health failed unexpectedly: ${JSON.stringify(result)}`);
        }
        const health = validateHealthPayload("structuredContent" in result ? result.structuredContent : undefined, descriptor);
        overallHealth = health.overall;
        if (options.failOnDegraded && health.overall !== "healthy") {
          return {
            outcome: "fail" as const,
            errorCode: health.overall,
            detail: `Provider health is '${health.overall}' (--fail-on-degraded): ${health.message}`
          };
        }
        return { detail: `oj.provider-health/v1 overall=${health.overall} (schema=${health.layers.schema})` };
      })
    ).result
  );

  checks.push(
    (
      await runCheck("mcp/negative-unknown-tool", async () => {
        const result = await client.callTool(
          { name: "__oj_health_unknown_tool__", arguments: {} },
          undefined,
          { signal: AbortSignal.timeout(options.timeoutMs) }
        );
        const error = validateErrorResult(result as McpToolCallEnvelope, descriptor, {
          expectedCode: "request.invalid",
          forbiddenSubstrings: ["NOWCODER_SESSION_COOKIE", "<html"]
        });
        return { detail: `Unknown tool returned oj.error/v1 (${error.code}, layer=${error.layer})` };
      })
    ).result
  );

  checks.push(
    (
      await runCheck("mcp/negative-invalid-search", async () => {
        const result = await client.callTool(
          { name: "oj_search_problems", arguments: descriptor.sampleInputs.invalidSearchArgs },
          undefined,
          { signal: AbortSignal.timeout(options.timeoutMs) }
        );
        const error = validateErrorResult(result as McpToolCallEnvelope, descriptor, {
          expectedCode: "request.invalid",
          forbiddenSubstrings: ["NOWCODER_SESSION_COOKIE", "<html"]
        });
        return { detail: `Invalid search rejected fail-closed (${error.code}, layer=${error.layer})` };
      })
    ).result
  );

  checks.push(
    (
      await runCheck("mcp/negative-invalid-read", async () => {
        const result = await client.callTool(
          {
            name: descriptor.sampleInputs.readToolName,
            arguments: descriptor.sampleInputs.invalidReadArgs
          },
          undefined,
          { signal: AbortSignal.timeout(options.timeoutMs) }
        );
        const error = validateErrorResult(result as McpToolCallEnvelope, descriptor, {
          expectedCode: "request.invalid",
          forbiddenSubstrings: ["NOWCODER_SESSION_COOKIE", "<html"]
        });
        return { detail: `Invalid read locator rejected fail-closed (${error.code}, layer=${error.layer})` };
      })
    ).result
  );

  if (options.live) {
    checks.push(
      (
        await runCheck("mcp/live-search", async () => {
          const requestId = String(descriptor.sampleInputs.searchArgs.requestId);
          const result = await client.callTool(
            { name: "oj_search_problems", arguments: descriptor.sampleInputs.searchArgs },
            undefined,
            { signal: AbortSignal.timeout(options.timeoutMs) }
          );
          if (result.isError) {
            const err = validateErrorResult(result as McpToolCallEnvelope, descriptor);
            return {
              outcome: "fail" as const,
              errorCode: err.code,
              detail: `Live search returned ${err.code}: ${err.message}`
            };
          }
          const parsed = validateSearchResultPayload(
            "structuredContent" in result ? result.structuredContent : undefined,
            descriptor,
            requestId
          );
          return { detail: `Live search returned ${parsed.items.length} item(s).` };
        })
      ).result
    );

    checks.push(
      (
        await runCheck("mcp/live-read", async () => {
          const result = await client.callTool(
            { name: descriptor.sampleInputs.readToolName, arguments: descriptor.sampleInputs.readArgs },
            undefined,
            { signal: AbortSignal.timeout(options.timeoutMs) }
          );
          if (result.isError) {
            const err = validateErrorResult(result as McpToolCallEnvelope, descriptor);
            return {
              outcome: "fail" as const,
              errorCode: err.code,
              detail: `Live read returned ${err.code}: ${err.message}`
            };
          }
          const structured = "structuredContent" in result ? result.structuredContent : undefined;
          if (descriptor.sampleInputs.readExpectation === "problem-summary") {
            const summary = validateProblemSummaryPayload(structured, descriptor);
            return { detail: `Live metadata read returned ${summary.ref.canonicalId} (${summary.title}).` };
          }
          const doc = validateProblemDocumentPayload(structured, descriptor);
          return { detail: `Live problem read returned ${doc.ref.canonicalId} (${doc.title}, ${doc.samples.length} sample(s)).` };
        })
      ).result
    );
  }

  return { checks, overallHealth };
}

async function runWorkerSecurityChecks(
  workerFetch: (request: Request) => Promise<Response>
): Promise<ComplianceCheckResult[]> {
  const results: ComplianceCheckResult[] = [];

  results.push(
    (
      await runCheck("worker/not-found", async () => {
        const response = await workerFetch(new Request("https://smoke.local/not-a-route"));
        if (response.status !== 404) {
          throw new Error(`Expected 404 for unknown Worker route, got ${response.status}.`);
        }
        return { detail: "Unknown Worker route rejected with HTTP 404." };
      })
    ).result
  );

  results.push(
    (
      await runCheck("worker/origin-deny", async () => {
        const response = await workerFetch(
          new Request("https://smoke.local/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              origin: "https://evil.example"
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
          })
        );
        if (response.status !== 403) {
          throw new Error(`Expected 403 for disallowed Origin, got ${response.status}.`);
        }
        return { detail: "Disallowed Origin rejected with HTTP 403." };
      })
    ).result
  );

  results.push(
    (
      await runCheck("worker/credential-reject", async () => {
        for (const [headerName, headerValue] of [
          ["cookie", "session=forbidden"],
          ["authorization", "Bearer forbidden"]
        ] as const) {
          const response = await workerFetch(
            new Request("https://smoke.local/mcp", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                [headerName]: headerValue
              },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
            })
          );
          if (response.status !== 400) {
            throw new Error(`Expected 400 when ${headerName} header is sent to anonymous worker, got ${response.status}.`);
          }
        }
        return { detail: "Cookie and Authorization headers rejected with HTTP 400." };
      })
    ).result
  );

  results.push(
    (
      await runCheck("worker/batch-reject", async () => {
        const response = await workerFetch(
          new Request("https://smoke.local/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream"
            },
            body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }])
          })
        );
        if (response.status !== 400) {
          throw new Error(`Expected 400 for JSON-RPC batch request, got ${response.status}.`);
        }
        return { detail: "JSON-RPC batch request rejected with HTTP 400." };
      })
    ).result
  );

  return results;
}

async function buildWorkerEnv(
  wranglerConfigPath: string,
  workerModule: WorkerModuleShape
): Promise<Record<string, unknown>> {
  const raw = await readFile(wranglerConfigPath, "utf8");
  const config = JSON.parse(raw) as {
    durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
  };
  const env: Record<string, unknown> = {};
  for (const binding of config.durable_objects?.bindings ?? []) {
    if (!binding.name || !binding.class_name) continue;
    const DoClass = workerModule[binding.class_name];
    if (typeof DoClass !== "function") {
      throw new Error(`Worker module does not export Durable Object class '${binding.class_name}' referenced by ${wranglerConfigPath}.`);
    }
    const instances = new Map<string, { fetch(request: Request): Promise<Response> }>();
    env[binding.name] = {
      getByName(name: string) {
        let instance = instances.get(name);
        if (!instance) {
          const storage = createInMemoryStorage();
          instance = new (DoClass as new (state: { storage: ReturnType<typeof createInMemoryStorage> }) => {
            fetch(request: Request): Promise<Response>;
          })({ storage });
          instances.set(name, instance);
        }
        return instance;
      }
    };
  }
  return env;
}

function createInMemoryStorage() {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async delete(keys: string | string[]): Promise<boolean | number> {
      if (Array.isArray(keys)) {
        let deleted = 0;
        for (const key of keys) {
          if (store.delete(key)) deleted += 1;
        }
        return deleted;
      }
      return store.delete(keys);
    },
    async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
      const entries = new Map<string, T>();
      for (const [key, value] of store.entries()) {
        if (key.startsWith(options.prefix)) {
          entries.set(key, value as T);
        }
      }
      return entries;
    }
  };
}

async function runCheck<T extends { detail: string; outcome?: "pass" | "fail"; errorCode?: string }>(
  name: string,
  fn: () => Promise<T>
): Promise<{ result: ComplianceCheckResult; value?: T }> {
  const startedAt = Date.now();
  try {
    const value = await fn();
    return {
      result: {
        name,
        outcome: value.outcome ?? "pass",
        durationMs: Date.now() - startedAt,
        detail: value.detail,
        ...(value.errorCode ? { errorCode: value.errorCode } : {})
      },
      value
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        name,
        outcome: "fail",
        durationMs: Date.now() - startedAt,
        detail: message
      }
    };
  }
}

function buildTargetReport(
  platform: ProviderPackageDescriptor["platform"],
  mode: SmokeMode,
  target: string,
  checks: ComplianceCheckResult[],
  startedAt: number,
  overallHealth?: OjProviderHealth["overall"]
): ProviderTargetReport {
  const hasFail = checks.some((check) => check.outcome === "fail");
  const allSkipped = checks.length > 0 && checks.every((check) => check.outcome === "skip");
  return {
    platform,
    mode,
    target,
    outcome: hasFail ? "fail" : allSkipped ? "skip" : "pass",
    ...(overallHealth ? { overallHealth } : {}),
    latencyMs: Date.now() - startedAt,
    checks
  };
}

function cleanDefinedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      defined[key] = value;
    }
  }
  return defined;
}
