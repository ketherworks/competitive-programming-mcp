import { readNowCoderSessionCookie } from "./auth.js";
import { NowCoderPageClient, type NowCoderPageClientOptions } from "./client.js";
import { NowCoderProvider } from "./provider.js";
import { createNowCoderMcpServer } from "./server.js";

export interface NowCoderBootstrapOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  clientOptions?: Omit<NowCoderPageClientOptions, "sessionCookie">;
  nowIso?: () => string;
}

export function createNowCoderMcpServerFromEnvironment(options: NowCoderBootstrapOptions = {}) {
  const sessionCookie = readNowCoderSessionCookie(options.environment);
  const client = new NowCoderPageClient({
    ...options.clientOptions,
    ...(sessionCookie === undefined ? {} : { sessionCookie })
  });
  return createNowCoderMcpServer({
    provider: new NowCoderProvider({ client, ...(options.nowIso === undefined ? {} : { nowIso: options.nowIso }) })
  });
}
