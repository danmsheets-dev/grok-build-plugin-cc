import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/grok-build/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

/**
 * Deterministic bytes that genuinely do not compress (xorshift32).
 *
 * Load-bearing: a linear-congruential generator produces a stream zlib models
 * almost perfectly, and a 100 KB LCG blob collapses to a ~2.6 KB `--binary`
 * diff - small enough that every assertion here would pass against UNPATCHED
 * code. The fixture is verified below by asserting the pre-fix inflation is
 * real before asserting that the fix removed it.
 */
function incompressibleBytes(size, seed) {
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[index] = state & 0xff;
  }
  return out;
}

const BINARY_FIXTURE_BYTES = 200 * 1024;

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
  assert.equal(target.explicit, true);
});

test("a changed texture is described, not base85-inflated into the prompt", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  const texture = path.join(cwd, "tex.png");
  fs.writeFileSync(texture, incompressibleBytes(BINARY_FIXTURE_BYTES, 0x1234abcd));
  run("git", ["add", "tex.png"], { cwd });
  run("git", ["commit", "-m", "add texture"], { cwd });
  fs.writeFileSync(texture, incompressibleBytes(BINARY_FIXTURE_BYTES, 0x0badc0de));

  // Fixture check: prove the inflation this test is about actually exists for
  // these bytes. If the generator ever becomes compressible, this fails loudly
  // instead of letting the assertions below pass vacuously.
  const inflated = run("git", ["diff", "--binary", "--no-ext-diff", "--submodule=diff"], { cwd });
  assert.equal(inflated.status, 0);
  assert.ok(
    Buffer.byteLength(inflated.stdout, "utf8") > 200000,
    `fixture is not incompressible: --binary produced only ${Buffer.byteLength(inflated.stdout, "utf8")} bytes`
  );

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.equal(context.inputMode, "inline-diff", "one changed file must still review inline");
  assert.doesNotMatch(context.content, /GIT binary patch/);
  assert.match(context.content, /Binary files .*tex\.png .* differ/);
  // The measurement site has to agree with the rendering site, or a single
  // texture demotes the whole review to self-collect on its own.
  assert.ok(context.diffBytes < 4096, `diffBytes should be tiny, got ${context.diffBytes}`);
  // The size the base85 payload used to convey, in one line.
  assert.match(context.content, /## Binary Assets/);
  assert.match(context.content, new RegExp(`tex\\.png \\(unstaged\\): ${BINARY_FIXTURE_BYTES} bytes -> ${BINARY_FIXTURE_BYTES} bytes`));
});

test("a Godot import cache cannot swamp the review context", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.gd"), "extends Node\n");
  run("git", ["add", "app.gd"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const cacheDir = path.join(cwd, ".godot", "imported");
  fs.mkdirSync(cacheDir, { recursive: true });
  for (let index = 0; index < 500; index += 1) {
    fs.writeFileSync(path.join(cacheDir, `asset-${index}.md5`), "m".repeat(100));
  }

  const target = resolveReviewTarget(cwd, {});
  assert.equal(target.mode, "working-tree");

  // Both branches build the untracked section, and the fallback to self-collect
  // protects against nothing on its own - so both are bounded and both checked.
  for (const includeDiff of [true, false]) {
    const context = collectReviewContext(cwd, target, { includeDiff });
    const label = `includeDiff=${includeDiff}`;

    assert.ok(context.content.length < 200000, `${label}: context was ${context.content.length} chars`);
    assert.equal((context.content.match(/^### /gm) ?? []).length, 40, `${label}: untracked file cap`);
    assert.match(context.content, /460 more untracked file\(s\) omitted/, label);
  }

  // The bare-path listing only exists on the self-collect branch, and had no
  // cap of any kind before.
  const selfCollected = collectReviewContext(cwd, target, { includeDiff: false });
  assert.match(selfCollected.content, /300 more path\(s\) omitted; 500 changed in total\./);
});
