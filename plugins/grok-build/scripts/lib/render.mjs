function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

/**
 * Prefer the liveness-derived status. enrichJob sets displayStatus to "abandoned"
 * when a run's tracked processes are gone but its stored status still says running.
 * Reporting the stored value would repeat the exact failure this was built to fix.
 */
function jobDisplayStatus(job) {
  return job.displayStatus || job.status || "unknown";
}

function formatJobLine(job) {
  const parts = [job.id, jobDisplayStatus(job)];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatGrokResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `grok -r ${job.threadId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active runs:");
  lines.push("| Run | Kind | Status | Phase | Elapsed | Grok Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/grok-build:runs ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/grok-build:stop ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(jobDisplayStatus(job))} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function formatTokenCount(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

export function formatUsageLine(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const cached = Number(usage.cachedInputTokens ?? 0);
  const inputPart = cached > 0
    ? `${formatTokenCount(usage.inputTokens)} in (${formatTokenCount(cached)} cached)`
    : `${formatTokenCount(usage.inputTokens)} in`;

  const parts = [`Tokens: ${inputPart} / ${formatTokenCount(usage.outputTokens)} out`];
  if (Number.isFinite(Number(usage.numTurns)) && Number(usage.numTurns) > 0) {
    const turns = Number(usage.numTurns);
    parts.push(`${turns} ${turns === 1 ? "turn" : "turns"}`);
  }
  if (usage.costUsd != null && Number.isFinite(Number(usage.costUsd))) {
    parts.push(`$${Number(usage.costUsd).toFixed(4)}`);
  }
  return parts.join(" · ");
}

/**
 * Sum token and cost usage across jobs that carry a usage object.
 * @param {Array<{ usage?: object|null }>} jobs
 * @returns {string|null}
 */
export function formatUsageTotals(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return null;
  }

  let runs = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  for (const job of jobs) {
    const usage = job?.usage;
    if (!usage || typeof usage !== "object") {
      continue;
    }
    runs += 1;
    inputTokens += Number(usage.inputTokens ?? 0) || 0;
    cachedInputTokens += Number(usage.cachedInputTokens ?? 0) || 0;
    outputTokens += Number(usage.outputTokens ?? 0) || 0;
    if (usage.costUsd != null && Number.isFinite(Number(usage.costUsd))) {
      costUsd += Number(usage.costUsd);
    }
  }

  if (runs === 0) {
    return null;
  }

  const inputPart =
    cachedInputTokens > 0
      ? `${formatTokenCount(inputTokens)} in (${formatTokenCount(cachedInputTokens)} cached)`
      : `${formatTokenCount(inputTokens)} in`;

  return `Session totals: ${runs} runs - ${inputPart} / ${formatTokenCount(outputTokens)} out - $${costUsd.toFixed(4)}`;
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (job.abandoned) {
    lines.push("  Abandoned: tracked processes are gone. Reclaim with `/grok-build:prune --apply`.");
  }
  if (job.lastEventAge && (job.status === "queued" || job.status === "running")) {
    lines.push(`  Last activity: ${job.lastEventAge}`);
  }
  if (job.lastHeartbeatAge && (job.status === "queued" || job.status === "running")) {
    lines.push(`  Last heartbeat: ${job.lastHeartbeatAge}`);
  }
  const usageLine = formatUsageLine(job.usage);
  if (usageLine) {
    lines.push(`  ${usageLine}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Grok session ID: ${job.threadId}`);
  }
  const resumeCommand = formatGrokResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Grok: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Stop: /grok-build:stop ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Show: /grok-build:show ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    if (job.worktree?.path) {
      // An isolated run never touched the working tree at all, so
      // /grok-build:review here would review the wrong thing entirely - it
      // would find nothing, since the actual changes sit unlanded in the
      // worktree. Point at land instead, which is what actually shows them.
      lines.push(`  Review and land: /grok-build:land ${job.id}`);
    } else {
      lines.push("  Review changes: /grok-build:review --wait");
      lines.push("  Stricter pass: /grok-build:critique --wait");
    }
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Grok Build Check",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- grok: ${report.grok.detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    ""
  ];

  if (report.actionsTaken?.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps?.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Grok Build ${meta.reviewLabel}`,
      "",
      "Grok did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Grok Build ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Grok returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Grok Build ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const lines = [
    `# Grok Build ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Grok review completed without any stdout output.");
  } else {
    lines.push("Grok review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Build the trailing status block for a delegate run: verification result,
 * worktree location, and any budget stop. Previously this information was
 * computed by executeTaskRun (verified, worktree, verify.note, budgetStopped)
 * but never appended to the rendered output at all - the terminal text a
 * user actually sees after a delegate run said nothing about whether
 * verification passed, whether a worktree was created, or whether a budget
 * stop cut the run short. This is the third instance of that exact failure
 * shape in this plugin's history (streaming was inert because outputFormat
 * was forced to plain; abandoned runs displayed as running because the
 * renderer read job.status instead of the computed liveness) - a value
 * computed correctly and then never actually reaching the user.
 */
/**
 * Labels for a resolved verify plan's origin. Mirrors describeVerifySource in
 * project-config.mjs rather than importing it: this module has no imports at
 * all today, and pulling in project-config would drag state.mjs (and fs, os,
 * crypto) into every consumer of the renderer for four strings.
 */
const VERIFY_SOURCE_LABELS = {
  cli: "--verify",
  config: ".grok-build.json",
  "ecosystem-default": "ecosystem default"
};

/**
 * Echo the verify plan the run actually used, and where it came from.
 *
 * Not cosmetic. As of 0.4.0 a run can verify commands the user never typed -
 * resolved from .grok-build.json or from a detected Godot/Blender project - so
 * the only thing standing between "helpful default" and "it ran something I
 * did not ask for" is saying, in the run's own output, exactly what ran and
 * which source chose it. It is also how a user learns that a config's verify
 * list was withheld for want of trust, rather than silently ignored.
 */
function pushVerifyPlanLines(lines, meta) {
  const plan = meta.verifyPlan;
  if (!plan) {
    return;
  }

  const commands = Array.isArray(meta.verifyCommands) ? meta.verifyCommands : [];
  if (commands.length > 0) {
    const label = VERIFY_SOURCE_LABELS[plan.source] ?? plan.source ?? "unknown";
    const scope = plan.ecosystem && plan.source === "ecosystem-default" ? `${label}, ${plan.ecosystem}` : label;
    lines.push(`Verify plan (${scope}):`);
    for (const command of commands) {
      lines.push(`  ${command}`);
    }
  } else if (plan.disabled) {
    lines.push("Verify plan: disabled for this run (--no-verify).");
  }

  const withheld = Array.isArray(plan.configWithheld) ? plan.configWithheld : [];
  if (withheld.length > 0) {
    lines.push(
      `Project config: ${withheld.join(", ")} in .grok-build.json was NOT used - this file is not trusted yet.`
    );
    if (meta.verifyTrustCommand) {
      lines.push(`  Review it, then trust it with: ${meta.verifyTrustCommand}`);
    }
  }
}

/**
 * What the isolated worktree was seeded with, and what it was not.
 *
 * Two things have to reach the user here. The mandatory one is the shared-cache
 * warning carried in `notes`: `.godot` is junctioned straight from the working
 * copy, so a Godot editor left open on the same project is writing into the
 * cache a headless verify run is reading. The other is a failed link, which is
 * silent otherwise and shows up only as a run that is inexplicably slow.
 */
function pushProvisionLines(lines, provision) {
  if (!provision || typeof provision !== "object") {
    return;
  }

  for (const note of Array.isArray(provision.notes) ? provision.notes : []) {
    const text = String(note ?? "").trim();
    if (text) {
      lines.push(`Provisioning: ${text}`);
    }
  }

  for (const entry of Array.isArray(provision.failed) ? provision.failed : []) {
    const name = String(entry?.name ?? "").trim() || "unknown";
    const reason = String(entry?.reason ?? "").trim();
    // "destination already exists" is fs's wording for a case that is not an
    // error at all: the directory is TRACKED IN GIT, so `git worktree add`
    // already checked it out. Note that it is stale-but-present, not absent -
    // saying "the first verify will run a cold import" would be wrong.
    lines.push(
      reason === "destination already exists"
        ? `Provisioning skipped: ${name} (already present in the worktree - it is tracked in git).`
        : `Provisioning skipped: ${name}${reason ? ` (${reason})` : ""}.`
    );
  }
}

/**
 * How many manifest entries reach the terminal. The payload keeps up to
 * CHANGED_FILES_MAX_ENTRIES (worktree.mjs); this is the reading limit, and the
 * remainder is reported as a count so the number is never silently wrong.
 */
const CHANGED_FILES_RENDER_LIMIT = 40;

/**
 * What the run actually changed on disk.
 *
 * For a Godot or Blender run this is the whole deliverable, and the status
 * block used to report only Verified/Worktree/Budget - a user could not tell a
 * run that rebuilt a scene from one that produced nothing but an import cache.
 * The empty case is therefore rendered EXPLICITLY rather than omitted: "none"
 * with the reason is an answer, a missing block is the silent-result complaint
 * all over again in exactly the import-cache case.
 */
function pushChangedFileLines(lines, changed) {
  if (!changed || typeof changed !== "object") {
    return;
  }
  const entries = Array.isArray(changed.entries) ? changed.entries : [];
  const total = Number.isFinite(Number(changed.total)) ? Number(changed.total) : entries.length;
  const label = changed.source === "working-tree" ? "Working tree changes" : "Changed files";

  if (entries.length === 0) {
    lines.push(
      changed.source === "working-tree"
        ? `${label}: none (the agent wrote nothing outside excluded build artifacts).`
        : `${label}: none (run produced only excluded build artifacts).`
    );
  } else {
    lines.push(`${label} (${total}):`);
    for (const entry of entries.slice(0, CHANGED_FILES_RENDER_LIMIT)) {
      // git's own `<status>\t<path>` shape; the tab renders as an alignment gap
      // nowhere in particular, so make it a plain space.
      lines.push(`  ${String(entry).replace(/\t/g, " ")}`);
    }
    const remaining = total - Math.min(entries.length, CHANGED_FILES_RENDER_LIMIT);
    if (remaining > 0) {
      lines.push(`  ... ${remaining} more`);
    }
  }

  // Only the non-isolated path can have these: paths that were already dirty
  // when the run started are excluded from the manifest, because a bare
  // post-run `git status` cannot tell the agent's edits from the user's.
  const preexisting = Number(changed.preexistingDirty);
  if (Number.isFinite(preexisting) && preexisting > 0) {
    lines.push(
      `  (${preexisting} path${preexisting === 1 ? " was" : "s were"} already modified before the run and ${preexisting === 1 ? "is" : "are"} not listed)`
    );
  }
}

/**
 * Diagnostics about the run's own machinery, as opposed to its result.
 *
 * `unknownEventTypes` was computed by the stream parser and had ZERO consumers
 * repo-wide: a CLI release that renames an event type degraded the transcript
 * silently, and the only symptom was output that looked thin. It is noise on a
 * healthy run though, so it is only surfaced when it might actually explain
 * something - the stream did not parse, or parsed and still produced no answer.
 *
 * The log path is unconditional. tracked-jobs appends the complete rendered
 * result to that file, which makes it the durable artifact of the run, and a
 * path the user never saw is a path they cannot read.
 */
function pushRunDiagnosticLines(lines, meta, rawOutput) {
  const unknown = Array.isArray(meta.unknownEventTypes) ? meta.unknownEventTypes.filter(Boolean) : [];
  if (unknown.length > 0 && (meta.streamParsed === false || !rawOutput)) {
    lines.push(
      `Stream: ${unknown.length} unrecognized event type${unknown.length === 1 ? "" : "s"} from the grok CLI (${unknown.join(", ")}) - this build may be newer than the bridge.`
    );
  }

  if (meta.logFile) {
    lines.push(`Log: ${meta.logFile}`);
  }
}

export function buildTaskStatusLines(meta = {}, rawOutput = "") {
  const lines = [];

  pushVerifyPlanLines(lines, meta);

  // The baseline probe runs for every verify run now, not just isolated write
  // runs, so on a non-isolated run it is a full extra verify pass. Reporting
  // the cost is the price of that change: an unexplained doubling of wall
  // clock is exactly how a useful safeguard gets switched off.
  const probeMs = Number(meta.baselineProbeMs);
  if (Number.isFinite(probeMs) && probeMs > 0) {
    const commandCount = Number(meta.baselineProbeCommands);
    const scope = Number.isFinite(commandCount) && commandCount > 0
      ? ` across ${commandCount} verify command${commandCount === 1 ? "" : "s"}`
      : "";
    lines.push(
      `Baseline probe: ${(probeMs / 1000).toFixed(1)}s${scope} (measured before the agent ran).`
    );
  }

  if (meta.verified === true) {
    lines.push(`Verified: yes${meta.verifyNote ? ` (${meta.verifyNote})` : ""}`);
  } else if (meta.verified === false) {
    // The note used to be dropped entirely on this branch, so a run that
    // failed verification for an infrastructure reason - a timed-out or
    // unrunnable command - told the user only "verification did not pass",
    // implying their code was at fault. That is the same computed-and-never-
    // delivered failure this whole block exists to fix.
    lines.push(
      meta.verifyNote
        ? `Verified: no - ${meta.verifyNote}`
        : "Verified: no - verification did not pass within the attempt budget."
    );
  }

  pushProvisionLines(lines, meta.provision);

  // Before the worktree line on purpose: what changed is the answer to "what
  // did this run do", and the path is only where to go and look at it.
  pushChangedFileLines(lines, meta.changedFiles);

  if (meta.worktree?.path) {
    lines.push(`Worktree: ${meta.worktree.path} (branch ${meta.worktree.branch ?? "unknown"})`);
    if (meta.worktree.commitError) {
      // The run itself succeeded; only the staging/commit step failed. Say so
      // explicitly and point at the directory, because the branch does NOT
      // contain the work and /grok-build:land would therefore land nothing.
      lines.push(
        `Worktree: could not commit agent changes (${meta.worktree.commitError}) - work is still on disk at ${meta.worktree.path}`
      );
    }
    if (meta.jobId) {
      lines.push(`Review and land with: /grok-build:land ${meta.jobId}`);
    }
  }

  if (meta.budgetStopped) {
    lines.push(`Budget: run stopped early (${meta.budgetStopped}).`);
  }

  pushRunDiagnosticLines(lines, meta, rawOutput);

  return lines;
}

/**
 * How much of a failing run's stderr is shown when there is no answer to show.
 * The interesting part of a CLI's stderr is always the end of it.
 */
const STDERR_TAIL_LINES = 20;

function tailLines(text, limit) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-limit)
    .join("\n");
}

export function renderTaskResult(parsedResult, meta = {}) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  let base = rawOutput
    ? (rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`)
    : `${String(parsedResult?.failureMessage ?? "").trim() || "Grok did not return a final message."}\n`;

  // The text above is raw stdout, not a parsed transcript, so say so - passing
  // machine output off as the model's answer is worse than either alternative.
  if (rawOutput && meta.streamParsed === false) {
    base = `Note: the grok stream produced no recognized assistant messages; showing raw stdout.\n\n${base}`;
  }

  // stderr was dropped entirely whenever the process exited 0, which is exactly
  // the shape a truncated or rate-limited response takes: status 0, no text,
  // and the only explanation on the channel nobody read. Only shown when there
  // is no answer, so a healthy run is not padded with warnings.
  if (!rawOutput) {
    const stderrTail = tailLines(parsedResult?.stderr, STDERR_TAIL_LINES);
    if (stderrTail) {
      base = `${base}\nstderr (last ${STDERR_TAIL_LINES} lines):\n\n\`\`\`text\n${stderrTail}\n\`\`\`\n`;
    }
  }

  const statusLines = buildTaskStatusLines(meta, rawOutput);
  if (statusLines.length === 0) {
    return base;
  }

  return `${base}\n${statusLines.join("\n")}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Grok Build Runs",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent runs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No runs recorded yet.", "");
  }

  const allJobs = [
    ...(report.running ?? []),
    ...(report.latestFinished ? [report.latestFinished] : []),
    ...(report.recent ?? [])
  ];
  const totalsLine = formatUsageTotals(allJobs);
  if (totalsLine) {
    lines.push(totalsLine, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Grok Build Run Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `grok -r ${threadId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`;
  }

  // The delimited report first when the model honoured the contract, because
  // that is the answer the run was asked for. `lastMessage` is deliberately NOT
  // in this chain: preferring a bare trailing line over the stored rawOutput
  // would make /grok-build:show print LESS than it does today. `grok.stdout`
  // stays last so stored *review* jobs, whose payload has no rawOutput at all,
  // render exactly as before.
  const rawOutput =
    (typeof storedJob?.result?.finalReport === "string" && storedJob.result.finalReport) ||
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.grok?.stdout === "string" && storedJob.result.grok.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Grok Build Result"}`,
    "",
    `Run: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Grok session ID: ${threadId}`);
    lines.push(`Resume in Grok: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  const storedUsageLine = formatUsageLine(storedJob?.usage ?? job.usage);
  if (storedUsageLine) {
    lines.push(storedUsageLine);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const delivered = job.cancelKill?.delivered ?? job.killDelivered;
  const lines = [
    "# Grok Build Stop",
    "",
    delivered === false
      ? `Stop requested for ${job.id}, but process kill was not confirmed.`
      : `Stopped ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  if (delivered === false) {
    lines.push("- Kill delivered: false (process may still be running).");
  }
  lines.push("- Check `/grok-build:runs` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
