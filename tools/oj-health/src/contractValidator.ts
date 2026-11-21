import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ojCapabilitiesSchema,
  ojCapabilityNameSchema,
  ojErrorSchema,
  ojProblemDocumentSchema,
  ojProblemSummarySchema,
  ojProviderHealthSchema,
  ojSearchResultSchema,
  type OjCapabilities,
  type OjCapability,
  type OjCapabilityName,
  type OjError,
  type OjErrorCode,
  type OjProblemDocument,
  type OjProblemSummary,
  type OjProviderHealth,
  type OjSearchResult,
  type OjTextBlock
} from "@kaiserunix/oj-mcp-contracts";
import type { ProviderPackageDescriptor } from "./types.js";

const FORBIDDEN_ANONYMOUS_TOOL_PATTERN = /(login|cookie|submit|platform_run|local_run|profile)/i;
const EXPECTED_PROTOCOL_VERSION = "2025-11-25";

export interface McpToolCallEnvelope {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

export function validateToolCatalog(tools: readonly Tool[], descriptor: ProviderPackageDescriptor): void {
  const actualNames = tools.map((tool) => tool.name).sort();
  const expectedNames = [...descriptor.expectedTools].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `[${descriptor.platform}] Tool list mismatch. Expected ${JSON.stringify(expectedNames)}, got ${JSON.stringify(actualNames)}.`
    );
  }

  const actionSet = new Set(descriptor.actionTools);
  const destructiveSet = new Set(descriptor.destructiveTools);

  for (const tool of tools) {
    if (descriptor.anonymousReadOnly && FORBIDDEN_ANONYMOUS_TOOL_PATTERN.test(tool.name)) {
      throw new Error(`[${descriptor.platform}] Anonymous read-only server exposed disallowed tool '${tool.name}'.`);
    }

    const inputSchema = tool.inputSchema as { type?: unknown } | undefined;
    if (!inputSchema || typeof inputSchema !== "object") {
      throw new Error(`[${descriptor.platform}] Tool '${tool.name}' is missing inputSchema.`);
    }

    const outputSchema = tool.outputSchema as { type?: unknown; anyOf?: unknown } | undefined;
    if (!outputSchema || outputSchema.type !== "object" || !Array.isArray(outputSchema.anyOf) || outputSchema.anyOf.length < 2) {
      throw new Error(`[${descriptor.platform}] Tool '${tool.name}' must declare an object outputSchema with anyOf variants.`);
    }

    const serializedOutput = JSON.stringify(outputSchema);
    if (!serializedOutput.includes("oj.error/v1")) {
      throw new Error(`[${descriptor.platform}] Tool '${tool.name}' outputSchema does not include oj.error/v1 variant.`);
    }

    const annotations = tool.annotations;
    if (!annotations) {
      throw new Error(`[${descriptor.platform}] Tool '${tool.name}' is missing MCP safety annotations.`);
    }
    const expectAction = actionSet.has(tool.name);
    const expectDestructive = destructiveSet.has(tool.name);
    if (annotations.readOnlyHint !== !expectAction) {
      throw new Error(
        `[${descriptor.platform}] Tool '${tool.name}' readOnlyHint=${String(annotations.readOnlyHint)} contradicts policy (expected ${String(!expectAction)}).`
      );
    }
    if (annotations.destructiveHint !== expectDestructive) {
      throw new Error(
        `[${descriptor.platform}] Tool '${tool.name}' destructiveHint=${String(annotations.destructiveHint)} contradicts policy (expected ${String(expectDestructive)}).`
      );
    }
    if (!expectAction && annotations.idempotentHint !== true) {
      throw new Error(`[${descriptor.platform}] Read-only tool '${tool.name}' must declare idempotentHint=true.`);
    }
  }
}

export function validateCapabilitiesPayload(
  payload: unknown,
  descriptor: ProviderPackageDescriptor,
  expectedTransport: OjCapability["transport"],
  listedToolNames: readonly string[]
): OjCapabilities {
  const parsed = ojCapabilitiesSchema.parse(payload);
  if (parsed.platform !== descriptor.platform) {
    throw new Error(`[${descriptor.platform}] Capabilities reported platform '${parsed.platform}'.`);
  }
  if (parsed.providerId !== descriptor.providerId) {
    throw new Error(`[${descriptor.platform}] Capabilities reported providerId '${parsed.providerId}', expected '${descriptor.providerId}'.`);
  }
  if (parsed.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
    throw new Error(`[${descriptor.platform}] Capabilities reported protocolVersion '${parsed.protocolVersion}'.`);
  }

  const toolSet = new Set(listedToolNames);
  const requiredNames = ojCapabilityNameSchema.options;
  for (const name of requiredNames) {
    const actual = parsed.operations[name];
    const expectation = descriptor.expectedCapabilities[name];
    if (!actual) {
      throw new Error(`[${descriptor.platform}] Capabilities missing operation '${name}'.`);
    }
    if (actual.transport !== expectedTransport) {
      throw new Error(
        `[${descriptor.platform}] Capability '${name}' reported transport '${actual.transport}', expected '${expectedTransport}'.`
      );
    }
    if (!expectation.allowedStatuses.includes(actual.status)) {
      throw new Error(
        `[${descriptor.platform}] Capability '${name}' reported disallowed status '${actual.status}' (expected one of ${expectation.allowedStatuses.join(", ")}).`
      );
    }
    if (actual.status === "available" || actual.status === "degraded") {
      if (!actual.toolName) {
        throw new Error(`[${descriptor.platform}] Active capability '${name}' must specify toolName.`);
      }
      if (!toolSet.has(actual.toolName)) {
        throw new Error(`[${descriptor.platform}] Capability '${name}' points to missing MCP tool '${actual.toolName}'.`);
      }
      if (expectation.expectedToolName && actual.toolName !== expectation.expectedToolName) {
        throw new Error(
          `[${descriptor.platform}] Capability '${name}' reported toolName '${actual.toolName}', expected '${expectation.expectedToolName}'.`
        );
      }
    } else if (actual.toolName !== undefined) {
      throw new Error(
        `[${descriptor.platform}] Inactive capability '${name}' (status='${actual.status}') must not advertise toolName '${actual.toolName}'.`
      );
    }

    if (descriptor.anonymousReadOnly && actual.risk !== "R0_public_read" && actual.status === "available") {
      throw new Error(`[${descriptor.platform}] Anonymous read-only provider exposed non-R0 capability '${name}' as available.`);
    }
  }

  return parsed;
}

export function validateHealthPayload(payload: unknown, descriptor: ProviderPackageDescriptor): OjProviderHealth {
  const parsed = ojProviderHealthSchema.parse(payload);
  if (parsed.platform !== descriptor.platform) {
    throw new Error(`[${descriptor.platform}] Health reported platform '${parsed.platform}'.`);
  }
  if (parsed.providerId !== descriptor.providerId) {
    throw new Error(`[${descriptor.platform}] Health reported providerId '${parsed.providerId}', expected '${descriptor.providerId}'.`);
  }
  return parsed;
}

export function validateErrorResult(
  envelope: McpToolCallEnvelope,
  descriptor: ProviderPackageDescriptor,
  options: { expectedCode?: OjErrorCode; forbiddenSubstrings?: readonly string[] } = {}
): OjError {
  if (envelope.isError !== true) {
    throw new Error(`[${descriptor.platform}] Expected tool error response (isError=true), got isError=${String(envelope.isError)}.`);
  }
  const parsed = ojErrorSchema.parse(envelope.structuredContent);
  if (parsed.platform !== undefined && parsed.platform !== descriptor.platform) {
    throw new Error(`[${descriptor.platform}] Error reported platform '${parsed.platform}'.`);
  }
  if (parsed.providerId !== undefined && parsed.providerId !== descriptor.providerId) {
    throw new Error(`[${descriptor.platform}] Error reported providerId '${parsed.providerId}'.`);
  }
  if (options.expectedCode && parsed.code !== options.expectedCode) {
    throw new Error(`[${descriptor.platform}] Expected error code '${options.expectedCode}', got '${parsed.code}'.`);
  }

  const serialized = JSON.stringify(envelope);
  for (const forbidden of options.forbiddenSubstrings ?? []) {
    if (serialized.includes(forbidden)) {
      throw new Error(`[${descriptor.platform}] Error envelope leaked forbidden substring '${forbidden}'.`);
    }
  }

  return parsed;
}

export function validateSearchResultPayload(
  payload: unknown,
  descriptor: ProviderPackageDescriptor,
  expectedRequestId: string
): OjSearchResult {
  const parsed = ojSearchResultSchema.parse(payload);
  if (parsed.requestId !== expectedRequestId) {
    throw new Error(`[${descriptor.platform}] Search result echoed requestId '${parsed.requestId}', expected '${expectedRequestId}'.`);
  }
  for (const item of parsed.items) {
    if (item.ref.platform !== descriptor.platform) {
      throw new Error(`[${descriptor.platform}] Search item reported platform '${item.ref.platform}'.`);
    }
    if (!item.ref.canonicalId.startsWith(`${descriptor.platform}:`)) {
      throw new Error(`[${descriptor.platform}] Search item canonicalId '${item.ref.canonicalId}' missing platform prefix.`);
    }
  }
  return parsed;
}

export function validateProblemDocumentPayload(payload: unknown, descriptor: ProviderPackageDescriptor): OjProblemDocument {
  const parsed = ojProblemDocumentSchema.parse(payload);
  if (parsed.ref.platform !== descriptor.platform) {
    throw new Error(`[${descriptor.platform}] Problem document reported platform '${parsed.ref.platform}'.`);
  }
  if (!parsed.ref.canonicalId.startsWith(`${descriptor.platform}:`)) {
    throw new Error(`[${descriptor.platform}] Problem document canonicalId '${parsed.ref.canonicalId}' missing platform prefix.`);
  }

  assertTextBlockDigest(parsed.content.statement, "content.statement", descriptor.platform);
  if (parsed.content.input) assertTextBlockDigest(parsed.content.input, "content.input", descriptor.platform);
  if (parsed.content.output) assertTextBlockDigest(parsed.content.output, "content.output", descriptor.platform);
  if (parsed.content.notes) assertTextBlockDigest(parsed.content.notes, "content.notes", descriptor.platform);

  parsed.samples.forEach((sample, index) => {
    if (sample.ordinal !== index + 1) {
      throw new Error(`[${descriptor.platform}] Sample ordinal ${sample.ordinal} is out of sequence at index ${index}.`);
    }
  });

  return parsed;
}

export function validateProblemSummaryPayload(payload: unknown, descriptor: ProviderPackageDescriptor): OjProblemSummary {
  const parsed = ojProblemSummarySchema.parse(payload);
  if (parsed.ref.platform !== descriptor.platform) {
    throw new Error(`[${descriptor.platform}] Problem summary reported platform '${parsed.ref.platform}'.`);
  }
  if (!parsed.ref.canonicalId.startsWith(`${descriptor.platform}:`)) {
    throw new Error(`[${descriptor.platform}] Problem summary canonicalId '${parsed.ref.canonicalId}' missing platform prefix.`);
  }
  return parsed;
}

function assertTextBlockDigest(block: OjTextBlock, fieldName: string, platform: string): void {
  const actualSha = createHash("sha256").update(block.text, "utf8").digest("hex");
  if (actualSha !== block.sha256.toLowerCase()) {
    throw new Error(`[${platform}] ${fieldName}.sha256 (${block.sha256}) does not match UTF-8 text digest (${actualSha}).`);
  }
}
