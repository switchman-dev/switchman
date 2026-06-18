import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";

const cli = resolve("..", "bin", "switchman.js");

test("board start creates a worktree and registers the session", () => {
  const root = mkdtempSync(join(tmpdir(), "switchman-cli-"));
  const repo = join(root, "repo");
  const registry = join(root, "sessions.json");
  const worktreesDir = join(root, "worktrees");

  try {
    git(root, ["init", "-b", "main", repo]);
    git(repo, ["config", "user.email", "switchman@example.test"]);
    git(repo, ["config", "user.name", "Switchman Test"]);
    writeFileSync(join(repo, "README.md"), "# Fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "Initial commit"]);

    execFileSync(
      process.execPath,
      [
        cli,
        "board",
        "start",
        "refactor cart total",
        "--agent",
        "codex",
        "--repo",
        repo,
        "--registry",
        registry,
        "--worktrees-dir",
        worktreesDir,
        "--no-launch",
      ],
      { encoding: "utf8" },
    );

    const parsed = JSON.parse(readFileSync(registry, "utf8"));
    assert.equal(parsed.sessions.length, 1);
    assert.equal(parsed.sessions[0].id, "refactor-cart-total");
    assert.equal(parsed.sessions[0].taskName, "refactor cart total");
    assert.equal(parsed.sessions[0].agent, "codex");
    assert.equal(parsed.sessions[0].status, "in-progress");
    assert.match(parsed.sessions[0].branchName, /^switchman\/refactor-cart-total$/);

    const worktreePath = parsed.sessions[0].worktreePath;
    assert.equal(worktreePath, join(worktreesDir, "refactor-cart-total"));
    assert.equal(git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "switchman/refactor-cart-total");

    const blockerPath = join(worktreesDir, "other-live-lane");
    git(repo, ["worktree", "add", "-b", "switchman/other-live-lane", blockerPath, "main"]);
    writeFileSync(join(worktreePath, "README.md"), "# Fixture\nchanged\n");
    writeFileSync(join(blockerPath, "README.md"), "# Fixture\nchanged elsewhere\n");
    parsed.sessions.push({
      id: "other-live-lane",
      taskName: "edit readme another way",
      agent: "claude-code",
      repoRoot: repo,
      baseRef: "main",
      worktreePath: blockerPath,
      branchName: "switchman/other-live-lane",
      status: "in-progress",
      filesTouched: ["README.md"],
    });
    writeFileSync(registry, `${JSON.stringify(parsed, null, 2)}\n`);

    const blocked = spawnSync(
      process.execPath,
      [cli, "board", "merge", "refactor-cart-total", "--registry", registry],
      { encoding: "utf8" },
    );
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /Switchman paused merge for "refactor cart total"/);
    assert.match(
      blocked.stderr,
      /Claude Code is still editing README\.md for "edit readme another way"/,
    );

    execFileSync(
      process.execPath,
      [cli, "board", "merge", "refactor-cart-total", "--registry", registry, "--force"],
      { encoding: "utf8" },
    );

    const merged = JSON.parse(readFileSync(registry, "utf8"));
    assert.equal(merged.sessions[0].status, "done");
    assert.equal(git(repo, ["log", "-1", "--pretty=%s"]), "Switchman merge: refactor cart total");
    assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# Fixture\nchanged\n");
    assert.doesNotThrow(() => JSON.parse(readFileSync(registry, "utf8")));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("registry lock blocks concurrent writes", () => {
  const root = mkdtempSync(join(tmpdir(), "switchman-cli-lock-"));
  const repo = join(root, "repo");
  const registry = join(root, "sessions.json");
  const worktreesDir = join(root, "worktrees");

  try {
    git(root, ["init", "-b", "main", repo]);
    git(repo, ["config", "user.email", "switchman@example.test"]);
    git(repo, ["config", "user.name", "Switchman Test"]);
    writeFileSync(join(repo, "README.md"), "# Fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "Initial commit"]);
    mkdirSync(`${registry}.lock`, { recursive: true });

    const blocked = spawnSync(
      process.execPath,
      [
        cli,
        "board",
        "start",
        "blocked task",
        "--agent",
        "codex",
        "--repo",
        repo,
        "--registry",
        registry,
        "--worktrees-dir",
        worktreesDir,
        "--no-launch",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, SWITCHMAN_LOCK_TIMEOUT_MS: "150" },
      },
    );

    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /timed out waiting for registry lock/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
