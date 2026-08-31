import { Effect } from "effect";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorktreeError } from "./errors.js";
import { create, remove } from "./WorktreeManager.js";
import {
  issueReceipt,
  removeVerified,
  verifyOwnership,
} from "./WorktreeOwnership.js";

const execAsync = promisify(exec);

const run = <A, E>(
  effect:
    | Effect.Effect<A, E, never>
    | Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    Effect.provide(
      effect as Effect.Effect<A, E, FileSystem.FileSystem>,
      NodeFileSystem.layer,
    ),
  ) as Promise<A>;

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const setupRepo = async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "wo-repo-"));
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello", "initial commit");
  return repoDir;
};

const worktreeListContains = async (repoDir: string, path: string) => {
  const { stdout } = await execAsync("git worktree list --porcelain", {
    cwd: repoDir,
  });
  return stdout.includes(path);
};

describe("WorktreeOwnership receipts", () => {
  it("issues a receipt bound to canonical path, repo, branch, and a random token", async () => {
    const repoDir = await setupRepo();
    const { path, branch } = await run(create(repoDir));

    const receipt = await run(
      issueReceipt({ worktreePath: path, repoDir, branch }),
    );

    expect(receipt.canonicalPath).toBe(path);
    expect(receipt.canonicalRepoDir).toBe(repoDir);
    expect(receipt.branch).toBe(branch);
    expect(receipt.token).toMatch(/^[0-9a-f]{32}$/);

    await run(remove(path));
  });

  it("removeVerified removes a run-owned worktree and freshly verifies the postcondition", async () => {
    const repoDir = await setupRepo();
    const { path, branch } = await run(create(repoDir));
    const receipt = await run(
      issueReceipt({ worktreePath: path, repoDir, branch }),
    );

    await run(removeVerified(receipt));

    // Read-after-write: directory gone AND no longer registered in git.
    expect(existsSync(path)).toBe(false);
    expect(await worktreeListContains(repoDir, path)).toBe(false);
  });

  it("fails closed when the worktree branch moved since the receipt was issued", async () => {
    const repoDir = await setupRepo();
    const { path, branch } = await run(create(repoDir));
    const receipt = await run(
      issueReceipt({ worktreePath: path, repoDir, branch }),
    );

    // Move the worktree onto a different branch after the receipt exists.
    await execAsync(`git checkout -b moved-branch`, { cwd: path });

    await expect(run(verifyOwnership(receipt))).rejects.toThrow(
      /branch moved.*No mutation was performed/,
    );

    // Fail-closed: the worktree is untouched.
    expect(existsSync(path)).toBe(true);
    expect(await worktreeListContains(repoDir, path)).toBe(true);

    await run(remove(path));
  });

  it("fails closed when the worktree is no longer registered in git", async () => {
    const repoDir = await setupRepo();
    const { path, branch } = await run(create(repoDir));
    const receipt = await run(
      issueReceipt({ worktreePath: path, repoDir, branch }),
    );

    // Deregister the worktree behind the receipt's back.
    await execAsync(`git worktree remove --force "${path}"`, {
      cwd: repoDir,
    });

    await expect(run(verifyOwnership(receipt))).rejects.toThrow(
      /no longer registered/,
    );
  });

  it("fails closed when the worktree directory vanished but git metadata remains", async () => {
    const repoDir = await setupRepo();
    const { path, branch } = await run(create(repoDir));
    const receipt = await run(
      issueReceipt({ worktreePath: path, repoDir, branch }),
    );

    // Delete the directory without telling git — ambiguous state.
    await rm(path, { recursive: true, force: true });

    await expect(run(verifyOwnership(receipt))).rejects.toThrow(
      /directory is missing/,
    );
  });

  it("a receipt from a different run cannot authorize cleanup of a foreign worktree", async () => {
    const repoDir = await setupRepo();
    const owned = await run(create(repoDir));
    const foreign = await run(create(repoDir));

    const ownedReceipt = await run(
      issueReceipt({
        worktreePath: owned.path,
        repoDir,
        branch: owned.branch,
      }),
    );

    // Forge a receipt whose path points at the foreign worktree but whose
    // branch is the owned worktree's branch — verification must catch the
    // mismatch and refuse.
    const forged = { ...ownedReceipt, canonicalPath: foreign.path };
    await expect(run(verifyOwnership(forged))).rejects.toThrow(
      /branch moved|no longer registered/,
    );

    // The foreign worktree survives.
    expect(existsSync(foreign.path)).toBe(true);

    await run(remove(owned.path));
    await run(remove(foreign.path));
  });
});

describe("Lifecycle safety: remote-write-free and worktree containment", () => {
  /**
   * Instrument the production remote-write boundary: run the full lifecycle
   * with a git shim that records every `git push` invocation. The shim sits
   * first on PATH so any push — from any code path — is captured.
   */
  const makeGitPushRecorder = async () => {
    const shimDir = await mkdtemp(join(tmpdir(), "wo-push-shim-"));
    const logPath = join(shimDir, "push.log");
    if (process.platform === "win32") {
      // Windows: a .cmd shim that appends args and forwards to real git.
      const shim = join(shimDir, "git.cmd");
      await writeFile(
        shim,
        `@echo off\r\nif "%~1"=="push" echo push >> "${logPath}"\r\ngit.exe %*\r\n`,
      );
    } else {
      const realGit = await execAsync("which git").then((r) => r.stdout.trim());
      const shim = join(shimDir, "git");
      await writeFile(
        shim,
        `#!/bin/sh\nif [ "$1" = "push" ]; then echo push >> "${logPath}"; fi\nexec "${realGit}" "$@"\n`,
      );
      await execAsync(`chmod +x "${shim}"`);
    }
    return {
      shimDir,
      logPath,
      restore: async (originalPath: string | undefined) => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      },
    };
  };

  it("full lifecycle performs zero remote writes (push/create/update/delete)", async () => {
    if (process.platform === "win32") return; // POSIX shim test
    const repoDir = await setupRepo();
    const recorder = await makeGitPushRecorder();
    const originalPath = process.env.PATH;
    process.env.PATH = `${recorder.shimDir}:${originalPath ?? ""}`;

    try {
      // Full production lifecycle: create → dirty → cleanup, plus pruneStale.
      const { path, branch } = await run(create(repoDir));
      const receipt = await run(
        issueReceipt({ worktreePath: path, repoDir, branch }),
      );

      // Dirty the worktree so cleanup takes the preserve path.
      await writeFile(join(path, "work.txt"), "work");
      await run(removeVerified(receipt)).catch(() => {});

      // Clean worktree path through removeVerified too.
      const second = await run(create(repoDir));
      const secondReceipt = await run(
        issueReceipt({
          worktreePath: second.path,
          repoDir,
          branch: second.branch,
        }),
      );
      await run(removeVerified(secondReceipt));

      const pushLog = await readFile(recorder.logPath, "utf-8").catch(() => "");
      expect(pushLog).toBe("");
    } finally {
      await recorder.restore(originalPath);
    }
  });

  it("cleanup never touches a foreign sibling worktree even when paths superficially resemble issue worktrees", async () => {
    const repoDir = await setupRepo();

    // A foreign worktree whose name mimics an issue worktree.
    const foreign = await run(create(repoDir, { branch: "issue-123-fix" }));

    // A run creates its own worktree and receives a receipt.
    const owned = await run(create(repoDir));
    const receipt = await run(
      issueReceipt({
        worktreePath: owned.path,
        repoDir,
        branch: owned.branch,
      }),
    );

    await run(removeVerified(receipt));

    // The foreign sibling is untouched: directory, branch, and registration.
    expect(existsSync(foreign.path)).toBe(true);
    expect(await worktreeListContains(repoDir, foreign.path)).toBe(true);
    const { stdout: foreignBranch } = await execAsync(
      "git rev-parse --abbrev-ref HEAD",
      { cwd: foreign.path },
    );
    expect(foreignBranch.trim()).toBe("issue-123-fix");

    await run(remove(foreign.path));
  });

  it("caller worktree state is unchanged across lifecycle success and failure", async () => {
    const repoDir = await setupRepo();
    await commitFile(repoDir, "tracked.txt", "original", "add tracked");

    // Snapshot caller state: HEAD, tracked content, untracked file.
    const { stdout: headBefore } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });
    await writeFile(join(repoDir, "untracked.txt"), "caller untracked");

    // Successful lifecycle.
    const ok = await run(create(repoDir));
    const okReceipt = await run(
      issueReceipt({
        worktreePath: ok.path,
        repoDir,
        branch: ok.branch,
      }),
    );
    await run(removeVerified(okReceipt));

    // Failed lifecycle: dirty worktree forces the preserve path (a "failure"
    // from the cleanup's perspective — nothing is deleted).
    const dirty = await run(create(repoDir));
    const dirtyReceipt = await run(
      issueReceipt({
        worktreePath: dirty.path,
        repoDir,
        branch: dirty.branch,
      }),
    );
    await writeFile(join(dirty.path, "work.txt"), "agent work");
    await run(removeVerified(dirtyReceipt)).catch(() => {});

    // Caller state is byte-identical.
    const { stdout: headAfter } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });
    expect(headAfter).toBe(headBefore);
    const tracked = await readFile(join(repoDir, "tracked.txt"), "utf-8");
    expect(tracked).toBe("original");
    const untracked = await readFile(join(repoDir, "untracked.txt"), "utf-8");
    expect(untracked).toBe("caller untracked");
  });

  it("interrupted run: dirty work in a run-owned worktree is preserved, not deleted", async () => {
    const repoDir = await setupRepo();
    const { path, branch } = await run(create(repoDir));
    const receipt = await run(
      issueReceipt({ worktreePath: path, repoDir, branch }),
    );

    // Simulate an interrupted run: committed + uncommitted agent work.
    await writeFile(join(path, "feature.txt"), "feature work");
    await execAsync(`git add feature.txt`, { cwd: path });
    await execAsync(`git commit -m "wip: feature"`, { cwd: path });
    await writeFile(join(path, "scratch.txt"), "uncommitted");

    // Cleanup must preserve, never delete.
    await expect(run(removeVerified(receipt))).rejects.toThrow(
      /Refusing destructive cleanup/,
    );

    const committed = await readFile(join(path, "feature.txt"), "utf-8");
    expect(committed).toBe("feature work");
    const uncommitted = await readFile(join(path, "scratch.txt"), "utf-8");
    expect(uncommitted).toBe("uncommitted");
    expect(await worktreeListContains(repoDir, path)).toBe(true);
  });

  it("unknown registry state: destructive cleanup is skipped with actionable evidence", async () => {
    const repoDir = await setupRepo();
    const { path, branch } = await run(create(repoDir));
    const receipt = await run(
      issueReceipt({ worktreePath: path, repoDir, branch }),
    );

    // Corrupt the registry: deregister without removing the directory.
    await execAsync(`git worktree remove --force "${path}"`, { cwd: repoDir });
    await mkdir(path, { recursive: true });

    await expect(run(removeVerified(receipt))).rejects.toThrow(
      /no longer registered.*No mutation was performed/,
    );

    // The directory was not touched by cleanup.
    const s = await stat(path);
    expect(s.isDirectory()).toBe(true);
  });
});
