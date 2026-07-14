import { z } from "zod";

export const nowCoderAuthStatusSchema = z.object({
  schemaVersion: z.literal("nowcoder.auth-status/v1"),
  platform: z.literal("nowcoder"),
  providerId: z.literal("nowcoder-public-page"),
  configured: z.boolean(),
  state: z.enum(["not_configured", "authenticated", "expired", "challenge", "unknown"]),
  checkedAt: z.string().datetime(),
  message: z.string().min(1).max(240)
}).strict();

export type NowCoderAuthStatus = z.infer<typeof nowCoderAuthStatusSchema>;

export function readNowCoderSessionCookie(
  environment: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  return environment.NOWCODER_SESSION_COOKIE;
}

export function authStatusMessage(state: NowCoderAuthStatus["state"]): string {
  switch (state) {
    case "not_configured":
      return "No local NowCoder session is configured.";
    case "authenticated":
      return "NowCoder accepted the configured local session.";
    case "expired":
      return "NowCoder rejected the configured local session or reported it as expired.";
    case "challenge":
      return "NowCoder requires an interactive browser challenge.";
    case "unknown":
      return "NowCoder returned no recognized login-state marker.";
  }
}
