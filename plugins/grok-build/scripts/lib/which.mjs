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
    // Check PATHEXT candidates in this directory BEFORE the bare extensionless
    // name. npm-style bin directories (node_modules/.bin/*, npm's own global
    // bin dir) ship an extensionless POSIX shim ALONGSIDE a .cmd wrapper for
    // the SAME tool. Checking bare first resolved to the POSIX shim, which
    // Windows CreateProcess cannot execute, producing ENOENT even though a
    // working .cmd sat right next to it - confirmed directly for a synthetic
    // eslint / eslint.cmd pair, the common shape of a JS project's local
    // devDependency binaries. Checking extensions first matches how native
    // Windows and cmd.exe itself resolve a bare command name.
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

    // No PATHEXT match in this directory. Fall back to an exact extensionless
    // match so a shebang-script fixture (or any legitimate extensionless
    // executable) still resolves when there is no Windows-native alternative.
    const bare = path.join(directory, name);
    try {
      if (fs.statSync(bare).isFile()) {
        return bare;
      }
    } catch {
      // not present
    }
  }

  return name;
}

const CMD_STYLE_EXTENSIONS = new Set([".cmd", ".bat"]);

function isCmdStyleScript(filePath) {
  if (!filePath || !path.isAbsolute(filePath)) {
    return false;
  }
  return CMD_STYLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Quote one argument per the Windows CRT argv-parsing rule: double any
 * backslashes that immediately precede a quote (or end the value before the
 * closing quote), escape the quote itself, wrap in quotes only if the value
 * needs it. Matches the algorithm behind Python's subprocess.list2cmdline.
 */
function quoteWindowsArg(arg) {
  const value = String(arg ?? "");
  if (value !== "" && !/[\s"]/.test(value)) {
    return value;
  }
  let result = "";
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      result += char;
      continue;
    }
    if (char === "\"") {
      result += "\\".repeat(backslashes + 1);
      backslashes = 0;
      result += "\"";
      continue;
    }
    backslashes = 0;
    result += char;
  }
  result += "\\".repeat(backslashes);
  return `"${result}"`;
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
  const argList = Array.isArray(args) ? args : [];

  if (platform === "win32" && isNodeShebangScript(executable)) {
    return {
      executable: process.execPath,
      args: [executable, ...argList]
    };
  }

  if (platform === "win32" && isCmdStyleScript(executable)) {
    // Confirmed directly: Node's spawnSync cannot invoke a .cmd/.bat file on
    // its own, even given an absolute path and shell:false - it fails with
    // EINVAL regardless of path form. This is common: node_modules/.bin/*
    // ships a .cmd wrapper for every tool (eslint.cmd, jest.cmd, tsc.cmd...)
    // alongside its POSIX shim, so resolving to it correctly (see above) is
    // not enough on its own - it still has to be routed through cmd.exe.
    const commandLine = [executable, ...argList].map(quoteWindowsArg).join(" ");
    return {
      executable: env?.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true
    };
  }

  return {
    executable,
    args: argList
  };
}
