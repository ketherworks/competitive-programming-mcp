import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AtCoderHtmlClient } from "../../packages/atcoder/src/client.js";
import { AtCoderProvider } from "../../packages/atcoder/src/provider.js";
import { createAtCoderMcpServer } from "../../packages/atcoder/src/server.js";
import { CodeforcesApiClient } from "../../packages/codeforces/src/client.js";
import { CodeforcesProvider } from "../../packages/codeforces/src/provider.js";
import { CodeforcesRateLimiter } from "../../packages/codeforces/src/rateLimiter.js";
import { createCodeforcesMcpServer } from "../../packages/codeforces/src/server.js";
import { LuoguPageClient } from "../../packages/luogu/src/client.js";
import { LuoguProvider } from "../../packages/luogu/src/provider.js";
import { createLuoguMcpServer } from "../../packages/luogu/src/server.js";
import { NowCoderPageClient, type NowCoderHttpResponse } from "../../packages/nowcoder/src/client.js";
import { NowCoderProvider } from "../../packages/nowcoder/src/provider.js";
import { createNowCoderMcpServer } from "../../packages/nowcoder/src/server.js";
import { getProviderDescriptor, type ProviderPackageDescriptor, type SupportedPlatform } from "../../tools/oj-health/src/index.js";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export type ComplianceScenario =
  | { kind: "ok" }
  | { kind: "not_found"; sentinelBody: string }
  | { kind: "rate_limited"; retryAfterSeconds: number; sentinelBody: string }
  | { kind: "upstream_unavailable"; status: number; sentinelBody: string }
  | { kind: "schema_drift"; sentinelBody: string }
  | { kind: "hang" };

export interface ComplianceHarness {
  platform: SupportedPlatform;
  descriptor: ProviderPackageDescriptor;
  client: Client;
  getNetworkCallCount: () => number;
  getObservedAbortSignal: () => AbortSignal | undefined;
  setScenario: (scenario: ComplianceScenario) => void;
  close: () => Promise<void>;
}

const FIXED_NOW_ISO = "2026-07-15T12:00:00.000Z";

export async function createComplianceHarness(
  platform: SupportedPlatform,
  initialScenario: ComplianceScenario = { kind: "ok" }
): Promise<ComplianceHarness> {
  const descriptor = getProviderDescriptor(platform);
  let scenario = initialScenario;
  let networkCalls = 0;
  let observedSignal: AbortSignal | undefined;

  const { server, dispose } = await buildPlatformServer(platform, {
    getScenario: () => scenario,
    recordNetworkCall: (signal) => {
      networkCalls += 1;
      observedSignal = signal;
    }
  });

  const client = new Client({ name: `compliance-client-${platform}`, version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    platform,
    descriptor,
    client,
    getNetworkCallCount: () => networkCalls,
    getObservedAbortSignal: () => observedSignal,
    setScenario: (next) => {
      scenario = next;
    },
    close: async () => {
      await client.close();
      await server.close();
      await dispose?.();
    }
  };
}

interface AdapterContext {
  getScenario: () => ComplianceScenario;
  recordNetworkCall: (signal?: AbortSignal) => void;
}

async function buildPlatformServer(
  platform: SupportedPlatform,
  context: AdapterContext
): Promise<{ server: McpServer | Server; dispose?: () => Promise<void> }> {
  switch (platform) {
    case "codeforces": {
      const fetchImpl: typeof fetch = async (_input, init) => {
        context.recordNetworkCall(init?.signal ?? undefined);
        const current = context.getScenario();
        if (current.kind === "hang") {
          return await hangUntilAborted(init?.signal ?? undefined);
        }
        if (current.kind === "rate_limited") {
          return new Response(current.sentinelBody, {
            status: 429,
            headers: { "retry-after": String(current.retryAfterSeconds) }
          });
        }
        if (current.kind === "upstream_unavailable") {
          return new Response(current.sentinelBody, { status: current.status });
        }
        if (current.kind === "schema_drift") {
          return new Response(JSON.stringify({ status: "OK", broken: current.sentinelBody }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(
          JSON.stringify({
            status: "OK",
            result: {
              problems: [
                { contestId: 4, index: "A", name: "Watermelon", type: "PROGRAMMING", rating: 800, tags: ["brute force", "math"] }
              ],
              problemStatistics: [{ contestId: 4, index: "A", solvedCount: 250000 }]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const provider = new CodeforcesProvider({
        client: new CodeforcesApiClient({
          fetchImpl,
          limiter: new CodeforcesRateLimiter({ intervalMs: 0 })
        }),
        nowIso: () => FIXED_NOW_ISO
      });
      return { server: createCodeforcesMcpServer({ provider, transport: "local_stdio" }) };
    }

    case "atcoder": {
      const htmlFixture = await readFixture("packages/atcoder/test/fixtures/abc086-a-en.html");
      const fetchImpl: typeof fetch = async (_input, init) => {
        context.recordNetworkCall(init?.signal ?? undefined);
        const current = context.getScenario();
        if (current.kind === "hang") {
          return await hangUntilAborted(init?.signal ?? undefined);
        }
        if (current.kind === "not_found") {
          return new Response(current.sentinelBody, { status: 404, headers: { "content-type": "text/html" } });
        }
        if (current.kind === "rate_limited") {
          return new Response(current.sentinelBody, {
            status: 429,
            headers: { "retry-after": String(current.retryAfterSeconds) }
          });
        }
        if (current.kind === "upstream_unavailable") {
          return new Response(current.sentinelBody, { status: current.status });
        }
        if (current.kind === "schema_drift") {
          return new Response(`<html><body><div>${current.sentinelBody}</div></body></html>`, {
            status: 200,
            headers: { "content-type": "text/html" }
          });
        }
        return new Response(htmlFixture, { status: 200, headers: { "content-type": "text/html" } });
      };

      const provider = new AtCoderProvider({
        client: new AtCoderHtmlClient({ fetchImpl }),
        nowIso: () => FIXED_NOW_ISO
      });
      return { server: createAtCoderMcpServer({ provider, transport: "local_stdio" }) };
    }

    case "luogu": {
      const problemFixture = await readFixture("packages/luogu/test/fixtures/problem-ok.json");
      const searchFixture = await readFixture("packages/luogu/test/fixtures/problem-search-ok.json");
      const fetchImpl: typeof fetch = async (input, init) => {
        context.recordNetworkCall(init?.signal ?? undefined);
        const current = context.getScenario();
        if (current.kind === "hang") {
          return await hangUntilAborted(init?.signal ?? undefined);
        }
        if (current.kind === "not_found") {
          return new Response(current.sentinelBody, { status: 404, headers: { "content-type": "application/json" } });
        }
        if (current.kind === "rate_limited") {
          return new Response(current.sentinelBody, {
            status: 429,
            headers: { "retry-after": String(current.retryAfterSeconds) }
          });
        }
        if (current.kind === "upstream_unavailable") {
          return new Response(current.sentinelBody, { status: current.status });
        }
        if (current.kind === "schema_drift") {
          return new Response(JSON.stringify({ data: { unexpected: current.sentinelBody } }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const body = url.pathname.endsWith("/list") ? searchFixture : problemFixture;
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      };

      const provider = new LuoguProvider({
        reader: new LuoguPageClient({ fetchImpl }),
        nowIso: () => FIXED_NOW_ISO,
        transport: "local_stdio"
      });
      return { server: createLuoguMcpServer({ provider }) };
    }

    case "nowcoder": {
      const problemFixture = await readFixture("packages/nowcoder/test/fixtures/acm-problem.html");
      const listFixture = await readFixture("packages/nowcoder/test/fixtures/problem-list.html");
      const requester = async (url: URL, reqContext: { signal: AbortSignal }): Promise<NowCoderHttpResponse> => {
        context.recordNetworkCall(reqContext.signal);
        const current = context.getScenario();
        if (current.kind === "hang") {
          return await hangUntilAborted(reqContext.signal);
        }
        if (current.kind === "not_found") {
          return { status: 404, body: current.sentinelBody, headers: { "content-type": "text/html" } };
        }
        if (current.kind === "rate_limited") {
          return {
            status: 429,
            body: current.sentinelBody,
            headers: { "content-type": "text/html", "retry-after": String(current.retryAfterSeconds) }
          };
        }
        if (current.kind === "upstream_unavailable") {
          return { status: current.status, body: current.sentinelBody, headers: { "content-type": "text/html" } };
        }
        if (current.kind === "schema_drift") {
          return {
            status: 200,
            body: `<html><body><div>${current.sentinelBody}</div></body></html>`,
            headers: { "content-type": "text/html" }
          };
        }
        return {
          status: 200,
          body: url.pathname.endsWith("/list") ? listFixture : problemFixture,
          headers: { "content-type": "text/html" }
        };
      };

      const provider = new NowCoderProvider({
        client: new NowCoderPageClient({ requester }),
        nowIso: () => FIXED_NOW_ISO
      });
      return {
        server: createNowCoderMcpServer({ provider }),
        dispose: () => provider.dispose()
      };
    }
  }
}

function readFixture(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), "utf8");
}

function hangUntilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) {
      reject(new Error("Expected AbortSignal for cancellation compliance check."));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
      { once: true }
    );
  });
}
