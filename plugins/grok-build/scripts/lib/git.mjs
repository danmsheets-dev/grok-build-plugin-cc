import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
// How many untracked files may be inlined, and how many bytes of them in total.
// A Godot import cache or a Blender bake directory routinely holds thousands of
// untracked sidecars; without a cap the "Untracked Files" section alone grew
// without bound and pushed the whole review prompt past the platform
// command-line limit (see item 19 / grok.mjs).
const MAX_UNTRACKED_FILES = 40;
const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024;
// The bare-path listings ("Changed Files") have the same unbounded shape: 5 000
// generated sidecars is ~150 KB of paths and nothing else, and unlike the
// untracked bodies those paths were never size-checked at all.
const MAX_LISTED_FILES = 200;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
export const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

export function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

export function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

// Rendering flags shared by every diff this module asks git for, including the
// measurement calls. `--binary` is deliberately NOT here: it replaces the one
// line a model can actually use ("Binary files a/tex.png and b/tex.png differ")
// with a base85 literal that inflates a 100 KB texture to ~145 KB of characters
// the model cannot decode, cannot review, and pays for. Worse, the measurement
// sites used the same flag, so a single re-exported texture inflated `diffBytes`
// past the inline budget and silently demoted the whole review to self-collect.
// Sizes are recovered separately and compactly - see collectBinaryAssets.
const DIFF_RENDER_ARGS = ["--no-ext-diff", "--submodule=diff"];

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

/**
 * Render a bare path listing with a hard cap, so a directory full of generated
 * sidecars cannot be the largest thing in the prompt.
 */
function formatFileList(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length <= MAX_LISTED_FILES) {
    return list.join("\n");
  }
  const shown = list.slice(0, MAX_LISTED_FILES);
  return [
    ...shown,
    `(${list.length - MAX_LISTED_FILES} more path(s) omitted; ${list.length} changed in total.)`
  ].join("\n");
}

function describeAssetSize(bytes) {
  return bytes == null ? "unknown" : `${bytes} bytes`;
}

function readGitObjectSize(cwd, rev, relativePath) {
  const result = git(cwd, ["cat-file", "-s", `${rev}:${relativePath}`]);
  if (result.error || result.status !== 0) {
    return null;
  }
  const parsed = Number(String(result.stdout).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function readWorkingTreeSize(cwd, relativePath) {
  try {
    return fs.statSync(path.join(cwd, relativePath)).size;
  } catch {
    return null;
  }
}

/**
 * The binary paths in one diff, with the size of each side.
 *
 * This is the enrichment that replaces `--binary`: `git diff --numstat` marks a
 * binary row as `-\t-`, so the paths are one cheap call, and the sizes come from
 * the object store for any side that has a rev. The unstaged side has no rev at
 * all - it is whatever is on disk right now - so that one is stat'd instead.
 * `newRev === null` means exactly that. Renames are switched off so the path
 * field is a plain path rather than git's `{old => new}` rendering, and `-z`
 * keeps paths with spaces or non-ASCII bytes unquoted.
 *
 * @param {string} cwd
 * @param {string[]} diffArgs the diff selector (`--cached`, a commit range, or nothing)
 * @param {{label: string, oldRev: string, newRev: string|null}} sides
 */
function collectBinaryAssets(cwd, diffArgs, { label, oldRev, newRev }) {
  const result = git(cwd, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-renames", ...diffArgs]);
  if (result.error || result.status !== 0) {
    return [];
  }

  const entries = [];
  for (const record of String(result.stdout).split("\0")) {
    if (!record.startsWith("-\t-\t")) {
      continue;
    }
    const file = record.slice(4);
    if (!file) {
      continue;
    }
    entries.push({
      path: file,
      label,
      oldBytes: readGitObjectSize(cwd, oldRev, file),
      newBytes: newRev === null ? readWorkingTreeSize(cwd, file) : readGitObjectSize(cwd, newRev, file)
    });
  }
  return entries;
}

function formatBinaryAssets(entries) {
  return entries
    .map(
      (entry) =>
        `${entry.path} (${entry.label}): ${describeAssetSize(entry.oldBytes)} -> ${describeAssetSize(entry.newBytes)}`
    )
    .join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

/**
 * Inline untracked file bodies until either budget runs out, then say what was
 * dropped. Both budgets matter: 40 tiny `.import` sidecars and one 24 KB script
 * are very different prompts, and only the byte budget catches the second.
 */
function formatUntrackedFiles(cwd, files) {
  const list = Array.isArray(files) ? files : [];
  const blocks = [];
  let usedBytes = 0;

  for (const file of list) {
    if (blocks.length >= MAX_UNTRACKED_FILES || usedBytes >= MAX_UNTRACKED_TOTAL_BYTES) {
      break;
    }
    const block = formatUntrackedFile(cwd, file);
    blocks.push(block);
    usedBytes += Buffer.byteLength(block, "utf8");
  }

  const omitted = list.length - blocks.length;
  if (omitted > 0) {
    blocks.push(
      `(${omitted} more untracked file(s) omitted: this section is capped at ` +
        `${MAX_UNTRACKED_FILES} files and ${MAX_UNTRACKED_TOTAL_BYTES} bytes. ` +
        `Inspect them directly if they matter.)`
    );
  }

  return blocks.join("\n\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  // `--untracked-files=normal` rather than `=all`: `state.untracked` is built by
  // its own `git ls-files --others` call (see getWorkingTreeState), so the flag
  // changes nothing about which files are reviewed - only how many lines this
  // one status block spends. `=all` printed one line per generated sidecar,
  // which is the same unbounded growth the caps below exist to stop; `normal`
  // collapses a wholly-untracked directory to a single entry and the individual
  // files still appear, with their contents, in the Untracked Files section.
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=normal"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  const binaryAssets = [
    ...collectBinaryAssets(cwd, ["--cached"], { label: "staged", oldRev: "HEAD", newRev: "" }),
    ...collectBinaryAssets(cwd, [], { label: "unstaged", oldRev: "", newRev: null })
  ];
  const untrackedBody = formatUntrackedFiles(cwd, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", ...DIFF_RENDER_ARGS]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", ...DIFF_RENDER_ARGS]).stdout;
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", formatFileList(changedFiles))
    ];
  }

  if (binaryAssets.length > 0) {
    parts.push(formatSection("Binary Assets", formatBinaryAssets(binaryAssets)));
  }
  parts.push(formatSection("Untracked Files", untrackedBody));

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();
  const binaryAssets = collectBinaryAssets(cwd, [comparison.commitRange], {
    label: "branch",
    oldRev: comparison.mergeBase,
    newRev: "HEAD"
  });

  const parts = includeDiff
    ? [
        formatSection("Commit Log", logOutput),
        formatSection("Diff Stat", diffStat),
        formatSection("Branch Diff", gitChecked(cwd, ["diff", ...DIFF_RENDER_ARGS, comparison.commitRange]).stdout)
      ]
    : [
        formatSection("Commit Log", logOutput),
        formatSection("Diff Stat", diffStat),
        formatSection("Changed Files", formatFileList(changedFiles))
      ];

  if (binaryAssets.length > 0) {
    parts.push(formatSection("Binary Assets", formatBinaryAssets(binaryAssets)));
  }

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: parts.join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        // Must be byte-for-byte the same command collectWorkingTreeContext
        // renders with, or the inline/self-collect decision is made against a
        // diff that is not the one the model will be shown.
        ["diff", "--cached", ...DIFF_RENDER_ARGS],
        ["diff", ...DIFF_RENDER_ARGS]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", ...DIFF_RENDER_ARGS, comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
