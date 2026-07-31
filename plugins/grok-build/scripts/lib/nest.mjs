/**
 * Nested Hyper-to-Hyper delegation: depth/fan-out bounds, budget inheritance,
 * sibling worktree placement, and the runtime `.mcp.json` that offers
 * `delegate_*` tools to an agent inside an isolated worktree.
 *
 * Why MCP and not Hyper's in-process subagents: those share the parent's
 * filesystem, terminal, env and permission handle, and default to a nesting
 * depth of 1. They fan out work, they do not isolate it. Headless `-p` runs
 * do not attach to a shared leader, so a child nest-run is a genuine peer.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isTerminalJobStatus } from "./state.mjs";
import { shortWorktreeId } from "./worktree.mjs";

export const NEST_DEPTH_ENV = "GROK_BUILD_NEST_DEPTH";
export const MAX_NEST_DEPTH_ENV = "GROK_BUILD_MAX_NEST_DEPTH";
export const MAX_NEST_CONCURRENCY_ENV = "GROK_BUILD_MAX_NEST_CONCURRENCY";
export const NESTED_DELEGATION_ENV = "GROK_BUILD_NESTED_DELEGATION";
export const PARENT_RUN_ID_ENV = "GROK_BUILD_PARENT_RUN_ID";
export const WORKSPACE_ROOT_ENV = "GROK_BUILD_WORKSPACE_ROOT";
export const BRIDGE_PATH_ENV = "GROK_BUILD_BRIDGE_PATH";
export const PARENT_BASE_SHA_ENV = "GROK_BUILD_PARENT_BASE_SHA";
export const PARENT_WORKTREE_ENV = "GROK_BUILD_PARENT_WORKTREE";
export const PARENT_MAX_COST_ENV = "GROK_BUILD_PARENT_MAX_COST";
export const PARENT_MAX_DURATION_ENV = "GROK_BUILD_PARENT_MAX_DURATION";
export const PARENT_MAX_TURNS_ENV = "GROK_BUILD_PARENT_MAX_TURNS";
export const PARENT_SPENT_COST_ENV = "GROK_BUILD_PARENT_SPENT_COST";

export const DEFAULT_MAX_NEST_DEPTH = 2;
export const DEFAULT_MAX_NEST_CONCURRENCY = 2;

/** Server name registered in the per-run `.mcp.json`. */
export const NEST_MCP_SERVER_NAME = "grok-build-delegate";

/**
 * Whether nested delegation is offered to the agent for this run.
 * Default ON; only an explicit 0/false/no disables it.
 */
export function nestedDelegationEnabled(env = process.env) {
  const raw = env?.[NESTED_DELEGATION_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }
  const normalized = String(raw).trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "no");
}

function parseNonNegInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.floor(n);
}

export function readNestDepth(env = process.env) {
  return parseNonNegInt(env?.[NEST_DEPTH_ENV], 0);
}

export function readMaxNestDepth(env = process.env) {
  return parseNonNegInt(env?.[MAX_NEST_DEPTH_ENV], DEFAULT_MAX_NEST_DEPTH);
}

export function readMaxNestConcurrency(env = process.env) {
  return parseNonNegInt(env?.[MAX_NEST_CONCURRENCY_ENV], DEFAULT_MAX_NEST_CONCURRENCY);
}

/**
 * Remaining depth budget the agent may still spend (children it can start).
 * At depth==max the agent cannot start any more nested runs.
 */
export function remainingNestDepth(depth, maxDepth = DEFAULT_MAX_NEST_DEPTH) {
  const d = Number.isFinite(Number(depth)) ? Math.floor(Number(depth)) : 0;
  const m = Number.isFinite(Number(maxDepth)) ? Math.floor(Number(maxDepth)) : DEFAULT_MAX_NEST_DEPTH;
  return Math.max(0, m - d);
}

/**
 * Refuse when the *incoming* depth is already at the maximum. A run at
 * depth==max is a leaf: it may finish work, but it must not start children.
 *
 * @throws {Error}
 */
export function assertNestDepthAllowed(incomingDepth, maxDepth = DEFAULT_MAX_NEST_DEPTH) {
  const depth = Number.isFinite(Number(incomingDepth)) ? Math.floor(Number(incomingDepth)) : 0;
  const max = Number.isFinite(Number(maxDepth)) ? Math.floor(Number(maxDepth)) : DEFAULT_MAX_NEST_DEPTH;
  if (depth >= max) {
    throw new Error(
      `Nested delegation refused: nest depth ${depth} is already at the maximum ` +
        `(${MAX_NEST_DEPTH_ENV}=${max}). Finish the work in this run, or land and start a fresh top-level run.`
    );
  }
  return { depth, maxDepth: max, childDepth: depth + 1 };
}

/**
 * Children still live (queued/running) count against the fan-out bound.
 * Terminal statuses free a slot. Never queue silently past the limit.
 */
export function listLiveChildren(children = []) {
  if (!Array.isArray(children)) {
    return [];
  }
  return children.filter((child) => {
    const status = child?.status;
    if (!status) {
      return true;
    }
    return !isTerminalJobStatus(status);
  });
}

/**
 * @throws {Error}
 */
export function assertNestConcurrencyAllowed(children, maxConcurrency = DEFAULT_MAX_NEST_CONCURRENCY) {
  const max = Number.isFinite(Number(maxConcurrency))
    ? Math.floor(Number(maxConcurrency))
    : DEFAULT_MAX_NEST_CONCURRENCY;
  const live = listLiveChildren(children);
  if (live.length >= max) {
    const names = live
      .map((c) => c.runId ?? c.id ?? "?")
      .slice(0, 8)
      .join(", ");
    throw new Error(
      `Nested delegation refused: already ${live.length} live child run(s) ` +
        `(${MAX_NEST_CONCURRENCY_ENV}=${max}). Live: ${names || "(unknown)"}. ` +
        `Wait for one to finish (delegate_wait / delegate_result) or stop one before starting another.`
    );
  }
  return { liveCount: live.length, maxConcurrency: max, live };
}

/**
 * Parent budgets are ceilings. A child may ask for less, never more.
 * Cost uses the *remaining* parent budget (cap minus spend so far, including
 * earlier children and reserved grants for live siblings) so N children cannot
 * each spend the full parent cap. Duration uses remaining wall-clock when
 * `parentRemainingDurationSeconds` is supplied (preferred over the raw cap).
 *
 * @param {{
 *   parentMaxCostUsd?: number|null,
 *   parentSpentCostUsd?: number|null,
 *   parentMaxDurationSeconds?: number|null,
 *   parentRemainingDurationSeconds?: number|null,
 *   parentMaxTurns?: number|null,
 *   childMaxCostUsd?: number|null,
 *   childMaxDurationSeconds?: number|null,
 *   childMaxTurns?: number|null
 * }} input
 */
export function inheritBudget(input = {}) {
  const parentRemainingCost = remainingCostBudget(input.parentMaxCostUsd, input.parentSpentCostUsd);
  const durationCeiling =
    input.parentRemainingDurationSeconds != null &&
    Number.isFinite(Number(input.parentRemainingDurationSeconds))
      ? Number(input.parentRemainingDurationSeconds)
      : input.parentMaxDurationSeconds;

  return {
    maxCostUsd: clampCeiling(input.childMaxCostUsd, parentRemainingCost),
    maxDurationSeconds: clampCeiling(input.childMaxDurationSeconds, durationCeiling),
    maxTurns: clampCeiling(input.childMaxTurns, input.parentMaxTurns),
    parentRemainingCostUsd: parentRemainingCost,
    parentRemainingDurationSeconds:
      durationCeiling != null && Number.isFinite(Number(durationCeiling))
        ? Math.max(0, Number(durationCeiling))
        : null
  };
}

/**
 * Remaining wall-clock seconds under a parent's max-duration ceiling.
 * Null parent cap → null (no ceiling). Missing/invalid start → full cap.
 */
export function remainingDurationSeconds(parentMaxDurationSeconds, parentStartedAt, nowMs = Date.now()) {
  if (parentMaxDurationSeconds == null || !Number.isFinite(Number(parentMaxDurationSeconds))) {
    return null;
  }
  const cap = Math.max(0, Number(parentMaxDurationSeconds));
  if (!parentStartedAt) {
    return cap;
  }
  const startedMs = Date.parse(String(parentStartedAt));
  if (!Number.isFinite(startedMs)) {
    return cap;
  }
  const elapsedSec = Math.max(0, (Number(nowMs) - startedMs) / 1000);
  return Math.max(0, cap - elapsedSec);
}

/**
 * Cap minus spend so far. Null parent cap → null (no ceiling). Negative
 * remaining collapses to 0 so a spent-out parent cannot hand a child money.
 */
export function remainingCostBudget(parentMaxCostUsd, parentSpentCostUsd) {
  if (parentMaxCostUsd == null || !Number.isFinite(Number(parentMaxCostUsd))) {
    return null;
  }
  const cap = Number(parentMaxCostUsd);
  const spent =
    parentSpentCostUsd == null || !Number.isFinite(Number(parentSpentCostUsd))
      ? 0
      : Number(parentSpentCostUsd);
  return Math.max(0, cap - spent);
}

function clampCeiling(requested, ceiling) {
  const hasCeiling = ceiling != null && Number.isFinite(Number(ceiling));
  const hasRequested = requested != null && Number.isFinite(Number(requested));
  if (!hasCeiling && !hasRequested) {
    return null;
  }
  if (!hasCeiling) {
    return Number(requested);
  }
  if (!hasRequested) {
    return Number(ceiling);
  }
  return Math.min(Number(requested), Number(ceiling));
}

/**
 * Sibling worktree path for a nested child.
 *
 * NEVER nest a worktree inside the parent's worktree directory. A worktree
 * inside a worktree breaks `git worktree remove`, doubles path length on
 * Windows (MAX_PATH + deep engine caches), and makes the artifact excludes
 * and `land` graph incoherent. Place the child next to the parent under the
 * same parent directory (`…/gb/w/<short-id>` on win32).
 *
 * @param {string} parentWorktreePath
 * @param {string} childRunId
 * @returns {string}
 */
export function deriveSiblingWorktreePath(parentWorktreePath, childRunId) {
  if (!parentWorktreePath) {
    throw new Error("deriveSiblingWorktreePath: parentWorktreePath is required");
  }
  if (!childRunId) {
    throw new Error("deriveSiblingWorktreePath: childRunId is required");
  }
  const parentDir = path.dirname(path.resolve(String(parentWorktreePath)));
  return path.join(parentDir, shortWorktreeId(childRunId));
}

/**
 * Sum usage objects without mutating inputs. Missing sides treated as zero.
 */
export function addUsage(a, b) {
  if (!a && !b) {
    return null;
  }
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  const sum = {
    inputTokens: (Number(left.inputTokens) || 0) + (Number(right.inputTokens) || 0),
    outputTokens: (Number(left.outputTokens) || 0) + (Number(right.outputTokens) || 0),
    cachedInputTokens: (Number(left.cachedInputTokens) || 0) + (Number(right.cachedInputTokens) || 0)
  };
  const leftCost = left.costUsd != null && Number.isFinite(Number(left.costUsd)) ? Number(left.costUsd) : null;
  const rightCost =
    right.costUsd != null && Number.isFinite(Number(right.costUsd)) ? Number(right.costUsd) : null;
  if (leftCost != null || rightCost != null) {
    sum.costUsd = (leftCost ?? 0) + (rightCost ?? 0);
  }
  const leftTurns = left.numTurns != null && Number.isFinite(Number(left.numTurns)) ? Number(left.numTurns) : null;
  const rightTurns =
    right.numTurns != null && Number.isFinite(Number(right.numTurns)) ? Number(right.numTurns) : null;
  if (leftTurns != null || rightTurns != null) {
    sum.numTurns = (leftTurns ?? 0) + (rightTurns ?? 0);
  }
  const resolved = right.resolvedModel ?? left.resolvedModel;
  if (resolved) {
    sum.resolvedModel = resolved;
  }
  return sum;
}

/**
 * Parent usage totals: `own` is this run's agent turns only; `includingNested`
 * folds children's usage on top. Do not double-count — children's usage is
 * not already inside `own`.
 *
 * @param {object|null} ownUsage
 * @param {Array<{ usage?: object|null }>} children
 */
export function aggregateUsageOwnVsNested(ownUsage, children = []) {
  const own = ownUsage && typeof ownUsage === "object" ? { ...ownUsage } : null;
  let nested = null;
  for (const child of Array.isArray(children) ? children : []) {
    if (child?.usage && typeof child.usage === "object") {
      nested = addUsage(nested, child.usage);
    }
  }
  const includingNested = addUsage(own, nested);
  return { own, nested, includingNested };
}

/**
 * Sum costUsd the parent has already committed:
 * - own usage so far
 * - each terminal (or usage-bearing) child's actual cost
 * - each live child's *reserved* grant (so concurrent fan-out cannot each take
 *   the full remaining cap)
 *
 * Used as the "spend so far" input to inheritBudget for the next child.
 */
export function parentSpentCostUsd(parentJob = {}) {
  let spent = 0;
  const own = parentJob?.usage;
  if (own?.costUsd != null && Number.isFinite(Number(own.costUsd))) {
    spent += Number(own.costUsd);
  }
  for (const child of Array.isArray(parentJob?.children) ? parentJob.children : []) {
    const usageCost =
      child?.usage?.costUsd != null && Number.isFinite(Number(child.usage.costUsd))
        ? Number(child.usage.costUsd)
        : null;
    const reserved =
      child?.reservedCostUsd != null && Number.isFinite(Number(child.reservedCostUsd))
        ? Number(child.reservedCostUsd)
        : null;
    const status = child?.status;
    const terminal = status ? isTerminalJobStatus(status) : false;
    if (usageCost != null && (terminal || usageCost > 0)) {
      // Actual spend replaces the reservation once known.
      spent += usageCost;
    } else if (!terminal && reserved != null) {
      spent += reserved;
    } else if (usageCost != null) {
      spent += usageCost;
    }
  }
  return spent;
}

/**
 * Compact child summary stored on the parent record.
 * Structured fan-in: id, status, verified, changed files, cost, and the
 * child's own report when available — not a flattened string.
 */
export function buildChildSummary(job = {}) {
  const runId = job.id ?? job.runId ?? null;
  const worktree = job.worktree ?? null;
  const usage = job.usage ?? job.result?.usage ?? null;
  const finalReport =
    job.finalReport ??
    job.result?.finalReport ??
    job.result?.rawOutput ??
    null;
  const changedFiles = job.changedFiles ?? job.result?.changedFiles ?? null;
  return {
    runId,
    status: job.status ?? "unknown",
    verified: job.verified ?? job.result?.verified ?? null,
    changedFileCount:
      job.changedFileCount ??
      changedFiles?.total ??
      worktree?.changedFileCount ??
      null,
    changedFiles,
    usage,
    cost: usage?.costUsd ?? job.cost ?? null,
    reservedCostUsd:
      job.reservedCostUsd != null && Number.isFinite(Number(job.reservedCostUsd))
        ? Number(job.reservedCostUsd)
        : null,
    worktree: typeof worktree === "string" ? worktree : (worktree?.path ?? null),
    branch:
      job.branch ??
      (typeof worktree === "object" && worktree ? worktree.branch : null) ??
      null,
    finalReport: typeof finalReport === "string" ? finalReport : null,
    landedInto: job.landedInto ?? worktree?.landedInto ?? null
  };
}

/**
 * Upsert a child entry into the parent's children array (by runId).
 */
export function upsertChildEntry(children, entry) {
  const list = Array.isArray(children) ? [...children] : [];
  const runId = entry?.runId ?? entry?.id;
  if (!runId) {
    return list;
  }
  const index = list.findIndex((c) => (c.runId ?? c.id) === runId);
  const summary = buildChildSummary({ ...entry, id: runId, runId });
  const normalized = {
    runId,
    status: summary.status,
    verified: summary.verified,
    changedFileCount: summary.changedFileCount,
    changedFiles: summary.changedFiles,
    usage: summary.usage,
    cost: summary.cost,
    reservedCostUsd: summary.reservedCostUsd,
    worktree: summary.worktree,
    branch: summary.branch,
    finalReport: summary.finalReport,
    landedInto: summary.landedInto
  };
  if (index === -1) {
    list.push(normalized);
  } else {
    // Preserve reservedCostUsd when a later update omits it (terminal patch
    // with usage should still keep the grant for audit; spend math uses usage).
    list[index] = {
      ...list[index],
      ...normalized,
      reservedCostUsd:
        normalized.reservedCostUsd != null
          ? normalized.reservedCostUsd
          : list[index].reservedCostUsd ?? null
    };
  }
  return list;
}

/**
 * Classify parent terminal status when children did not all succeed.
 * A parent whose own agent work succeeded still must not claim plain
 * `completed` if a child failed, cancelled, or was abandoned.
 *
 * @param {string} ownStatus
 * @param {Array<{ status?: string }>} children
 * @returns {string}
 */
export function applyChildrenToCompletionStatus(ownStatus, children = []) {
  const list = Array.isArray(children) ? children : [];
  if (list.length === 0) {
    return ownStatus;
  }
  const nonTerminal = list.filter((c) => c?.status && !isTerminalJobStatus(c.status));
  const failed = list.filter((c) => {
    const s = c?.status;
    return (
      s === "failed" ||
      s === "timed-out" ||
      s === "isolation-breached" ||
      s === "cancelled" ||
      s === "completed-truncated"
    );
  });
  const successFamily = new Set([
    "completed",
    "completed-unverified",
    "completed-noop",
    "completed-blind"
  ]);
  if (!successFamily.has(ownStatus) && ownStatus !== "completed-truncated") {
    return ownStatus;
  }
  if (nonTerminal.length > 0 || failed.length > 0) {
    return "completed-with-failed-children";
  }
  return ownStatus;
}

/**
 * Default bound (seconds) the parent waits for live children at end of run.
 */
export const DEFAULT_NEST_DRAIN_SECONDS = 120;
export const NEST_DRAIN_SECONDS_ENV = "GROK_BUILD_NEST_DRAIN_SECONDS";

export function readNestDrainSeconds(env = process.env) {
  const raw = env?.[NEST_DRAIN_SECONDS_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_NEST_DRAIN_SECONDS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_NEST_DRAIN_SECONDS;
  }
  return Math.floor(n);
}

/**
 * Live (non-terminal) child run ids from a parent children[] snapshot.
 */
export function listNonTerminalChildIds(children = []) {
  return listLiveChildren(children)
    .map((c) => c.runId ?? c.id)
    .filter(Boolean);
}

/**
 * Shape of the per-run `.mcp.json` Hyper discovers under
 * `.grok/plugins/grok-build-runtime/` (see xai-grok-agent plugins/discovery.rs:
 * a plugin directory is recognised by skills/, agents/, .mcp.json, or
 * hooks/hooks.json).
 *
 * @param {{
 *   bridgePath: string,
 *   mcpScriptPath: string,
 *   workspaceRoot: string,
 *   parentRunId: string,
 *   nestDepth: number,
 *   parentBaseSha?: string|null,
 *   parentWorktree?: string|null,
 *   parentMaxCostUsd?: number|null,
 *   parentMaxDurationSeconds?: number|null,
 *   parentMaxTurns?: number|null,
 *   parentSpentCostUsd?: number|null,
 *   nodeExecutable?: string
 * }} options
 */
export function buildMcpJsonConfig(options = {}) {
  const mcpScriptPath = path.resolve(String(options.mcpScriptPath ?? ""));
  const bridgePath = path.resolve(String(options.bridgePath ?? ""));
  const workspaceRoot = path.resolve(String(options.workspaceRoot ?? ""));
  const parentRunId = String(options.parentRunId ?? "");
  const nestDepth = Number.isFinite(Number(options.nestDepth)) ? Math.floor(Number(options.nestDepth)) : 0;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;

  if (!mcpScriptPath || !bridgePath || !workspaceRoot || !parentRunId) {
    throw new Error("buildMcpJsonConfig requires mcpScriptPath, bridgePath, workspaceRoot, and parentRunId");
  }

  const env = {
    [BRIDGE_PATH_ENV]: bridgePath,
    [WORKSPACE_ROOT_ENV]: workspaceRoot,
    [PARENT_RUN_ID_ENV]: parentRunId,
    [NEST_DEPTH_ENV]: String(nestDepth)
  };
  if (options.parentBaseSha) {
    env[PARENT_BASE_SHA_ENV] = String(options.parentBaseSha);
  }
  if (options.parentWorktree) {
    env[PARENT_WORKTREE_ENV] = path.resolve(String(options.parentWorktree));
  }
  if (options.parentMaxCostUsd != null && Number.isFinite(Number(options.parentMaxCostUsd))) {
    env[PARENT_MAX_COST_ENV] = String(options.parentMaxCostUsd);
  }
  if (options.parentMaxDurationSeconds != null && Number.isFinite(Number(options.parentMaxDurationSeconds))) {
    env[PARENT_MAX_DURATION_ENV] = String(options.parentMaxDurationSeconds);
  }
  if (options.parentMaxTurns != null && Number.isFinite(Number(options.parentMaxTurns))) {
    env[PARENT_MAX_TURNS_ENV] = String(options.parentMaxTurns);
  }
  if (options.parentSpentCostUsd != null && Number.isFinite(Number(options.parentSpentCostUsd))) {
    env[PARENT_SPENT_COST_ENV] = String(options.parentSpentCostUsd);
  }

  return {
    mcpServers: {
      [NEST_MCP_SERVER_NAME]: {
        command: nodeExecutable,
        args: [mcpScriptPath],
        env
      }
    }
  };
}

/**
 * Write `.mcp.json` into the runtime plugin directory inside the worktree.
 * Creates the directory when WP-P3's injectRuntimePlugin has not run yet;
 * never overwrites agents/ or other skills owned by that package.
 *
 * Also copies the nested-delegation skill (this package's concern) so Hyper
 * discovers when-to-delegate guidance next to the MCP tools. WP-P3's pack
 * list does not include it; we own this one skill file + `.mcp.json` only.
 *
 * @returns {{ written: boolean, path: string|null, notes: string[] }}
 */
export function writeRuntimeMcpJson(worktreePath, options = {}) {
  const notes = [];
  if (!worktreePath) {
    return { written: false, path: null, notes: ["Nested MCP: no worktree"] };
  }
  if (!nestedDelegationEnabled(options.env ?? process.env)) {
    return {
      written: false,
      path: null,
      notes: [`Nested MCP: disabled (${NESTED_DELEGATION_ENV}=0)`]
    };
  }

  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const copyFileSync = options.copyFileSync ?? fs.copyFileSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;

  // Same relative layout as provision.RUNTIME_PLUGIN_RELATIVE. Duplicated as a
  // string join so nest.mjs does not import provision (provision already
  // documents that nested-delegation owns .mcp.json, not the other way around).
  const targetDir = path.join(path.resolve(String(worktreePath)), ".grok", "plugins", "grok-build-runtime");
  const targetPath = path.join(targetDir, ".mcp.json");

  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
      notes.push("Nested MCP: created runtime plugin directory (WP-P3 inject had not run yet)");
    }
    const config = buildMcpJsonConfig(options);
    writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    notes.push(`Nested MCP: offered delegate_* tools via ${path.relative(worktreePath, targetPath) || targetPath}`);

    // Skill: only the nested-delegation pack — not the ecosystem packs.
    const skillName = "nested-delegation";
    const skillDstDir = path.join(targetDir, "skills", skillName);
    mkdirSync(skillDstDir, { recursive: true });
    const skillDst = path.join(skillDstDir, "SKILL.md");
    if (options.skillSourcePath && existsSync(options.skillSourcePath)) {
      copyFileSync(options.skillSourcePath, skillDst);
    } else if (options.pluginRoot) {
      const skillSrc = path.join(
        path.resolve(String(options.pluginRoot)),
        "runtime-plugin",
        "skills",
        skillName,
        "SKILL.md"
      );
      if (existsSync(skillSrc)) {
        copyFileSync(skillSrc, skillDst);
      }
    } else {
      // Last resort: resolve relative to this module
      // (…/scripts/lib/nest.mjs → …/runtime-plugin/skills/…).
      const fallback = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "runtime-plugin",
        "skills",
        skillName,
        "SKILL.md"
      );
      if (existsSync(fallback)) {
        copyFileSync(fallback, skillDst);
      }
    }
    void readFileSync;
    return { written: true, path: targetPath, notes };
  } catch (error) {
    notes.push(
      `Nested MCP: failed to write .mcp.json (${error instanceof Error ? error.message : String(error)})`
    );
    return { written: false, path: null, notes };
  }
}

/**
 * Resolve the shipped MCP server script next to the plugin root.
 */
export function resolveMcpScriptPath(pluginRoot) {
  return path.join(path.resolve(String(pluginRoot)), "mcp", "grok-build-mcp.mjs");
}

/**
 * Resolve the bridge script path inside the plugin.
 */
export function resolveBridgeScriptPath(pluginRoot) {
  return path.join(path.resolve(String(pluginRoot)), "scripts", "grok-bridge.mjs");
}

/**
 * One-line header fragment reporting whether nested delegation was offered
 * and how much depth budget remains for children of this run.
 */
export function formatNestedDelegationHeaderLine({
  offered,
  nestDepth = 0,
  maxNestDepth = DEFAULT_MAX_NEST_DEPTH,
  maxConcurrency = DEFAULT_MAX_NEST_CONCURRENCY
} = {}) {
  if (!offered) {
    return `Nested delegation: off (${NESTED_DELEGATION_ENV}=0)`;
  }
  const remaining = remainingNestDepth(nestDepth, maxNestDepth);
  return (
    `Nested delegation: on (depth ${nestDepth}/${maxNestDepth}, ` +
    `${remaining} child level${remaining === 1 ? "" : "s"} remaining, ` +
    `max ${maxConcurrency} live children)`
  );
}

/**
 * Successful terminal statuses that may be landed into the parent. Matches
 * the bridge's AWAITING_LAND_STATUSES spirit but is intentionally stricter:
 * only a verified-or-at-least-completed child is landable; failed/cancelled
 * never auto-merge.
 */
export function childIsLandable(status) {
  return (
    status === "completed" ||
    status === "completed-unverified" ||
    status === "completed-truncated" ||
    status === "completed-noop" ||
    status === "completed-blind"
  );
}

