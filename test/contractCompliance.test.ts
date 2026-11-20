import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ojSchemaRegistry } from "@kaiserunix/oj-mcp-contracts";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  SUPPORTED_PLATFORMS,
  validateCapabilitiesPayload,
  validateErrorResult,
  validateHealthPayload,
  validateProblemDocumentPayload,
  validateProblemSummaryPayload,
  validateSearchResultPayload,
  validateToolCatalog,
  type McpToolCallEnvelope
} from "../tools/oj-health/src/index.js";
import { createComplianceHarness, type ComplianceHarness } from "./compliance/providerAdapters.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const harnesses: ComplianceHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

async function openHarness(platform: (typeof SUPPORTED_PLATFORMS)[number]): Promise<ComplianceHarness> {
  const harness = await createComplianceHarness(platform);
  harnesses.push(harness);
  return harness;
}

describe("cross-provider OJ v1 contract compliance", () => {
  describe.each(SUPPORTED_PLATFORMS)("%s provider contract", (platform) => {
    test("exposes policy-compliant MCP tools, schemas, and annotations", async () => {
      const harness = await openHarness(platform);
      const listed = await harness.client.listTools();

      expect(() => validateToolCatalog(listed.tools, harness.descriptor)).not.toThrow();
      expect(harness.getNetworkCallCount()).toBe(0);
    });

    test("reports valid oj.capabilities/v1 aligned with advertised tools and transport", async () => {
      const harness = await openHarness(platform);
      const listed = await harness.client.listTools();
      const result = await harness.client.callTool({ name: "oj_capabilities", arguments: {} });

      expect(result.isError).not.toBe(true);
      const capabilities = validateCapabilitiesPayload(
        "structuredContent" in result ? result.structuredContent : undefined,
        harness.descriptor,
        "local_stdio",
        listed.tools.map((tool) => tool.name)
      );
      expect(capabilities.platform).toBe(platform);
      expect(harness.getNetworkCallCount()).toBe(0);
    });

    test("keeps oj_health passive on cold start without touching upstream", async () => {
      const harness = await openHarness(platform);
      const result = await harness.client.callTool({ name: "oj_health", arguments: {} });

      expect(result.isError).not.toBe(true);
      const health = validateHealthPayload(
        "structuredContent" in result ? result.structuredContent : undefined,
        harness.descriptor
      );
      expect(["unknown", "pass"]).toContain(health.layers.schema);
      expect(health.layers.transport).toBe("pass");
      expect(health.layers.protocol).toBe("pass");
      expect(health.layers.upstream).toBe("pass");
      expect(harness.getNetworkCallCount()).toBe(0);
    });

    test("rejects malformed inputs and unknown tools fail-closed with zero upstream calls", async () => {
      const harness = await openHarness(platform);
      const { sampleInputs } = harness.descriptor;

      const invalidCalls = [
        { name: "__unknown_oj_tool__", arguments: {} },
        { name: "oj_capabilities", arguments: { unexpected: true } },
        { name: "oj_health", arguments: { unexpected: true } },
        { name: "oj_search_problems", arguments: sampleInputs.invalidSearchArgs },
        { name: sampleInputs.readToolName, arguments: sampleInputs.invalidReadArgs }
      ];

      for (const call of invalidCalls) {
        const result = await harness.client.callTool(call);
        validateErrorResult(result as McpToolCallEnvelope, harness.descriptor, {
          expectedCode: "request.invalid"
        });
      }

      expect(harness.getNetworkCallCount()).toBe(0);
    });

    test("executes fixture search and problem read with valid digests and transitions health to healthy", async () => {
      const harness = await openHarness(platform);
      const { sampleInputs } = harness.descriptor;
      const requestId = String(sampleInputs.searchArgs.requestId);

      const searchResponse = await harness.client.callTool({
        name: "oj_search_problems",
        arguments: sampleInputs.searchArgs
      });
      expect(searchResponse.isError).not.toBe(true);
      const searchResult = validateSearchResultPayload(
        "structuredContent" in searchResponse ? searchResponse.structuredContent : undefined,
        harness.descriptor,
        requestId
      );
      expect(searchResult.items.length).toBeGreaterThan(0);

      const readResponse = await harness.client.callTool({
        name: sampleInputs.readToolName,
        arguments: sampleInputs.readArgs
      });
      expect(readResponse.isError).not.toBe(true);
      const readStructured = "structuredContent" in readResponse ? readResponse.structuredContent : undefined;
      if (sampleInputs.readExpectation === "problem-summary") {
        validateProblemSummaryPayload(readStructured, harness.descriptor);
      } else {
        const doc = validateProblemDocumentPayload(readStructured, harness.descriptor);
        expect(doc.samples.length).toBeGreaterThan(0);
      }

      const healthResponse = await harness.client.callTool({ name: "oj_health", arguments: {} });
      const health = validateHealthPayload(
        "structuredContent" in healthResponse ? healthResponse.structuredContent : undefined,
        harness.descriptor
      );
      expect(health.overall).toBe("healthy");
      expect(health.layers.schema).toBe("pass");
      expect(health.layers.upstream).toBe("pass");
    });

    test("returns non-degrading resource.not_found without leaking upstream error bodies", async () => {
      const harness = await openHarness(platform);
      const sentinel = "SENTINEL_NOT_FOUND_BODY_DO_NOT_LEAK";
      harness.setScenario({ kind: "not_found", sentinelBody: sentinel });

      const missingArgs =
        platform === "codeforces"
          ? { nativeId: "9999/Z" }
          : platform === "atcoder"
            ? { contestId: "abc999", taskId: "abc999_z", locale: "en" }
            : platform === "luogu"
              ? { nativeId: "P999999", maxContentChars: 5000 }
              : { nativeId: "NC999999" };

      const result = await harness.client.callTool({
        name: harness.descriptor.sampleInputs.readToolName,
        arguments: missingArgs
      });
      const error = validateErrorResult(result as McpToolCallEnvelope, harness.descriptor, {
        expectedCode: "resource.not_found",
        forbiddenSubstrings: [sentinel]
      });
      expect(error.retryPolicy).toBe("never");
      expect(error.userAction).toBe("none");

      const healthResponse = await harness.client.callTool({ name: "oj_health", arguments: {} });
      const health = validateHealthPayload(
        "structuredContent" in healthResponse ? healthResponse.structuredContent : undefined,
        harness.descriptor
      );
      expect(health.layers.upstream).toBe("pass");
    });

    test("maps rate-limit, upstream outage, and schema drift into oj.error/v1 without leaking raw bodies", async () => {
      const cases = [
        {
          scenario: { kind: "rate_limited" as const, retryAfterSeconds: 5, sentinelBody: "SECRET_429_HTML_BODY" },
          expectedCode: "rate_limited" as const,
          expectedRetryPolicy: "safe_read" as const,
          expectedUserAction: "retry" as const,
          expectedHealthOverall: "degraded" as const,
          expectedUpstreamLayer: "rate_limited" as const,
          expectedSchemaLayer: undefined
        },
        {
          scenario: { kind: "upstream_unavailable" as const, status: 503, sentinelBody: "SECRET_503_GATEWAY_BODY" },
          expectedCode: "upstream.unavailable" as const,
          expectedRetryPolicy: "safe_read" as const,
          expectedUserAction: "retry" as const,
          expectedHealthOverall: "unavailable" as const,
          expectedUpstreamLayer: "fail" as const,
          expectedSchemaLayer: undefined
        },
        {
          scenario: { kind: "schema_drift" as const, sentinelBody: "SECRET_DRIFT_UPSTREAM_PAYLOAD" },
          expectedCode: "upstream.schema_changed" as const,
          expectedRetryPolicy: "never" as const,
          expectedUserAction: "open_logs" as const,
          expectedHealthOverall: "degraded" as const,
          expectedUpstreamLayer: undefined,
          expectedSchemaLayer: "drift" as const
        }
      ];

      for (const testCase of cases) {
        const harness = await openHarness(platform);
        harness.setScenario(testCase.scenario);

        const targetCall =
          platform === "codeforces"
            ? { name: "oj_search_problems", arguments: harness.descriptor.sampleInputs.searchArgs }
            : { name: harness.descriptor.sampleInputs.readToolName, arguments: harness.descriptor.sampleInputs.readArgs };

        const response = await harness.client.callTool(targetCall);
        const error = validateErrorResult(response as McpToolCallEnvelope, harness.descriptor, {
          expectedCode: testCase.expectedCode,
          forbiddenSubstrings: [testCase.scenario.sentinelBody]
        });
        expect(error.retryPolicy).toBe(testCase.expectedRetryPolicy);
        expect(error.userAction).toBe(testCase.expectedUserAction);
        if (testCase.expectedCode === "rate_limited") {
          expect(error.retryAfterMs).toBe(5_000);
        }

        const healthResponse = await harness.client.callTool({ name: "oj_health", arguments: {} });
        const health = validateHealthPayload(
          "structuredContent" in healthResponse ? healthResponse.structuredContent : undefined,
          harness.descriptor
        );
        expect(health.overall).toBe(testCase.expectedHealthOverall);
        if (testCase.expectedUpstreamLayer) {
          expect(health.layers.upstream).toBe(testCase.expectedUpstreamLayer);
        }
        if (testCase.expectedSchemaLayer) {
          expect(health.layers.schema).toBe(testCase.expectedSchemaLayer);
        }
      }
    });

    test("propagates request cancellation without degrading provider health", async () => {
      const harness = await openHarness(platform);
      harness.setScenario({ kind: "hang" });

      const controller = new AbortController();
      const targetCall =
        platform === "codeforces"
          ? { name: "oj_search_problems", arguments: harness.descriptor.sampleInputs.searchArgs }
          : { name: harness.descriptor.sampleInputs.readToolName, arguments: harness.descriptor.sampleInputs.readArgs };

      const pending = harness.client.callTool(targetCall, undefined, { signal: controller.signal, timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort(new DOMException("Cancelled by compliance test", "AbortError"));

      await expect(pending).rejects.toThrow();

      const healthResponse = await harness.client.callTool({ name: "oj_health", arguments: {} });
      const health = validateHealthPayload(
        "structuredContent" in healthResponse ? healthResponse.structuredContent : undefined,
        harness.descriptor
      );
      expect(health.layers.upstream).toBe("pass");
      expect(health.layers.transport).toBe("pass");
    });
  });

  test("publishes valid draft 2020-12 JSON Schemas for every contract in ojSchemaRegistry", async () => {
    for (const [name, schema] of Object.entries(ojSchemaRegistry)) {
      const schemaFilePath = join(repoRoot, "packages", "contracts", "schema", "v1", `${name}.schema.json`);
      const onDisk = JSON.parse(await readFile(schemaFilePath, "utf8")) as {
        $schema?: string;
        type?: string;
        additionalProperties?: boolean;
        properties?: { schemaVersion?: { const?: string } };
      };
      const generated = z.toJSONSchema(schema) as {
        $schema?: string;
        type?: string;
        additionalProperties?: boolean;
        properties?: { schemaVersion?: { const?: string } };
      };
      expect(onDisk.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(onDisk.type).toBe(generated.type);
      expect(onDisk.additionalProperties).toBe(generated.additionalProperties);
      expect(onDisk.properties?.schemaVersion?.const).toBe(generated.properties?.schemaVersion?.const);
    }
  });
});
