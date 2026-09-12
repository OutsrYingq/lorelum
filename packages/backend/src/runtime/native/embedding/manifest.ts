import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const MAX_MANIFEST_BYTES = 16_384;
const SHA256 = /^[a-f0-9]{64}$/;
const FILE_NAME = /^[A-Za-z0-9_.-]+$/;

export type NativeArtifactPlatform = "darwin" | "linux";
export type NativeArtifactArch = "arm64" | "x64";

/** Static llama-server builds may only link the operating system's own libraries. */
export const NATIVE_SYSTEM_DEPENDENCIES: Readonly<
  Record<"darwin-arm64" | "linux-x64", ReadonlySet<string>>
> = {
  "darwin-arm64": new Set([
    "/usr/lib/libSystem.B.dylib",
    "/System/Library/Frameworks/Accelerate.framework/Versions/A/Accelerate",
    "/usr/lib/libc++.1.dylib",
  ]),
  // Sonames from ldd on the Ubuntu 24.04 (glibc 2.39) build baseline.
  "linux-x64": new Set(["libc.so.6", "libstdc++.so.6", "libm.so.6", "libgcc_s.so.1"]),
};

export interface NativeArtifactManifest {
  readonly schemaVersion: 1;
  readonly buildIdentity: string;
  readonly recipeIdentity: string;
  readonly platform: NativeArtifactPlatform;
  readonly arch: NativeArtifactArch;
  readonly executable: string;
  readonly source: {
    readonly tag: string;
    readonly commit: string;
    readonly archiveSha256: string;
  };
  readonly patchSha256: string;
  readonly toolchain: { readonly cmake: string; readonly compiler: string };
  readonly cmakeFlags: readonly string[];
  readonly model: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
  readonly files: readonly NativeArtifactFile[];
  readonly licenses: readonly string[];
  readonly dynamicDependencies: readonly string[];
}

export interface NativeArtifactFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Read and validate the fixed-shape manifest before it becomes a compiler input. */
export async function readNativeArtifactManifest(
  directory: string,
): Promise<NativeArtifactManifest> {
  const path = join(directory, "manifest.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES)
    throw new Error("native manifest is not a bounded regular file");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("native manifest is not valid JSON");
  }
  return parseNativeArtifactManifest(value);
}

/** Verify every declared native file and the target's system-library allowlist. */
export async function verifyNativeArtifact(directory: string): Promise<NativeArtifactManifest> {
  const manifest = await readNativeArtifactManifest(directory);
  const expectedNames = new Set(["manifest.json", ...manifest.files.map((file) => file.path)]);
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== expectedNames.size ||
    entries.some(
      (entry) => !expectedNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink(),
    )
  )
    throw new Error("native artifact directory contains unexpected files");
  await Promise.all(
    manifest.files.map(async (file) => {
      const path = join(directory, file.path);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes)
        throw new Error(`native artifact file is invalid: ${file.path}`);
      if ((await sha256File(path)) !== file.sha256)
        throw new Error(`native artifact file digest does not match: ${file.path}`);
    }),
  );
  const executable = manifest.files.find((file) => file.path === manifest.executable);
  const executableInfo = await lstat(join(directory, manifest.executable));
  if (!executable || (executableInfo.mode & 0o111) === 0)
    throw new Error("native executable is missing execute permissions");
  const target = `${manifest.platform}-${manifest.arch}`;
  const allowed =
    target === "darwin-arm64" || target === "linux-x64"
      ? NATIVE_SYSTEM_DEPENDENCIES[target]
      : undefined;
  if (
    allowed === undefined ||
    manifest.dynamicDependencies.some((dependency) => !allowed.has(dependency))
  )
    throw new Error("native artifact links an unsupported dynamic dependency");
  return manifest;
}

/** Ensure the copied native directory is the one whose manifest was compiled into the CLI. */
export function assertNativeArtifactMatch(
  expected: NativeArtifactManifest,
  actual: NativeArtifactManifest,
): void {
  if (!isDeepStrictEqual(actual, expected))
    throw new Error("native artifact manifest differs from the compiled CLI manifest");
}

/** Source runs accept local compiler bytes but require the reviewed native recipe and model contract. */
export function assertSourceNativeArtifactMatch(
  expected: NativeArtifactManifest,
  actual: NativeArtifactManifest,
): void {
  if (
    actual.recipeIdentity !== expected.recipeIdentity ||
    actual.platform !== expected.platform ||
    actual.arch !== expected.arch ||
    actual.executable !== expected.executable ||
    !isDeepStrictEqual(actual.model, expected.model) ||
    !isDeepStrictEqual(actual.source, expected.source) ||
    actual.patchSha256 !== expected.patchSha256 ||
    !isDeepStrictEqual(actual.cmakeFlags, expected.cmakeFlags)
  ) {
    throw new Error("native artifact manifest differs from the current source recipe");
  }
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export function parseNativeArtifactManifest(value: unknown): NativeArtifactManifest {
  const manifest = object(value, "manifest");
  assertKeys(
    manifest,
    [
      "schemaVersion",
      "buildIdentity",
      "recipeIdentity",
      "platform",
      "arch",
      "executable",
      "source",
      "patchSha256",
      "toolchain",
      "cmakeFlags",
      "model",
      "files",
      "licenses",
      "dynamicDependencies",
    ],
    "manifest",
  );
  const platform = text(manifest.platform, "manifest.platform");
  const arch = text(manifest.arch, "manifest.arch");
  if (
    manifest.schemaVersion !== 1 ||
    (platform !== "darwin" && platform !== "linux") ||
    (arch !== "arm64" && arch !== "x64") ||
    !Object.hasOwn(NATIVE_SYSTEM_DEPENDENCIES, `${platform}-${arch}`)
  )
    throw new Error("native manifest target is unsupported");
  const files = array(manifest.files, "manifest.files").map((entry, index) => {
    const file = object(entry, `manifest.files[${index}]`);
    assertKeys(file, ["path", "bytes", "sha256"], `manifest.files[${index}]`);
    const path = fileName(file.path, `manifest.files[${index}].path`);
    const bytes = nonNegativeInteger(file.bytes, `manifest.files[${index}].bytes`);
    return { path, bytes, sha256: digest(file.sha256, `manifest.files[${index}].sha256`) };
  });
  if (files.length === 0 || new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("native manifest files must be unique and nonempty");
  const licenses = strings(manifest.licenses, "manifest.licenses");
  if (
    new Set(licenses).size !== licenses.length ||
    licenses.some((path) => !files.some((file) => file.path === path))
  )
    throw new Error("native manifest licenses must name declared files");
  const source = object(manifest.source, "manifest.source");
  assertKeys(source, ["tag", "commit", "archiveSha256"], "manifest.source");
  const toolchain = object(manifest.toolchain, "manifest.toolchain");
  assertKeys(toolchain, ["cmake", "compiler"], "manifest.toolchain");
  const model = object(manifest.model, "manifest.model");
  assertKeys(model, ["fileName", "bytes", "sha256"], "manifest.model");
  const executable = fileName(manifest.executable, "manifest.executable");
  if (!files.some((file) => file.path === executable))
    throw new Error("native executable is not declared as a file");
  return {
    schemaVersion: 1,
    buildIdentity: digest(manifest.buildIdentity, "manifest.buildIdentity"),
    recipeIdentity: digest(manifest.recipeIdentity, "manifest.recipeIdentity"),
    platform,
    arch,
    executable,
    source: {
      tag: text(source.tag, "manifest.source.tag"),
      commit: text(source.commit, "manifest.source.commit"),
      archiveSha256: digest(source.archiveSha256, "manifest.source.archiveSha256"),
    },
    patchSha256: digest(manifest.patchSha256, "manifest.patchSha256"),
    toolchain: {
      cmake: text(toolchain.cmake, "manifest.toolchain.cmake"),
      compiler: text(toolchain.compiler, "manifest.toolchain.compiler"),
    },
    cmakeFlags: strings(manifest.cmakeFlags, "manifest.cmakeFlags"),
    model: {
      fileName: fileName(model.fileName, "manifest.model.fileName"),
      bytes: nonNegativeInteger(model.bytes, "manifest.model.bytes"),
      sha256: digest(model.sha256, "manifest.model.sha256"),
    },
    files,
    licenses,
    dynamicDependencies: strings(manifest.dynamicDependencies, "manifest.dynamicDependencies"),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function strings(value: unknown, label: string): readonly string[] {
  return array(value, label).map((entry, index) => text(entry, `${label}[${index}]`));
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`);
  return value;
}

function fileName(value: unknown, label: string): string {
  const name = text(value, label);
  if (!FILE_NAME.test(name)) throw new Error(`${label} must be a safe file name`);
  return name;
}

function digest(value: unknown, label: string): string {
  const hash = text(value, label);
  if (!SHA256.test(hash)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return hash;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
}

function assertKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedKeys = new Set(expected);
  if (Object.keys(record).some((key) => !expectedKeys.has(key)))
    throw new Error(`${label} contains unknown fields`);
}
