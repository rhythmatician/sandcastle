import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

const processMock = vi.hoisted(() => ({
  kill: vi.fn(() => true),
  execFile: vi.fn(() => ({ kill: processMock.kill })),
}));

vi.mock("node:child_process", () => ({ execFile: processMock.execFile }));

import { getCurrentBranch } from "./WorktreeManager.js";

describe("WorktreeManager git process cancellation", () => {
  it("terminates Git when the calling effect is interrupted", async () => {
    await Effect.runPromise(
      getCurrentBranch(".").pipe(
        Effect.timeoutFail({
          duration: 0,
          onTimeout: () => new Error("test timeout"),
        }),
        Effect.flip,
      ),
    );

    expect(processMock.execFile).toHaveBeenCalledOnce();
    expect(processMock.kill).toHaveBeenCalledOnce();
  });
});
