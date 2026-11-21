import type { OjCapabilityName, OjErrorCode, OjPlatformId, OjProviderHealth } from "@kaiserunix/oj-mcp-contracts";

export type SupportedPlatform = Extract<OjPlatformId, "codeforces" | "atcoder" | "nowcoder" | "luogu">;
export type SmokeMode = "stdio" | "worker" | "http";
export type CheckOutcome = "pass" | "fail" | "skip";

export interface ProviderSampleInputs {
  searchArgs: Record<string, unknown>;
  invalidSearchArgs: Record<string, unknown>;
  readToolName: "oj_fetch_problem" | "codeforces_get_problem_metadata";
  readArgs: Record<string, unknown>;
  invalidReadArgs: Record<string, unknown>;
  readExpectation: "problem-document" | "problem-summary";
}

export interface ProviderPackageDescriptor {
  platform: SupportedPlatform;
  displayName: string;
  packageDir: string;
  packageName: string;
  providerId: string;
  expectedTools: readonly string[];
  actionTools: readonly string[];
  destructiveTools: readonly string[];
  anonymousReadOnly: boolean;
  supportsWorker: boolean;
  allowedOriginEnvVar?: string;
  remoteMcpUrl?: string;
  expectedCapabilities: Record<
    OjCapabilityName,
    {
      allowedStatuses: ReadonlyArray<"available" | "auth_required" | "unsupported" | "disabled_by_policy" | "degraded">;
      expectedToolName?: string;
    }
  >;
  sampleInputs: ProviderSampleInputs;
}

export interface ResolvedPackageArtifacts {
  platform: SupportedPlatform;
  packageDir: string;
  manifestPath: string;
  manifestName: string;
  version: string;
  stdioEntryPath: string;
  workerEntryPath?: string;
  wranglerConfigPath?: string;
  unpublishedWorkspaceDeps: string[];
}

export interface ComplianceCheckResult {
  name: string;
  outcome: CheckOutcome;
  durationMs: number;
  detail: string;
  errorCode?: OjErrorCode | string;
}

export interface ProviderTargetReport {
  platform: SupportedPlatform;
  mode: SmokeMode;
  target: string;
  outcome: CheckOutcome;
  overallHealth?: OjProviderHealth["overall"];
  latencyMs: number;
  checks: ComplianceCheckResult[];
}

export interface SmokeRunSummary {
  schemaVersion: "oj.smoke-report/v1";
  checkedAt: string;
  platforms: SupportedPlatform[];
  modes: SmokeMode[];
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  targets: ProviderTargetReport[];
}

export interface SmokeProbeOptions {
  repoRoot: string;
  timeoutMs: number;
  live: boolean;
  failOnDegraded: boolean;
  internalKey?: string;
  passEnv?: boolean;
}
