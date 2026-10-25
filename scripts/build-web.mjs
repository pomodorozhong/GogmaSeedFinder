import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The app is browser-native ES modules. Match the static Pages deployment;
// no bundler or Rust rebuild is required for UI changes.
const source = new URL("../web/", import.meta.url);
const output = new URL("../dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true, filter: (path) => !path.endsWith(".test.mjs") });
const indexPath = new URL("index.html", output);
const index = await readFile(indexPath, "utf8");
const version = process.env.GITHUB_SHA ?? "local";
await writeFile(indexPath, index.replaceAll("__BUILD_ID__", version));
console.info(`Static web app built in ${fileURLToPath(output)}`);
