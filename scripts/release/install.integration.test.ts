import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = "0.1.0";
const repositoryRoot = join(import.meta.dir, "..", "..");

// The POSIX installer runs under Git Bash on Windows hosts, where MSYS shasum emits
// a leading mode marker that its parsing does not accept; Windows installs use
// install.ps1 instead, which install-ps1.integration.test.ts covers.
const posixOnly = process.platform !== "win32";

const platforms = {
  "darwin-arm64": { unameS: "Darwin", unameM: "arm64" },
  "linux-x64": { unameS: "Linux", unameM: "x86_64" },
} as const;
type InstallerPlatform = keyof typeof platforms;

test.skipIf(!posixOnly)(
  "installer verifies, extracts, and atomically links one platform package",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lore-install-integration-"));
    const server = await createReleaseServer(root);
    try {
      const result = await runInstaller(root, server.url.origin);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const command = join(root, "bin", "lore");
      expect(await realpath(command)).toBe(
        await realpath(join(root, "share", "versions", version, "lore")),
      );
      expect(await readFile(join(root, "share", "versions", version, "LICENSE"), "utf8")).toBe(
        "Apache-2.0 fixture\n",
      );
      expect(result.stdout).toContain(`Installed lore ${version}`);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posixOnly)("installer installs the linux-x64 package on Linux x86_64", async () => {
  const root = await mkdtemp(join(tmpdir(), "lore-install-linux-"));
  const server = await createReleaseServer(root, { platform: "linux-x64" });
  try {
    const result = await runInstaller(root, server.url.origin, ["--version", version], "linux-x64");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Installed lore ${version}`);
    expect(
      await readFile(
        join(root, "share", "versions", version, "native", "linux-x64", "manifest.json"),
        "utf8",
      ),
    ).toBe("{}\n");
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!posixOnly)(
  "installer resolves the latest stable release when no version is supplied",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lore-install-latest-"));
    const server = await createReleaseServer(root);
    try {
      const result = await runInstaller(root, server.url.origin, []);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(Bun.file(join(root, "share", "versions", version, "lore")).exists()).resolves.toBe(
        true,
      );
      expect(result.stdout).toContain(`Installed lore ${version}`);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posixOnly)(
  "installer uses the exact tag returned for the latest release assets",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lore-install-latest-tag-"));
    const server = await createReleaseServer(root, { latestTag: version, releaseTag: version });
    try {
      const result = await runInstaller(root, server.url.origin, []);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Installed lore ${version}`);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posixOnly)(
  "installer rejects a latest-release tag that is not semantic versioning",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lore-install-invalid-latest-"));
    const server = await createReleaseServer(root, { latestTag: "release-candidate" });
    try {
      const result = await runInstaller(root, server.url.origin, []);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("cannot resolve the latest stable release");
      await expect(
        Bun.file(join(root, "share", "versions", version, "lore")).exists(),
      ).resolves.toBe(false);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posixOnly)("installer leaves an unmanaged command untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "lore-install-conflict-"));
  const server = await createReleaseServer(root);
  try {
    await mkdir(join(root, "bin"), { recursive: true });
    const command = join(root, "bin", "lore");
    await writeFile(command, "foreign\n");
    const result = await runInstaller(root, server.url.origin);
    expect(result.exitCode).toBe(1);
    expect(await readFile(command, "utf8")).toBe("foreign\n");
    await expect(Bun.file(join(root, "share", "versions", version, "lore")).exists()).resolves.toBe(
      false,
    );
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

async function createReleaseServer(
  root: string,
  options: { latestTag?: string; releaseTag?: string; platform?: InstallerPlatform } = {},
) {
  const platform = options.platform ?? "darwin-arm64";
  const archiveName = `lore-${version}-${platform}.tar.gz`;
  const packageName = archiveName.slice(0, -".tar.gz".length);
  const releaseTag = options.releaseTag ?? `v${version}`;
  const releases = join(root, "releases", releaseTag);
  const packageDirectory = join(root, packageName);
  await mkdir(join(packageDirectory, "native", platform), { recursive: true });
  await writeFile(join(packageDirectory, "lore"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(packageDirectory, "LICENSE"), "Apache-2.0 fixture\n");
  await writeFile(join(packageDirectory, "THIRD_PARTY_NOTICES.txt"), "notices\n");
  await writeFile(
    join(packageDirectory, "native", platform, "llama-server"),
    "#!/bin/sh\nexit 0\n",
  );
  await writeFile(join(packageDirectory, "native", platform, "manifest.json"), "{}\n");
  await chmod(join(packageDirectory, "lore"), 0o755);
  await chmod(join(packageDirectory, "native", platform, "llama-server"), 0o755);
  await mkdir(releases, { recursive: true });
  const archive = join(releases, archiveName);
  const archived = Bun.spawnSync(["tar", "-C", root, "-czf", archive, packageName]);
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
          tag_name: options.latestTag ?? `v${version}`,
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
  arguments_: readonly string[] = ["--version", version],
  platform: InstallerPlatform = "darwin-arm64",
) {
  const fakeBin = join(root, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  const uname = join(fakeBin, "uname");
  const { unameS, unameM } = platforms[platform];
  await writeFile(
    uname,
    `#!/bin/sh\ncase "$1" in\n  -s) echo ${unameS} ;;\n  -m) echo ${unameM} ;;\nesac\n`,
  );
  await chmod(uname, 0o755);
  const child = Bun.spawn(["sh", join(repositoryRoot, "install.sh"), ...arguments_], {
    cwd: root,
    env: {
      HOME: root,
      PATH: `${fakeBin}:${process.env.PATH}`,
      LORELUM_INSTALL_RELEASE_BASE_URL: releaseBase,
      LORELUM_INSTALL_RELEASE_API_BASE_URL: `${releaseBase}/api/releases`,
      LORELUM_INSTALL_ROOT: join(root, "share"),
      LORELUM_INSTALL_BIN_DIR: join(root, "bin"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
