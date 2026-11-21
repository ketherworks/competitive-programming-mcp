import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ojCapabilitiesSchema,
  ojProblemSummarySchema,
  ojProviderHealthSchema,
  ojSearchResultSchema,
  type OjCapability,
  type OjError
} from "@kaiserunix/oj-mcp-contracts";
import {
  createPermissiveCallToolRequestSchema,
  defineOjTool,
  executeOjToolCall,
  extractBoundedRequestId,
  parseStrictToolInput,
  readToolArguments,
  readToolName,
  strictEmptyInputSchema,
  type OjErrorNormalizerOptions
} from "@kaiserunix/oj-mcp-server-common";
import { z } from "zod";
import { CodeforcesApiError, CodeforcesRequestCancelledError } from "./client.js";
import { CodeforcesProvider, codeforcesSearchInputSchema } from "./provider.js";

export const CODEFORCES_MCP_TOOL_NAMES = [
  "oj_capabilities",
  "oj_health",
  "oj_search_problems",
  "codeforces_get_problem_metadata"
] as const;

const metadataInputSchema = z.object({ nativeId: z.string().trim().min(3).max(64) }).strict();
const permissiveCallToolRequestSchema = createPermissiveCallToolRequestSchema("__invalid_codeforces_tool_call__");

const errorNormalizer: OjErrorNormalizerOptions = {
  platform: "codeforces",
  providerId: "codeforces-official-api",
  internalMessage: "Codeforces provider failed.",
  resolveLayer: (error): OjError["layer"] => {
    if (error.code === "network.timeout") return "transport";
    if (error.code === "rate_limited" || error.code === "resource.not_found" || error.code.startsWith("upstream.")) {
      return "upstream";
    }
    return "broker";
  },
  resolveRetryPolicy: (error): OjError["retryPolicy"] =>
    error.code === "rate_limited" || error.code === "network.timeout" || error.code === "upstream.unavailable"
      ? "safe_read"
      : "never",
  resolveUserAction: (error): OjError["userAction"] => {
    if (error.code === "rate_limited" || error.code === "network.timeout" || error.code === "upstream.unavailable") {
      return "retry";
    }
    if (error.code === "upstream.schema_changed" || error.code === "internal") return "open_logs";
    return "none";
  }
};

const tools: Tool[] = [
  defineOjTool({
    name: "oj_capabilities",
    title: "Codeforces Provider Capabilities",
    description: "Report audited Codeforces official API capabilities and unsupported operations.",
    inputSchema: strictEmptyInputSchema,
    outputSchema: ojCapabilitiesSchema,
    openWorldHint: false
  }),
  defineOjTool({
    name: "oj_health",
    title: "Codeforces Provider Health",
    description: "Return passive transport, schema, and persisted Codeforces upstream health.",
    inputSchema: strictEmptyInputSchema,
    outputSchema: ojProviderHealthSchema,
    openWorldHint: true
  }),
  defineOjTool({
    name: "oj_search_problems",
    title: "Search Codeforces Problems",
    description: "Search official Codeforces problem metadata by id, title, or tag.",
    inputSchema: codeforcesSearchInputSchema,
    outputSchema: ojSearchResultSchema,
    openWorldHint: true
  }),
  defineOjTool({
    name: "codeforces_get_problem_metadata",
    title: "Get Codeforces Problem Metadata",
    description: "Get official metadata only. This tool does not return a problem statement or submit code.",
    inputSchema: metadataInputSchema,
    outputSchema: ojProblemSummarySchema,
    openWorldHint: true
  })
];

export interface CodeforcesMcpServerOptions {
  provider?: CodeforcesProvider;
  transport: OjCapability["transport"];
}

export function createCodeforcesMcpServer(options: CodeforcesMcpServerOptions): McpServer {
  const provider = options.provider ?? new CodeforcesProvider();
  const server = new McpServer({ name: "codeforces-mcp-server", version: "0.1.0" });
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.server.setRequestHandler(permissiveCallToolRequestSchema, async (request, extra) => {
    const params = request.params;
    const name = readToolName(params);
    const input = readToolArguments(params);
    const requestId = extractBoundedRequestId(input);

    return executeOjToolCall(
      async () => {
        switch (name) {
          case "oj_capabilities":
            parseInput(strictEmptyInputSchema, input, name);
            return provider.getCapabilities(options.transport);
          case "oj_health":
            parseInput(strictEmptyInputSchema, input, name);
            return provider.getHealth({ signal: extra.signal });
          case "oj_search_problems":
            return provider.search(parseInput(codeforcesSearchInputSchema, input, name), { signal: extra.signal });
          case "codeforces_get_problem_metadata": {
            const { nativeId } = parseInput(metadataInputSchema, input, name);
            const summary = await provider.getProblemMetadata(nativeId, { signal: extra.signal });
            if (!summary) throw new CodeforcesApiError("resource.not_found", `Codeforces problem ${nativeId} was not found.`);
            return summary;
          }
          default:
            throw new CodeforcesApiError("request.invalid", "tools/call must name one of the four advertised Codeforces tools.");
        }
      },
      {
        errorNormalizer,
        requestId,
        signal: extra.signal,
        createCancelledError: (cause) =>
          new CodeforcesRequestCancelledError("Codeforces tool call was cancelled by the caller.", { cause })
      }
    );
  });
  return server;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  return parseStrictToolInput(schema, input, () => {
    throw new CodeforcesApiError("request.invalid", `${toolName} input did not match its strict bounded schema.`);
  });
}
