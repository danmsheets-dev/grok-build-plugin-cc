import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".cmd", ".bat", ".com"]);

/**
 * Resolve a bare command name to an absolute path on Windows using PATH + PATHEXT.
 * Lets callers spawn without `shell: true`, which avoids DEP0190 and the
 * argument-concatenation injection surface that warning describes.
 *
 * Also matches extensionless files on PATH (e.g. shebang scripts installed by
 * test fixtures). Those still need `resolveSpawnInvocation` (or equivalent)
 * to run under node on Windows.
 */
export function resolveExecutable(command, env = process.env, platform = process.platform) {
  const name = String(command ?? "");
  if (platform !== "win32" || !name || path.isAbsolute(name)) {
    return name;
  }
  if (name.includes("/") || name.includes("\\")) {
    return name;
  }

  const searchPath = String(env?.PATH ?? env?.Path ?? "");
  const extensions = String(env?.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);

  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    // Prefer an exact basename match in this directory (bash / cmd-style), so an
    // extensionless fixture ahead of a real *.exe later on PATH wins.
    const bare = path.join(directory, name);
    try {
      if (fs.statSync(bare).isFile()) {
        return bare;
      }
    } catch {
      // not present
    }

    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension.toLowerCase()}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
      }
      const upper = path.join(directory, `${name}${extension.toUpperCase()}`);
      try {
        if (fs.statSync(upper).isFile()) {
          return upper;
        }
      } catch {
      }
    }
  }

  return name;
}

function isNodeShebangScript(filePath) {
  if (!filePath || !path.isAbsolute(filePath)) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (WINDOWS_EXECUTABLE_EXTENSIONS.has(ext)) {
    return false;
  }
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(256);
    const bytesRead = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    const head = buf.toString("utf8", 0, bytesRead);
    if (!head.startsWith("#!")) {
      return false;
    }
    const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
    return /\bnode\b/i.test(firstLine);
  } catch {
    return false;
  }
}

/**
 * Resolve command + args into a spawn target that works without `shell: true`.
 * On Windows, extensionless node shebang scripts are rewritten to
 * `process.execPath script ...args` because CreateProcess cannot run them.
 */
export function resolveSpawnInvocation(command, args = [], env = process.env, platform = process.platform) {
  const executable = resolveExecutable(command, env, platform);
  if (platform === "win32" && isNodeShebangScript(executable)) {
    return {
      executable: process.execPath,
      args: [executable, ...args]
    };
  }
  return {
    executable,
    args: Array.isArray(args) ? args : []
  };
}
