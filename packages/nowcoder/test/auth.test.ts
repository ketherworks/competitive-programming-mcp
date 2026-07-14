import { describe, expect, test } from "vitest";
import { readNowCoderSessionCookie } from "../src/auth.js";

describe("NowCoder local session configuration", () => {
  test("reads the opaque cookie only from the dedicated process environment slot", () => {
    const sessionCookie = readNowCoderSessionCookie({
      NOWCODER_SESSION_COOKIE: "NOWCODER_SESSION=secret-value; token=second-secret",
      UNRELATED_SECRET: "must-not-be-read"
    });

    expect(sessionCookie).toBe("NOWCODER_SESSION=secret-value; token=second-secret");
    expect(readNowCoderSessionCookie({})).toBeUndefined();
  });
});
