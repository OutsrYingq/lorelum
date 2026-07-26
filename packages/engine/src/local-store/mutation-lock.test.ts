import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withMutationLock } from "./mutation-lock";
import { storageRoot } from "./local-store";

async function waitForFile(path: string, attempt = 0): Promise<void> {
  try {
    await stat(path);
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
    if (attempt >= 100) {
      throw new Error(`Timed out waiting for "${path}"`, { cause: error });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return waitForFile(path, attempt + 1);
  }
}

describe("withMutationLock", () => {
  test("releases an interrupted process's mutation boundary", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "lorelum-mutation-lock-"));
    const root = storageRoot(rootPath);
    const readyPath = join(rootPath, "lock-ready");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { withMutationLock } from "./packages/engine/src/local-store/mutation-lock";
await withMutationLock(
  { path: Bun.env.LORELUM_LOCK_ROOT },
  async () => {
    await Bun.write(Bun.env.LORELUM_LOCK_READY_PATH, "ready");
    await new Promise(() => {});
  },
);`,
      ],
      {
        env: {
          ...process.env,
          LORELUM_LOCK_ROOT: root.path,
          LORELUM_LOCK_READY_PATH: readyPath,
        },
        stderr: "pipe",
        stdout: "ignore",
      },
    );

    try {
      await waitForFile(readyPath);
      child.kill();
      await child.exited;

      let acquired = false;
      await withMutationLock(root, async () => {
        acquired = true;
      });
      expect(acquired).toBe(true);
    } finally {
      child.kill();
      await child.exited;
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
