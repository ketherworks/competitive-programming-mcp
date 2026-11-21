import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ojErrorSchema, type OjError } from "@kaiserunix/oj-mcp-contracts";
import { z } from "zod";
import { abortReason } from "./abort.js";
import { isPlainRecord } from "./bounds.js";
import { OjRequestCancelledError, toNormalizedToolError, type OjErrorNormalizerOptions } from "./errors.js";

export const strictEmptyInputSchema = z.object({}).strict();

export function toToolResult(result: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result
  };
}

export function toToolError(error: OjError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
    structuredContent: error as unknown as Record<string, unknown>
  };
}

export function toOjToolOutputSchema(successSchema: z.ZodType): Record<string, unknown> {
  return {
    type: "object",
    anyOf: [withoutDialect(z.toJSONSchema(successSchema)), withoutDialect(z.toJSONSchema(ojErrorSchema))]
  };
}

function withoutDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, ...jsonSchema } = schema;
  return jsonSchema;
}

export type OjToolBehavior = "read" | "localAction" | "realSubmit";

export function readOnlyToolAnnotations(openWorldHint: boolean) {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint
  } as const;
}

export function localActionToolAnnotations(openWorldHint: boolean) {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint
  } as const;
}

export function destructiveToolAnnotations(openWorldHint: boolean) {
  return {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint
  } as const;
}

export interface DefineOjToolOptions {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  openWorldHint: boolean;
  behavior?: OjToolBehavior;
  inputSchemaTarget?: "draft-2020-12" | "draft-7";
}

export function defineOjTool(options: DefineOjToolOptions): Tool {
  const behavior = options.behavior ?? "read";
  const rawInputSchema = options.inputSchemaTarget
    ? { type: "object", ...z.toJSONSchema(options.inputSchema, { target: options.inputSchemaTarget }) }
    : z.toJSONSchema(options.inputSchema);

  return {
    name: options.name,
    title: options.title,
    description: options.description,
    inputSchema: rawInputSchema as Tool["inputSchema"],
    outputSchema: toOjToolOutputSchema(options.outputSchema) as Tool["outputSchema"],
    annotations:
      behavior === "read"
        ? readOnlyToolAnnotations(options.openWorldHint)
        : behavior === "realSubmit"
          ? destructiveToolAnnotations(options.openWorldHint)
          : localActionToolAnnotations(options.openWorldHint)
  };
}

export function createPermissiveCallToolRequestSchema(invalidToolName: string) {
  return z
    .object({
      method: z.literal("tools/call"),
      params: z
        .unknown()
        .transform((value) => normalizeCallParams(value, invalidToolName))
        .optional()
        .default({ name: invalidToolName, arguments: { __invalidCallParams: true } })
    })
    .passthrough();
}

function normalizeCallParams(value: unknown, invalidToolName: string): { name: string; arguments: Record<string, unknown> } {
  if (!isPlainRecord(value)) {
    return { name: invalidToolName, arguments: { __invalidCallParams: true } };
  }
  const name = typeof value.name === "string" ? value.name : invalidToolName;
  const rawArguments = value.arguments;
  const args: Record<string, unknown> =
    rawArguments === undefined ? {} : isPlainRecord(rawArguments) ? { ...rawArguments } : { __invalidArguments: true };
  const unexpectedParams = Object.keys(value).filter((key) => key !== "name" && key !== "arguments" && key !== "_meta");
  if (unexpectedParams.length > 0) {
    args.__invalidCallParams = true;
  }
  return { name, arguments: args };
}

export function readToolName(params: unknown): string | undefined {
  if (!isPlainRecord(params)) return undefined;
  return typeof params.name === "string" ? params.name : undefined;
}

export function readToolArguments(params: unknown): unknown {
  return isPlainRecord(params) ? params.arguments : undefined;
}

export function extractBoundedRequestId(input: unknown, maxLength = 128): string | undefined {
  if (!isPlainRecord(input)) return undefined;
  const requestId = input.requestId;
  return typeof requestId === "string" && requestId.length >= 1 && requestId.length <= maxLength ? requestId : undefined;
}

export function parseStrictToolInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  onInvalid: (error: z.ZodError) => never
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    onInvalid(parsed.error);
  }
  return parsed.data;
}

export interface ExecuteOjToolCallOptions {
  errorNormalizer: OjErrorNormalizerOptions;
  requestId?: string;
  signal?: AbortSignal;
  rethrowOnAbort?: boolean;
  isCancelledError?: (caught: unknown) => boolean;
  createCancelledError?: (caught: unknown) => unknown;
}

export async function executeOjToolCall<T extends object>(
  operation: () => Promise<T>,
  options: ExecuteOjToolCallOptions
): Promise<CallToolResult> {
  try {
    return toToolResult((await operation()) as Record<string, unknown>);
  } catch (caught) {
    if (caught instanceof OjRequestCancelledError || options.isCancelledError?.(caught)) {
      throw caught;
    }
    if (options.rethrowOnAbort !== false && options.signal?.aborted) {
      throw options.createCancelledError
        ? options.createCancelledError(caught)
        : abortReason(options.signal, "Tool call was cancelled.");
    }
    return toNormalizedToolError(caught, options.errorNormalizer, options.requestId);
  }
}
