import { rename, rm } from "node:fs/promises";

import { validatePack, type Practice } from "@lorelum/format";

import { artifactPath, verifyArtifact } from "./artifact-store";
import {
  assertProjectionMatchesPreparedPack,
  readArtifactProjection,
  type ArtifactProjection,
} from "./artifact-projection";
import { canonicalContent, contentDigest, normalizeSnapshotPath, storageKey } from "./canonicalize";
import { databasePath, StoreDatabase } from "./database";
import { StoreReindexError } from "./errors";
import type { InstalledPacksManifest } from "./manifest";
import { loadOperationJournals } from "./operation-journal";
import { LocalStoreRepository } from "./repositories";
import type { InstalledPack, SnapshotCodec, SnapshotFile, StorageRoot } from "./types";

interface DecodedPractice {
  readonly practice: Practice;
  readonly canonicalContent: string;
  readonly contentDigest: string;
  readonly sourcePath: string;
}

interface DecodedPack {
  readonly pack: InstalledPack;
  readonly practices: readonly DecodedPractice[];
}

export async function reindexLocalStore(
  root: StorageRoot,
  manifest: InstalledPacksManifest,
  snapshotCodec: SnapshotCodec,
): Promise<void> {
  const journals = await loadOperationJournals(root);
  if (journals.length > 0) {
    throw new StoreReindexError(
      "LocalStore reindex cannot run while an interrupted operation requires recovery",
    );
  }
  const packs = await Promise.all(
    manifest.packs.map(async (pack) => {
      const files = await verifyArtifact(root, pack.storageKey, pack.artifactDigest);
      return decodeActivePack(root, pack, files, readArtifactProjection(files), snapshotCodec);
    }),
  );
  assertNoConflicts(packs);
  await rebuildDerivedDatabase(root, (database) => writeDerivedState(database, manifest, packs));
}

async function decodeActivePack(
  root: StorageRoot,
  pack: InstalledPack,
  files: readonly SnapshotFile[],
  projection: ArtifactProjection,
  snapshotCodec: SnapshotCodec,
): Promise<DecodedPack> {
  if (pack.storageKey !== storageKey(pack.name)) {
    throw new StoreReindexError(
      `Active Pack "${pack.name}" has an invalid storage key in the manifest`,
    );
  }
  let decoded;
  try {
    decoded = await snapshotCodec.decode(artifactPath(root, pack.storageKey, pack.artifactDigest));
  } catch (error: unknown) {
    throw new StoreReindexError(
      `Unable to decode active Pack "${pack.name}": ${errorMessage(error)}`,
      error,
    );
  }

  const validation = validatePack(decoded.input);
  if (!validation.valid) {
    throw new StoreReindexError(`Active Pack "${pack.name}" no longer passes format validation`);
  }
  if (decoded.input.pack.name !== pack.name || decoded.input.pack.version !== pack.version) {
    throw new StoreReindexError(
      `Active artifact for Pack "${pack.name}" does not match manifest metadata`,
    );
  }
  if (decoded.practiceSourcePaths.size !== decoded.input.practices.length) {
    throw new StoreReindexError(
      `Active artifact for Pack "${pack.name}" has incomplete Practice source paths`,
    );
  }
  try {
    assertProjectionMatchesPreparedPack(projection, decoded);
  } catch (error: unknown) {
    throw new StoreReindexError(
      `Active artifact for Pack "${pack.name}" does not match its LocalStore projection: ${errorMessage(error)}`,
      error,
    );
  }

  const filePaths = new Set(files.map((file) => file.relativePath));
  const practices: DecodedPractice[] = [];
  for (const practice of decoded.input.practices) {
    const sourcePath = decoded.practiceSourcePaths.get(practice.id);
    if (sourcePath === undefined) {
      throw new StoreReindexError(
        `Active artifact for Pack "${pack.name}" has no source path for Practice "${practice.id}"`,
      );
    }
    const normalizedSourcePath = normalizeSnapshotPath(sourcePath);
    if (!filePaths.has(normalizedSourcePath)) {
      throw new StoreReindexError(
        `Active artifact for Pack "${pack.name}" is missing source "${normalizedSourcePath}"`,
      );
    }
    practices.push({
      practice,
      canonicalContent: canonicalContent(practice),
      contentDigest: contentDigest(practice),
      sourcePath: normalizedSourcePath,
    });
  }
  return { pack, practices };
}

function assertNoConflicts(packs: readonly DecodedPack[]): void {
  const contentByPracticeId = new Map<string, { digest: string; packName: string }>();
  for (const pack of packs) {
    for (const practice of pack.practices) {
      const existing = contentByPracticeId.get(practice.practice.id);
      if (existing !== undefined && existing.digest !== practice.contentDigest) {
        throw new StoreReindexError(
          `Active Pack "${pack.pack.name}" conflicts with "${existing.packName}" for Practice "${practice.practice.id}"`,
        );
      }
      contentByPracticeId.set(practice.practice.id, {
        digest: practice.contentDigest,
        packName: pack.pack.name,
      });
    }
  }
}

function writeDerivedState(
  database: StoreDatabase,
  manifest: InstalledPacksManifest,
  packs: readonly DecodedPack[],
): void {
  const repository = new LocalStoreRepository(database.connection);
  const effectiveRevision = nextReindexRevision(manifest.generation);

  const effectivePractices = new Map<string, DecodedPractice>();
  for (const pack of packs) {
    repository.savePack(pack.pack);
    for (const practice of pack.practices) {
      repository.addSource(
        pack.pack.name,
        practice.practice.id,
        practice.contentDigest,
        practice.sourcePath,
      );
      if (!effectivePractices.has(practice.practice.id)) {
        effectivePractices.set(practice.practice.id, practice);
      }
    }
  }
  for (const practice of effectivePractices.values()) {
    repository.saveEffectivePractice(
      practice.practice,
      practice.canonicalContent,
      practice.contentDigest,
      effectiveRevision,
    );
  }
  repository.setState({
    installedPacksGeneration: manifest.generation,
    effectiveRevision,
  });
}

async function rebuildDerivedDatabase(
  root: StorageRoot,
  populate: (database: StoreDatabase) => void,
): Promise<void> {
  const database = openHealthyDatabase(root);
  if (database !== undefined) {
    try {
      database.transaction(() => {
        clearDerivedState(database);
        populate(database);
      });
      database.assertHealthy();
      return;
    } catch (error: unknown) {
      if (error instanceof StoreReindexError) throw error;
      throw new StoreReindexError(
        `Unable to rebuild LocalStore SQLite state: ${errorMessage(error)}`,
        error,
      );
    } finally {
      database.close();
    }
  }

  await replaceUnusableDatabase(root, populate);
}

function openHealthyDatabase(root: StorageRoot): StoreDatabase | undefined {
  let database: StoreDatabase | undefined;
  try {
    database = new StoreDatabase(root);
    database.assertHealthy();
    return database;
  } catch {
    database?.close();
    return undefined;
  }
}

function clearDerivedState(database: StoreDatabase): void {
  database.connection.exec(`
    DELETE FROM active_packs;
    DELETE FROM effective_practices;
  `);
}

async function replaceUnusableDatabase(
  root: StorageRoot,
  populate: (database: StoreDatabase) => void,
): Promise<void> {
  const targetPath = databasePath(root);
  const temporaryPath = `${targetPath}.${crypto.randomUUID()}.reindex`;
  let database: StoreDatabase | undefined;
  try {
    database = new StoreDatabase(root, temporaryPath);
    const replacementDatabase = database;
    replacementDatabase.transaction(() => populate(replacementDatabase));
    replacementDatabase.assertHealthy();
    replacementDatabase.close();
    database = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error: unknown) {
    database?.close();
    await rm(temporaryPath, { force: true });
    if (error instanceof StoreReindexError) throw error;
    throw new StoreReindexError(
      `Unable to rebuild LocalStore SQLite state: ${errorMessage(error)}`,
      error,
    );
  }
}

function nextReindexRevision(manifestGeneration: number): number {
  if (manifestGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new StoreReindexError("Manifest generation cannot produce a new effective revision");
  }
  return manifestGeneration + 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
