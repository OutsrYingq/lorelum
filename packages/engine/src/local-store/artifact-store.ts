import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";

import { artifactDigest, normalizeSnapshotPath } from "./canonicalize";
import { InvalidPreparedPackError, StoreInvariantError } from "./errors";
import type { SnapshotFile, StorageRoot } from "./types";

export interface StagedArtifact {
  readonly directory: string;
}

export function artifactPath(root: StorageRoot, storageKey: string, digest: string): string {
  const packsRoot = resolve(root.path, "packs");
  const path = resolve(packsRoot, storageKey, digest);
  if (relative(packsRoot, path).startsWith("..")) {
    throw new InvalidPreparedPackError("Artifact path escapes StorageRoot");
  }
  return path;
}

export async function stageArtifact(
  root: StorageRoot,
  operationId: string,
  files: readonly SnapshotFile[],
): Promise<StagedArtifact> {
  const directory = join(root.path, "staging", operationId);
  const seen = new Set<string>();
  await mkdir(directory, { recursive: true });

  try {
    const writes: Promise<void>[] = [];
    for (const file of files) {
      const path = normalizeSnapshotPath(file.relativePath);
      if (seen.has(path)) {
        throw new InvalidPreparedPackError(`Duplicate snapshot path "${path}"`);
      }
      seen.add(path);

      const destination = safeDescendant(directory, path);
      writes.push(
        mkdir(join(destination, ".."), { recursive: true }).then(() =>
          writeFile(destination, file.bytes),
        ),
      );
    }

    const results = await Promise.allSettled(writes);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  } catch (error: unknown) {
    await discardStagedArtifact(root, { directory });
    throw error;
  }

  return { directory };
}

export async function promoteArtifact(
  root: StorageRoot,
  staged: StagedArtifact,
  storageKey: string,
  digest: string,
): Promise<void> {
  const destination = artifactPath(root, storageKey, digest);
  await mkdir(join(destination, ".."), { recursive: true });

  try {
    await access(destination);
    await discardStagedArtifact(root, staged);
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await rename(staged.directory, destination);
  }
}

export async function discardStagedArtifact(
  root: StorageRoot,
  staged: StagedArtifact,
): Promise<void> {
  const stagingRoot = resolve(root.path, "staging");
  const target = resolve(staged.directory);
  if (relative(stagingRoot, target).startsWith("..")) {
    throw new InvalidPreparedPackError(
      "Refusing to remove a staging directory outside StorageRoot",
    );
  }
  await rm(target, { recursive: true, force: true });
}

export async function removeArtifact(
  root: StorageRoot,
  storageKey: string,
  digest: string,
): Promise<void> {
  const packsRoot = resolve(root.path, "packs");
  const target = resolve(artifactPath(root, storageKey, digest));
  if (relative(packsRoot, target).startsWith("..")) {
    throw new InvalidPreparedPackError("Refusing to remove an artifact outside StorageRoot");
  }
  await rm(target, { recursive: true, force: true });
}

export async function verifyArtifact(
  root: StorageRoot,
  storageKey: string,
  expectedDigest: string,
): Promise<readonly SnapshotFile[]> {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new StoreInvariantError(`Invalid artifact digest "${expectedDigest}"`);
  }

  const directory = artifactPath(root, storageKey, expectedDigest);
  let files: readonly SnapshotFile[];
  try {
    files = await readSnapshotFiles(directory);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      throw new StoreInvariantError(`Active artifact "${expectedDigest}" is missing`);
    }
    if (error instanceof InvalidPreparedPackError || error instanceof StoreInvariantError) {
      throw error;
    }
    throw new StoreInvariantError(
      `Unable to read active artifact "${expectedDigest}": ${errorMessage(error)}`,
    );
  }

  if (artifactDigest(files) !== expectedDigest) {
    throw new StoreInvariantError(`Active artifact "${expectedDigest}" does not match its digest`);
  }
  return files;
}

export async function cleanupUnreferencedArtifacts(
  root: StorageRoot,
  activeArtifacts: ReadonlySet<string>,
): Promise<void> {
  const stagingPath = resolve(root.path, "staging");
  await rm(stagingPath, { recursive: true, force: true });

  const packsRoot = resolve(root.path, "packs");
  let storageEntries: readonly Dirent<string>[];
  try {
    storageEntries = await readdir(packsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return;
    throw new StoreInvariantError(`Unable to inspect artifact directory: ${errorMessage(error)}`);
  }

  await Promise.all(
    storageEntries.map((storageEntry) =>
      cleanupStorageEntry(packsRoot, storageEntry, activeArtifacts),
    ),
  );
}

function safeDescendant(root: string, relativePath: string): string {
  const destination = resolve(root, ...relativePath.split("/"));
  if (relative(resolve(root), destination).startsWith("..")) {
    throw new InvalidPreparedPackError(`Unsafe snapshot path "${relativePath}"`);
  }
  return destination;
}

async function readSnapshotFiles(directory: string): Promise<readonly SnapshotFile[]> {
  return collectSnapshotFiles(directory, directory);
}

async function collectSnapshotFiles(
  root: string,
  directory: string,
): Promise<readonly SnapshotFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map((entry) => readArtifactEntry(root, directory, entry)),
  );
  return nestedFiles.flat();
}

async function readArtifactEntry(
  root: string,
  directory: string,
  entry: Dirent<string>,
): Promise<readonly SnapshotFile[]> {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) {
    return collectSnapshotFiles(root, path);
  }
  if (!entry.isFile()) {
    throw new StoreInvariantError(`Artifact contains unsupported entry "${entry.name}"`);
  }
  const relativePath = normalizeSnapshotPath(relative(root, path).replace(/\\/g, "/"));
  return [{ relativePath, bytes: await readFile(path) }];
}

async function cleanupStorageEntry(
  packsRoot: string,
  storageEntry: Dirent<string>,
  activeArtifacts: ReadonlySet<string>,
): Promise<void> {
  const storageDirectory = resolve(packsRoot, storageEntry.name);
  if (relative(packsRoot, storageDirectory).startsWith("..")) {
    throw new StoreInvariantError("Artifact directory escapes StorageRoot");
  }
  if (!storageEntry.isDirectory()) {
    await rm(storageDirectory, { recursive: true, force: true });
    return;
  }

  const artifactEntries = await readdir(storageDirectory, { withFileTypes: true });
  await Promise.all(
    artifactEntries.map(async (artifactEntry) => {
      const artifactDirectory = resolve(storageDirectory, artifactEntry.name);
      if (relative(storageDirectory, artifactDirectory).startsWith("..")) {
        throw new StoreInvariantError("Artifact entry escapes StorageRoot");
      }
      const key = `${storageEntry.name}/${artifactEntry.name}`;
      if (!activeArtifacts.has(key)) {
        await rm(artifactDirectory, { recursive: true, force: true });
      }
    }),
  );

  if ((await readdir(storageDirectory)).length === 0) {
    await rm(storageDirectory, { recursive: true, force: true });
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
