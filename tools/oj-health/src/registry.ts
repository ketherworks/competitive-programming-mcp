import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProviderPackageDescriptor, ResolvedPackageArtifacts, SupportedPlatform } from "./types.js";

export const SUPPORTED_PLATFORMS: readonly SupportedPlatform[] = ["codeforces", "atcoder", "nowcoder", "luogu"] as const;

export const PROVIDER_DESCRIPTORS: Record<SupportedPlatform, ProviderPackageDescriptor> = {
  codeforces: {
    platform: "codeforces",
    displayName: "Codeforces",
    packageDir: "packages/codeforces",
    packageName: "@kaiserunix/codeforces-mcp-server",
    providerId: "codeforces-official-api",
    expectedTools: ["oj_capabilities", "oj_health", "oj_search_problems", "codeforces_get_problem_metadata"],
    actionTools: [],
    destructiveTools: [],
    anonymousReadOnly: true,
    supportsWorker: true,
    allowedOriginEnvVar: "CODEFORCES_MCP_ALLOWED_ORIGINS",
    remoteMcpUrl: "https://codeforces-oj-mcp.lantangtang54.workers.dev/mcp",
    expectedCapabilities: {
      searchProblems: { allowedStatuses: ["available"], expectedToolName: "oj_search_problems" },
      fetchProblem: { allowedStatuses: ["degraded"], expectedToolName: "codeforces_get_problem_metadata" },
      importProblem: { allowedStatuses: ["unsupported"] },
      fetchProfile: { allowedStatuses: ["unsupported"] },
      listSubmissions: { allowedStatuses: ["unsupported"] },
      localRun: { allowedStatuses: ["unsupported"] },
      platformRun: { allowedStatuses: ["unsupported"] },
      prepareSubmission: { allowedStatuses: ["unsupported"] },
      commitSubmission: { allowedStatuses: ["unsupported"] },
      pollSubmission: { allowedStatuses: ["unsupported"] }
    },
    sampleInputs: {
      searchArgs: {
        schemaVersion: "oj.search-request/v1",
        requestId: "smoke-cf-search",
        platform: "codeforces",
        query: "Watermelon",
        limit: 3
      },
      invalidSearchArgs: {
        schemaVersion: "oj.search-request/v1",
        requestId: "smoke-cf-invalid",
        platform: "atcoder",
        query: "Watermelon",
        limit: 3
      },
      readToolName: "codeforces_get_problem_metadata",
      readArgs: { nativeId: "4/A" },
      invalidReadArgs: { nativeId: "x" },
      readExpectation: "problem-summary"
    }
  },
  atcoder: {
    platform: "atcoder",
    displayName: "AtCoder",
    packageDir: "packages/atcoder",
    packageName: "@kaiserunix/atcoder-mcp-server",
    providerId: "atcoder-page-adapter",
    expectedTools: ["oj_capabilities", "oj_health", "oj_fetch_problem", "oj_search_problems"],
    actionTools: [],
    destructiveTools: [],
    anonymousReadOnly: true,
    supportsWorker: true,
    allowedOriginEnvVar: "ATCODER_MCP_ALLOWED_ORIGINS",
    remoteMcpUrl: "https://api.ksrnyx.top/oj-mcp/atcoder/mcp",
    expectedCapabilities: {
      searchProblems: { allowedStatuses: ["available"], expectedToolName: "oj_search_problems" },
      fetchProblem: { allowedStatuses: ["available"], expectedToolName: "oj_fetch_problem" },
      importProblem: { allowedStatuses: ["unsupported"] },
      fetchProfile: { allowedStatuses: ["unsupported"] },
      listSubmissions: { allowedStatuses: ["unsupported"] },
      localRun: { allowedStatuses: ["unsupported"] },
      platformRun: { allowedStatuses: ["unsupported"] },
      prepareSubmission: { allowedStatuses: ["unsupported"] },
      commitSubmission: { allowedStatuses: ["unsupported"] },
      pollSubmission: { allowedStatuses: ["unsupported"] }
    },
    sampleInputs: {
      searchArgs: {
        schemaVersion: "oj.search-request/v1",
        requestId: "smoke-ac-search",
        platform: "atcoder",
        query: "abc086/abc086_a",
        limit: 1
      },
      invalidSearchArgs: {
        schemaVersion: "oj.search-request/v1",
        requestId: "smoke-ac-invalid",
        platform: "codeforces",
        query: "abc086/abc086_a",
        limit: 1
      },
      readToolName: "oj_fetch_problem",
      readArgs: { contestId: "abc086", taskId: "abc086_a", locale: "en" },
      invalidReadArgs: { contestId: "ABC086", taskId: "abc086_a", locale: "en" },
      readExpectation: "problem-document"
    }
  },
  nowcoder: {
    platform: "nowcoder",
    displayName: "NowCoder",
    packageDir: "packages/nowcoder",
    packageName: "@kaiserunix/nowcoder-mcp-server",
    providerId: "nowcoder-public-page",
    expectedTools: [
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
    ],
    actionTools: [
      "oj_open_import_window",
      "oj_complete_import",
      "oj_prepare_submission",
      "oj_commit_submission",
      "oj_platform_run"
    ],
    destructiveTools: ["oj_commit_submission"],
    anonymousReadOnly: false,
    supportsWorker: false,
    expectedCapabilities: {
      searchProblems: { allowedStatuses: ["available"], expectedToolName: "oj_search_problems" },
      fetchProblem: { allowedStatuses: ["available"], expectedToolName: "oj_fetch_problem" },
      importProblem: { allowedStatuses: ["available"], expectedToolName: "oj_open_import_window" },
      fetchProfile: { allowedStatuses: ["available"], expectedToolName: "oj_fetch_profile" },
      listSubmissions: { allowedStatuses: ["available"], expectedToolName: "oj_list_submissions" },
      localRun: { allowedStatuses: ["unsupported"] },
      platformRun: { allowedStatuses: ["available", "auth_required"], expectedToolName: "oj_platform_run" },
      prepareSubmission: { allowedStatuses: ["available", "auth_required"], expectedToolName: "oj_prepare_submission" },
      commitSubmission: { allowedStatuses: ["available", "auth_required"], expectedToolName: "oj_commit_submission" },
      pollSubmission: { allowedStatuses: ["available", "auth_required"], expectedToolName: "oj_poll_submission" }
    },
    sampleInputs: {
      searchArgs: {
        schemaVersion: "oj.search-request/v1",
        requestId: "smoke-nc-search",
        platform: "nowcoder",
        query: "二分",
        limit: 3
      },
      invalidSearchArgs: {
        schemaVersion: "oj.search-request/v1",
        requestId: "smoke-nc-invalid",
        platform: "nowcoder",
        query: "   ",
        limit: 3
      },
      readToolName: "oj_fetch_problem",
      readArgs: { nativeId: "NC218144" },
      invalidReadArgs: { nativeId: "11244/../A" },
      readExpectation: "problem-document"
    }
  },
  luogu: {
    platform: "luogu",
    displayName: "Luogu",
    packageDir: "packages/luogu",
    packageName: "@kaiserunix/luogu-mcp-server",
    providerId: "luogu-lentille-page-adapter",
    expectedTools: ["oj_capabilities", "oj_health", "oj_search_problems", "oj_fetch_problem"],
    actionTools: [],
    destructiveTools: [],
    anonymousReadOnly: true,
    supportsWorker: true,
    allowedOriginEnvVar: "LUOGU_MCP_ALLOWED_ORIGINS",
    remoteMcpUrl: "https://api.ksrnyx.top/oj-mcp/luogu/mcp",
    expectedCapabilities: {
      searchProblems: { allowedStatuses: ["available"], expectedToolName: "oj_search_problems" },
      fetchProblem: { allowedStatuses: ["available"], expectedToolName: "oj_fetch_problem" },
      importProblem: { allowedStatuses: ["unsupported"] },
      fetchProfile: { allowedStatuses: ["disabled_by_policy"] },
      listSubmissions: { allowedStatuses: ["disabled_by_policy"] },
      localRun: { allowedStatuses: ["unsupported"] },
      platformRun: { allowedStatuses: ["disabled_by_policy"] },
      prepareSubmission: { allowedStatuses: ["disabled_by_policy"] },
      commitSubmission: { allowedStatuses: ["disabled_by_policy"] },
      pollSubmission: { allowedStatuses: ["disabled_by_policy"] }
    },
    sampleInputs: {
      searchArgs: {
        schemaVersion: "oj.search-request/v1",
        requestId: "smoke-lg-search",
        platform: "luogu",
        query: "二叉树",
        limit: 3
      },
      invalidSearchArgs: {
        schemaVersion: "oj.search-request/v1",
        requestId: "smoke-lg-invalid",
        platform: "luogu",
        query: "二叉树",
        limit: 51
      },
      readToolName: "oj_fetch_problem",
      readArgs: { nativeId: "P1305", maxContentChars: 5000 },
      invalidReadArgs: { nativeId: "../user/1", maxContentChars: 5000 },
      readExpectation: "problem-document"
    }
  }
};

export function isSupportedPlatform(value: string): value is SupportedPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

export function getProviderDescriptor(platform: SupportedPlatform): ProviderPackageDescriptor {
  return PROVIDER_DESCRIPTORS[platform];
}

export async function resolvePackageArtifacts(
  repoRoot: string,
  platform: SupportedPlatform
): Promise<ResolvedPackageArtifacts> {
  const descriptor = getProviderDescriptor(platform);
  const packageDir = resolve(repoRoot, descriptor.packageDir);
  const manifestPath = join(packageDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    name?: string;
    version?: string;
    main?: string;
    bin?: Record<string, string>;
    exports?: Record<string, unknown>;
    dependencies?: Record<string, string>;
  };

  if (manifest.name !== descriptor.packageName) {
    throw new Error(`Expected ${manifestPath} name to be ${descriptor.packageName}, got ${manifest.name ?? "<missing>"}.`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`Expected ${manifestPath} to declare a package version.`);
  }
  if (!manifest.main) {
    throw new Error(`Expected ${manifestPath} to declare a main entry point.`);
  }

  const stdioEntryPath = resolve(packageDir, manifest.main);
  await access(stdioEntryPath);

  const binValues = Object.values(manifest.bin ?? {});
  if (binValues.length === 0 || resolve(packageDir, binValues[0]!) !== stdioEntryPath) {
    throw new Error(`Expected ${manifestPath} bin entrypoint to align with main (${manifest.main}).`);
  }

  const unpublishedWorkspaceDeps = Object.keys(manifest.dependencies ?? {}).filter((dep) =>
    dep.startsWith("@kaiserunix/oj-mcp-")
  );

  let workerEntryPath: string | undefined;
  let wranglerConfigPath: string | undefined;
  if (descriptor.supportsWorker) {
    wranglerConfigPath = join(packageDir, "wrangler.jsonc");
    const wrangler = JSON.parse(await readFile(wranglerConfigPath, "utf8")) as { main?: string };
    if (!wrangler.main) {
      throw new Error(`Expected ${wranglerConfigPath} to declare a main Worker entry point.`);
    }
    workerEntryPath = resolve(packageDir, wrangler.main);
    await access(workerEntryPath);
  }

  return {
    platform,
    packageDir,
    manifestPath,
    manifestName: manifest.name,
    version: manifest.version,
    stdioEntryPath,
    ...(workerEntryPath ? { workerEntryPath } : {}),
    ...(wranglerConfigPath ? { wranglerConfigPath } : {}),
    unpublishedWorkspaceDeps
  };
}
