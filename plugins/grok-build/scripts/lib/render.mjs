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
  if (job.parentRunId) {
    parts.push(`parent ${job.parentRunId}`);
  }
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

/**
 * Compact token count for dense usage lines (151.0k, 1.7M).
 * Small values stay plain so unit tests and short runs stay readable.
 */
function formatCompactTokenCount(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) {
    return "0";
  }
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 10_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return formatTokenCount(n);
}

/**
 * @param {object|null|undefined} usage
 * @param {{ model?: string|null, resolvedModel?: string|null, compact?: boolean }} [options]
 */
export function formatUsageLine(usage, options = {}) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const formatCount = options.compact ? formatCompactTokenCount : formatTokenCount;
  const cached = Number(usage.cachedInputTokens ?? 0);
  const inputPart = cached > 0
    ? `${formatCount(usage.inputTokens)} in (${formatCount(cached)} cached)`
    : `${formatCount(usage.inputTokens)} in`;

  // Compact form leads with inference-call count when present (BRIDGE-5): the
  // field that made Luna look cheap on the rate card and expensive per asset.
  const parts = [];
  if (options.compact && Number.isFinite(Number(usage.modelCalls)) && Number(usage.modelCalls) >= 0) {
    const calls = Number(usage.modelCalls);
    parts.push(`${calls} ${calls === 1 ? "call" : "calls"}`);
  }
  if (options.compact) {
    if (Number.isFinite(Number(usage.numTurns)) && Number(usage.numTurns) > 0) {
      const turns = Number(usage.numTurns);
      parts.push(`${turns} ${turns === 1 ? "turn" : "turns"}`);
    }
    if (usage.costUsd != null && Number.isFinite(Number(usage.costUsd))) {
      parts.push(`$${Number(usage.costUsd).toFixed(2)}`);
    }
    const requested = options.model ?? usage.model ?? null;
    const served = options.resolvedModel ?? usage.resolvedModel ?? null;
    if (requested || served) {
      if (requested && served && String(requested) !== String(served)) {
        parts.push(`model ${requested} -> ${served}`);
      } else {
        parts.push(`model ${served || requested}`);
      }
    }
    // Keep the token detail as a trailing clause when compact already has a head.
    if (parts.length > 0) {
      parts.push(`${inputPart} / ${formatCount(usage.outputTokens)} out`);
      return parts.join(" · ");
    }
  }

  parts.push(`Tokens: ${inputPart} / ${formatCount(usage.outputTokens)} out`);
  if (Number.isFinite(Number(usage.modelCalls)) && Number(usage.modelCalls) >= 0) {
    const calls = Number(usage.modelCalls);
    parts.push(`${calls} ${calls === 1 ? "call" : "calls"}`);
  }
  if (Number.isFinite(Number(usage.numTurns)) && Number(usage.numTurns) > 0) {
    const turns = Number(usage.numTurns);
    parts.push(`${turns} ${turns === 1 ? "turn" : "turns"}`);
  }
  if (usage.costUsd != null && Number.isFinite(Number(usage.costUsd))) {
    parts.push(`$${Number(usage.costUsd).toFixed(4)}`);
  }
  const requested = options.model ?? usage.model ?? null;
  const served = options.resolvedModel ?? usage.resolvedModel ?? null;
  if (requested || served) {
    if (requested && served && String(requested) !== String(served)) {
      parts.push(`model ${requested} -> ${served}`);
    } else {
      parts.push(`model ${served || requested}`);
    }
  }
  return parts.join(" · ");
}

/**
 * Group finished runs by resolvedModel for "which model was cheaper" without
 * joining unified.jsonl. Only meaningful when usage fields are populated.
 *
 * @param {Array<object>} runs
 * @returns {{ byResolvedModel: Record<string, object>, runCount: number }}
 */
export function buildSessionTotalsByModel(runs) {
  const byResolvedModel = {};
  let runCount = 0;
  for (const job of Array.isArray(runs) ? runs : []) {
    if (!job || typeof job !== "object") {
      continue;
    }
    runCount += 1;
    const key =
      (job.resolvedModel && String(job.resolvedModel).trim()) ||
      (job.model && String(job.model).trim()) ||
      "unknown";
    if (!byResolvedModel[key]) {
      byResolvedModel[key] = {
        resolvedModel: key,
        runs: 0,
        costUsd: 0,
        modelCalls: 0,
        totalTokens: 0,
        changedFileCount: 0,
        durationMs: 0,
        durationSamples: 0
      };
    }
    const bucket = byResolvedModel[key];
    bucket.runs += 1;
    const usage = job.usage && typeof job.usage === "object" ? job.usage : null;
    if (usage?.costUsd != null && Number.isFinite(Number(usage.costUsd))) {
      bucket.costUsd += Number(usage.costUsd);
    }
    if (usage?.modelCalls != null && Number.isFinite(Number(usage.modelCalls))) {
      bucket.modelCalls += Number(usage.modelCalls);
    }
    if (usage?.totalTokens != null && Number.isFinite(Number(usage.totalTokens))) {
      bucket.totalTokens += Number(usage.totalTokens);
    }
    const files = job.changedFileCount;
    if (files != null && Number.isFinite(Number(files))) {
      bucket.changedFileCount += Number(files);
    }
    // duration may be a string like "1m 2s" from the status projector; prefer ms.
    const ms = job.durationMs ?? job.elapsedMs ?? null;
    if (ms != null && Number.isFinite(Number(ms))) {
      bucket.durationMs += Number(ms);
      bucket.durationSamples += 1;
    }
  }
  return { byResolvedModel, runCount };
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

/** Alias for session-total callers; same implementation as formatUsageTotals. */
export function summarizeSessionUsage(jobs) {
  return formatUsageTotals(jobs);
}

function pushJobDetails(lines, job, options = {}) {
  const indent = options.indent ?? "";
  lines.push(`${indent}- ${formatJobLine(job)}`);
  if (job.parentRunId) {
    lines.push(`${indent}  Parent: ${job.parentRunId}`);
  }
  if (job.summary) {
    lines.push(`${indent}  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`${indent}  Phase: ${job.phase}`);
  }
  if (job.abandoned) {
    lines.push(`${indent}  Abandoned: tracked processes are gone. Reclaim with \`/grok-build:prune --apply\`.`);
  }
  if (job.lastEventAge && (job.status === "queued" || job.status === "running")) {
    lines.push(`${indent}  Last activity: ${job.lastEventAge}`);
  }
  if (job.lastHeartbeatAge && (job.status === "queued" || job.status === "running")) {
    lines.push(`${indent}  Last heartbeat: ${job.lastHeartbeatAge}`);
  }
  const usageLine = formatUsageLine(job.usage);
  if (usageLine) {
    lines.push(`${indent}  ${usageLine}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`${indent}  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`${indent}  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`${indent}  Grok session ID: ${job.threadId}`);
  }
  const resumeCommand = formatGrokResumeCommand(job);
  if (resumeCommand) {
    lines.push(`${indent}  Resume in Grok: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`${indent}  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`${indent}  Stop: /grok-build:stop ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`${indent}  Show: /grok-build:show ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    if (job.worktree?.path) {
      // An isolated run never touched the working tree at all, so
      // /grok-build:review here would review the wrong thing entirely - it
      // would find nothing, since the actual changes sit unlanded in the
      // worktree. Point at land instead, which is what actually shows them.
      lines.push(`${indent}  Review and land: /grok-build:land ${job.id}`);
    } else {
      lines.push(`${indent}  Review changes: /grok-build:review --wait`);
      lines.push(`${indent}  Stricter pass: /grok-build:critique --wait`);
    }
  }
  if (Array.isArray(job.children) && job.children.length > 0 && options.showChildren !== false) {
    lines.push(`${indent}  Nested children:`);
    for (const child of job.children) {
      const childId = child.runId ?? child.id ?? "?";
      const childStatus = child.status ?? "unknown";
      lines.push(`${indent}    - ${childId} ${childStatus}`);
    }
  }
  if (job.progressPreview?.length) {
    lines.push(`${indent}  Progress:`);
    for (const line of job.progressPreview) {
      lines.push(`${indent}    ${line}`);
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
    `- session runtime: ${report.sessionRuntime.label}`
  ];
  if (report.isolation) {
    const iso = report.isolation;
    lines.push(
      iso.programmatic
        ? `- isolation: programmatic (${iso.source ?? "unknown"}) — write runs force a worktree` +
          (iso.allowNoIsolate ? " (GROK_BUILD_ALLOW_NO_ISOLATE=1 set)" : "")
        : "- isolation: interactive — write runs isolate by default; --no-isolate allowed"
    );
  }
  lines.push("");

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

  // Blender version the verify actually ran against — answers "works on my
  // machine" without requiring the user to open --json.
  if (typeof meta.blenderVersion === "string" && meta.blenderVersion.trim()) {
    lines.push(meta.blenderVersion.trim());
  }

  const runtimePacks = meta.runtimePlugin?.packs ?? meta.verifyRuntimePlugin?.packs;
  if (Array.isArray(runtimePacks) && runtimePacks.length > 0) {
    lines.push(`Runtime plugin: injected [${runtimePacks.join(", ")}]`);
  }
}

/**
 * What the isolated worktree was seeded with, and what it was not.
 *
 * The shared-cache warning (when the user opted into a linked `.godot`) and the
 * private-cache line (the isolated default) both live in `notes`, as do UID
 * integrity failures and Blender sandbox decisions. A failed link is otherwise
 * silent and shows up only as a run that is inexplicably slow.
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
 * Render one side of the dual changed-file accounting (worktree vs main tree).
 * BRIDGE-3: never conflate the two numbers into one label.
 *
 * @param {string[]} lines
 * @param {string} label
 * @param {{entries?: string[], total?: number, truncated?: boolean, emptyReason?: string|null}|null|undefined} side
 */
function pushOneChangedSide(lines, label, side) {
  if (!side || typeof side !== "object") {
    return;
  }
  const entries = Array.isArray(side.entries) ? side.entries : [];
  const total = Number.isFinite(Number(side.total)) ? Number(side.total) : entries.length;
  if (entries.length === 0 && total === 0) {
    // Distinguish "wrote nothing" from "only excluded caches" — the reporter
    // saw the artifact wording on runs that had written many real files into
    // the other tree, and on runs that truly touched nothing.
    const reason =
      side.emptyReason === "excluded-artifacts"
        ? "run produced only excluded build artifacts"
        : side.emptyReason === "nothing-written"
          ? "nothing was written"
          : side.emptyReason === "working-tree-clean"
            ? "the agent wrote nothing outside excluded build artifacts"
            : "nothing was written";
    lines.push(`${label}: none (${reason}).`);
    return;
  }
  lines.push(`${label}: ${total}`);
  for (const entry of entries.slice(0, CHANGED_FILES_RENDER_LIMIT)) {
    lines.push(`  ${String(entry).replace(/\t/g, " ")}`);
  }
  const remaining = total - Math.min(entries.length, CHANGED_FILES_RENDER_LIMIT);
  if (remaining > 0) {
    lines.push(`  ... ${remaining} more`);
  }
}

/**
 * What the run actually changed on disk.
 *
 * Dual-tree accounting (BRIDGE-3): isolated runs report worktree and main-tree
 * sides separately when both moved. A single conflated number was how main-
 * checkout writes showed as "none".
 */
function pushChangedFileLines(lines, changed) {
  if (!changed || typeof changed !== "object") {
    return;
  }

  // Preferred dual shape from executeTaskRun.
  if (changed.worktree || changed.mainTree) {
    pushOneChangedSide(lines, "Changed files (worktree)", changed.worktree);
    pushOneChangedSide(lines, "Changed files (main tree)", changed.mainTree);
  } else {
    // Legacy single-manifest shape (non-isolated write, or older stored jobs).
    const entries = Array.isArray(changed.entries) ? changed.entries : [];
    const total = Number.isFinite(Number(changed.total)) ? Number(changed.total) : entries.length;
    const label =
      changed.source === "working-tree"
        ? "Changed files (main tree)"
        : changed.source === "commit"
          ? "Changed files (worktree)"
          : "Changed files";
    pushOneChangedSide(lines, label, {
      entries,
      total,
      emptyReason:
        changed.emptyReason ??
        (changed.source === "working-tree" ? "working-tree-clean" : "nothing-written")
    });
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
 * Report unaccounted debris the run left behind (BRIDGE-12).
 * Never delete and never stage — only make the files visible.
 */
function pushDebrisLines(lines, debris) {
  if (!debris || typeof debris !== "object") {
    return;
  }
  const entries = Array.isArray(debris.entries) ? debris.entries : Array.isArray(debris) ? debris : [];
  const total = Number.isFinite(Number(debris.total)) ? Number(debris.total) : entries.length;
  if (total === 0 || entries.length === 0) {
    return;
  }
  const names = entries.map((entry) => {
    const text = String(entry);
    const tab = text.indexOf("\t");
    const pathPart = tab >= 0 ? text.slice(tab + 1).trim() : text.trim();
    return pathPart.replace(/\s+\(.*\)$/, "");
  });
  const shown = names.slice(0, CHANGED_FILES_RENDER_LIMIT);
  lines.push(
    `Debris: ${total} file${total === 1 ? "" : "s"} the run left behind and did not commit (${shown.join(", ")}${
      names.length > shown.length ? `, … +${names.length - shown.length} more` : ""
    }).`
  );
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

/**
 * Statuses where "Verified: yes" would be a lie even if the verify loop passed:
 * nothing was proven because the run did no work, saw nothing, or stopped early.
 */
const VERIFIED_NA_STATUSES = new Set([
  "completed-noop",
  "completed-blind",
  "completed-truncated",
  "isolation-breached"
]);

function verifiedNaLine(status, stopReason) {
  if (status === "completed-noop") {
    return "Verified: n/a - the run changed no files, so verification proves nothing.";
  }
  if (status === "completed-blind") {
    return "Verified: n/a - the agent completed no successful tool calls; treat this run as blind.";
  }
  if (status === "completed-truncated") {
    const reason = stopReason && String(stopReason).trim() ? String(stopReason).trim() : "early stop";
    return `Verified: n/a - the run stopped early (${reason}).`;
  }
  if (status === "isolation-breached") {
    return "Verified: n/a - isolation was breached; work landed in the main checkout, not the worktree.";
  }
  return null;
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

  // Prefer the explicit own/nested split when the run had children — a single
  // summed line would look like the parent spent the children's budget alone.
  if (meta.usageBreakdown?.own || meta.usageBreakdown?.includingNested) {
    const ownLine = formatUsageLine(meta.usageBreakdown.own ?? meta.usage, {
      model: meta.model,
      resolvedModel: meta.resolvedModel ?? meta.usage?.resolvedModel,
      compact: true
    });
    if (ownLine) {
      lines.push(`Usage (own): ${ownLine.replace(/^Tokens:\s*/, "")}`);
    }
    if (meta.usageBreakdown.nested) {
      const nestedLine = formatUsageLine(meta.usageBreakdown.nested, { compact: true });
      if (nestedLine) {
        lines.push(`Usage (nested children): ${nestedLine.replace(/^Tokens:\s*/, "")}`);
      }
    }
    const totalLine = formatUsageLine(meta.usageBreakdown.includingNested ?? meta.usage, {
      model: meta.model,
      resolvedModel: meta.resolvedModel,
      compact: true
    });
    if (totalLine) {
      lines.push(`Usage (including nested): ${totalLine.replace(/^Tokens:\s*/, "")}`);
    }
  } else {
    const usageLine = formatUsageLine(meta.usage, {
      model: meta.model,
      resolvedModel: meta.resolvedModel ?? meta.usage?.resolvedModel,
      compact: true
    });
    if (usageLine) {
      lines.push(usageLine);
    }
  }

  const naLine = VERIFIED_NA_STATUSES.has(meta.status)
    ? verifiedNaLine(meta.status, meta.stopReason)
    : null;
  if (naLine) {
    // Never render Verified: yes for noop/blind/truncated - even when the
    // verify loop happened to return true, it proved nothing about the work.
    lines.push(naLine);
  } else if (meta.verified === true) {
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

    // Godot and Blender both exit 0 on a broken project, so a `Verified: no`
    // on an exit-0 command is otherwise inexplicable without reading
    // `--json`'s matchedLines field - which nobody does mid-run. This is the
    // only place a reader who never opens the JSON learns which line made the
    // bridge disbelieve a clean exit code.
    for (const entry of meta.verifyMatchedLines ?? []) {
      for (const line of entry.matchedLines ?? []) {
        lines.push(`  Output matched a known failure marker in \`${entry.command}\`: ${line}`);
      }
    }
  }

  pushProvisionLines(lines, meta.provision);

  // Before the worktree line on purpose: what changed is the answer to "what
  // did this run do", and the path is only where to go and look at it.
  pushChangedFileLines(lines, meta.changedFiles);
  pushDebrisLines(lines, meta.debris);

  // Signal, not a new terminal status (BRIDGE-1 bonus). completed-noop /
  // completed-blind already carry the verdict; this is corroborating evidence.
  if (meta.implausiblyShort) {
    const seconds = Number.isFinite(Number(meta.durationSeconds))
      ? Math.round(Number(meta.durationSeconds))
      : Number.isFinite(Number(meta.durationMs))
        ? Math.round(Number(meta.durationMs) / 1000)
        : null;
    const tools =
      meta.toolCallCount == null ? "unknown" : String(meta.toolCallCount);
    const secLabel = seconds != null ? `${seconds}s` : "under the floor";
    lines.push(
      `Implausibly short: this write run finished in ${secLabel} having changed nothing and made ${tools} tool calls — treat the result as suspect.`
    );
  }

  if (meta.autoContinued) {
    lines.push(
      "Auto-continued once: the first turn ended on a user-facing question with no tool calls; re-issued with a non-interactive nudge."
    );
  }

  if (meta.isolationBreached || meta.status === "isolation-breached") {
    // Deliberately "changed during this run" rather than "the agent wrote":
    // the check is a before/after diff of the main checkout's dirty set, and it
    // cannot tell the agent's write from a human editing the same checkout
    // while the run was in flight. Observed exactly that during development -
    // three files edited by hand mid-run were reported as leaked.
    //
    // The status stays terminal and stays loud anyway. A false positive costs
    // one look at the list below; a missed breach costs the thing this whole
    // mechanism exists to prevent. Do not soften it into a warning.
    lines.push(
      "Isolation BREACHED: the main checkout changed while this run was in flight, so work may be in the wrong tree and is not verified."
    );
    const leaked = meta.isolationLeak?.entries ?? meta.isolationLeak?.paths ?? null;
    if (Array.isArray(leaked) && leaked.length > 0) {
      lines.push("Changed in the main checkout during this run:");
      for (const entry of leaked) {
        lines.push(`  ${entry}`);
      }
      if (meta.isolationLeak?.truncated) {
        lines.push(
          `  … truncated (${meta.isolationLeak.total} total)`
        );
      }
    }
    lines.push(
      "  If you edited the main checkout yourself while this run was going, that is what this is - re-check with `git status` and land the worktree normally."
    );
  }

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

  pushNestedRunsSection(lines, meta);

  pushRunDiagnosticLines(lines, meta, rawOutput);

  return lines;
}

/**
 * Parent report section listing each nested child. A child failure is never
 * summarised as success here — status is the stored terminal value, verbatim.
 */
function pushNestedRunsSection(lines, meta = {}) {
  const children = Array.isArray(meta.children) ? meta.children : [];
  if (children.length === 0) {
    return;
  }

  lines.push("", "## Nested runs");
  for (const child of children) {
    const id = child.runId ?? child.id ?? "unknown";
    const status = child.status ?? "unknown";
    const files =
      child.changedFileCount == null ? "unknown files" : `${child.changedFileCount} file(s)`;
    const usageLine = formatUsageLine(child.usage, { compact: true });
    const branch = child.branch ? ` branch ${child.branch}` : "";
    const parts = [`- ${id}: ${status}, ${files}`];
    if (usageLine) {
      parts.push(usageLine);
    }
    if (branch) {
      parts.push(branch.trim());
    }
    lines.push(parts.join(" · "));
    lines.push(`  Land into this worktree: node scripts/grok-bridge.mjs land ${id} --into-run ${meta.jobId ?? "<parent>"}`);
    // Make non-success impossible to skim past as "fine".
    if (status !== "completed" && status !== "completed-noop") {
      lines.push(`  Note: child did not fully succeed (status=${status}); do not treat as landed work.`);
    }
  }
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

export function renderJobStatusReport(job, options = {}) {
  const lines = ["# Grok Build Run Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  // `runs --wait` gave up on a run that is still queued/running - not the same
  // thing as the run itself timing out, and worth saying explicitly: without
  // this the report reads identically to a run that was merely polled once.
  if (options.waitTimedOut) {
    const seconds = Math.max(0, Math.round(Number(options.timeoutMs ?? 0) / 1000));
    lines.push(
      "",
      `Wait timed out after ${seconds}s — the run is still \`${job.status}\`. Re-run with --timeout-ms <ms> to wait longer.`
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Structured trailer every `show` path appends so a machine (or a hurried human)
 * can read status/isolation/usage without scraping prose.
 */
export function buildBridgeResultBlock(job = {}, storedJob = null) {
  const record = { ...job, ...(storedJob ?? {}) };
  const status = record.status ?? "unknown";
  const stopReason = record.stopReason ?? record.result?.stopReason ?? null;
  const verified = record.verified ?? record.result?.verified ?? null;

  let verifiedLabel = "n/a";
  if (VERIFIED_NA_STATUSES.has(status)) {
    verifiedLabel = "n/a";
  } else if (verified === true) {
    verifiedLabel = "yes";
  } else if (verified === false) {
    verifiedLabel = "no";
  }

  const worktree = record.worktree ?? null;
  let isolation = "INACTIVE (workspaceRoot)";
  if (worktree?.path) {
    isolation = `ACTIVE (worktree ${worktree.path}, branch ${worktree.branch ?? "unknown"})`;
  }
  if (worktree?.breached || record.isolationBreached) {
    isolation = "breached";
  }

  const changedFileCount =
    record.changedFileCount ??
    record.result?.changedFiles?.total ??
    worktree?.changedFileCount ??
    null;
  const changedFilesLabel =
    changedFileCount == null
      ? "unknown"
      : changedFileCount === 0
        ? "none"
        : String(changedFileCount);

  const toolCallCount = record.toolCallCount ?? record.result?.toolCallCount ?? null;
  const toolCallsLabel = toolCallCount == null ? "unknown" : String(toolCallCount);

  const usage = record.usage ?? record.result?.usage ?? null;
  const usageLine =
    formatUsageLine(usage, {
      model: record.model,
      resolvedModel: record.resolvedModel ?? usage?.resolvedModel,
      compact: true
    }) ?? "none";

  const verify = record.verify ?? record.result?.verify ?? null;
  let verifyLabel = "none";
  if (verify && typeof verify === "object") {
    const planSource = verify.plan?.source ?? verify.source ?? null;
    const note = verify.note ?? null;
    const verdict =
      verified === true ? "passed" : verified === false ? "failed" : VERIFIED_NA_STATUSES.has(status) ? "n/a" : "n/a";
    verifyLabel = [planSource ? `source=${planSource}` : null, note, `verdict=${verdict}`]
      .filter(Boolean)
      .join("; ");
  } else if (VERIFIED_NA_STATUSES.has(status)) {
    verifyLabel = verifiedNaLine(status, stopReason) ?? "n/a";
  }

  const logFile = record.logFile ?? null;
  const lines = [
    "===BRIDGE-RESULT===",
    `status: ${status}`,
    `stopReason: ${stopReason && String(stopReason).trim() ? stopReason : "none"}`,
    `verified: ${verifiedLabel}`,
    `isolation: ${isolation}`,
    `changed files: ${changedFilesLabel}`,
    `tool calls: ${toolCallsLabel}`,
    `usage: ${usageLine}`,
    `verify: ${verifyLabel}`,
    `log: ${logFile ?? "none"}`
  ];
  if (worktree?.path) {
    lines.push(`land: /grok-build:land ${record.id ?? job.id}`);
  }
  lines.push("===END-BRIDGE-RESULT===");
  return lines.join("\n");
}

function appendBridgeResult(output, job, storedJob) {
  const base = output.endsWith("\n") ? output : `${output}\n`;
  return `${base}\n${buildBridgeResultBlock(job, storedJob)}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `grok -r ${threadId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    const withSession = threadId
      ? `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`
      : output;
    return appendBridgeResult(withSession, job, storedJob);
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
    const withSession = threadId
      ? `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`
      : output;
    return appendBridgeResult(withSession, job, storedJob);
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    const withSession = threadId
      ? `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`
      : output;
    return appendBridgeResult(withSession, job, storedJob);
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

  const storedUsageLine = formatUsageLine(storedJob?.usage ?? job.usage, {
    model: storedJob?.model ?? job.model,
    resolvedModel: storedJob?.resolvedModel ?? job.resolvedModel
  });
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

  return appendBridgeResult(`${lines.join("\n").trimEnd()}\n`, job, storedJob);
}

export function renderCancelReport(job) {
  const delivered = job.cancelKill?.delivered ?? job.killDelivered;
  const survivors = job.cancelKill?.survivors ?? job.killSurvivors ?? [];
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
  if (job.killMethod ?? job.cancelKill?.method) {
    lines.push(`- Kill method: ${job.killMethod ?? job.cancelKill?.method}`);
  }
  if (Array.isArray(job.killTargets) && job.killTargets.length > 0) {
    lines.push(`- Kill targets: ${job.killTargets.join(", ")}`);
  }
  if (delivered === false) {
    lines.push("- Kill delivered: false (process may still be running).");
    if (Array.isArray(survivors) && survivors.length > 0) {
      lines.push(
        `- Survivors: PID ${survivors.join(", ")}. End them from Task Manager or \`Stop-Process -Id <pid> -Force\`, then re-run stop/prune.`
      );
    } else {
      lines.push(
        "- Re-check with `/grok-build:runs`. If a process is still alive, end it from Task Manager and re-run stop."
      );
    }
  }
  lines.push("- Check `/grok-build:runs` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
