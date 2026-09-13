import { describe, expect, test } from "bun:test";
import { windowsProcessStartTime } from "./windows-process";

const windowsOnly = process.platform === "win32";

describe("windows process identity", () => {
  test.skipIf(!windowsOnly)("returns a stable creation time for a live process", () => {
    const first = windowsProcessStartTime(process.pid);
    expect(first).toMatch(/^[0-9]+$/);
    expect(windowsProcessStartTime(process.pid)).toBe(first);
  });

  test.skipIf(!windowsOnly)("treats an unlikely pid as gone", () => {
    expect(windowsProcessStartTime(0x7fffffff)).toBeUndefined();
  });
});
