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

function buildTaskStatusLines(meta = {}) {
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

  if (meta.worktree?.path) {
    lines.push(`Worktree: ${meta.worktree.path} (branch ${meta.worktree.branch ?? "unknown"})`);
    if (meta.jobId) {
      lines.push(`Review and land with: /grok-build:land ${meta.jobId}`);
    }
  }

  if (meta.budgetStopped) {
    lines.push(`Budget: run stopped early (${meta.budgetStopped}).`);
  }

  return lines;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  const base = rawOutput
    ? (rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`)
    : `${String(parsedResult?.failureMessage ?? "").trim() || "Grok did not return a final message."}\n`;

  const statusLines = buildTaskStatusLines(meta);
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

  const rawOutput =
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
