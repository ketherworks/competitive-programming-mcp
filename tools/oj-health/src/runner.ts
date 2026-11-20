import { probeHttpEndpoint, probeStdioPackage, probeWorkerPackage } from "./probeClient.js";
import { getProviderDescriptor, SUPPORTED_PLATFORMS } from "./registry.js";
import type {
  ProviderPackageDescriptor,
  ProviderTargetReport,
  SmokeMode,
  SmokeProbeOptions,
  SmokeRunSummary,
  SupportedPlatform
} from "./types.js";

export interface SmokeRunnerDependencies {
  probeStdio?: (descriptor: ProviderPackageDescriptor, options: SmokeProbeOptions) => Promise<ProviderTargetReport>;
  probeWorker?: (descriptor: ProviderPackageDescriptor, options: SmokeProbeOptions) => Promise<ProviderTargetReport>;
  probeHttp?: (
    url: string,
    descriptor: ProviderPackageDescriptor,
    options: SmokeProbeOptions
  ) => Promise<ProviderTargetReport>;
  nowIso?: () => string;
}

export interface SmokeRunRequest {
  platforms: SupportedPlatform[];
  modes: SmokeMode[];
  url?: string;
  remote?: boolean;
  repoRoot: string;
  timeoutMs: number;
  live: boolean;
  failOnDegraded: boolean;
  internalKey?: string;
  passEnv?: boolean;
}

export async function runSmokeChecks(
  request: SmokeRunRequest,
  dependencies: SmokeRunnerDependencies = {}
): Promise<SmokeRunSummary> {
  const startedAt = Date.now();
  const nowIso = dependencies.nowIso ?? (() => new Date().toISOString());
  const probeStdio = dependencies.probeStdio ?? probeStdioPackage;
  const probeWorker = dependencies.probeWorker ?? probeWorkerPackage;
  const probeHttp = dependencies.probeHttp ?? probeHttpEndpoint;

  const probeOptions: SmokeProbeOptions = {
    repoRoot: request.repoRoot,
    timeoutMs: request.timeoutMs,
    live: request.live,
    failOnDegraded: request.failOnDegraded,
    ...(request.internalKey ? { internalKey: request.internalKey } : {}),
    ...(request.passEnv ? { passEnv: true } : {})
  };

  const targets: ProviderTargetReport[] = [];

  if (request.url) {
    if (request.platforms.length !== 1) {
      throw new Error("--url requires specifying exactly one platform via --platform or --platforms.");
    }
    const descriptor = getProviderDescriptor(request.platforms[0]!);
    targets.push(await probeHttp(request.url, descriptor, probeOptions));
  } else {
    for (const platform of request.platforms) {
      const descriptor = getProviderDescriptor(platform);
      for (const mode of request.modes) {
        if (mode === "stdio") {
          targets.push(await probeStdio(descriptor, probeOptions));
        } else if (mode === "worker") {
          targets.push(await probeWorker(descriptor, probeOptions));
        } else if (mode === "http") {
          if (!descriptor.remoteMcpUrl) {
            targets.push({
              platform,
              mode: "http",
              target: "not-applicable",
              outcome: "skip",
              latencyMs: 0,
              checks: [
                {
                  name: "http-policy",
                  outcome: "skip",
                  durationMs: 0,
                  detail: `${descriptor.displayName} has no public remote HTTP endpoint.`
                }
              ]
            });
          } else {
            targets.push(await probeHttp(descriptor.remoteMcpUrl, descriptor, probeOptions));
          }
        }
      }
    }
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const target of targets) {
    if (target.outcome === "pass") passed += 1;
    else if (target.outcome === "fail") failed += 1;
    else skipped += 1;
  }

  return {
    schemaVersion: "oj.smoke-report/v1",
    checkedAt: nowIso(),
    platforms: request.platforms,
    modes: request.url ? ["http"] : request.modes,
    passed,
    failed,
    skipped,
    durationMs: Date.now() - startedAt,
    targets
  };
}

export function formatSmokeSummaryText(summary: SmokeRunSummary): string {
  const lines: string[] = [
    `OJ MCP Smoke Check (${summary.checkedAt})`,
    `Platforms: ${summary.platforms.join(", ")} | Modes: ${summary.modes.join(", ")}`,
    ""
  ];

  for (const target of summary.targets) {
    const tag = target.outcome === "pass" ? "[PASS]" : target.outcome === "skip" ? "[SKIP]" : "[FAIL]";
    const healthSuffix = target.overallHealth ? ` | health=${target.overallHealth}` : "";
    lines.push(`${tag} ${target.platform} (${target.mode}) ${target.latencyMs}ms${healthSuffix} — ${target.target}`);
    for (const check of target.checks) {
      const checkTag = check.outcome === "pass" ? "  ✓" : check.outcome === "skip" ? "  -" : "  ✗";
      lines.push(`${checkTag} ${check.name} (${check.durationMs}ms): ${check.detail}`);
    }
  }

  lines.push("");
  lines.push(
    `Summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.durationMs}ms total).`
  );
  return lines.join("\n");
}

export function defaultPlatforms(): SupportedPlatform[] {
  return [...SUPPORTED_PLATFORMS];
}
