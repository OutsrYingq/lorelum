import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import config from "../../native/embedding/build-config.json";
import { ensurePinnedDownload } from "./download";
import { nativeBuildWorktreeDirectory } from "./source-tree";

/** Windows builder state for the pinned CMake + MinGW-w64 toolchain. */
export interface Win32NativeToolchain {
  readonly cmakeExecutable: string;
  readonly gppExecutable: string;
  readonly objdumpExecutable: string;
  /** Toolchain identities derive from the pinned archives, never from host state. */
  readonly cmakeIdentity: string;
  readonly compilerIdentity: string;
  /** Cache-key input standing in for the OS runtime ABI, matching ldd's role on Linux. */
  readonly windowsVersion: string;
  /** Minimal PATH for toolchain children; avoids shell-provided sh.exe and GNU tar. */
  readonly childPath: string;
  readonly childEnvironment: Readonly<Record<string, string>>;
  prepare(): Promise<void>;
  dynamicDependencies(executable: string): string[];
}

export function win32NativeToolchain(repositoryRoot: string): Win32NativeToolchain {
  const recipe = config.targets["win32-x64"];
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const system32 = join(systemRoot, "System32");
  const toolRoot = join(nativeBuildWorktreeDirectory(repositoryRoot), "tools");
  const cmakeRoot = join(toolRoot, `cmake-${recipe.cmake.version}-windows-x86_64`);
  const compilerExtractRoot = join(toolRoot, "winlibs");
  const compilerRoot = join(compilerExtractRoot, recipe.compiler.rootDirectory);
  const binDirectory = join(compilerRoot, "bin");
  const cmakeExecutable = join(cmakeRoot, "bin", "cmake.exe");
  const gppExecutable = join(binDirectory, "g++.exe");
  const objdumpExecutable = join(binDirectory, "objdump.exe");
  const cmakeZip = join(toolRoot, basename(recipe.cmake.win64Url));
  const compilerZip = join(toolRoot, basename(recipe.compiler.url));
  const tar = join(system32, "tar.exe");

  return {
    cmakeExecutable,
    gppExecutable,
    objdumpExecutable,
    cmakeIdentity: `cmake version ${recipe.cmake.version}`,
    compilerIdentity: `${recipe.compiler.name} (${recipe.compiler.sha256.slice(0, 12)})`,
    windowsVersion: run(["cmd", "/c", "ver"]),
    childPath: [binDirectory, system32, systemRoot].join(";"),
    childEnvironment: {
      PATH: [binDirectory, system32, systemRoot].join(";"),
      SystemRoot: systemRoot,
    },
    async prepare() {
      mkdirSync(toolRoot, { recursive: true });
      if (!existsSync(tar)) throw new Error(`Windows tar.exe is missing: ${tar}`);
      await ensurePinnedDownload({
        url: recipe.cmake.win64Url,
        destination: cmakeZip,
        sha256: recipe.cmake.win64Sha256,
        bytes: recipe.cmake.win64Bytes,
      });
      await ensurePinnedDownload({
        url: recipe.compiler.url,
        destination: compilerZip,
        sha256: recipe.compiler.sha256,
        bytes: recipe.compiler.bytes,
      });
      if (!existsSync(cmakeExecutable)) run([tar, "-xf", cmakeZip, "-C", toolRoot], toolRoot);
      if (!existsSync(gppExecutable)) {
        mkdirSync(compilerExtractRoot, { recursive: true });
        run([tar, "-xf", compilerZip, "-C", compilerExtractRoot]);
      }
      const cmakeVersion = run([cmakeExecutable, "--version"]).split("\n")[0] ?? "unknown";
      if (cmakeVersion !== `cmake version ${recipe.cmake.version}`)
        throw new Error(`pinned CMake identity mismatch: ${cmakeVersion}`);
    },
    dynamicDependencies(executable) {
      const output = run([objdumpExecutable, "-p", executable]);
      const names = new Set<string>();
      for (const match of output.matchAll(/DLL Name:\s*(\S+\.dll)/gi)) names.add(match[1]);
      if (names.size === 0)
        throw new Error(`could not parse objdump dependencies for ${executable}`);
      return [...names];
    },
  };
}

function run(command: readonly string[], cwd?: string): string {
  const result = Bun.spawnSync([...command], {
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(
      `command failed (${result.exitCode}): ${command.join(" ")}\n${result.stdout.toString()}${result.stderr.toString()}`,
    );
  return result.stdout.toString().trim();
}
