import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}

/**
 * Detect whether this process was launched by a programmatic caller (Claude
 * Code, another bridge, or an explicit --caller flag) rather than a human at a
 * terminal.
 *
 * Programmatic write runs force isolation: a Claude-authored brief almost
 * always contains absolute paths into the main checkout, and without isolation
 * (and without telling the agent about it) the agent obeys the brief and
 * writes into the shared dirty tree. Measured in the field: 5 of 7 concurrent
 * runs did exactly that.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ caller?: string|null }} [options]
 * @returns {{ programmatic: boolean, source: string|null }}
 */
export function detectCaller(env = process.env, options = {}) {
  if (options.caller != null && String(options.caller).trim()) {
    return { programmatic: true, source: `cli:${String(options.caller).trim()}` };
  }
  if (env?.GROK_BUILD_CALLER && String(env.GROK_BUILD_CALLER).trim()) {
    return { programmatic: true, source: `env:GROK_BUILD_CALLER=${String(env.GROK_BUILD_CALLER).trim()}` };
  }
  if (env?.CLAUDECODE) {
    return { programmatic: true, source: "env:CLAUDECODE" };
  }
  if (env?.CLAUDE_CODE_ENTRYPOINT) {
    return { programmatic: true, source: "env:CLAUDE_CODE_ENTRYPOINT" };
  }
  if (env?.CLAUDE_PLUGIN_ROOT) {
    return { programmatic: true, source: "env:CLAUDE_PLUGIN_ROOT" };
  }
  return { programmatic: false, source: null };
}

/**
 * True when GROK_BUILD_ALLOW_NO_ISOLATE is an explicit opt-in.
 * Only the values "1" / "true" (case-insensitive) count — anything else is
 * not an accidental string in the environment.
 */
export function allowNoIsolateFromEnv(env = process.env) {
  const raw = String(env?.GROK_BUILD_ALLOW_NO_ISOLATE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}
