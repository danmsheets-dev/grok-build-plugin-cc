#!/usr/bin/env node
/**
 * Stdio MCP server that lets a Hyper agent inside an isolated grok-build run
 * delegate a sub-task to another Hyper instance (sibling worktree, tracked
 * run, structured result, land into the parent).
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout — the framing
 * Hyper's stdio transport actually uses (see xai-grok-mcp servers.rs
 * newline-delimited reader). No Content-Length headers, no npm deps.
 *
 * Every tool shells out to the bridge (`nest-run` / `runs` / `wait` / `show` /
 * `land` / `stop`). Run logic never lives here.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_PATH_ENV,
  NEST_DEPTH_ENV,
  PARENT_BASE_SHA_ENV,
  PARENT_MAX_COST_ENV,
  PARENT_MAX_DURATION_ENV,
  PARENT_MAX_TURNS_ENV,
  PARENT_RUN_ID_ENV,
  PARENT_SPENT_COST_ENV,
  PARENT_WORKTREE_ENV,
  WORKSPACE_ROOT_ENV,
  childIsLandable
} from "../scripts/lib/nest.mjs";

const SERVER_INFO = {
  name: "grok-build-delegate",
  version: "0.5.0"
};

const PROTOCOL_VERSION = "2024-11-05";

/** @type {Map<string, object>} */
const TOOLS = new Map();

function defineTool(name, description, inputSchema, handler) {
  TOOLS.set(name, { name, description, inputSchema, handler });
}

function envOrThrow(name) {
  const value = process.env[name];
  if (value == null || String(value).trim() === "") {
    throw new Error(`MCP server missing required env ${name}`);
  }
  return String(value);
}

function resolveBridgePath() {
  if (process.env[BRIDGE_PATH_ENV]) {
    return path.resolve(process.env[BRIDGE_PATH_ENV]);
  }
  // Fallback when launched by hand during tests: sibling of this file.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "grok-bridge.mjs");
}

function resolveWorkspaceRoot() {
  if (process.env[WORKSPACE_ROOT_ENV]) {
    return path.resolve(process.env[WORKSPACE_ROOT_ENV]);
  }
  return process.cwd();
}

/**
 * Shell out to the bridge. stdout is expected to be JSON when --json is
 * passed. stderr is captured for error messages only — never mixed into
 * the MCP stdout channel.
 */
export function runBridge(args, options = {}) {
  const bridgePath = options.bridgePath ?? resolveBridgePath();
  const workspaceRoot = options.workspaceRoot ?? resolveWorkspaceRoot();
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const timeout = options.timeoutMs ?? 0;

  const fullArgs = [bridgePath, ...args];
  if (!fullArgs.includes("--cwd") && !fullArgs.includes("-C")) {
    fullArgs.push("--cwd", workspaceRoot);
  }
  if (!fullArgs.includes("--json")) {
    fullArgs.push("--json");
  }

  const result = spawnSync(nodeExecutable, fullArgs, {
    cwd: workspaceRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: timeout > 0 ? timeout : undefined,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });

  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Leave parsed null; caller may still want raw text.
    }
  }

  return {
    status: result.status,
    signal: result.signal,
    error: result.error ?? null,
    stdout,
    stderr,
    parsed,
    ok: result.status === 0 && !result.error
  };
}

function toolText(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function toolError(message, extra = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message, ...extra }
  };
}

function writePromptFile(prompt, workspaceRoot) {
  const dir = path.join(workspaceRoot, ".grok-build", "nest-prompts");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(filePath, String(prompt ?? ""), "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

defineTool(
  "delegate_run",
  "Start a nested Hyper run in its own sibling worktree. Always backgrounds. " +
    "Returns {runId, worktree, branch, logFile} immediately. Poll with " +
    "delegate_status / delegate_wait / delegate_result; land with delegate_land.",
  {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Task prompt for the child Hyper run." },
      write: {
        type: "boolean",
        description: "Allow the child to edit files (default true). Nested runs are always isolated."
      },
      model: { type: "string" },
      effort: { type: "string", enum: ["low", "medium", "high"] },
      max_turns: { type: "number" },
      max_cost: { type: "number", description: "USD ceiling; cannot exceed parent's remaining budget." },
      max_duration: { type: "number", description: "Seconds ceiling; cannot exceed parent's ceiling." },
      verify: {
        type: "array",
        items: { type: "string" },
        description: "Verify commands for the child (bridge-side)."
      },
      no_verify: { type: "boolean" }
    },
    required: ["prompt"]
  },
  (args) => {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) {
      return toolError("delegate_run requires a non-empty prompt");
    }

    const workspaceRoot = resolveWorkspaceRoot();
    const promptFile = writePromptFile(prompt, workspaceRoot);
    const bridgeArgs = [
      "nest-run",
      "--background",
      "--prompt-file",
      promptFile
    ];

    const write = args.write === false ? false : true;
    if (write) {
      bridgeArgs.push("--write");
    }
    if (args.model) {
      bridgeArgs.push("--model", String(args.model));
    }
    if (args.effort) {
      bridgeArgs.push("--effort", String(args.effort));
    }
    if (args.max_turns != null) {
      bridgeArgs.push("--max-turns", String(args.max_turns));
    }
    if (args.max_cost != null) {
      bridgeArgs.push("--max-cost", String(args.max_cost));
    }
    if (args.max_duration != null) {
      bridgeArgs.push("--max-duration", String(args.max_duration));
    }
    if (args.no_verify) {
      bridgeArgs.push("--no-verify");
    }
    if (Array.isArray(args.verify)) {
      for (const command of args.verify) {
        bridgeArgs.push("--verify", String(command));
      }
    }

    const result = runBridge(bridgeArgs);
    if (!result.ok || !result.parsed) {
      return toolError(
        result.stderr || result.stdout || `nest-run failed (exit ${result.status})`,
        { status: result.status }
      );
    }

    const payload = result.parsed;
    return toolText({
      runId: payload.jobId ?? payload.runId ?? null,
      worktree: payload.worktree?.path ?? payload.worktree ?? null,
      branch: payload.worktree?.branch ?? payload.branch ?? null,
      logFile: payload.logFile ?? null,
      status: payload.status ?? "queued"
    });
  }
);

defineTool(
  "delegate_status",
  "Poll one nested child run. Returns {runId, status, phase, elapsed, alive, usage}.",
  {
    type: "object",
    properties: {
      runId: { type: "string", description: "Child run id from delegate_run." }
    },
    required: ["runId"]
  },
  (args) => {
    const runId = String(args.runId ?? "").trim();
    if (!runId) {
      return toolError("delegate_status requires runId");
    }
    const result = runBridge(["runs", runId]);
    if (!result.parsed) {
      return toolError(result.stderr || result.stdout || `runs ${runId} failed`, {
        status: result.status
      });
    }
    const job = result.parsed.job ?? result.parsed;
    return toolText({
      runId: job.id ?? runId,
      status: job.status ?? job.displayStatus ?? "unknown",
      phase: job.phase ?? null,
      elapsed: job.elapsed ?? job.duration ?? null,
      alive: Boolean(job.alive),
      usage: job.usage ?? null
    });
  }
);

defineTool(
  "delegate_wait",
  "Block until the child is terminal (or timeout), then return the same structure as delegate_result.",
  {
    type: "object",
    properties: {
      runId: { type: "string" },
      timeout: {
        type: "number",
        description: "Seconds to wait (default 3600)."
      }
    },
    required: ["runId"]
  },
  (args) => {
    const runId = String(args.runId ?? "").trim();
    if (!runId) {
      return toolError("delegate_wait requires runId");
    }
    const timeoutSec =
      args.timeout != null && Number.isFinite(Number(args.timeout))
        ? Math.max(1, Math.floor(Number(args.timeout)))
        : 3600;
    const result = runBridge(["wait", runId, "--timeout", String(timeoutSec)], {
      // Bridge wait already blocks; give spawnSync headroom past the user timeout.
      timeoutMs: (timeoutSec + 30) * 1000
    });
    if (!result.parsed) {
      return toolError(result.stderr || result.stdout || `wait ${runId} failed`, {
        status: result.status
      });
    }
    return toolText(shapeDelegateResult(result.parsed, runId));
  }
);

defineTool(
  "delegate_result",
  "Full structured result of a nested child: status, stopReason, verified, " +
    "changedFiles, usage, cost, worktree, branch, final report.",
  {
    type: "object",
    properties: {
      runId: { type: "string" }
    },
    required: ["runId"]
  },
  (args) => {
    const runId = String(args.runId ?? "").trim();
    if (!runId) {
      return toolError("delegate_result requires runId");
    }
    const result = runBridge(["show", runId]);
    if (!result.parsed) {
      return toolError(result.stderr || result.stdout || `show ${runId} failed`, {
        status: result.status
      });
    }
    return toolText(shapeDelegateResult(result.parsed, runId));
  }
);

defineTool(
  "delegate_land",
  "Merge a completed child's branch into the PARENT worktree branch " +
    "(not the main checkout). Refuses when the child is not in a terminal " +
    "successful state. Never auto-lands — this tool is the only path.",
  {
    type: "object",
    properties: {
      runId: { type: "string", description: "Child run id to land." }
    },
    required: ["runId"]
  },
  (args) => {
    const runId = String(args.runId ?? "").trim();
    if (!runId) {
      return toolError("delegate_land requires runId");
    }

    // Pre-check status so the refusal message is about the child state, not a
    // cryptic land error. Land itself still re-checks.
    const show = runBridge(["show", runId]);
    const status = show.parsed?.status ?? show.parsed?.job?.status ?? null;
    if (status && !childIsLandable(status)) {
      return toolError(
        `delegate_land refused: child ${runId} status is "${status}" (need a completed-family terminal status).`,
        { runId, status }
      );
    }

    const parentRunId = process.env[PARENT_RUN_ID_ENV];
    const bridgeArgs = ["land", runId];
    if (parentRunId) {
      bridgeArgs.push("--into-run", parentRunId);
    }

    const result = runBridge(bridgeArgs);
    if (!result.ok) {
      return toolError(
        result.stderr || result.stdout || `land ${runId} failed`,
        { status: result.status, parsed: result.parsed }
      );
    }
    return toolText(result.parsed ?? { runId, action: "apply" });
  }
);

defineTool(
  "delegate_stop",
  "Cancel a nested child run.",
  {
    type: "object",
    properties: {
      runId: { type: "string" }
    },
    required: ["runId"]
  },
  (args) => {
    const runId = String(args.runId ?? "").trim();
    if (!runId) {
      return toolError("delegate_stop requires runId");
    }
    const result = runBridge(["stop", runId]);
    if (!result.parsed && !result.ok) {
      return toolError(result.stderr || result.stdout || `stop ${runId} failed`, {
        status: result.status
      });
    }
    return toolText(result.parsed ?? { runId, status: "cancelled" });
  }
);

/**
 * Normalise show/wait JSON into the contract surface for wait/result.
 */
export function shapeDelegateResult(parsed, runId) {
  const job = parsed?.job ?? parsed ?? {};
  const result = job.result ?? parsed?.result ?? {};
  const worktree = job.worktree ?? result.worktree ?? null;
  const usage = job.usage ?? result.usage ?? null;
  const finalReport =
    result.finalReport ??
    result.rawOutput ??
    (typeof parsed?.rendered === "string" ? parsed.rendered : null);

  return {
    runId: job.id ?? runId,
    status: job.status ?? parsed?.status ?? "unknown",
    stopReason: job.stopReason ?? result.stopReason ?? null,
    verified: job.verified ?? result.verified ?? null,
    changedFiles: result.changedFiles ?? null,
    changedFileCount:
      job.changedFileCount ?? result.changedFileCount ?? worktree?.changedFileCount ?? null,
    usage,
    cost: usage?.costUsd ?? null,
    worktree: worktree?.path ?? null,
    branch: worktree?.branch ?? null,
    finalReport,
    logFile: job.logFile ?? null
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC framing (newline-delimited, matching Hyper's stdio transport)
// ---------------------------------------------------------------------------

export function handleJsonRpcMessage(message) {
  if (!message || typeof message !== "object") {
    return { response: null };
  }

  // Notifications: no response.
  if (message.id === undefined && typeof message.method === "string") {
    if (message.method === "notifications/initialized" || message.method === "initialized") {
      return { response: null };
    }
    return { response: null };
  }

  const id = message.id ?? null;

  if (message.method === "initialize") {
    return {
      response: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        }
      }
    };
  }

  if (message.method === "ping") {
    return { response: { jsonrpc: "2.0", id, result: {} } };
  }

  if (message.method === "tools/list") {
    const tools = [...TOOLS.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
    return { response: { jsonrpc: "2.0", id, result: { tools } } };
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    const tool = TOOLS.get(name);
    if (!tool) {
      return {
        response: {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` }
        }
      };
    }
    try {
      const result = tool.handler(args && typeof args === "object" ? args : {});
      return { response: { jsonrpc: "2.0", id, result } };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return {
        response: {
          jsonrpc: "2.0",
          id,
          result: toolError(text)
        }
      };
    }
  }

  return {
    response: {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${message.method}` }
    }
  };
}

export function parseJsonRpcLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) {
    return null;
  }
  return JSON.parse(trimmed);
}

function writeResponse(message) {
  if (message == null) {
    return;
  }
  // stdout is the MCP channel — never log here. stderr is free for diagnostics.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main() {
  // Fail fast on missing wiring when launched as a real MCP server (not under
  // unit tests that import handleJsonRpcMessage only).
  try {
    envOrThrow(PARENT_RUN_ID_ENV);
    envOrThrow(WORKSPACE_ROOT_ENV);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    // Still answer initialize so the client gets a clean handshake error path
    // rather than a dead pipe; tools will fail with a clear message.
  }

  // Silence accidental console.log from deps (we have none, but belt/braces).
  console.log = (...args) => {
    process.stderr.write(args.map(String).join(" ") + "\n");
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    let message;
    try {
      message = parseJsonRpcLine(line);
    } catch (error) {
      writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${error instanceof Error ? error.message : String(error)}`
        }
      });
      continue;
    }
    if (!message) {
      continue;
    }
    const { response } = handleJsonRpcMessage(message);
    writeResponse(response);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

// Re-export env names used by tests that assert the MCP contract.
export {
  BRIDGE_PATH_ENV,
  NEST_DEPTH_ENV,
  PARENT_BASE_SHA_ENV,
  PARENT_MAX_COST_ENV,
  PARENT_MAX_DURATION_ENV,
  PARENT_MAX_TURNS_ENV,
  PARENT_RUN_ID_ENV,
  PARENT_SPENT_COST_ENV,
  PARENT_WORKTREE_ENV,
  WORKSPACE_ROOT_ENV,
  TOOLS
};

