import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const web = new URL("../web/", import.meta.url);
for (const file of readdirSync(web).filter((name) => name.endsWith(".js"))) {
  execFileSync(process.execPath, ["--check", fileURLToPath(new URL(file, web))], { stdio: "inherit" });
}
