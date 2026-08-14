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
  const binary = String(job.binary ?? job.cliBinary ?? "turbo").trim() || "turbo";
  return `${binary} -r ${job.threadId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active runs:");
  lines.push("| Run | Kind | Status | Phase | Elapsed | Grok Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/turbo-build-plugin:runs ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/turbo-build-plugin:stop ${job.id}`);
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
 * Format cost for display. Never print $0.00 for an unknown/partial cost —
 * Hyper withholds untrustworthy totals and sets costIsPartial / usageIsIncomplete.
 *
 * @param {object} usage
 * @param {{ compact?: boolean }} [options]
 * @returns {string|null}
 */
export function formatCostLabel(usage, options = {}) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const incomplete = Boolean(usage.usageIsIncomplete);
  const partial = Boolean(usage.costIsPartial);
  const hasCost = usage.costUsd != null && Number.isFinite(Number(usage.costUsd));
  if (incomplete || partial) {
    if (hasCost && partial && !incomplete) {
      const digits = options.compact ? 2 : 4;
      return `$${Number(usage.costUsd).toFixed(digits)} (partial)`;
    }
    return "cost: unavailable (partial)";
  }
  if (!hasCost) {
    // Tokens present but cost withheld without flags — still not free.
    if (
      Number(usage.inputTokens) > 0 ||
      Number(usage.outputTokens) > 0 ||
      Number(usage.totalTokens) > 0 ||
      Number(usage.modelCalls) > 0
    ) {
      return "cost: unavailable";
    }
    return null;
  }
  // Genuine $0.00 is rare but allowed only when a finite number was reported.
  const digits = options.compact ? 2 : 4;
  return `$${Number(usage.costUsd).toFixed(digits)}`;
}

/**
 * Human label for toolCallCount. Null means the CLI stream carries no tool
 * events — not "unknown" as a soft synonym for zero.
 *
 * @param {number|null|undefined} toolCallCount
 * @param {{ toolVisibility?: string|null, toolCallCountFloor?: number|null }} [options]
 */
export function formatToolCallsLabel(toolCallCount, options = {}) {
  if (toolCallCount != null && Number.isFinite(Number(toolCallCount))) {
    return String(Number(toolCallCount));
  }
  const visibility = options.toolVisibility ?? "unavailable";
  if (visibility === "unavailable" || visibility == null) {
    const floor = options.toolCallCountFloor;
    if (floor != null && Number.isFinite(Number(floor)) && Number(floor) > 0) {
      return `not reported by this CLI (≥${Number(floor)} from files changed)`;
    }
    return "not reported by this CLI";
  }
  return "unknown";
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

  const costLabel = formatCostLabel(usage, { compact: Boolean(options.compact) });

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
    if (costLabel) {
      parts.push(costLabel);
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
  if (costLabel) {
    parts.push(costLabel);
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
  let sawCost = false;
  let costPartial = false;

  for (const job of jobs) {
    const usage = job?.usage;
    if (!usage || typeof usage !== "object") {
      continue;
    }
    runs += 1;
    inputTokens += Number(usage.inputTokens ?? 0) || 0;
    cachedInputTokens += Number(usage.cachedInputTokens ?? 0) || 0;
    outputTokens += Number(usage.outputTokens ?? 0) || 0;
    if (usage.costIsPartial || usage.usageIsIncomplete) {
      costPartial = true;
    }
    if (usage.costUsd != null && Number.isFinite(Number(usage.costUsd))) {
      costUsd += Number(usage.costUsd);
      sawCost = true;
    }
  }

  if (runs === 0) {
    return null;
  }

  const inputPart =
    cachedInputTokens > 0
      ? `${formatTokenCount(inputTokens)} in (${formatTokenCount(cachedInputTokens)} cached)`
      : `${formatTokenCount(inputTokens)} in`;

  let costPart;
  if (costPartial && !sawCost) {
    costPart = "cost: unavailable (partial)";
  } else if (costPartial && sawCost) {
    costPart = `$${costUsd.toFixed(4)} (partial)`;
  } else if (sawCost) {
    costPart = `$${costUsd.toFixed(4)}`;
  } else {
    costPart = "cost: unavailable";
  }

  return `Session totals: ${runs} runs - ${inputPart} / ${formatTokenCount(outputTokens)} out - ${costPart}`;
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
    lines.push(`${indent}  Abandoned: tracked processes are gone. Reclaim with \`/turbo-build-plugin:prune --apply\`.`);
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
    lines.push(`${indent}  Stop: /turbo-build-plugin:stop ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`${indent}  Show: /turbo-build-plugin:show ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    if (job.worktree?.path) {
      // An isolated run never touched the working tree at all, so
      // /turbo-build-plugin:review here would review the wrong thing entirely - it
      // would find nothing, since the actual changes sit unlanded in the
      // worktree. Point at land instead, which is what actually shows them.
      lines.push(`${indent}  Review and land: /turbo-build-plugin:land ${job.id}`);
    } else {
      lines.push(`${indent}  Review changes: /turbo-build-plugin:review --wait`);
      lines.push(`${indent}  Stricter pass: /turbo-build-plugin:critique --wait`);
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

function verifiedNaLine(status, stopReason, meta = {}) {
  if (status === "completed-noop") {
    return "Verified: n/a - the run changed no files, so verification proves nothing.";
  }
  if (status === "completed-blind") {
    // Genuine zero only (decideCompletionStatus never maps null → blind).
    // Phrase as a stream observation, not an unsupported claim about the agent
    // when the CLI simply never put tool events on the wire.
    if (meta.toolVisibility === "unavailable" || meta.toolCallCount == null) {
      return "Verified: n/a - tool calls were not reported by this CLI; treat tool activity as unobserved.";
    }
    return "Verified: n/a - the stream reported zero tool calls; treat this run as blind.";
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

/**
 * Push stream-channel diagnostics: errors, confine violations, denials,
 * compaction, unknown event types. These must reach the human trailer and
 * the run manifest — Hyper emits them for harness honesty.
 */
function pushStreamChannelLines(lines, meta = {}) {
  const streamErrors = Array.isArray(meta.streamErrors)
    ? meta.streamErrors
    : Array.isArray(meta.errors)
      ? meta.errors
      : [];
  for (const err of streamErrors) {
    const message = typeof err === "string" ? err : err?.message;
    if (message) {
      lines.push(`Stream error: ${message}`);
    }
  }

  const violations = Array.isArray(meta.confineViolations) ? meta.confineViolations : [];
  if (violations.length > 0) {
    // Blocked attempt ≠ breach. The CLI refused the write; isolation held unless
    // the main-checkout dirty-set (or shared-dir fingerprint) independently says
    // otherwise. Do not fold this signal into isolationBreached.
    const n = violations.length;
    lines.push(
      `${n} confine attempt${n === 1 ? "" : "s"} blocked by the CLI (isolation held).`
    );
    for (const v of violations.slice(0, 20)) {
      const tool = v.tool ? `tool=${v.tool}` : "tool=?";
      const path = v.resolvedPath || v.path || "?";
      const root = v.root ? ` root=${v.root}` : "";
      lines.push(`  ${tool} path=${path}${root}`);
    }
    if (violations.length > 20) {
      lines.push(`  … truncated (${violations.length} total)`);
    }
  }

  const denials = Array.isArray(meta.toolDenials) ? meta.toolDenials : [];
  if (denials.length > 0) {
    lines.push(`Tool denials: ${denials.length}`);
    for (const d of denials.slice(0, 10)) {
      const tool = d.tool ?? "?";
      const reason = d.reason ? ` (${d.reason})` : "";
      lines.push(`  ${tool}${reason}`);
    }
  }

  const questions = Array.isArray(meta.questionsSuppressed) ? meta.questionsSuppressed : [];
  if (questions.length > 0) {
    lines.push(
      `Question suppressed: ${questions.length} headless ask_user_question refusal${questions.length === 1 ? "" : "s"}.`
    );
  }

  const warnings = Array.isArray(meta.streamWarnings)
    ? meta.streamWarnings
    : Array.isArray(meta.warnings)
      ? meta.warnings
      : [];
  for (const warning of warnings.slice(0, 10)) {
    const code = warning?.code ? `${warning.code}: ` : "";
    const message = warning?.message ?? (typeof warning === "string" ? warning : null);
    if (message) {
      lines.push(`Stream warning: ${code}${message}`);
    }
  }

  const subagentsRollup = meta.subagentsRollup;
  if (subagentsRollup && typeof subagentsRollup === "object") {
    const spawned = Number(subagentsRollup.spawned ?? 0);
    if (spawned > 0) {
      lines.push(
        `Subagents: ${spawned} spawned (${subagentsRollup.completed ?? 0} completed, ${subagentsRollup.failed ?? 0} failed, ${subagentsRollup.cancelled ?? 0} cancelled)`
      );
    }
  }

  if (meta.maxTurnsReached) {
    lines.push("Max turns reached: the CLI stopped the run at the turn budget.");
  }

  const compaction = Array.isArray(meta.compaction) ? meta.compaction : [];
  if (compaction.length > 0) {
    const phases = compaction.map((c) => c.phase || c.type).filter(Boolean);
    lines.push(`Context compaction: ${phases.join(", ") || compaction.length + " event(s)"}`);
  }
}

/**
 * Count files the run changed for the honesty header (R7-4).
 * Prefer dual-tree total when present; fall back to flat manifests / scalars.
 *
 * @param {object} meta
 * @returns {number|null}
 */
export function countChangedFilesForHonesty(meta = {}) {
  if (meta.changedFileCount != null && Number.isFinite(Number(meta.changedFileCount))) {
    return Number(meta.changedFileCount);
  }
  const changed = meta.changedFiles;
  if (!changed || typeof changed !== "object") {
    return null;
  }
  if (changed.worktree || changed.mainTree) {
    const wt = Number(changed.worktree?.total ?? changed.worktree?.entries?.length ?? 0) || 0;
    const main = Number(changed.mainTree?.total ?? changed.mainTree?.entries?.length ?? 0) || 0;
    return wt + main;
  }
  if (Number.isFinite(Number(changed.total))) {
    return Number(changed.total);
  }
  if (Array.isArray(changed.entries)) {
    return changed.entries.length;
  }
  return null;
}

/**
 * Verify ratio for the honesty header: `verify 2/3 (baseline 2/3)`.
 * A boolean "Verified: yes" reads stronger than it means; the ratio is the truth.
 *
 * @param {object} meta
 * @returns {string|null}
 */
export function formatVerifyRatioLine(meta = {}) {
  if (meta.verifyNote && /skipped \(read-only run\)/i.test(String(meta.verifyNote))) {
    return "verify n/a (read-only run)";
  }
  if (VERIFIED_NA_STATUSES.has(meta.status)) {
    return null;
  }

  const results = Array.isArray(meta.verifyResults)
    ? meta.verifyResults
    : Array.isArray(meta.verify?.results)
      ? meta.verify.results
      : null;
  const baselines = Array.isArray(meta.baselines)
    ? meta.baselines
    : Array.isArray(meta.verify?.baselines)
      ? meta.verify.baselines
      : null;

  if (!results || results.length === 0) {
    // No per-command breakdown — fall back only when we know verification ran.
    if (meta.verified === true) {
      return meta.verifyNote ? `verify passed (${meta.verifyNote})` : "verify passed";
    }
    if (meta.verified === false) {
      return meta.verifyNote ? `verify failed (${meta.verifyNote})` : "verify failed";
    }
    return null;
  }

  const total = results.length;
  const passed = results.filter((entry) => entry && entry.ok === true).length;
  let line = `verify ${passed}/${total}`;
  if (baselines && baselines.length > 0) {
    const baselineTotal = baselines.length;
    const baselinePassed = baselines.filter((entry) => entry && entry.ok === true).length;
    line += ` (baseline ${baselinePassed}/${baselineTotal})`;
  }
  return line;
}

/**
 * R7-4 — report honesty at the TOP of the status trailer.
 * Operating rule: judge every run by the filesystem, never by its status line.
 * Put the filesystem count and the verify ratio first so the status line is
 * worth trusting.
 *
 * @param {string[]} lines
 * @param {object} meta
 */
function pushHonestyHeader(lines, meta = {}) {
  const n = countChangedFilesForHonesty(meta);
  if (n != null) {
    if (meta.write === true && n === 0) {
      lines.push(`files changed: 0  ⚠ --write run changed nothing`);
    } else {
      lines.push(`files changed: ${n}`);
    }
  }

  const verifyRatio = formatVerifyRatioLine(meta);
  if (verifyRatio) {
    lines.push(verifyRatio);
  }
}

export function buildTaskStatusLines(meta = {}, rawOutput = "") {
  const lines = [];

  // R7-4: filesystem + verify ratio first — before plan notes and usage.
  pushHonestyHeader(lines, meta);

  pushVerifyPlanLines(lines, meta);
  pushStreamChannelLines(lines, meta);

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
    ? verifiedNaLine(meta.status, meta.stopReason, meta)
    : null;
  // R7-4: when the honesty header already has `verify X/Y`, do not also print
  // a boolean "Verified: yes" that oversells a baseline-passing zero-change run.
  const hasVerifyResults =
    (Array.isArray(meta.verifyResults) && meta.verifyResults.length > 0) ||
    (Array.isArray(meta.verify?.results) && meta.verify.results.length > 0);
  if (naLine) {
    // Never render Verified: yes for noop/blind/truncated - even when the
    // verify loop happened to return true, it proved nothing about the work.
    lines.push(naLine);
  } else if (meta.verifyNote && /skipped \(read-only run\)/i.test(String(meta.verifyNote))) {
    // Already covered by honesty header "verify n/a (read-only run)" when present.
    if (!lines.some((line) => /^verify n\/a \(read-only run\)/.test(line))) {
      lines.push("Verified: n/a - skipped (read-only run)");
    }
  } else if (hasVerifyResults) {
    // Ratio already at top; only add failure detail / markers below.
    if (meta.verified === false) {
      if (meta.verifyNote) {
        lines.push(`Verify note: ${meta.verifyNote}`);
      }
      for (const entry of meta.verifyMatchedLines ?? []) {
        for (const line of entry.matchedLines ?? []) {
          lines.push(`  Output matched a known failure marker in \`${entry.command}\`: ${line}`);
        }
      }
    } else if (meta.verifyNote) {
      lines.push(`Verify note: ${meta.verifyNote}`);
    }
  } else if (meta.verified === true) {
    // No per-command breakdown — keep a soft line (honesty header may already
    // say "verify passed").
    if (!lines.some((line) => /^verify passed/.test(line))) {
      lines.push(`Verified: yes${meta.verifyNote ? ` (${meta.verifyNote})` : ""}`);
    }
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
    const tools = formatToolCallsLabel(meta.toolCallCount, {
      toolVisibility: meta.toolVisibility,
      toolCallCountFloor: meta.toolCallCountFloor
    });
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
    //
    // WP-B7-FIX: CLI-blocked confine attempts do NOT set isolationBreached.
    // Only a real main-checkout dirty-set (or shared-dir) change does. Blocked
    // attempts are surfaced separately above as "isolation held".
    //
    // R7-1: name BOTH file lists (worktree vs main). A split state is harder
    // to recover from than no isolation; land refuses a breached run.
    lines.push(
      "Isolation BREACHED: the main checkout changed while this run was in flight, so work may be in the wrong tree and is not verified."
    );
    const wtFiles =
      meta.worktree?.worktreeFiles ??
      meta.changedFiles?.worktree?.entries ??
      meta.worktree?.changedFiles ??
      null;
    if (Array.isArray(wtFiles) && wtFiles.length > 0) {
      lines.push("In the worktree:");
      for (const entry of wtFiles.slice(0, 40)) {
        lines.push(`  ${entry}`);
      }
      if (wtFiles.length > 40) {
        lines.push(`  … ${wtFiles.length - 40} more`);
      }
    } else {
      lines.push("In the worktree: (none recorded — work may have landed only in main)");
    }
    const leaked =
      meta.worktree?.mainTreeFiles ??
      meta.changedFiles?.mainTree?.entries ??
      meta.isolationLeak?.entries ??
      meta.isolationLeak?.paths ??
      null;
    if (Array.isArray(leaked) && leaked.length > 0) {
      lines.push("Leaked to main checkout:");
      for (const entry of leaked.slice(0, 40)) {
        lines.push(`  ${entry}`);
      }
      if (meta.isolationLeak?.truncated || leaked.length > 40) {
        lines.push(
          `  … truncated (${meta.isolationLeak?.total ?? leaked.length} total)`
        );
      }
    } else {
      lines.push("Leaked to main checkout: (none listed)");
    }
    lines.push(
      "Land refuses this run. Recovery: inspect both trees; copy wanted main-tree files into the worktree or re-apply the full change by hand; then land --discard. " +
        "If you edited the main checkout yourself while this run was going, re-check with `git status` and keep those edits."
    );
  }

  if (meta.worktree?.path) {
    lines.push(`Worktree: ${meta.worktree.path} (branch ${meta.worktree.branch ?? "unknown"})`);
    if (meta.worktree.commitError) {
      // The run itself succeeded; only the staging/commit step failed. Say so
      // explicitly and point at the directory, because the branch does NOT
      // contain the work and /turbo-build-plugin:land would therefore land nothing.
      lines.push(
        `Worktree: could not commit agent changes (${meta.worktree.commitError}) - work is still on disk at ${meta.worktree.path}`
      );
    }
    if (meta.jobId) {
      lines.push(`Review and land with: /turbo-build-plugin:land ${meta.jobId}`);
    }
  }

  if (meta.budgetStopped === "max-cost-unenforceable") {
    lines.push(
      "Budget: --max-cost was set but cost was incomplete/partial, so the cap could not be enforced (unknown spend is not treated as $0)."
    );
  } else if (meta.budgetStopped) {
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
    const verified =
      child.verified === true ? "verified" : child.verified === false ? "unverified" : null;
    const cost =
      child.cost != null && Number.isFinite(Number(child.cost))
        ? `cost=$${Number(child.cost).toFixed(4)}`
        : null;
    const parts = [`- ${id}: ${status}, ${files}`];
    if (verified) {
      parts.push(verified);
    }
    if (cost) {
      parts.push(cost);
    }
    if (usageLine) {
      parts.push(usageLine);
    }
    if (branch) {
      parts.push(branch.trim());
    }
    lines.push(parts.join(" · "));
    lines.push(`  Land into this worktree: node scripts/grok-bridge.mjs land ${id} --into-run ${meta.jobId ?? "<parent>"}`);
    if (typeof child.finalReport === "string" && child.finalReport.trim()) {
      const snippet = child.finalReport.trim().split(/\r?\n/).slice(0, 3).join(" ").slice(0, 200);
      lines.push(`  Child report: ${snippet}${child.finalReport.trim().length > 200 ? "…" : ""}`);
    }
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
  const isoRecord =
    record.isolation && typeof record.isolation === "object" ? record.isolation : null;
  let isolation = "INACTIVE (workspaceRoot)";
  const isoPath = worktree?.path ?? isoRecord?.worktree ?? null;
  if (isoPath || isoRecord?.active) {
    isolation = `ACTIVE (worktree ${isoPath ?? "removed"}, branch ${worktree?.branch ?? isoRecord?.branch ?? "unknown"})`;
  }
  if (worktree?.breached || record.isolationBreached || isoRecord?.breached) {
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
  const toolVisibility =
    record.toolVisibility ?? record.result?.toolVisibility ?? null;
  const toolCallCountFloor =
    record.toolCallCountFloor ?? record.result?.toolCallCountFloor ?? null;
  const toolCallsLabel = formatToolCallsLabel(toolCallCount, {
    toolVisibility,
    toolCallCountFloor
  });

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
    if (verify.skippedReadOnly || /skipped \(read-only run\)/i.test(String(verify.note ?? ""))) {
      verifyLabel = "skipped (read-only run)";
    } else {
      const planSource = verify.plan?.source ?? verify.source ?? null;
      const note = verify.note ?? null;
      const verdict =
        verified === true ? "passed" : verified === false ? "failed" : VERIFIED_NA_STATUSES.has(status) ? "n/a" : "n/a";
      verifyLabel = [planSource ? `source=${planSource}` : null, note, `verdict=${verdict}`]
        .filter(Boolean)
        .join("; ");
    }
  } else if (VERIFIED_NA_STATUSES.has(status)) {
    verifyLabel = verifiedNaLine(status, stopReason, record) ?? "n/a";
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
    lines.push(`land: /turbo-build-plugin:land ${record.id ?? job.id}`);
  }
  lines.push("===END-BRIDGE-RESULT===");
  return lines.join("\n");
}

function appendBridgeResult(output, job, storedJob) {
  const base = output.endsWith("\n") ? output : `${output}\n`;
  return `${base}\n${buildBridgeResultBlock(job, storedJob)}\n`;
}

/**
 * Strip a leading copy of `answer` from a full rendered result so show can
 * compose report + status trailer without duplicating the answer block.
 * Falls back to returning the rendered text as-is when no clean strip is possible.
 */
export function extractStatusTrailerFromRendered(rendered, answer) {
  const full = String(rendered ?? "");
  if (!full.trim()) {
    return "";
  }
  const answerText = String(answer ?? "").trim();
  if (!answerText) {
    // No separate answer — whole rendered body is the trailer (minus bridge block if any).
    return stripBridgeResultBlock(full).trimEnd();
  }
  const stripped = stripBridgeResultBlock(full);
  // Prefer exact prefix strip (renderTaskResult: base + "\n" + statusLines).
  const normalizedAnswer = answerText.endsWith("\n") ? answerText : `${answerText}\n`;
  if (stripped.startsWith(normalizedAnswer)) {
    return stripped.slice(normalizedAnswer.length).replace(/^\n+/, "").trimEnd();
  }
  // Final-report case: answer may be only the report body while rendered has it
  // embedded mid-string. Locate the answer and take the suffix after it.
  const idx = stripped.indexOf(answerText);
  if (idx >= 0) {
    const after = stripped.slice(idx + answerText.length).replace(/^\n+/, "").trimEnd();
    // Only use the suffix when it looks like status lines (not the whole body again).
    if (after && after.length < stripped.length) {
      return after;
    }
  }
  // Last resort: if stored statusLines exist they are preferred by the caller;
  // returning empty avoids dumping a duplicate answer as "trailer".
  return "";
}

function stripBridgeResultBlock(text) {
  return String(text ?? "").replace(
    /\n*===BRIDGE-RESULT===[\s\S]*?===END-BRIDGE-RESULT===\n*/g,
    "\n"
  );
}

/**
 * Resolve the status trailer for `show`: prefer explicitly stored statusLines
 * (no string surgery), else derive from the stored rendered body.
 */
export function resolveStoredStatusTrailer(storedJob, answer) {
  const fromResult = storedJob?.result?.statusLines;
  if (Array.isArray(fromResult) && fromResult.length > 0) {
    return fromResult.join("\n").trimEnd();
  }
  if (typeof storedJob?.statusLines === "string" && storedJob.statusLines.trim()) {
    return storedJob.statusLines.trimEnd();
  }
  if (Array.isArray(storedJob?.statusLines) && storedJob.statusLines.length > 0) {
    return storedJob.statusLines.join("\n").trimEnd();
  }
  if (typeof storedJob?.rendered === "string" && storedJob.rendered.trim()) {
    return extractStatusTrailerFromRendered(storedJob.rendered, answer);
  }
  return "";
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = formatGrokResumeCommand({
    threadId,
    binary: storedJob?.binary ?? job?.binary ?? storedJob?.cliBinary ?? job?.cliBinary
  });
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    const withSession = threadId
      ? `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`
      : output;
    return appendBridgeResult(withSession, job, storedJob);
  }

  // Compose rather than choose, in three parts:
  //   1. the answer the run was asked for,
  //   2. the verify-fix history, clearly labelled (FIELD-2), so a fix-turn
  //      report can never masquerade as the deliverable,
  //   3. the bridge status trailer foreground runs print (changed files,
  //      verify markers, isolation, …), so `show` after a background run is
  //      never strictly poorer than a foreground run.
  //
  // `lastMessage` is deliberately NOT in the answer chain: preferring a bare
  // trailing line over the stored rawOutput would make /turbo-build-plugin:show print
  // LESS than it does today. `grok.stdout` stays last so stored *review* jobs,
  // whose payload has no rawOutput at all, render exactly as before.
  const answer =
    (typeof storedJob?.result?.finalReport === "string" && storedJob.result.finalReport) ||
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.grok?.stdout === "string" && storedJob.result.grok.stdout) ||
    "";

  const fixAttempts =
    storedJob?.result?.verify?.fixAttempts ??
    storedJob?.verify?.fixAttempts ??
    null;
  const hasFixAttempts = Array.isArray(fixAttempts) && fixAttempts.length > 0;
  const trailer = resolveStoredStatusTrailer(storedJob, answer);

  if (answer || hasFixAttempts || trailer) {
    const parts = [];
    if (answer) {
      parts.push(answer.endsWith("\n") ? answer.trimEnd() : answer);
    }
    if (hasFixAttempts) {
      const fixLines = ["--- Verify fix history (not the task deliverable) ---"];
      for (const entry of fixAttempts) {
        fixLines.push(
          `Fix attempt ${entry.attempt ?? "?"}${entry.command ? ` for \`${entry.command}\`` : ""}:`
        );
        const body =
          (typeof entry.finalReport === "string" && entry.finalReport.trim()) ||
          (typeof entry.lastMessage === "string" && entry.lastMessage.trim()) ||
          "(no report from this fix turn)";
        fixLines.push(body.endsWith("\n") ? body.trimEnd() : body);
        fixLines.push("");
      }
      parts.push(fixLines.join("\n").trimEnd());
    }
    if (trailer) {
      parts.push(trailer.endsWith("\n") ? trailer.trimEnd() : trailer);
    }
    let output = `${parts.join("\n\n")}\n`;
    if (threadId) {
      output = `${output}\nGrok session ID: ${threadId}\nResume in Grok: ${resumeCommand}\n`;
    }
    return appendBridgeResult(output, job, storedJob);
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
        "- Re-check with `/turbo-build-plugin:runs`. If a process is still alive, end it from Task Manager and re-run stop."
      );
    }
  }
  lines.push("- Check `/turbo-build-plugin:runs` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}

/** schemaVersion for the machine-readable run manifest (`show --json`). */
export const RUN_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Parse common ## sections out of a delimited final report for the manifest.
 * Best-effort; missing sections stay empty arrays/null.
 */
export function parseReportSections(finalReport) {
  const text = String(finalReport ?? "").trim();
  const empty = {
    result: null,
    decisions: [],
    assumptions: [],
    notDone: [],
    openQuestions: [],
    followUps: [],
    confidence: null
  };
  if (!text) {
    return empty;
  }

  const sections = {};
  const parts = text.split(/^##\s+/m);
  for (const part of parts) {
    if (!part.trim()) {
      continue;
    }
    const nl = part.indexOf("\n");
    const title = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase();
    const body = (nl === -1 ? "" : part.slice(nl + 1)).trim();
    sections[title] = body;
  }

  const bulletLines = (body) =>
    String(body ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
      .filter(Boolean);

  const resultBody = sections.result ?? sections.summary ?? null;
  let confidence = null;
  const confMatch = text.match(/\bconfidence\s*[:\-]\s*(high|medium|low)\b/i);
  if (confMatch) {
    confidence = confMatch[1].toLowerCase();
  }

  return {
    result: resultBody,
    decisions: bulletLines(sections.decisions),
    assumptions: bulletLines(sections.assumptions),
    notDone: bulletLines(
      sections["not done"] ?? sections.notdone ?? sections["deliberately not done"] ?? sections["not-done"]
    ),
    openQuestions: bulletLines(
      sections["open questions"] ?? sections.openquestions ?? sections.questions
    ),
    followUps: bulletLines(sections["follow-ups"] ?? sections.followups ?? sections["follow ups"]),
    confidence
  };
}

function usageForManifest(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return {
    inputTokens: usage.inputTokens ?? null,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    costUsd: usage.costUsd ?? null,
    costUsdTicks: usage.costUsdTicks ?? null,
    costIsPartial: Boolean(usage.costIsPartial),
    usageIsIncomplete: Boolean(usage.usageIsIncomplete),
    modelCalls: usage.modelCalls ?? null,
    numTurns: usage.numTurns ?? null,
    resolvedModel: usage.resolvedModel ?? null,
    byModel: usage.modelUsage ?? null
  };
}

/**
 * Authoritative machine-readable surface of a finished (or in-progress) run.
 * Consumed by `show --json` / `wait --json` so callers act without re-reading
 * the repo. Shape is pinned by plugins/turbo-build-plugin/schemas/run-manifest.schema.json.
 *
 * @param {object} job - index / hydrated job row
 * @param {object|null} storedJob - jobs/<id>.json contents
 * @returns {object}
 */
export function buildRunManifest(job = {}, storedJob = null) {
  const record = { ...job, ...(storedJob ?? {}) };
  const result = storedJob?.result ?? record.result ?? null;
  const worktree = record.worktree ?? result?.worktree ?? null;
  const usage = record.usage ?? result?.usage ?? null;
  const usageBreakdown = result?.usageBreakdown ?? record.usageBreakdown ?? null;
  const verify = result?.verify ?? record.verify ?? null;
  const changedFiles = result?.changedFiles ?? record.changedFiles ?? null;
  const finalReport =
    (typeof result?.finalReport === "string" && result.finalReport) ||
    (typeof record.finalReport === "string" && record.finalReport) ||
    "";
  const reportSections = parseReportSections(finalReport);
  const start = result?.start ?? record.start ?? null;
  const confineViolations = result?.confineViolations ?? record.confineViolations ?? [];
  const streamErrors = result?.streamErrors ?? result?.errors ?? record.streamErrors ?? [];
  const toolVisibility =
    result?.toolVisibility ?? record.toolVisibility ?? (record.toolCallCount == null ? "unavailable" : "observed");

  // WP-B7-FIX: breached is only main-checkout dirtiness (or an explicit stored
  // flag). CLI confine_violation events are blocked attempts — keep them under
  // isolation.confineViolations; do not fold them into breached.
  const isolationBreached = Boolean(
    record.isolationBreached || worktree?.breached || record.isolation?.breached
  );

  const children = Array.isArray(record.children)
    ? record.children
    : Array.isArray(result?.children)
      ? result.children
      : [];

  const statusLines = Array.isArray(result?.statusLines)
    ? result.statusLines
    : typeof result?.statusLines === "string"
      ? result.statusLines.split(/\r?\n/)
      : null;

  return {
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    runId: record.id ?? null,
    parentRunId: record.parentRunId ?? result?.parentRunId ?? null,
    nestDepth: record.nestDepth ?? result?.nestDepth ?? 0,
    status: record.status ?? "unknown",
    stopReason: record.stopReason ?? result?.stopReason ?? null,
    terminalReason: record.terminalReason ?? result?.budgetStopped ?? null,
    write: record.write ?? null,
    verified: record.verified ?? result?.verified ?? null,
    timing: {
      startedAt: record.startedAt ?? record.createdAt ?? null,
      endedAt: record.completedAt ?? null,
      durationMs: record.durationMs ?? result?.durationMs ?? null,
      baselineProbeMs: verify?.baselineProbeMs ?? result?.baselineProbeMs ?? null,
      backgroundWaitMs: record.backgroundWaitMs ?? null
    },
    cli: {
      binary: start?.binary ?? record.cliBinary ?? null,
      version: start?.version ?? record.grokVersion ?? null,
      brand: record.cliBrand ?? null,
      schemaVersion: start?.schemaVersion ?? result?.streamSchemaVersion ?? null,
      permissionMode: start?.permissionMode ?? null,
      sandbox: start?.sandbox ?? null,
      alwaysApprove: start?.alwaysApprove ?? null,
      confineRoot: start?.confineRoot ?? null,
      sessionCwd: start?.sessionCwd ?? null,
      originalCwd: start?.originalCwd ?? null,
      folderTrust: start?.folderTrust ?? null
    },
    model: {
      requested: record.model ?? null,
      served: record.resolvedModel ?? usage?.resolvedModel ?? start?.servedModel ?? null
    },
    isolation: {
      // R6-2: prefer the persisted isolation object so completed/landed runs
      // still report active/worktree/branch/source after worktree cleanup.
      active: Boolean(
        worktree?.path ||
          record.isolation?.active ||
          record.isolation?.worktree
      ),
      worktree: record.isolation?.worktree ?? worktree?.path ?? null,
      branch: record.isolation?.branch ?? worktree?.branch ?? null,
      baseSha:
        record.isolation?.baseSha ?? worktree?.baseSha ?? worktree?.base_sha ?? null,
      headSha:
        record.isolation?.headSha ?? worktree?.headSha ?? worktree?.head_sha ?? worktree?.sha ?? null,
      breached: isolationBreached,
      source: record.isolation?.source ?? record.isolateSource ?? null,
      leakedPaths: record.isolationLeak?.entries ?? record.isolationLeak?.paths ?? result?.isolationLeak?.entries ?? [],
      confineViolations: Array.isArray(confineViolations) ? confineViolations : []
    },
    changes: {
      git: {
        worktree: changedFiles?.worktree ?? changedFiles ?? null,
        mainTree: changedFiles?.mainTree ?? null
      },
      agentReported: result?.agentFilesChanged ?? result?.filesChangedFromStream ?? null,
      debris: result?.debris ?? record.debris ?? { entries: [], total: 0, truncated: false },
      uidIntegrity: verify?.uidIntegrity ?? null,
      changedFileCount:
        record.changedFileCount ??
        result?.changedFileCount ??
        changedFiles?.total ??
        worktree?.changedFileCount ??
        null
    },
    verify: verify
      ? {
          plan: verify.plan ?? null,
          baselineSkipped: Boolean(verify.baselineSkipped),
          note: verify.note ?? null,
          results: Array.isArray(verify.results)
            ? verify.results.map((entry) => ({
                command: entry.command ?? null,
                ok: entry.ok ?? null,
                exitCode: entry.exitCode ?? entry.status ?? null,
                timeoutMs: entry.timeoutMs ?? null,
                timeoutSource: entry.timeoutSource ?? null,
                failureSource: entry.failureSource ?? null,
                attribution: entry.attribution ?? null,
                matchedLines: entry.matchedLines ?? [],
                elidedBytes: entry.elidedBytes ?? null,
                outputTail: entry.outputTail ?? entry.stderrTail ?? null
              }))
            : []
        }
      : null,
    usage: {
      ...usageForManifest(usage),
      own: usageForManifest(usageBreakdown?.own),
      nested: usageForManifest(usageBreakdown?.nested),
      includingNested: usageForManifest(usageBreakdown?.includingNested)
    },
    agent: {
      toolCallCount: record.toolCallCount ?? result?.toolCallCount ?? null,
      toolCallCountFloor: result?.toolCallCountFloor ?? record.toolCallCountFloor ?? null,
      toolVisibility,
      autoContinued: Boolean(record.autoContinued ?? result?.autoContinued),
      maxTurnsReached: Boolean(result?.maxTurnsReached),
      unknownEventTypes: result?.unknownEventTypes ?? [],
      errors: Array.isArray(streamErrors) ? streamErrors : [],
      toolDenials: result?.toolDenials ?? [],
      warnings: result?.streamWarnings ?? result?.warnings ?? [],
      questionsSuppressed: result?.questionsSuppressed ?? [],
      subagents: result?.subagents ?? [],
      subagentsRollup: result?.subagentsRollup ?? null,
      compaction: result?.compaction ?? [],
      toolActivity: result?.toolActivity ?? []
    },
    report: {
      prose: finalReport || (typeof result?.rawOutput === "string" ? result.rawOutput : null),
      contractHonoured: Boolean(finalReport && String(finalReport).trim()),
      structured: reportSections.result
        ? {
            summary: reportSections.result,
            confidence: reportSections.confidence,
            decisions: reportSections.decisions,
            assumptions: reportSections.assumptions,
            notDone: reportSections.notDone,
            openQuestions: reportSections.openQuestions,
            followUps: reportSections.followUps
          }
        : null,
      statusLines
    },
    decisions: reportSections.decisions,
    assumptions: reportSections.assumptions,
    notDone: reportSections.notDone,
    openQuestions: reportSections.openQuestions,
    followUps: reportSections.followUps,
    confidence: reportSections.confidence,
    children: children.map((child) => ({
      runId: child.runId ?? child.id ?? null,
      status: child.status ?? null,
      verified: child.verified ?? null,
      changedFileCount: child.changedFileCount ?? null,
      cost: child.cost ?? child.usage?.costUsd ?? null,
      usage: usageForManifest(child.usage),
      branch: child.branch ?? child.worktree?.branch ?? null,
      finalReport: typeof child.finalReport === "string" ? child.finalReport : null
    })),
    artifacts: {
      logFile: record.logFile ?? result?.logFile ?? null,
      eventsFile: record.eventsFile ?? null,
      transcriptFile: record.transcriptFile ?? null,
      promptFile: record.promptFile ?? result?.promptFile ?? null
    },
    // One minor version of the pre-manifest shape for callers still reading job/storedJob.
    compat: {
      job,
      storedJob
    }
  };
}
