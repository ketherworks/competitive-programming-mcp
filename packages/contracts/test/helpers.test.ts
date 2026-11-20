import { describe, expect, test } from "vitest";
import {
  buildOjCapabilities,
  createOjError,
  defaultCapabilityRisk,
  defaultErrorLayer,
  defaultRetryPolicy,
  defaultUserAction,
  OJ_CAPABILITY_NAMES,
  OJ_MAX_RETRY_AFTER_MS,
  OJ_PROTOCOL_VERSION,
  ojCapabilitiesSchema,
  ojCodeArtifactSchema,
  ojErrorSchema,
  ojProviderManifestSchema,
  sanitizeHttpStatus,
  sanitizeRetryAfterMs
} from "../src/index.js";

describe("OJ contract helpers", () => {
  test("defines canonical capability names, protocol version, and risk defaults", () => {
    expect(OJ_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(OJ_CAPABILITY_NAMES).toHaveLength(10);
    expect(defaultCapabilityRisk("searchProblems")).toBe("R0_public_read");
    expect(defaultCapabilityRisk("fetchProblem")).toBe("R0_public_read");
    expect(defaultCapabilityRisk("importProblem")).toBe("R0_public_read");
    expect(defaultCapabilityRisk("fetchProfile")).toBe("R1_private_read");
    expect(defaultCapabilityRisk("listSubmissions")).toBe("R1_private_read");
    expect(defaultCapabilityRisk("pollSubmission")).toBe("R1_private_read");
    expect(defaultCapabilityRisk("localRun")).toBe("R2_local_execute");
    expect(defaultCapabilityRisk("platformRun")).toBe("R2_local_execute");
    expect(defaultCapabilityRisk("prepareSubmission")).toBe("R3_prepare_write");
    expect(defaultCapabilityRisk("commitSubmission")).toBe("R4_real_submit");
  });

  test("buildOjCapabilities populates all canonical operations and validates against schema", () => {
    const checkedAt = "2026-07-11T00:00:00.000Z";
    const capabilities = buildOjCapabilities({
      providerId: "test-adapter",
      providerVersion: "0.1.0",
      platform: "atcoder",
      source: {
        kind: "page_adapter",
        adapterId: "test-adapter",
        adapterVersion: "0.1.0",
        fetchedAt: checkedAt,
        sourceUrl: "https://atcoder.jp/",
        confidence: "derived"
      },
      buildOperation: (name) => ({
        name,
        status: name === "fetchProblem" ? "available" : "unsupported",
        ...(name === "fetchProblem" ? { toolName: "oj_fetch_problem" } : {}),
        transport: "local_stdio",
        auth: "none",
        risk: defaultCapabilityRisk(name),
        compliance: "unofficial",
        checkedAt
      })
    });

    expect(ojCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(Object.keys(capabilities.operations).sort()).toEqual([...OJ_CAPABILITY_NAMES].sort());
    expect(capabilities.protocolVersion).toBe(OJ_PROTOCOL_VERSION);
  });

  test("sanitizes HTTP status codes and retryAfterMs bounds", () => {
    expect(sanitizeHttpStatus(200)).toBe(200);
    expect(sanitizeHttpStatus(599)).toBe(599);
    expect(sanitizeHttpStatus(99)).toBeUndefined();
    expect(sanitizeHttpStatus(600)).toBeUndefined();
    expect(sanitizeHttpStatus(200.5)).toBeUndefined();
    expect(sanitizeHttpStatus(Number.NaN)).toBeUndefined();

    expect(sanitizeRetryAfterMs(0)).toBe(0);
    expect(sanitizeRetryAfterMs(3_000)).toBe(3_000);
    expect(sanitizeRetryAfterMs(OJ_MAX_RETRY_AFTER_MS + 5_000)).toBe(OJ_MAX_RETRY_AFTER_MS);
    expect(sanitizeRetryAfterMs(-1)).toBeUndefined();
    expect(sanitizeRetryAfterMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("maps canonical default error layer, retry policy, and user action", () => {
    expect(defaultErrorLayer("request.invalid")).toBe("broker");
    expect(defaultErrorLayer("policy.blocked")).toBe("policy");
    expect(defaultErrorLayer("confirmation.mismatch")).toBe("policy");
    expect(defaultErrorLayer("auth.required")).toBe("auth");
    expect(defaultErrorLayer("challenge.required")).toBe("auth");
    expect(defaultErrorLayer("network.timeout")).toBe("transport");
    expect(defaultErrorLayer("runner.unavailable")).toBe("runner");
    expect(defaultErrorLayer("rate_limited")).toBe("upstream");

    expect(defaultRetryPolicy("rate_limited")).toBe("safe_read");
    expect(defaultRetryPolicy("challenge.required")).toBe("after_user_action");
    expect(defaultRetryPolicy("submission.outcome_unknown")).toBe("poll_only");
    expect(defaultRetryPolicy("request.invalid")).toBe("never");

    expect(defaultUserAction("challenge.required")).toBe("solve_challenge");
    expect(defaultUserAction("auth.invalid")).toBe("sign_in");
    expect(defaultUserAction("language.unsupported")).toBe("change_language");
    expect(defaultUserAction("network.timeout")).toBe("retry");
    expect(defaultUserAction("upstream.schema_changed")).toBe("open_logs");
    expect(defaultUserAction("resource.not_found")).toBe("none");
  });

  test("createOjError sanitizes invalid metadata and falls back to a valid internal error on corrupted fields", () => {
    const sanitized = createOjError({
      code: "rate_limited",
      message: "Slow down",
      platform: "luogu",
      providerId: "luogu-adapter",
      httpStatus: 999,
      retryAfterMs: OJ_MAX_RETRY_AFTER_MS * 2
    });
    expect(ojErrorSchema.safeParse(sanitized).success).toBe(true);
    expect(sanitized.httpStatus).toBeUndefined();
    expect(sanitized.retryAfterMs).toBe(OJ_MAX_RETRY_AFTER_MS);

    const fallback = createOjError({
      code: "upstream.unavailable",
      message: "",
      platform: "nowcoder",
      providerId: "nowcoder-public-page",
      fallbackMessage: "Safe fallback."
    });
    expect(ojErrorSchema.safeParse(fallback).success).toBe(true);
    expect(fallback).toMatchObject({
      code: "internal",
      layer: "broker",
      message: "Safe fallback.",
      retryPolicy: "never",
      userAction: "open_logs",
      platform: "nowcoder",
      providerId: "nowcoder-public-page"
    });
  });

  test("enforces contract schema invariants for UTF-8 byte length and agentReadOnly manifest bounds", () => {
    const multibyte = "你好\n";
    const validSha = "a".repeat(64);
    expect(
      ojCodeArtifactSchema.safeParse({
        languageKey: "cpp",
        source: multibyte,
        sha256: validSha,
        bytes: multibyte.length, // wrong: UTF-16 code units != UTF-8 bytes
        capturedAt: "2026-07-11T00:00:00.000Z",
        sourceWasDirty: false
      }).success
    ).toBe(false);
    expect(
      ojCodeArtifactSchema.safeParse({
        languageKey: "cpp",
        source: multibyte,
        sha256: validSha,
        bytes: new TextEncoder().encode(multibyte).byteLength,
        capturedAt: "2026-07-11T00:00:00.000Z",
        sourceWasDirty: false
      }).success
    ).toBe(true);

    const artifact = {
      sourceUrl: "https://example.test/release.tgz",
      repository: "https://github.com/ketherworks/competitive-programming-mcp",
      version: "0.1.0",
      commit: "a".repeat(40),
      os: ["linux"],
      arch: ["x64"],
      runtime: "node22",
      archiveSha256: validSha,
      filesSha256: validSha,
      sbomSha256: validSha,
      license: "MIT"
    };
    const manifestWithWriteRisk = ojProviderManifestSchema.safeParse({
      schemaVersion: "oj-provider-manifest/v1",
      providerId: "test-provider",
      platform: "atcoder",
      minimumExtensionVersion: "0.1.0",
      installDirectoryLayout: "v1",
      artifacts: { active: artifact, rollback: artifact },
      entrypoints: [
        {
          id: "agentReadOnly",
          transport: "local_stdio",
          command: "node",
          args: ["--cookie=secret"],
          expectedTools: [],
          allowedRisks: ["R4_real_submit"]
        }
      ],
      expectedProtocol: "2025-11-25"
    });
    expect(manifestWithWriteRisk.success).toBe(false);
  });
});
