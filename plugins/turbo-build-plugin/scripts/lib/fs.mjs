import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

/** Official harness temp root (`%TEMP%/grok/...`) so turbo disk temp-grok can reclaim. */
export function harnessTempRoot(...parts) {
  const root = path.join(os.tmpdir(), "grok", ...parts);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function createTempDir(prefix = "t-") {
  return fs.mkdtempSync(path.join(harnessTempRoot("plugin-tests"), prefix));
}

/** Isolation harness files — never payload for land / allowed_paths. */
export function isHarnessLandPath(rel) {
  const n = String(rel || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  return (
    n === ".grok-subagent-live" ||
    n === ".grok" ||
    n.startsWith(".grok/") ||
    n === ".grok-restore" ||
    n.startsWith(".grok-restore/")
  );
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
