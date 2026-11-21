import { createAtCoderWorker, type AtCoderWorkerEnv } from "@kaiserunix/atcoder-mcp-server/worker";
import { createLuoguWorker, type LuoguWorkerEnv } from "@kaiserunix/luogu-mcp-server/worker";
import { validateInternalKey, type WebWorker } from "./bridge.js";

export type HostedProvider = "atcoder" | "luogu";

interface HostedProviderDescriptor {
  allowedOriginsEnv: string;
  createWorker: () => WebWorker<Record<string, string | undefined>>;
}

const HOSTED_PROVIDERS: Record<HostedProvider, HostedProviderDescriptor> = {
  atcoder: {
    allowedOriginsEnv: "ATCODER_MCP_ALLOWED_ORIGINS",
    createWorker: () => {
      const worker = createAtCoderWorker();
      return { fetch: (request, env) => worker.fetch(request, env as AtCoderWorkerEnv) };
    }
  },
  luogu: {
    allowedOriginsEnv: "LUOGU_MCP_ALLOWED_ORIGINS",
    createWorker: () => {
      const worker = createLuoguWorker();
      return { fetch: (request, env) => worker.fetch(request, env as LuoguWorkerEnv) };
    }
  }
};

export interface HostConfig {
  provider: HostedProvider;
  host: string;
  port: number;
  internalKey?: string;
  workerEnv: Record<string, string | undefined>;
}

function isHostedProvider(value: string | undefined): value is HostedProvider {
  return value !== undefined && Object.prototype.hasOwnProperty.call(HOSTED_PROVIDERS, value);
}

export function parseHostConfig(argv: string[], env: Record<string, string | undefined>): HostConfig {
  const provider = argv[0];
  if (!isHostedProvider(provider)) {
    throw new TypeError("The hosted provider must be atcoder or luogu.");
  }
  const host = env.OJ_MCP_HOST?.trim() || "127.0.0.1";
  if (host.includes("\0")) throw new TypeError("OJ_MCP_HOST is invalid.");
  const portText = env.OJ_MCP_PORT?.trim() || "8787";
  if (!/^[0-9]+$/.test(portText)) throw new TypeError("OJ_MCP_PORT must be an integer from 1 to 65535.");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("OJ_MCP_PORT must be an integer from 1 to 65535.");
  }
  const internalKey = env.OJ_MCP_INTERNAL_KEY;
  validateInternalKey(internalKey);

  const originsName = HOSTED_PROVIDERS[provider].allowedOriginsEnv;
  const allowedOrigins = env[originsName];
  return {
    provider,
    host,
    port,
    ...(internalKey !== undefined ? { internalKey } : {}),
    workerEnv: { ...(allowedOrigins !== undefined ? { [originsName]: allowedOrigins } : {}) }
  };
}

export function createHostedWorker(provider: HostedProvider): WebWorker<Record<string, string | undefined>> {
  return HOSTED_PROVIDERS[provider].createWorker();
}
