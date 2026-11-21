import type {
  OjCapabilities,
  OjCapability,
  OjCapabilityName,
  OjError,
  OjErrorCode,
  OjOperationRisk,
  OjPlatformId,
  OjSourceRef
} from "./contracts.js";
import { ojCapabilityNameSchema } from "./schemaPrimitives.js";
import { ojCapabilitiesSchema, ojErrorSchema } from "./schemas.js";

export const OJ_PROTOCOL_VERSION = "2025-11-25" as const;
export const OJ_MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
export const OJ_CAPABILITY_NAMES: readonly OjCapabilityName[] = Object.freeze([...ojCapabilityNameSchema.options]);

export function defaultCapabilityRisk(name: OjCapabilityName): OjOperationRisk {
  if (name === "commitSubmission") return "R4_real_submit";
  if (name === "prepareSubmission") return "R3_prepare_write";
  if (name === "localRun" || name === "platformRun") return "R2_local_execute";
  if (name === "fetchProfile" || name === "listSubmissions" || name === "pollSubmission") return "R1_private_read";
  return "R0_public_read";
}

export interface BuildOjCapabilitiesOptions {
  providerId: string;
  providerVersion: string;
  platform: OjPlatformId;
  protocolVersion?: string;
  languages?: OjCapabilities["languages"];
  source: OjSourceRef;
  buildOperation: (name: OjCapabilityName) => OjCapability;
}

export function buildOjCapabilities(options: BuildOjCapabilitiesOptions): OjCapabilities {
  const operations = Object.fromEntries(
    OJ_CAPABILITY_NAMES.map((name) => [name, options.buildOperation(name)])
  ) as Record<OjCapabilityName, OjCapability>;

  return ojCapabilitiesSchema.parse({
    schemaVersion: "oj.capabilities/v1",
    providerId: options.providerId,
    providerVersion: options.providerVersion,
    platform: options.platform,
    protocolVersion: options.protocolVersion ?? OJ_PROTOCOL_VERSION,
    operations,
    languages: options.languages ?? [],
    source: options.source
  });
}

export function defaultErrorLayer(code: OjErrorCode): OjError["layer"] {
  if (code === "request.invalid" || code === "internal" || code === "capability.unsupported" || code === "language.unsupported") {
    return "broker";
  }
  if (code === "policy.blocked" || code.startsWith("confirmation.")) return "policy";
  if (code.startsWith("auth.") || code === "challenge.required") return "auth";
  if (code === "network.timeout") return "transport";
  if (code.startsWith("runner.")) return "runner";
  return "upstream";
}

export function defaultRetryPolicy(code: OjErrorCode): OjError["retryPolicy"] {
  if (code === "challenge.required" || code.startsWith("auth.") || code.startsWith("confirmation.")) {
    return "after_user_action";
  }
  if (code === "rate_limited" || code === "network.timeout" || code === "upstream.unavailable") {
    return "safe_read";
  }
  if (code === "submission.outcome_unknown") {
    return "poll_only";
  }
  return "never";
}

export function defaultUserAction(code: OjErrorCode): OjError["userAction"] {
  if (code === "challenge.required") return "solve_challenge";
  if (code.startsWith("auth.")) return "sign_in";
  if (code === "language.unsupported") return "change_language";
  if (code === "rate_limited" || code === "network.timeout" || code === "upstream.unavailable") return "retry";
  if (code === "upstream.schema_changed" || code === "internal") return "open_logs";
  return "none";
}

export function sanitizeHttpStatus(status: unknown): number | undefined {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

export function sanitizeRetryAfterMs(retryAfterMs: unknown, maxMs = OJ_MAX_RETRY_AFTER_MS): number | undefined {
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? Math.min(retryAfterMs, maxMs)
    : undefined;
}

export interface CreateOjErrorInput {
  code: OjErrorCode;
  message: string;
  platform?: OjPlatformId;
  providerId?: string;
  layer?: OjError["layer"];
  retryPolicy?: OjError["retryPolicy"];
  userAction?: OjError["userAction"];
  httpStatus?: number;
  upstreamCode?: string;
  requestId?: string;
  jobId?: string;
  retryAfterMs?: number;
  fallbackMessage?: string;
}

export function createOjError(input: CreateOjErrorInput): OjError {
  const httpStatus = sanitizeHttpStatus(input.httpStatus);
  const retryAfterMs = sanitizeRetryAfterMs(input.retryAfterMs);

  const candidate = {
    schemaVersion: "oj.error/v1" as const,
    code: input.code,
    layer: input.layer ?? defaultErrorLayer(input.code),
    message: input.message,
    retryPolicy: input.retryPolicy ?? defaultRetryPolicy(input.code),
    userAction: input.userAction ?? defaultUserAction(input.code),
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(input.upstreamCode !== undefined && input.upstreamCode.length > 0 ? { upstreamCode: input.upstreamCode } : {}),
    ...(input.requestId !== undefined && input.requestId.length > 0 ? { requestId: input.requestId } : {}),
    ...(input.jobId !== undefined && input.jobId.length > 0 ? { jobId: input.jobId } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  };

  const parsed = ojErrorSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  const safeProviderId =
    typeof input.providerId === "string" && input.providerId.length > 0 ? input.providerId : undefined;
  const safeRequestId =
    typeof input.requestId === "string" && input.requestId.length > 0 ? input.requestId : undefined;
  return {
    schemaVersion: "oj.error/v1",
    code: "internal",
    layer: "broker",
    message: input.fallbackMessage || "OJ provider failed to produce a valid error response.",
    retryPolicy: "never",
    userAction: "open_logs",
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(safeProviderId !== undefined ? { providerId: safeProviderId } : {}),
    ...(safeRequestId !== undefined ? { requestId: safeRequestId } : {})
  };
}
