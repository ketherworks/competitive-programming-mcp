import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ojCapabilitiesSchema,
  ojCodeArtifactSchema,
  ojImportPreviewSchema,
  ojImportWindowRequestSchema,
  ojImportWindowSchema,
  ojPrepareSubmissionRequestSchema,
  ojProblemDocumentSchema,
  ojProviderHealthSchema,
  ojRunRequestSchema,
  ojRunResultSchema,
  ojSearchResultSchema,
  ojSubmitCommitRequestSchema,
  ojSubmitPreviewSchema,
  ojSubmitResultSchema,
  type OjError,
  type OjSubmitPreview
} from "@kaiserunix/oj-mcp-contracts";
import {
  defineOjTool,
  executeOjToolCall,
  parseStrictToolInput,
  strictEmptyInputSchema,
  type OjErrorNormalizerOptions,
  type OjToolBehavior
} from "@kaiserunix/oj-mcp-server-common";
import { z } from "zod";
import { nowCoderAuthStatusSchema } from "./auth.js";
import { safeConfirmationValue } from "./artifact.js";
import { NowCoderAdapterError } from "./errors.js";
import { nowCoderProfileSchema } from "./profile.js";
import { NowCoderProvider, nowCoderProfileInputSchema, nowCoderSearchInputSchema, nowCoderSubmissionsInputSchema } from "./provider.js";
import { nowCoderSubmissionListSchema } from "./submissions.js";
import type { NowCoderProblemLocator } from "./url.js";
import type { NowCoderPlatformRunPreview } from "./judge.js";

export const NOWCODER_MCP_TOOL_NAMES = [
  "oj_capabilities",
  "oj_health",
  "oj_fetch_problem",
  "oj_search_problems",
  "oj_open_import_window",
  "oj_complete_import",
  "oj_fetch_profile",
  "oj_list_submissions",
  "oj_prepare_submission",
  "oj_commit_submission",
  "oj_poll_submission",
  "oj_platform_run",
  "oj_poll_run",
  "nowcoder_auth_status"
] as const;

const fetchProblemInputSchema = z.object({
  url: z.string().url().max(2_048).describe(
    "Official public URL shaped as https://ac.nowcoder.com/acm/problem/<id> or https://ac.nowcoder.com/acm/contest/<contest>/<index>."
  ).optional(),
  nativeId: z.string().min(3).max(29).describe(
    "Canonical NowCoder native ID: NC<positive-id> or <positive-contest-id>/<uppercase-or-numeric-index>."
  ).optional()
}).strict().refine((value) => (value.url === undefined) !== (value.nativeId === undefined), {
  message: "Provide exactly one URL or nativeId."
});
const nowCoderCodeArtifactSchema = ojCodeArtifactSchema.safeExtend({
  sourceUri: z.string().url().min(8).max(4_096),
  sourceWasDirty: z.literal(false)
}).strict();
const nowCoderPrepareSubmissionInputSchema = ojPrepareSubmissionRequestSchema.extend({
  code: nowCoderCodeArtifactSchema
}).strict();
const nowCoderRunInputSchema = ojRunRequestSchema.extend({
  code: nowCoderCodeArtifactSchema
}).strict();
const completeImportInputSchema = z.object({
  windowId: z.string().min(1).max(100)
}).strict();
const commitSubmissionInputSchema = ojSubmitCommitRequestSchema.omit({ confirmationProof: true }).strict();
const pollSubmissionInputSchema = z.object({
  requestId: z.string().min(1).max(200),
  submissionOperationId: z.string().min(1).max(200)
}).strict();
const pollRunInputSchema = z.object({
  requestId: z.string().min(1).max(200)
}).strict();

const errorNormalizer: OjErrorNormalizerOptions = {
  platform: "nowcoder",
  providerId: "nowcoder-public-page",
  internalMessage: "NowCoder provider failed.",
  fallbackMessage: "NowCoder provider failed to produce a valid error response.",
  resolveLayer: (error): OjError["layer"] => {
    if (error.code === "request.invalid" || error.code === "internal") return "broker";
    if (error.code === "policy.blocked" || error.code.startsWith("confirmation.")) return "policy";
    if (error.code.startsWith("auth.") || error.code === "challenge.required") return "auth";
    if (error.code === "network.timeout") return "transport";
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
    if (error.code === "upstream.schema_changed" || error.code === "internal") return "open_logs";
    return "none";
  }
};

const tools: Tool[] = [
  tool(
    "oj_capabilities",
    "NowCoder Provider Capabilities",
    "Report the active NowCoder tools, authentication mode, operation risk, and judge language IDs.",
    strictEmptyInputSchema,
    ojCapabilitiesSchema,
    false
  ),
  tool(
    "oj_health",
    "NowCoder Provider Health",
    "Report passive adapter health from the last fetch; this tool does not probe NowCoder.",
    strictEmptyInputSchema,
    ojProviderHealthSchema,
    false
  ),
  tool(
    "oj_platform_run",
    "Run on NowCoder",
    "Resolve the official problem and saved local file, show an MCP-native confirmation, upload that immutable artifact for one sample, and return the platform result.",
    nowCoderRunInputSchema,
    ojRunResultSchema,
    true,
    "localAction"
  ),
  tool(
    "oj_poll_run",
    "Poll NowCoder Platform Run",
    "Continue polling a previously dispatched NowCoder platform run by its stable requestId without uploading code again.",
    pollRunInputSchema,
    ojRunResultSchema,
    true
  ),
  tool(
    "oj_prepare_submission",
    "Prepare NowCoder Submission",
    "Validate the official problem, saved local file, submitter, contest, language, and immutable code artifact, then return a two-minute preview.",
    nowCoderPrepareSubmissionInputSchema,
    ojSubmitPreviewSchema,
    true,
    "localAction"
  ),
  tool(
    "oj_commit_submission",
    "Submit to NowCoder",
    "Show an MCP-native confirmation prompt and submit the exact prepared code to NowCoder once after the user accepts.",
    commitSubmissionInputSchema,
    ojSubmitResultSchema,
    true,
    "realSubmit"
  ),
  tool(
    "oj_poll_submission",
    "Poll NowCoder Submission",
    "Poll a submission operation created by this local process without resubmitting code.",
    pollSubmissionInputSchema,
    ojSubmitResultSchema,
    true
  ),
  tool(
    "oj_list_submissions",
    "List NowCoder Submissions",
    "List compact server-rendered submission metadata for a public or signed-in NowCoder competition profile.",
    nowCoderSubmissionsInputSchema,
    nowCoderSubmissionListSchema,
    true
  ),
  tool(
    "oj_fetch_profile",
    "Fetch NowCoder Profile",
    "Return a compact NowCoder competition profile by account ID, or resolve the signed-in account from the local session.",
    nowCoderProfileInputSchema,
    nowCoderProfileSchema,
    true
  ),
  tool(
    "oj_open_import_window",
    "Open Browser Import Window",
    "Open a short-lived loopback receiver for one NowCoder problem sent by Competitive Companion.",
    ojImportWindowRequestSchema,
    ojImportWindowSchema,
    false,
    "localAction"
  ),
  tool(
    "oj_complete_import",
    "Complete Browser Import",
    "Wait for the selected Competitive Companion window and return its typed NowCoder problem preview.",
    completeImportInputSchema,
    ojImportPreviewSchema,
    false,
    "localAction"
  ),
  tool(
    "oj_search_problems",
    "Search NowCoder Problems",
    "Search the official NowCoder ACM problem catalog by keyword with bounded cursor pagination.",
    nowCoderSearchInputSchema,
    ojSearchResultSchema,
    true
  ),
  tool(
    "oj_fetch_problem",
    "Fetch NowCoder Problem",
    "Fetch and normalize one official NowCoder ACM problem page with statement, limits, samples, tags, provenance, and hashes.",
    fetchProblemInputSchema,
    ojProblemDocumentSchema,
    true
  ),
  tool(
    "nowcoder_auth_status",
    "NowCoder Login Status",
    "Validate the configured local session without returning account identity or cookie data.",
    strictEmptyInputSchema,
    nowCoderAuthStatusSchema,
    true
  )
];

export function createNowCoderMcpServer(options: { provider?: NowCoderProvider } = {}): McpServer {
  const provider = options.provider ?? new NowCoderProvider();
  const server = new McpServer({ name: "nowcoder-mcp-server", version: "0.2.0" });
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const input = request.params.arguments ?? {};
    return executeOjToolCall(
      async () => {
        switch (request.params.name) {
          case "oj_capabilities":
            parseInput(strictEmptyInputSchema, input, request.params.name);
            return provider.getCapabilities();
          case "oj_health":
            parseInput(strictEmptyInputSchema, input, request.params.name);
            return provider.getHealth();
          case "nowcoder_auth_status":
            parseInput(strictEmptyInputSchema, input, request.params.name);
            return provider.getAuthStatus({ signal: extra.signal });
          case "oj_fetch_problem":
            return provider.fetchProblem(parseInput(fetchProblemInputSchema, input, request.params.name) as NowCoderProblemLocator, {
              signal: extra.signal
            });
          case "oj_search_problems":
            return provider.search(parseInput(nowCoderSearchInputSchema, input, request.params.name), {
              signal: extra.signal
            });
          case "oj_open_import_window":
            return provider.openImportWindow(parseInput(ojImportWindowRequestSchema, input, request.params.name));
          case "oj_complete_import":
            return provider.completeImport(parseInput(completeImportInputSchema, input, request.params.name).windowId);
          case "oj_fetch_profile":
            return provider.fetchProfile(parseInput(nowCoderProfileInputSchema, input, request.params.name), {
              signal: extra.signal
            });
          case "oj_list_submissions":
            return provider.listSubmissions(parseInput(nowCoderSubmissionsInputSchema, input, request.params.name), {
              signal: extra.signal
            });
          case "oj_prepare_submission":
            return provider.prepareSubmission(parseInput(nowCoderPrepareSubmissionInputSchema, input, request.params.name), extra.signal);
          case "oj_commit_submission": {
            const parsed = parseInput(commitSubmissionInputSchema, input, request.params.name);
            const confirmation = provider.getSubmissionConfirmation(parsed.intentId);
            const authorized = await confirmRealSubmission(server, confirmation, extra.signal);
            return provider.commitSubmission({
              ...parsed,
              confirmationProof: "mcp-form-elicitation"
            }, authorized, extra.signal);
          }
          case "oj_poll_submission":
            return provider.pollSubmission(parseInput(pollSubmissionInputSchema, input, request.params.name), extra.signal);
          case "oj_platform_run": {
            const parsed = parseInput(nowCoderRunInputSchema, input, request.params.name);
            const preview = await provider.preparePlatformRun(parsed, extra.signal);
            let authorized: boolean;
            try {
              authorized = await confirmPlatformRun(server, preview, extra.signal);
            } catch (error) {
              provider.cancelPlatformRun(preview.intentId);
              throw error;
            }
            return provider.commitPlatformRun(preview.intentId, authorized, extra.signal);
          }
          case "oj_poll_run":
            return provider.pollPlatformRun(parseInput(pollRunInputSchema, input, request.params.name), extra.signal);
          default:
            throw new NowCoderAdapterError("request.invalid", "Unknown NowCoder tool name.");
        }
      },
      {
        errorNormalizer,
        signal: extra.signal,
        createCancelledError: () => extra.signal?.reason ?? new DOMException("NowCoder tool call was cancelled.", "AbortError")
      }
    );
  });

  return server;
}

function tool(
  name: (typeof NOWCODER_MCP_TOOL_NAMES)[number],
  title: string,
  description: string,
  inputSchema: z.ZodType,
  successSchema: z.ZodType,
  openWorldHint: boolean,
  behavior: OjToolBehavior = "read"
): Tool {
  return defineOjTool({
    name,
    title,
    description,
    inputSchema,
    outputSchema: successSchema,
    openWorldHint,
    behavior
  });
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  return parseStrictToolInput(schema, input, () => {
    throw new NowCoderAdapterError("request.invalid", `${toolName} input did not match its strict bounded schema.`);
  });
}

async function confirmRealSubmission(
  server: McpServer,
  confirmation: { preview: OjSubmitPreview; filePath: string },
  signal?: AbortSignal
): Promise<boolean> {
  const { preview } = confirmation;
  const target = preview.submissionTarget;
  try {
    const result = await server.server.elicitInput({
      mode: "form",
      message: [
        `确认提交到牛客：${safeConfirmationValue(preview.problem.nativeId, "Problem ID")}`,
        `登录账号：${safeConfirmationValue(preview.account.displayName, "Account name")} (${preview.account.accountId})`,
        `提交主体：${target?.kind === "team" ? "团队" : "个人"} ${target?.id ?? preview.account.accountId}`,
        `比赛：${target?.contestId ?? "题库"}`,
        `语言：${safeConfirmationValue(preview.languageKey, "Language name")} / ${preview.platformLanguageId}`,
        `已保存文件：${safeConfirmationValue(confirmation.filePath, "Source path")}`,
        `代码：${preview.codeBytes} bytes / SHA-256 ${preview.codeSha256}`
      ].join("\n"),
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "确认真实提交",
            description: "勾选后将立即向牛客提交一次。",
            default: false
          }
        },
        required: ["confirm"]
      }
    }, { signal });
    return result.action === "accept" && result.content?.confirm === true;
  } catch (error) {
    if (error instanceof NowCoderAdapterError) throw error;
    throw new NowCoderAdapterError("confirmation.required", "The MCP client must show and accept the real-submission confirmation form.");
  }
}

async function confirmPlatformRun(server: McpServer, preview: NowCoderPlatformRunPreview, signal?: AbortSignal): Promise<boolean> {
  try {
    const target = preview.submissionTarget;
    const result = await server.server.elicitInput({
      mode: "form",
      message: [
        `确认上传源码到牛客自测：${safeConfirmationValue(preview.problem.nativeId, "Problem ID")}`,
        `提交主体：${target.kind === "team" ? "团队" : "个人"} ${target.id}`,
        `比赛：${target.contestId ?? "题库"}`,
        `语言：${safeConfirmationValue(preview.languageKey, "Language name")} / ${preview.platformLanguageId}`,
        `已保存文件：${safeConfirmationValue(preview.filePath, "Source path")}`,
        `代码：${preview.codeBytes} bytes / SHA-256 ${preview.codeSha256}`,
        `样例：${preview.sampleOrdinal}`
      ].join("\n"),
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "确认平台自测",
            description: "勾选后将把这份源码上传到牛客并运行一次。",
            default: false
          }
        },
        required: ["confirm"]
      }
    }, { signal });
    return result.action === "accept" && result.content?.confirm === true;
  } catch (error) {
    if (error instanceof NowCoderAdapterError) throw error;
    throw new NowCoderAdapterError("confirmation.required", "The MCP client must show and accept the platform-run confirmation form.");
  }
}
