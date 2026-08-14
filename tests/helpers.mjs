import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { resolveSpawnInvocation } from "../plugins/turbo-build-plugin/scripts/lib/which.mjs";

export function harnessTempRoot(...parts) {
  const root = path.join(os.tmpdir(), "grok", ...parts);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function makeTempDir(prefix = "t-") {
  return fs.mkdtempSync(path.join(harnessTempRoot("plugin-tests"), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  const env = options.env ?? process.env;
  const invocation = resolveSpawnInvocation(command, args ?? [], env);
  return spawnSync(invocation.executable, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    windowsHide: true,
    shell: options.shell ?? false
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Grok Build Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
