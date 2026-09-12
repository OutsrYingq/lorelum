/* eslint-disable no-await-in-loop -- Poll observable process state until a bounded deadline. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { isSameProcess, type ProcessIdentity } from "../../src/runtime/process-identity";

const PROCESS_SUSPEND_RESUME = 0x0800;

/** Freeze one process: SIGSTOP on POSIX, NtSuspendProcess on Windows. */
export async function suspendProcess(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGSTOP");
    return;
  }
  const { dlopen } = await import("bun:ffi");
  const kernel32 = dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    CloseHandle: { args: ["ptr"], returns: "bool" },
  });
  const ntdll = dlopen("ntdll.dll", {
    NtSuspendProcess: { args: ["ptr"], returns: "i32" },
  });
  const handle = kernel32.symbols.OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
  assert(handle !== null, "OpenProcess must reach the native process to suspend it");
  try {
    const status = ntdll.symbols.NtSuspendProcess(handle);
    assert.equal(status, 0, "NtSuspendProcess must succeed");
  } finally {
    kernel32.symbols.CloseHandle(handle);
  }
}

export async function waitUntil(
  description: string,
  condition: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    assert(Date.now() < deadline, `Timed out waiting for ${description}`);
    await Bun.sleep(20);
  }
}

export function waitForProcessExit(identity: ProcessIdentity): Promise<void> {
  return waitUntil(`process ${identity.pid} to exit`, async () => !(await isSameProcess(identity)));
}

export async function readRssMiB(identity: ProcessIdentity): Promise<number> {
  assert(await isSameProcess(identity), "RSS sample requires the recorded live process");
  if (process.platform === "win32") {
    // tasklist reports working set in KiB with the PID filtered to one CSV row.
    const tasklist = Bun.spawn(
      [
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"),
        "/fi",
        `PID eq ${identity.pid}`,
        "/fo",
        "csv",
        "/nh",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const row = (await new Response(tasklist.stdout).text()).trim();
    assert.equal(await tasklist.exited, 0, "tasklist must successfully read native RSS");
    // Fifth CSV field is the working set, e.g. "66,552 K"; keep only the digits.
    const workingSetKib = Number(row.split('","')[4]?.replace(/[^0-9]/g, ""));
    assert(
      Number.isFinite(workingSetKib) && workingSetKib > 0,
      "Native working set must be finite and positive",
    );
    return workingSetKib / 1024;
  }
  const ps = Bun.spawn(["/bin/ps", "-o", "rss=", "-p", String(identity.pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const rss = Number((await new Response(ps.stdout).text()).trim());
  assert.equal(await ps.exited, 0, "ps must successfully read native RSS");
  assert(Number.isFinite(rss) && rss > 0, "Native RSS must be finite and positive");
  return rss / 1024;
}
