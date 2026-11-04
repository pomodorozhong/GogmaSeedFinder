import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const web = new URL("../web/", import.meta.url);
for (const file of readdirSync(web).filter((name) => name.endsWith(".js"))) {
  execFileSync(process.execPath, ["--check", fileURLToPath(new URL(file, web))], { stdio: "inherit" });
}
const eslint = new ESLint();
const results = await eslint.lintFiles(["web/*.js"]);
const formatter = await eslint.loadFormatter("stylish");
const output = formatter.format(results);
if (output) process.stdout.write(output);
if (results.some((result) => result.errorCount > 0)) process.exitCode = 1;
