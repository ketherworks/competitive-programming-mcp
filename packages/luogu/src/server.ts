import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ojCapabilitiesSchema,
  ojProblemDocumentSchema,
  ojProviderHealthSchema,
  ojSearchResultSchema,
  type OjError
} from "@kaiserunix/oj-mcp-contracts";
import {
  combineAbortSignals,
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
import { LuoguAdapterError, LuoguRequestCancelledError, LuoguUpstreamAdmissionError } from "./client.js";
import { LuoguProvider, luoguFetchProblemInputSchema, luoguSearchInputSchema } from "./provider.js";

export const LUOGU_MCP_TOOL_NAMES = ["oj_capabilities", "oj_health", "oj_search_problems", "oj_fetch_problem"] as const;

const permissiveCallToolRequestSchema = createPermissiveCallToolRequestSchema("__invalid_luogu_tool_call__");

const errorNormalizer: OjErrorNormalizerOptions = {
  platform: "luogu",
  providerId: "luogu-lentille-page-adapter",
  internalMessage: "Luogu provider failed without exposing upstream response data.",
  resolveLayer: (error): OjError["layer"] => {
    if (error instanceof LuoguUpstreamAdmissionError) return "broker";
    if (error.code === "policy.blocked") return "policy";
    if (error.code === "challenge.required") return "auth";
    if (error.code === "request.invalid") return "broker";
    return "upstream";
  },
  resolveRetryPolicy: (error): OjError["retryPolicy"] => {
    if (error.code === "challenge.required") return "after_user_action";
    if (error.code === "rate_limited" || error.code === "network.timeout" || error.code === "upstream.unavailable") {
      return "safe_read";
    }
    return "never";
  },
  resolveUserAction: (error): OjError["userAction"] => {
    if (error.code === "challenge.required") return "solve_challenge";
    if (error.code === "rate_limited" || error.code === "network.timeout" || error.code === "upstream.unavailable") {
      return "retry";
    }
    return error.code === "resource.not_found" ? "none" : "open_logs";
  }
};

const tools: Tool[] = [
  defineOjTool({
    name: "oj_capabilities",
    title: "Luogu Provider Capabilities",
    description: "Report the audited anonymous Luogu read surface and operations excluded by policy.",
    inputSchema: strictEmptyInputSchema,
    outputSchema: ojCapabilitiesSchema,
    openWorldHint: false
  }),
  defineOjTool({
    name: "oj_health",
    title: "Luogu Provider Health",
    description: "Report local protocol health and the most recent bounded anonymous Luogu read observation.",
    inputSchema: strictEmptyInputSchema,
    outputSchema: ojProviderHealthSchema,
    openWorldHint: false
  }),
  defineOjTool({
    name: "oj_search_problems",
    title: "Search Luogu Problems",
    description: "Search anonymous public Luogu problem metadata and return shared OJ summaries with bounded cursor pagination.",
    inputSchema: luoguSearchInputSchema,
    outputSchema: ojSearchResultSchema,
    openWorldHint: true
  }),
  defineOjTool({
    name: "oj_fetch_problem",
    title: "Fetch Luogu Problem",
    description: "Fetch one anonymous public Luogu statement as a bounded shared OJ problem document.",
    inputSchema: luoguFetchProblemInputSchema,
    outputSchema: ojProblemDocumentSchema,
    openWorldHint: true
  })
];

export function createLuoguMcpServer(options: { provider?: LuoguProvider; requestSignal?: AbortSignal } = {}): McpServer {
  const provider = options.provider ?? new LuoguProvider();
  const server = new McpServer({ name: "luogu-mcp-server", version: "0.1.0" });
  server.server.registerCapabilities({ tools: { listChanged: false } });

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.server.setRequestHandler(permissiveCallToolRequestSchema, async (request, extra) => {
    const callAbort = combineAbortSignals(options.requestSignal, extra.signal);
    const params = request.params;
    const name = readToolName(params);
    const input = readToolArguments(params);
    const requestId = extractBoundedRequestId(input);

    try {
      return await executeOjToolCall(
        async () => {
          switch (name) {
            case "oj_capabilities":
              parseInput(strictEmptyInputSchema, input, name);
              return provider.getCapabilities();
            case "oj_health":
              parseInput(strictEmptyInputSchema, input, name);
              return provider.getHealth();
            case "oj_search_problems":
              return provider.search(parseInput(luoguSearchInputSchema, input, name), { signal: callAbort.signal });
            case "oj_fetch_problem":
              return provider.fetchProblem(parseInput(luoguFetchProblemInputSchema, input, name), {
                signal: callAbort.signal
              });
            default:
              throw new LuoguAdapterError("request.invalid", "tools/call must name one of the four advertised Luogu tools.");
          }
        },
        {
          errorNormalizer,
          requestId,
          signal: callAbort.signal,
          createCancelledError: (cause) =>
            new LuoguRequestCancelledError("Luogu tool call was cancelled by the caller.", { cause })
        }
      );
    } finally {
      callAbort.dispose();
    }
  });

  return server;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  return parseStrictToolInput(schema, input, (cause) => {
    throw new LuoguAdapterError("request.invalid", `${toolName} input did not match its strict bounded schema.`, {
      cause
    });
  });
}
