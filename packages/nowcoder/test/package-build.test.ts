import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("package build scripts", () => {
  test("builds project references before production, test typecheck, and prepack", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts).toMatchObject({
      build:
        "npm run clean && tsc -b tsconfig.json && node ../../scripts/bundle-platform.mjs nowcoder && node scripts/prepare-bin.mjs",
      typecheck: "npm run clean && tsc -b tsconfig.json",
      "typecheck:test": "npm run typecheck && tsc -p tsconfig.test.json",
      prepack: "npm run build && node scripts/verify-package.mjs"
    });
  });

  test("ships without unpublished workspace runtime dependencies", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const cli = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");

    expect(Object.keys(manifest.dependencies).filter((name) => name.startsWith("@kaiserunix/oj-mcp-"))).toEqual([]);
    expect(cli).not.toContain("@kaiserunix/oj-mcp-");
  });

  test("publishes only the supported bundled CLI entrypoint", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      files: string[];
    };

    expect(manifest.files).toEqual([
      "dist/index.js",
      "dist/index.js.map",
      "dist/index.d.ts",
      "dist/index.d.ts.map",
      "README.md",
      "LICENSE"
    ]);
  });
});
