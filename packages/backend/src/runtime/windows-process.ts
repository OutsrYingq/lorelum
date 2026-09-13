import { dlopen, ptr } from "bun:ffi";
import { BackendError } from "../protocol/errors";

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/**
 * kernel32 process-identity calls, resolved on first use. Importing this module must
 * stay inert on every platform; only windowsProcessStartTime under win32 opens the library.
 */
let kernel32Symbols: ReturnType<typeof loadKernel32Symbols> | undefined;

function loadKernel32Symbols() {
  return dlopen("kernel32.dll", {
    OpenProcess: {
      args: ["u32", "i32", "u32"],
      returns: "ptr",
    },
    GetProcessTimes: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "bool",
    },
    CloseHandle: { args: ["ptr"], returns: "bool" },
  }).symbols;
}

/**
 * Return the process creation time as a FILETIME string for identity comparison, or
 * undefined when the process no longer exists. Lorelum daemons run as the current
 * user, so a null handle from OpenProcess is treated as "gone" rather than a failure.
 */
export function windowsProcessStartTime(pid: number): string | undefined {
  const symbols = (kernel32Symbols ??= loadKernel32Symbols());
  const handle = symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === null) return undefined;
  try {
    const times = Buffer.alloc(32);
    const readable = symbols.GetProcessTimes(
      handle,
      ptr(times, 0),
      ptr(times, 8),
      ptr(times, 16),
      ptr(times, 24),
    );
    if (!readable) throw new BackendError("backend.state-invalid");
    return times.readBigUInt64LE(0).toString();
  } finally {
    symbols.CloseHandle(handle);
  }
}
