import { chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const platformEntrypoints = {
  atcoder: ["index", "worker"],
  codeforces: ["index", "worker"],
  luogu: ["index", "worker"],
  nowcoder: ["index"]
};
const externalPackages = [
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  "parse5",
  "parse5/*",
  "parse5-sax-parser",
  "parse5-sax-parser/*",
  "zod",
  "zod/*",
  "node:*"
];
const workspaceAliases = {
  "@kaiserunix/oj-mcp-contracts": join(repositoryRoot, "packages", "contracts", "src", "index.ts"),
  "@kaiserunix/oj-mcp-server-common": join(repositoryRoot, "packages", "server-common", "src", "index.ts")
};

export async function bundlePlatform(platform) {
  const entrypoints = platformEntrypoints[platform];
  if (!entrypoints) throw new TypeError(`Unsupported MCP platform package: ${platform}`);

  const packageDir = resolve(repositoryRoot, "packages", platform);
  if (dirname(packageDir) !== resolve(repositoryRoot, "packages")) {
    throw new Error("Refusing to bundle outside the packages directory.");
  }

  await Promise.all(
    entrypoints.map((entrypoint) =>
      build({
        entryPoints: [join(packageDir, "src", `${entrypoint}.ts`)],
        outfile: join(packageDir, "dist", `${entrypoint}.js`),
        alias: workspaceAliases,
        bundle: true,
        external: externalPackages,
        format: "esm",
        legalComments: "none",
        logLevel: "silent",
        platform: entrypoint === "index" ? "node" : "neutral",
        sourcemap: true,
        sourcesContent: false,
        target: "es2022"
      })
    )
  );
  await chmod(join(packageDir, "dist", "index.js"), 0o755);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundlePlatform(process.argv[2]);
}
