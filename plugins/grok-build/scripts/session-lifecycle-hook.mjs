#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import {
  claimJobTerminal,
  jobHasLiveWorktree,
  loadState,
  resolveStateFile,
  updateState,
  writeJobFile
} from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveJobTreeKillTargets, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return;
  }

  for (const job of sessionJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (stillRunning) {
      // Cascade through nested children so a session-end stop is
      // platform-symmetric (not only the parent's own PIDs).
      // Snapshot PIDs before any claim nulls them (C21). Claim descendants AND
      // root before kill so a finishing runner cannot win completed (H3/M7).
      const { pids: killTargets, jobs: treeJobs } = resolveJobTreeKillTargets(
        workspaceRoot,
        job
      );
      for (const node of treeJobs) {
        if (!node?.id || node.id === job.id) {
          continue;
        }
        if (node.status !== "queued" && node.status !== "running") {
          continue;
        }
        try {
          claimJobTerminal(workspaceRoot, node.id, "cancelled", {
            errorMessage: "Stopped by session end (parent cascade).",
            phase: "cancelled",
            pid: null,
            agentPid: null,
            bridgePid: null
          });
        } catch {
          // Claim races are fine.
        }
      }
      // Claim root before kill (same order as handleCancel).
      let rootClaimed = false;
      try {
        const rootClaim = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
          errorMessage: "Stopped by session end.",
          phase: "cancelled",
          pid: null,
          agentPid: null,
          bridgePid: null
        });
        rootClaimed = Boolean(rootClaim?.claimed || rootClaim?.status === "cancelled");
      } catch {
        // Claim races are fine.
      }

      const killResults = [];
      const survivors = [];
      for (const pid of killTargets) {
        // terminateProcessTree never throws — a taskkill "could not be
        // terminated" used to blow past the claim and leave the job running
        // in the record forever.
        const outcome = terminateProcessTree(pid);
        killResults.push({ pid, ...outcome });
        if (Array.isArray(outcome.survivors) && outcome.survivors.length > 0) {
          survivors.push(...outcome.survivors);
        }
      }

      const killDelivered =
        killTargets.length === 0 ||
        (killResults.some((entry) => entry.delivered) && survivors.length === 0);

      // Patch kill outcome onto the already-claimed root when possible.
      if (rootClaimed) {
        try {
          claimJobTerminal(workspaceRoot, job.id, "cancelled", {
            errorMessage: killDelivered
              ? "Stopped by session end."
              : "Stopped by session end; process kill was not confirmed.",
            phase: "cancelled",
            killTombstone: killDelivered
              ? null
              : {
                  at: new Date().toISOString(),
                  survivors: [...new Set(survivors)],
                  method: killResults.map((entry) => entry.method).filter(Boolean).join("+") || null,
                  errorText:
                    killResults.map((entry) => entry.errorText).filter(Boolean).join("; ") || null
                }
          });
        } catch {
          // cancelled-wins / races are fine.
        }
      }
    }
  }

  // updateState reads and writes under ONE lock acquisition. The previous code
  // read state, then separately called saveState with that now-possibly-stale
  // snapshot - if another process (a different session, or this session's own
  // background worker) added a job in between, saveState's pruning logic saw
  // that job as "dropped" relative to the stale snapshot and deleted its files
  // from disk. Confirmed directly: a job from an unrelated session, created in
  // that exact window, had its job file deleted by this cleanup.
  //
  // Never drop a job whose worktree still exists on disk. Filtering by
  // sessionId alone deleted the index entry, jobs/<id>.json and log of every
  // completed write run for the ending session — the worktree and branch
  // survived on disk but became permanently undiscoverable to land/prune/runs.
  // Retain those records (re-key sessionId so a future SessionEnd does not
  // re-process them) and let /prune be the single place that reclaims.
  updateState(workspaceRoot, (state) => {
    const nextJobs = [];
    for (const job of state.jobs) {
      if (job.sessionId !== sessionId) {
        nextJobs.push(job);
        continue;
      }
      if (jobHasLiveWorktree(job)) {
        const retained = {
          ...job,
          sessionId: null,
          sessionEnded: true
        };
        nextJobs.push(retained);
        try {
          writeJobFile(workspaceRoot, job.id, retained);
        } catch {
          // Index retention is the critical half; job-file best-effort.
        }
        continue;
      }
      // Safely reclaimable: no live worktree for this session's job.
    }
    state.jobs = nextJobs;
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
