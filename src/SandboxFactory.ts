import { Context, Effect, Exit, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { join, resolve } from "node:path";
import type { PlatformError } from "@effect/platform/Error";
import {
  AgentError,
  AgentIdleTimeoutError,
  CopyError,
  ExecError,
  SyncError,
  WorktreeError,
  type DockerError,
  type SandboxError,
} from "./errors.js";
import type { Timeouts } from "./run.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToWorktree } from "./CopyToWorktree.js";
import { Display } from "./Display.js";
import type {
  SandboxProvider,
  BranchStrategy,
  BindMountSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import { runHostHooks, type SandboxHooks } from "./SandboxLifecycle.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import { patchGitMountsForWindows } from "./mountUtils.js";
import {
  issueReceipt,
  removeVerified,
  type WorktreeOwnershipReceipt,
} from "./WorktreeOwnership.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      stdin?: string;
    },
  ) => Effect.Effect<ExecResult, ExecError>;

  /** Copy a file or directory from the host into the sandbox. */
  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, CopyError>;

  /** Copy a single file from the sandbox to the host. */
  readonly copyFileOut: (
    sandboxPath: string,
    hostPath: string,
  ) => Effect.Effect<void, CopyError>;
}

const getCopyIn = (
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle,
): SandboxService["copyIn"] => {
  if ("copyIn" in handle) {
    return (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: () =>
          (handle as IsolatedSandboxHandle).copyIn(hostPath, sandboxPath),
        catch: (e) =>
          new CopyError({
            message: `copyIn failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
  }
  if ("copyFileIn" in handle) {
    return (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: () =>
          (handle as BindMountSandboxHandle).copyFileIn(hostPath, sandboxPath),
        catch: (e) =>
          new CopyError({
            message: `copyFileIn failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });
  }
  return () =>
    Effect.fail(
      new CopyError({
        message: "copyIn is not supported for this sandbox provider",
      }),
    );
};

/**
 * Wrap a Promise-based sandbox handle into an Effect-based SandboxService.
 * Delegates copyIn/copyFileOut to the handle when available.
 */
export const makeSandboxFromHandle = (
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle,
): SandboxService => ({
  exec: (command, options) =>
    Effect.tryPromise({
      try: () => handle.exec(command, options),
      catch: (e) =>
        new ExecError({
          command,
          message: `exec failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    }),
  copyIn: getCopyIn(handle),
  copyFileOut:
    "copyFileOut" in handle
      ? (sandboxPath, hostPath) =>
          Effect.tryPromise({
            try: () =>
              (
                handle as IsolatedSandboxHandle | BindMountSandboxHandle
              ).copyFileOut(sandboxPath, hostPath),
            catch: (e) =>
              new CopyError({
                message: `copyFileOut failed: ${e instanceof Error ? e.message : String(e)}`,
              }),
          })
      : () =>
          Effect.fail(
            new CopyError({
              message: "copyFileOut is not supported for this sandbox provider",
            }),
          ),
});

/** The mount point inside the sandbox where the project worktree is bound. */
export const SANDBOX_REPO_DIR = "/home/agent/workspace";

export interface SandboxInfo {
  /** Host-side path to the worktree directory (worktree/branch mode only). */
  readonly hostWorktreePath?: string;
  /** Absolute path to the worktree inside the sandbox, as reported by the provider. */
  readonly sandboxRepoPath: string;
  /** Sync changes from the sandbox to the host worktree (isolated providers only). */
  readonly applyToHost?: () => Effect.Effect<void, SyncError>;
  /** The bind-mount sandbox handle, available when the provider is a bind-mount provider. Used for session capture. */
  readonly bindMountHandle?: BindMountSandboxHandle;
}

export interface WithSandboxResult<A> {
  readonly value: A;
  /** Host path to the preserved worktree, set when the worktree was left behind due to uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

export class SandboxFactory extends Context.Tag("SandboxFactory")<
  SandboxFactory,
  {
    readonly withSandbox: <A, E, R>(
      makeEffect: (
        info: SandboxInfo,
        sandbox: SandboxService,
      ) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<WithSandboxResult<A>, E | SandboxError, R>;
  }
>() {}

export class SandboxConfig extends Context.Tag("SandboxConfig")<
  SandboxConfig,
  {
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
    readonly copyToWorktree?: string[];
    /** When specified, the run name is included in the auto-generated branch and worktree names. */
    readonly name?: string;
    /** Sandbox provider — delegates sandbox lifecycle to the provider. */
    readonly sandboxProvider: SandboxProvider;
    /** Branch strategy — controls how the agent's changes relate to branches. */
    readonly branchStrategy: BranchStrategy;
    /** Lifecycle hooks grouped by execution location (host or sandbox). */
    readonly hooks?: SandboxHooks;
    /** AbortSignal threaded to lifecycle hooks so they can cooperatively cancel. */
    readonly signal?: AbortSignal;
    /** Override default timeouts for built-in lifecycle steps. */
    readonly timeouts?: Timeouts;
  }
>() {}

/**
 * Print a message to stderr about a preserved worktree, with review and cleanup instructions.
 */
const printWorktreePreservedMessage = (
  worktreePath: string,
  reason: string,
): void => {
  console.error(`\n${reason}`);
  console.error(`  To review: cd ${worktreePath}`);
  console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
};

/**
 * Check for uncommitted changes and either preserve or remove the worktree.
 * Returns the preserved path if preserved, undefined if removed.
 *
 * Destructive removal is guarded by the run's ownership receipt: the
 * worktree's freshly re-read state (registration, branch, directory) must
 * still match what this run created, and the path must sit inside the
 * managed `.sandcastle/worktrees/` directory. Any mismatch fails closed —
 * nothing is mutated and the error carries the primary failure's context.
 */
const cleanupWorktree = (
  worktreePath: string,
  exit: Exit.Exit<unknown, unknown>,
  receipt: WorktreeOwnershipReceipt | undefined,
): Effect.Effect<string | undefined, WorktreeError> =>
  WorktreeManager.hasUncommittedChanges(worktreePath).pipe(
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.flatMap((isDirty) => {
      if (isDirty) {
        printWorktreePreservedMessage(
          worktreePath,
          Exit.isSuccess(exit)
            ? `Run succeeded but worktree has uncommitted changes at ${worktreePath}`
            : `Worktree preserved at ${worktreePath}`,
        );
        return Effect.succeed(worktreePath as string | undefined);
      }
      if (!Exit.isSuccess(exit)) {
        console.error(`\nWorktree removed (no uncommitted changes)`);
      }
      if (receipt === undefined) {
        // No receipt means this run did not provably create the worktree —
        // fail closed rather than guessing ownership from a path name.
        return Effect.fail(
          new WorktreeError({
            message:
              `Refusing destructive cleanup of ${worktreePath}: no ownership receipt was issued by this run. ` +
              `The worktree is preserved for manual inspection.`,
          }),
        );
      }
      return removeVerified(receipt).pipe(
        Effect.map(() => undefined as string | undefined),
      );
    }),
  );

/**
 * Cleanup-failure precedence (invariant 5): a cleanup failure must never
 * erase the primary worker/factory failure, and must never let the run
 * report success while external state is uncertain.
 *
 * - Primary failure present → re-fail with the primary error; the cleanup
 *   diagnostic is logged so it is retained for the operator.
 * - Primary success but cleanup failed → fail closed with an infrastructure
 *   error carrying the cleanup diagnostic. The run did NOT complete cleanly.
 */
const handleCleanupFailure = (
  cleanupError: WorktreeError,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<never> =>
  Effect.sync(() => {
    console.error(
      `\n[sandcastle] Cleanup failed (fail-closed): ${cleanupError.message}`,
    );
    if (Exit.isSuccess(exit)) {
      console.error(
        `[sandcastle] The run's work completed, but cleanup could not be verified. ` +
          `Treating the run as failed — inspect the worktree before retrying.`,
      );
    }
  }).pipe(
    // Dying (defect) rather than failing: Effect.acquireUseRelease requires a
    // total release, and a defect raised in the release is *combined* with the
    // primary use-phase failure instead of replacing it — so the primary
    // failure stays primary (invariant 5). When the run had succeeded, the
    // defect propagates and the run reports failure (invariant 6).
    Effect.andThen(
      Effect.die(
        new WorktreeError({
          message: `Cleanup failed (fail-closed): ${cleanupError.message}`,
        }),
      ),
    ),
  );

/**
 * Attach the preserved worktree path to AgentIdleTimeoutError and AgentError so
 * programmatic callers can build on top of the preserved worktree.
 */
const attachPreservedPath = <E>(
  path: string | undefined,
  e: E | SandboxError,
): E | SandboxError => {
  if (path !== undefined) {
    if (e instanceof AgentIdleTimeoutError) {
      return new AgentIdleTimeoutError({
        message: e.message,
        timeoutMs: e.timeoutMs,
        preservedWorktreePath: path,
      }) as unknown as E | SandboxError;
    }
    if (e instanceof AgentError) {
      return new AgentError({
        message: e.message,
        preservedWorktreePath: path,
      }) as unknown as E | SandboxError;
    }
  }
  return e;
};

export interface MountEntry {
  readonly hostPath: string;
  readonly sandboxPath: string;
}

/**
 * Resolves the git-related mounts needed for the sandbox.
 * Handles both normal repos (where .git is a directory) and worktrees
 * (where .git is a file pointing to the parent repo's .git/worktrees/<name>).
 */
export const resolveGitMounts = (
  gitPath: string,
): Effect.Effect<MountEntry[], PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(gitPath);
    if (stat.type === "Directory") {
      return [{ hostPath: gitPath, sandboxPath: gitPath }];
    }
    // Worktree: .git is a file with "gitdir: <path>"
    const content = (yield* fs.readFileString(gitPath)).trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) {
      // Unrecognized format — fall back to mounting the file as-is
      return [{ hostPath: gitPath, sandboxPath: gitPath }];
    }
    const gitdirPath = match[1]!;
    // gitdirPath is like /path/to/repo/.git/worktrees/<name>
    // Mount both the .git file and the parent .git directory
    const parentGitDir = resolve(gitdirPath, "..", "..");
    return [
      { hostPath: gitPath, sandboxPath: gitPath },
      { hostPath: parentGitDir, sandboxPath: parentGitDir },
    ];
  });

export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const {
        env,
        hostRepoDir,
        copyToWorktree: copyPaths,
        name,
        sandboxProvider,
        branchStrategy,
        hooks,
        signal,
        timeouts,
      } = yield* SandboxConfig;

      const isHeadMode = branchStrategy.type === "head";
      const branch =
        branchStrategy.type === "branch" ? branchStrategy.branch : undefined;
      const baseBranch =
        branchStrategy.type === "branch"
          ? branchStrategy.baseBranch
          : undefined;
      const fileSystem = yield* FileSystem.FileSystem;
      const display = yield* Display;

      /**
       * Prune stale worktrees, then create a fresh one and issue this run's
       * ownership receipt for it. The receipt is the only authority the
       * release phase has to destructively remove the worktree later.
       *
       * A prune failure is NOT swallowed: uncertain external state must stop
       * progression (issue #6) — creating a new worktree on top of an
       * unverified stale-worktree state would compound the uncertainty.
       */
      const pruneAndCreate = () =>
        WorktreeManager.pruneStale(hostRepoDir, timeouts?.worktreeMs).pipe(
          Effect.mapError(
            (e) =>
              new WorktreeError({
                message:
                  `Aborting before worktree creation: stale-worktree prune failed — ` +
                  `external state is uncertain. ${e.message}`,
              }),
          ),
          Effect.andThen(
            branch
              ? WorktreeManager.create(hostRepoDir, {
                  branch,
                  baseBranch,
                  timeoutMs: timeouts?.worktreeMs,
                })
              : WorktreeManager.create(hostRepoDir, {
                  name,
                  timeoutMs: timeouts?.worktreeMs,
                }),
          ),
          Effect.andThen((worktreeInfo) =>
            issueReceipt({
              worktreePath: worktreeInfo.path,
              repoDir: hostRepoDir,
              branch: worktreeInfo.branch,
            }).pipe(Effect.map((receipt) => ({ worktreeInfo, receipt }))),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );

      return {
        withSandbox: <A, E, R>(
          makeEffect: (
            info: SandboxInfo,
            sandbox: SandboxService,
          ) => Effect.Effect<A, E, R>,
        ): Effect.Effect<WithSandboxResult<A>, E | SandboxError, R> => {
          // No-sandbox providers: run directly on the host, no container or mounts.
          if (sandboxProvider.tag === "none") {
            let preservedPath: string | undefined;

            // Head mode: use hostRepoDir directly, no worktree.
            if (isHeadMode) {
              return (
                hooks?.host?.onWorktreeReady?.length
                  ? runHostHooks(
                      hooks.host.onWorktreeReady,
                      hostRepoDir,
                      signal,
                    )
                  : Effect.void
              ).pipe(
                Effect.andThen(
                  Effect.acquireUseRelease(
                    startSandbox({
                      provider: sandboxProvider,
                      hostRepoDir,
                      env,
                      worktreeOrRepoPath: hostRepoDir,
                    }),
                    ({ sandbox, worktreePath }) =>
                      makeEffect(
                        {
                          hostWorktreePath: hostRepoDir,
                          sandboxRepoPath: worktreePath,
                        },
                        sandbox,
                      ) as Effect.Effect<A, E | SandboxError, R>,
                    ({ handle }) =>
                      Effect.tryPromise({
                        try: () => handle.close(),
                        catch: () => undefined,
                      }).pipe(Effect.orDie),
                  ).pipe(
                    Effect.map((value) => ({
                      value,
                      preservedWorktreePath: undefined,
                    })),
                  ),
                ),
              );
            }

            // Worktree mode (merge-to-head or explicit branch).
            // Nested so the worktree is always cleaned up (outer release) even
            // when copying, hooks, or sandbox start fail. The provider handle is
            // closed by the inner release, which only runs once it exists.
            return Effect.acquireUseRelease(
              pruneAndCreate(),
              ({ worktreeInfo }) =>
                (copyPaths && copyPaths.length > 0
                  ? display.spinner(
                      "Copying to worktree",
                      copyToWorktree(
                        copyPaths,
                        hostRepoDir,
                        worktreeInfo.path,
                        timeouts?.copyToWorktreeMs,
                      ),
                    )
                  : Effect.succeed(undefined)
                ).pipe(
                  Effect.andThen(
                    hooks?.host?.onWorktreeReady?.length
                      ? runHostHooks(
                          hooks.host.onWorktreeReady,
                          worktreeInfo.path,
                          signal,
                        )
                      : Effect.void,
                  ),
                  Effect.andThen(
                    Effect.acquireUseRelease(
                      startSandbox({
                        provider: sandboxProvider,
                        hostRepoDir,
                        env,
                        worktreeOrRepoPath: worktreeInfo.path,
                      }),
                      ({ sandbox, worktreePath }) =>
                        makeEffect(
                          {
                            hostWorktreePath: worktreeInfo.path,
                            sandboxRepoPath: worktreePath,
                          },
                          sandbox,
                        ),
                      ({ handle }) =>
                        Effect.tryPromise({
                          try: () => handle.close(),
                          catch: () => undefined,
                        }).pipe(Effect.orDie),
                    ),
                  ),
                ) as Effect.Effect<A, E | SandboxError, R>,
              ({ worktreeInfo, receipt }, exit) =>
                cleanupWorktree(worktreeInfo.path, exit, receipt).pipe(
                  Effect.tap((p) => {
                    preservedPath = p;
                  }),
                  Effect.catchAll((cleanupError) =>
                    handleCleanupFailure(cleanupError, exit),
                  ),
                  Effect.asVoid,
                ),
            ).pipe(
              Effect.map((value) => ({
                value,
                preservedWorktreePath: preservedPath,
              })),
              Effect.mapError((e: E | SandboxError) =>
                attachPreservedPath(preservedPath, e),
              ),
            );
          }

          // Isolated providers: create worktree, sync via git bundle
          if (sandboxProvider.tag === "isolated") {
            let preservedPath: string | undefined;

            // Nested so the worktree is always cleaned up (outer release) even
            // when hooks or sandbox start fail. The provider handle is closed by
            // the inner release, which only runs once it exists.
            return Effect.acquireUseRelease(
              pruneAndCreate(),
              ({ worktreeInfo }) =>
                (hooks?.host?.onWorktreeReady?.length
                  ? runHostHooks(
                      hooks.host.onWorktreeReady,
                      worktreeInfo.path,
                      signal,
                    )
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    Effect.acquireUseRelease(
                      startSandbox({
                        provider: sandboxProvider,
                        hostRepoDir: worktreeInfo.path,
                        env,
                        copyPaths,
                      }),
                      ({ sandbox, worktreePath, handle }) =>
                        makeEffect(
                          {
                            hostWorktreePath: worktreeInfo.path,
                            sandboxRepoPath: worktreePath,
                            applyToHost: () =>
                              syncOut(
                                worktreeInfo.path,
                                handle as IsolatedSandboxHandle,
                              ),
                          },
                          sandbox,
                        ),
                      ({ handle }) =>
                        Effect.tryPromise({
                          try: () => handle.close(),
                          catch: () => undefined,
                        }).pipe(Effect.orDie),
                    ),
                  ),
                ) as Effect.Effect<A, E | SandboxError, R>,
              ({ worktreeInfo, receipt }, exit) =>
                cleanupWorktree(worktreeInfo.path, exit, receipt).pipe(
                  Effect.tap((p) => {
                    preservedPath = p;
                  }),
                  Effect.catchAll((cleanupError) =>
                    handleCleanupFailure(cleanupError, exit),
                  ),
                  Effect.asVoid,
                ),
            ).pipe(
              Effect.map((value) => ({
                value,
                preservedWorktreePath: preservedPath,
              })),
              Effect.mapError((e: E | SandboxError) =>
                attachPreservedPath(preservedPath, e),
              ),
            );
          }

          if (isHeadMode) {
            // Head mode: bind-mount host directory directly, no worktree
            const gitPath = join(hostRepoDir, ".git");
            return (
              hooks?.host?.onWorktreeReady?.length
                ? runHostHooks(hooks.host.onWorktreeReady, hostRepoDir, signal)
                : Effect.void
            ).pipe(
              Effect.andThen(resolveGitMounts(gitPath)),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.mapError(
                (e) =>
                  new WorktreeError({
                    message: `Failed to resolve git mounts: ${e}`,
                  }) as E | SandboxError,
              ),
              Effect.flatMap((gitMounts) =>
                // Patch git mounts for Windows worktree compatibility (ADR-0006)
                patchGitMountsForWindows(
                  gitMounts,
                  hostRepoDir,
                  SANDBOX_REPO_DIR,
                ),
              ),
              Effect.flatMap((gitMounts) =>
                Effect.acquireUseRelease(
                  startSandbox({
                    provider: sandboxProvider,
                    hostRepoDir,
                    env,
                    worktreeOrRepoPath: hostRepoDir,
                    gitMounts,
                    repoDir: SANDBOX_REPO_DIR,
                  }),
                  // Use
                  ({ sandbox, worktreePath, handle }) =>
                    makeEffect(
                      {
                        hostWorktreePath: hostRepoDir,
                        sandboxRepoPath: worktreePath,
                        bindMountHandle: handle as BindMountSandboxHandle,
                      },
                      sandbox,
                    ) as Effect.Effect<A, E | SandboxError, R>,
                  // Release
                  ({ handle }) =>
                    Effect.tryPromise({
                      try: () => handle.close(),
                      catch: () => undefined,
                    }).pipe(Effect.orDie),
                ).pipe(
                  Effect.map((value) => ({
                    value,
                    preservedWorktreePath: undefined,
                  })),
                ),
              ),
            );
          }

          // Worktree mode (merge-to-head or explicit branch)
          // Populated by the release phase when a worktree is preserved on failure,
          // so we can attach the path to recognized error types before they propagate.
          let preservedWorktreePath: string | undefined;

          // Worktree creation and sandbox start are nested so the worktree is
          // always cleaned up (outer release) even when a later step — copying,
          // hooks, or sandbox start — fails. The provider handle is closed by the
          // inner release, which only runs once the handle exists.
          return Effect.acquireUseRelease(
            // Acquire: prune stale worktrees (best-effort), then create the worktree.
            pruneAndCreate(),
            // Use: copy files, run host hooks, resolve+patch git mounts, then start
            // the sandbox under a nested acquireUseRelease.
            ({ worktreeInfo }) =>
              (copyPaths && copyPaths.length > 0
                ? display.spinner(
                    "Copying to worktree",
                    copyToWorktree(
                      copyPaths,
                      hostRepoDir,
                      worktreeInfo.path,
                      timeouts?.copyToWorktreeMs,
                    ),
                  )
                : Effect.succeed(undefined)
              ).pipe(
                Effect.andThen(
                  hooks?.host?.onWorktreeReady?.length
                    ? runHostHooks(
                        hooks.host.onWorktreeReady,
                        worktreeInfo.path,
                        signal,
                      )
                    : Effect.void,
                ),
                Effect.andThen(
                  resolveGitMounts(join(hostRepoDir, ".git")).pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.mapError(
                      (e) =>
                        new WorktreeError({
                          message: `Failed to resolve git mounts: ${e}`,
                        }),
                    ),
                  ),
                ),
                // Patch git mounts for Windows worktree compatibility (ADR-0006)
                Effect.flatMap((gitMounts) =>
                  patchGitMountsForWindows(
                    gitMounts,
                    worktreeInfo.path,
                    SANDBOX_REPO_DIR,
                  ),
                ),
                Effect.flatMap((gitMounts) =>
                  Effect.acquireUseRelease(
                    // sandboxProvider is guaranteed bind-mount here
                    // (isolated providers return early above)
                    startSandbox({
                      provider: sandboxProvider as BindMountSandboxProvider,
                      hostRepoDir,
                      env,
                      worktreeOrRepoPath: worktreeInfo.path,
                      gitMounts,
                      repoDir: SANDBOX_REPO_DIR,
                    }),
                    ({ sandbox, worktreePath, handle }) =>
                      makeEffect(
                        {
                          hostWorktreePath: worktreeInfo.path,
                          sandboxRepoPath: worktreePath,
                          bindMountHandle: handle as BindMountSandboxHandle,
                        },
                        sandbox,
                      ),
                    ({ handle }) =>
                      Effect.tryPromise({
                        try: () => handle.close(),
                        catch: () => undefined,
                      }).pipe(Effect.orDie),
                  ),
                ),
              ) as Effect.Effect<A, E | SandboxError, R>,
            // Release: remove or preserve the worktree based on dirty state.
            ({ worktreeInfo, receipt }, exit) =>
              cleanupWorktree(worktreeInfo.path, exit, receipt).pipe(
                Effect.tap((p) => {
                  preservedWorktreePath = p;
                }),
                Effect.catchAll((cleanupError) =>
                  handleCleanupFailure(cleanupError, exit),
                ),
                Effect.asVoid,
              ),
          ).pipe(
            Effect.map((value) => ({
              value,
              preservedWorktreePath,
            })),
            Effect.mapError((e: E | SandboxError) =>
              attachPreservedPath(preservedWorktreePath, e),
            ),
          );
        },
      };
    }),
  ),
};
