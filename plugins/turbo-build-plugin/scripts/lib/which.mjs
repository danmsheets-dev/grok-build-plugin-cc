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
function firstExistingWithPathext(base, env) {
  const ext = path.extname(base);
  if (ext && WINDOWS_EXECUTABLE_EXTENSIONS.has(ext.toLowerCase())) {
    return base;
  }
  const extensions = String(env?.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const entry of extensions) {
    const suffix = entry.startsWith(".") ? entry : `.${entry}`;
    const candidate = `${base}${suffix}`;
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // keep looking
    }
  }
  return base;
}

export function resolveExecutable(command, env = process.env, platform = process.platform) {
  const name = String(command ?? "");
  if (platform !== "win32" || !name) {
    return name;
  }
  if (path.isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    return firstExistingWithPathext(name, env);
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
  return quoteWindowsArgAlways(value);
}

/**
 * The CRT quoting rule with no bare-value short-circuit.
 *
 * The cmd path needs every value quoted (so `&` and friends stay inert through
 * cmd's two parses), and it must still get the backslash doubling right — a
 * value ending in `\` would otherwise escape the closing quote and the child
 * would receive `trailing"`.
 */
function quoteWindowsArgAlways(arg) {
  const value = String(arg ?? "");
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

/**
 * Thrown when an argument cannot be represented safely on a cmd.exe line.
 *
 * Failing loudly is the point. The alternative that shipped was cmd silently
 * truncating the command line at the first newline, which dropped
 * `--sandbox read-only`, `--deny Edit(*)` and `--permission-mode plan` while
 * the run still exited 0 and reported success.
 */
export class CmdArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "CmdArgumentError";
  }
}

/**
 * Quote one argument for **cmd.exe's** grammar, not the C runtime's.
 *
 * `quoteWindowsArg` implements the CRT rule, which is right for CreateProcess
 * but wrong here: the string is handed to `cmd.exe /d /s /c "<line>"`, and cmd
 * parses first. cmd does not honour backslash escapes — it tracks quote parity
 * — so a `"` inside a value ends the quoted run and everything after `&` is a
 * new command. cmd also expands `%VAR%` and treats `& | < > ^` as operators
 * before the CRT ever sees the line.
 *
 * Rules applied here:
 *  - a `"` inside a quoted value is doubled (`""`), which is cmd's own escape;
 *  - every value is quoted, never bare, so `&`, `^`, `(`, `)` cannot act;
 *  - CR/LF is rejected outright — cmd's line ends there and no quoting saves it;
 *  - `%IDENT%` is rejected, because there is no way to escape it here.
 *
 * On the `%` rule specifically, measured rather than assumed: cmd expands
 * `%NAME%` only when NAME is a *defined* variable. A bare `%` ("50% faster")
 * and an undefined reference both survive verbatim, so ordinary prose is left
 * alone; only an identifier-shaped reference is refused. The batch-file escape
 * `%%` does NOT work on a `cmd /c` line — verified — so rejecting is the only
 * fail-closed option. Callers with free-form text should use file transport.
 */
const CMD_VARIABLE_REFERENCE = /%[A-Za-z_][A-Za-z0-9_]*%/;

/**
 * Whether a value can round-trip through a `cmd.exe /c` line unchanged.
 *
 * Callers use this to choose file transport BEFORE building argv, so a prompt
 * containing a newline or a `%VAR%` is spilled to `--prompt-file` instead of
 * failing the run in `quoteCmdArg`.
 */
export function cmdLineCanCarry(value) {
  const text = String(value ?? "");
  return !/[\r\n]/.test(text) && !CMD_VARIABLE_REFERENCE.test(text);
}

export function quoteCmdArg(arg) {
  const value = String(arg ?? "");
  if (/[\r\n]/.test(value)) {
    throw new CmdArgumentError(
      "Argument contains a newline, which cmd.exe cannot carry: everything after " +
        "the first line would be silently discarded. Pass it via a file instead " +
        "(--prompt-file / --rules-file)."
    );
  }
  if (CMD_VARIABLE_REFERENCE.test(value)) {
    throw new CmdArgumentError(
      "Argument contains a %VARIABLE% reference, which cmd.exe would expand " +
        "before the child sees it (leaking the variable's value into the " +
        "argument). Carets do not escape %, because expansion happens first. " +
        "Pass it via a file instead (--prompt-file / --rules-file)."
    );
  }
  // A `.cmd` shim means the line is parsed TWICE by cmd — once for `/c`, then
  // again inside the shim when `%*` is expanded — before the child's C runtime
  // parses it. Measured, not assumed: caret escaping does not survive that,
  // because the first pass consumes the caret and the second sees a bare
  // metacharacter.
  //
  // What does survive is a cmd-quoted region: quotes are preserved through both
  // passes, and everything inside them is inert to cmd. So the rule is to
  // ALWAYS quote. `quoteWindowsArg` returns a short value bare, which is what
  // exposed `&` in an ordinary Windows path like `C:\dev\R&D` and produced a
  // deny rule matching nothing.
  const alwaysQuoted = quoteWindowsArgAlways(value);

  // The one shape that cannot be encoded: an embedded quote breaks cmd's parity
  // (cmd counts quotes; it does not honour the CRT's `\"`), so a following `&`
  // starts a new command on the host. Benign quoted text is unaffected — it
  // only matters when a metacharacter follows.
  if (value.includes('"') && /[&|<>^]/.test(value)) {
    throw new CmdArgumentError(
      "Argument contains both a quote and a cmd metacharacter (& | < > ^). That " +
        "combination breaks cmd.exe's quote tracking and would execute the rest " +
        "as a separate command. Pass it via a file instead (--prompt-file / " +
        "--rules-file)."
    );
  }
  return alwaysQuoted;
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
    const commandLine = [executable, ...argList].map(quoteCmdArg).join(" ");
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
