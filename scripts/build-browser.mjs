import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/browser/main.ts"],
  bundle: true,
  format: "iife",
  target: ["es2022", "chrome110", "safari16"],
  outfile: "dist/plugin.js",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  define: { __VERSION__: JSON.stringify(pkg.version) },
  banner: { js: `// opencode-web-stream cockpit v${pkg.version} — built ${new Date().toISOString()}` },
  logLevel: "info",
});
