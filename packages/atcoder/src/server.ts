import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import {
  createOjError,
  ojCapabilitiesSchema,
  ojProblemDocumentSchema,
  ojProviderHealthSchema,
  ojSearchResultSchema,
  type OjCapability,
  type OjError
} from "@kaiserunix/oj-mcp-contracts";
import {
  defineOjTool,
  executeOjToolCall,
  parseStrictToolInput,
  strictEmptyInputSchema,
  toNormalizedToolError,
  type OjErrorNormalizerOptions
} from "@kaiserunix/oj-mcp-server-common";
import { z } from "zod";
import { AtCoderClientError } from "./client.js";
import {
  AtCoderProvider,
  atCoderFetchProblemInputSchema,
  atCoderSearchInputSchema
} from "./provider.js";

export const ATCODER_MCP_TOOL_NAMES = ["oj_capabilities", "oj_health", "oj_fetch_problem", "oj_search_problems"] as const;

export interface AtCoderMcpServerOptions {
  provider?: AtCoderProvider;
  transport: OjCapability["transport"];
}

const errorNormalizer: OjErrorNormalizerOptions = {
  platform: "atcoder",
  providerId: "atcoder-page-adapter",
  internalMessage: "AtCoder provider failed.",
  resolveLayer: (error) => {
    if (error.code === "policy.blocked") return "policy";
    if (error.code === "network.timeout") return "transport";
    if (error.code === "request.invalid") return "protocol";
    if (error.code === "challenge.required") return "auth";
    if (error.code === "resource.not_found" || error.code === "rate_limited" || error.code.startsWith("upstream.")) {
      return "upstream";
    }
    return "broker";
  },
  resolveRetryPolicy: (error): OjError["retryPolicy"] =>
    error.code === "rate_limited" ||
    error.code === "network.timeout" ||
    error.code === "upstream.unavailable" ||
    error.code === "challenge.required"
      ? "safe_read"
      : "never",
  resolveUserAction: (error): OjError["userAction"] => {
    if (
      error.code === "rate_limited" ||
      error.code === "network.timeout" ||
      error.code === "upstream.unavailable" ||
      error.code === "challenge.required"
    ) {
      return "retry";
    }
    if (error.code === "upstream.schema_changed" || error.code === "internal") return "open_logs";
    return "none";
  },
  mapUnknownError: (caught) =>
    caught instanceof z.ZodError
      ? createOjError({
          code: "request.invalid",
          layer: "protocol",
          message: "AtCoder request failed schema validation.",
          retryPolicy: "never",
          userAction: "none",
          platform: "atcoder",
          providerId: "atcoder-page-adapter"
        })
      : undefined
};

export function createAtCoderMcpServer(options: AtCoderMcpServerOptions): Server {
  const provider = options.provider ?? new AtCoderProvider();
  const server = new Server(
    { name: "atcoder-mcp-server", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const input = request.params.arguments ?? {};
    switch (request.params.name) {
      case "oj_capabilities":
        return callWithSchema(strictEmptyInputSchema, input, () => provider.getCapabilities(options.transport), extra.signal);
      case "oj_health":
        return callWithSchema(strictEmptyInputSchema, input, () => provider.getHealth(), extra.signal);
      case "oj_fetch_problem":
        return callWithSchema(
          atCoderFetchProblemInputSchema,
          input,
          (parsed) => provider.fetchProblem(parsed, extra.signal),
          extra.signal
        );
      case "oj_search_problems":
        return callWithSchema(
          atCoderSearchInputSchema,
          input,
          (parsed) => provider.search(parsed, extra.signal),
          extra.signal
        );
      default:
        return toNormalizedToolError(
          new AtCoderClientError("request.invalid", `Unknown AtCoder tool '${request.params.name}'.`),
          errorNormalizer
        );
    }
  });

  return server;
}

function toolDefinitions(): Tool[] {
  return [
    defineOjTool({
      name: "oj_capabilities",
      title: "AtCoder Provider Capabilities",
      description: "Report the audited anonymous AtCoder read surface and explicitly unsupported operations.",
      inputSchema: strictEmptyInputSchema,
      outputSchema: ojCapabilitiesSchema,
      openWorldHint: false,
      inputSchemaTarget: "draft-2020-12"
    }),
    defineOjTool({
      name: "oj_health",
      title: "AtCoder Provider Health",
      description: "Report local readiness and the latest observed AtCoder page-read status without probing upstream.",
      inputSchema: strictEmptyInputSchema,
      outputSchema: ojProviderHealthSchema,
      openWorldHint: false,
      inputSchemaTarget: "draft-2020-12"
    }),
    defineOjTool({
      name: "oj_fetch_problem",
      title: "Fetch AtCoder Problem",
      description:
        "Fetch one public problem statement from an exact contest/task pair or canonical atcoder.jp task URL. Returns sanitized HTML with preserved math, samples, limits, hashes, and source provenance.",
      inputSchema: atCoderFetchProblemInputSchema,
      outputSchema: ojProblemDocumentSchema,
      openWorldHint: true,
      inputSchemaTarget: "draft-2020-12"
    }),
    defineOjTool({
      name: "oj_search_problems",
      title: "Find Exact AtCoder Problem",
      description:
        "Resolve exactly one contest/task id, atcoder:contest/task id, or canonical task URL. Free-text and catalog crawling are not supported.",
      inputSchema: atCoderSearchInputSchema,
      outputSchema: ojSearchResultSchema,
      openWorldHint: true,
      inputSchemaTarget: "draft-2020-12"
    })
  ];
}

function callWithSchema<T>(
  schema: z.ZodType<T>,
  input: unknown,
  operation: (parsed: T) => Promise<object>,
  signal?: AbortSignal
): Promise<CallToolResult> {
  return executeOjToolCall(
    async () => {
      const parsed = parseStrictToolInput(schema, input, (error) => {
        throw new AtCoderClientError(
          "request.invalid",
          error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join(" ")
        );
      });
      return operation(parsed);
    },
    { errorNormalizer, signal }
  );
}
