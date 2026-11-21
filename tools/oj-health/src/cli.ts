#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSupportedPlatform, SUPPORTED_PLATFORMS } from "./registry.js";
import { formatSmokeSummaryText, runSmokeChecks, type SmokeRunnerDependencies } from "./runner.js";
import type { SmokeMode, SupportedPlatform } from "./types.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface ParsedCliArgs {
  help: boolean;
  platforms: SupportedPlatform[];
  modes: SmokeMode[];
  url?: string;
  remote: boolean;
  live: boolean;
  failOnDegraded: boolean;
  json: boolean;
  passEnv: boolean;
  timeoutMs: number;
  internalKeyEnv?: string;
  repoRoot: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function helpText(): string {
  return [
    "oj-health — Cross-provider contract & smoke-check CLI for Competitive Programming MCP",
    "",
    "Usage:",
    "  node tools/oj-health/dist/cli.js [options]",
    "",
    "Options:",
    "  --platforms <list>       Comma-separated platforms: codeforces,atcoder,nowcoder,luogu (or 'all')",
    "  --platform <name>        Alias for single platform",
    "  --mode <mode>            Probe mode: stdio | worker | http | all (default: all -> stdio,worker)",
    "  --url <endpoint>         Probe a specific Streamable HTTP /mcp endpoint (requires single --platform)",
    "  --remote                 Probe documented public production HTTP endpoints (opt-in network calls)",
    "  --live                   Run one safe public search/fetch query per target in addition to contract checks",
    "  --fail-on-degraded       Exit non-zero if oj_health reports degraded, unavailable, or auth_required",
    "  --timeout-ms <ms>        Per-operation timeout in ms (100..120000, default: 10000)",
    "  --internal-key-env <VAR> Env variable name containing X-OJ-MCP-Key for protected HTTP host probes",
    "  --pass-env               Forward process env into stdio servers (disabled by default to protect secrets)",
    "  --repo-root <path>       Repository root containing packages/ (defaults to current monorepo root)",
    "  --json                   Emit machine-readable oj.smoke-report/v1 JSON",
    "  -h, --help               Show this help message"
  ].join("\n");
}

export function parseCliArgs(argv: readonly string[], defaultRepoRoot: string): ParsedCliArgs {
  let help = false;
  let platforms: SupportedPlatform[] | undefined;
  let modeArg: string | undefined;
  let url: string | undefined;
  let remote = false;
  let live = false;
  let failOnDegraded = false;
  let json = false;
  let passEnv = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let internalKeyEnv: string | undefined;
  let repoRoot = defaultRepoRoot;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--remote") {
      remote = true;
      continue;
    }
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (arg === "--fail-on-degraded") {
      failOnDegraded = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--pass-env") {
      passEnv = true;
      continue;
    }

    const [flag, inlineValue] = splitFlagValue(arg);
    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        throw new TypeError(`Option ${flag} requires a value.`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "--platforms":
      case "--platform":
        platforms = parsePlatforms(readValue());
        break;
      case "--mode":
        modeArg = readValue();
        break;
      case "--url":
        url = readValue();
        break;
      case "--timeout-ms": {
        const parsed = Number(readValue());
        if (!Number.isInteger(parsed) || parsed < 100 || parsed > 120_000) {
          throw new TypeError("--timeout-ms must be an integer between 100 and 120000.");
        }
        timeoutMs = parsed;
        break;
      }
      case "--internal-key-env": {
        const varName = readValue();
        if (!/^[A-Z][A-Z0-9_]*$/.test(varName)) {
          throw new TypeError("--internal-key-env must be an uppercase environment variable name.");
        }
        internalKeyEnv = varName;
        break;
      }
      case "--repo-root":
        repoRoot = resolve(readValue());
        break;
      default:
        throw new TypeError(`Unknown option: ${arg}`);
    }
  }

  if (help) {
    return {
      help: true,
      platforms: platforms ?? [...SUPPORTED_PLATFORMS],
      modes: ["stdio", "worker"],
      remote,
      live,
      failOnDegraded,
      json,
      passEnv,
      timeoutMs,
      repoRoot
    };
  }

  const resolvedPlatforms = platforms ?? [...SUPPORTED_PLATFORMS];
  if (url && remote) {
    throw new TypeError("--url and --remote cannot be combined.");
  }
  if (url && resolvedPlatforms.length !== 1) {
    throw new TypeError("--url requires selecting exactly one platform via --platform.");
  }

  const modes = resolveModes(modeArg, Boolean(url || remote));
  return {
    help: false,
    platforms: resolvedPlatforms,
    modes,
    ...(url ? { url } : {}),
    remote,
    live,
    failOnDegraded,
    json,
    passEnv,
    timeoutMs,
    ...(internalKeyEnv ? { internalKeyEnv } : {}),
    repoRoot
  };
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    env: process.env
  },
  dependencies: SmokeRunnerDependencies = {}
): Promise<number> {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv, defaultRoot);
  } catch (error) {
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    io.stderr("Run with --help for usage.");
    return 2;
  }

  if (parsed.help) {
    io.stdout(helpText());
    return 0;
  }

  let internalKey: string | undefined;
  if (parsed.internalKeyEnv) {
    const candidate = (io.env ?? process.env)[parsed.internalKeyEnv];
    if (!candidate || candidate.length < 24) {
      io.stderr(`Error: Environment variable ${parsed.internalKeyEnv} must be set and at least 24 characters.`);
      return 2;
    }
    internalKey = candidate;
  }

  const summary = await runSmokeChecks(
    {
      platforms: parsed.platforms,
      modes: parsed.modes,
      ...(parsed.url ? { url: parsed.url } : {}),
      remote: parsed.remote,
      repoRoot: parsed.repoRoot,
      timeoutMs: parsed.timeoutMs,
      live: parsed.live,
      failOnDegraded: parsed.failOnDegraded,
      ...(internalKey ? { internalKey } : {}),
      passEnv: parsed.passEnv
    },
    dependencies
  );

  io.stdout(parsed.json ? JSON.stringify(summary, null, 2) : formatSmokeSummaryText(summary));
  return summary.failed > 0 ? 1 : 0;
}

function splitFlagValue(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq < 0) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function parsePlatforms(value: string): SupportedPlatform[] {
  const trimmed = value.trim();
  if (trimmed === "all") return [...SUPPORTED_PLATFORMS];
  const parts = trimmed
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new TypeError("Platform list must not be empty.");
  }
  const unique: SupportedPlatform[] = [];
  for (const part of parts) {
    if (!isSupportedPlatform(part)) {
      throw new TypeError(`Unsupported platform '${part}'. Expected one of: ${SUPPORTED_PLATFORMS.join(", ")}.`);
    }
    if (!unique.includes(part)) unique.push(part);
  }
  return unique;
}

function resolveModes(modeArg: string | undefined, isRemoteOrUrl: boolean): SmokeMode[] {
  if (!modeArg) {
    return isRemoteOrUrl ? ["http"] : ["stdio", "worker"];
  }
  const normalized = modeArg.trim().toLowerCase();
  if (normalized === "all") {
    return isRemoteOrUrl ? ["http"] : ["stdio", "worker"];
  }
  if (normalized === "stdio" || normalized === "worker" || normalized === "http") {
    if (isRemoteOrUrl && normalized !== "http") {
      throw new TypeError("--url and --remote only support --mode http.");
    }
    if (!isRemoteOrUrl && normalized === "http") {
      throw new TypeError("--mode http requires --url <endpoint> or --remote.");
    }
    return [normalized];
  }
  throw new TypeError(`Unsupported mode '${modeArg}'. Expected stdio, worker, http, or all.`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
