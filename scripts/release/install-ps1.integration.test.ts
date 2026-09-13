import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const windowsOnly = process.platform === "win32";
const version = "0.1.0";
const target = "win32-x64";
const archiveName = `lore-${version}-${target}.zip`;
const packageName = archiveName.slice(0, -".zip".length);
const repositoryRoot = join(import.meta.dir, "..", "..");
const installer = join(repositoryRoot, "install.ps1");

interface InstallerRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

test.skipIf(!windowsOnly)(
  "windows installer verifies, extracts, and installs one platform package",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lore-install-win-"));
    const server = await createReleaseServer(root);
    try {
      const result = await runInstaller(root, server.url.origin);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const shim = (await readFile(join(root, "bin", "lore.cmd"), "utf8")).trim();
      expect(shim).toContain(`"${join(root, "share", "versions", version, "lore.exe")}"`);
      expect(await readFile(join(root, "share", "versions", version, "LICENSE"), "utf8")).toBe(
        "Apache-2.0 fixture\n",
      );
      expect(await readFile(join(root, "share", "versions", version, "lore.exe"), "utf8")).toBe(
        "cli fixture\n",
      );
      expect(result.stdout).toContain(`Installed lore ${version}`);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!windowsOnly)(
  "windows installer resolves the latest stable release when no version is supplied",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lore-install-win-latest-"));
    const server = await createReleaseServer(root);
    try {
      const result = await runInstaller(root, server.url.origin, []);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(await Bun.file(join(root, "share", "versions", version, "lore.exe")).exists()).toBe(
        true,
      );
      expect(result.stdout).toContain(`Installed lore ${version}`);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!windowsOnly)(
  "windows installer rejects a latest-release tag that is not semantic versioning",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lore-install-win-invalid-"));
    const server = await createReleaseServer(root, { latestTag: "release-candidate" });
    try {
      const result = await runInstaller(root, server.url.origin, []);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("cannot resolve the latest stable release");
      expect(await Bun.file(join(root, "share", "versions", version, "lore.exe")).exists()).toBe(
        false,
      );
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!windowsOnly)("windows installer leaves an unmanaged command untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "lore-install-win-conflict-"));
  const server = await createReleaseServer(root);
  try {
    await mkdir(join(root, "bin"), { recursive: true });
    const command = join(root, "bin", "lore.cmd");
    await writeFile(command, "foreign\r\n");
    const result = await runInstaller(root, server.url.origin);
    expect(result.exitCode).toBe(1);
    expect(await readFile(command, "utf8")).toBe("foreign\r\n");
    expect(await Bun.file(join(root, "share", "versions", version, "lore.exe")).exists()).toBe(
      false,
    );
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

async function createReleaseServer(root: string, options: { latestTag?: string } = {}) {
  const releaseTag = `v${version}`;
  const releases = join(root, "releases", releaseTag);
  const packageDirectory = join(root, packageName);
  await mkdir(join(packageDirectory, "native", target), { recursive: true });
  await writeFile(join(packageDirectory, "lore.exe"), "cli fixture\n");
  await writeFile(join(packageDirectory, "LICENSE"), "Apache-2.0 fixture\n");
  await writeFile(join(packageDirectory, "THIRD_PARTY_NOTICES.txt"), "notices\n");
  await writeFile(join(packageDirectory, "native", target, "llama-server.exe"), "native\n");
  await writeFile(join(packageDirectory, "native", target, "manifest.json"), "{}\n");
  await chmod(join(packageDirectory, "lore.exe"), 0o755);
  await mkdir(releases, { recursive: true });
  const archive = join(releases, archiveName);
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const archived = Bun.spawnSync([tar, "-C", root, "-a", "-cf", archive, packageName]);
  if (archived.exitCode !== 0) throw new Error("fixture archive creation failed");
  const sha256 = createHash("sha256")
    .update(Buffer.from(await Bun.file(archive).arrayBuffer()))
    .digest("hex");
  await writeFile(join(releases, "SHA256SUMS"), `${sha256}  ${archiveName}\n`);
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === `/${releaseTag}/${archiveName}`) return new Response(Bun.file(archive));
      if (path === `/${releaseTag}/SHA256SUMS`)
        return new Response(Bun.file(join(releases, "SHA256SUMS")));
      if (path === "/api/releases/latest")
        return Response.json({
          tag_name: options.latestTag ?? releaseTag,
          prerelease: false,
          draft: false,
        });
      return new Response("missing", { status: 404 });
    },
  });
}

async function runInstaller(
  root: string,
  releaseBase: string,
  arguments_: readonly string[] = ["-Version", version],
): Promise<InstallerRun> {
  // PowerShell needs SystemRoot and a writable TEMP even with the overrides below.
  const temporary = join(root, "temp");
  await mkdir(temporary, { recursive: true });
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installer,
      ...arguments_,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        LORELUM_INSTALL_RELEASE_BASE_URL: releaseBase,
        LORELUM_INSTALL_RELEASE_API_BASE_URL: `${releaseBase}/api/releases`,
        LORELUM_INSTALL_ROOT: join(root, "share"),
        LORELUM_INSTALL_BIN_DIR: join(root, "bin"),
        LOCALAPPDATA: join(root, "localappdata"),
        TEMP: temporary,
        TMP: temporary,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode: exitCode ?? 1 };
}
