import { cleanupUnreferencedArtifacts, verifyArtifact } from "./artifact-store";
import { storageKey } from "./canonicalize";
import { StoreRecoveryRequiredError } from "./errors";
import type { InstalledPacksManifest } from "./manifest";
import { writeManifest } from "./manifest";
import {
  loadOperationJournals,
  removeOperationJournal,
  type OperationJournal,
} from "./operation-journal";
import type { LocalStoreRepository } from "./repositories";
import type { StorageRoot } from "./types";

export async function recoverInterruptedMutation(
  root: StorageRoot,
  manifest: InstalledPacksManifest,
  installedPacksGeneration: number,
): Promise<InstalledPacksManifest> {
  const journals = await loadOperationJournals(root);
  if (journals.length === 0) return manifest;
  if (journals.length > 1) {
    throw new StoreRecoveryRequiredError(
      "Multiple incomplete LocalStore operations require recovery",
    );
  }

  const journal = journals[0];
  if (journal === undefined) {
    throw new StoreRecoveryRequiredError("Unable to identify incomplete LocalStore operation");
  }
  return recoverJournal(root, journal, installedPacksGeneration);
}

export async function verifyOpenState(
  root: StorageRoot,
  repository: LocalStoreRepository,
  manifest: InstalledPacksManifest,
): Promise<void> {
  const activeArtifacts = new Set(
    manifest.packs.map((pack) => `${pack.storageKey}/${pack.artifactDigest}`),
  );
  await Promise.all(
    manifest.packs.map(async (pack) => {
      if (pack.storageKey !== storageKey(pack.name)) {
        throw new StoreRecoveryRequiredError(
          `Active Pack "${pack.name}" has an invalid storage key in the manifest`,
        );
      }
      await verifyArtifact(root, pack.storageKey, pack.artifactDigest);
    }),
  );
  repository.assertConsistent(manifest);
  await cleanupUnreferencedArtifacts(root, activeArtifacts);
}

async function recoverJournal(
  root: StorageRoot,
  journal: OperationJournal,
  installedPacksGeneration: number,
): Promise<InstalledPacksManifest> {
  if (installedPacksGeneration === journal.targetManifest.generation) {
    await writeManifest(root, journal.targetManifest);
    await removeOperationJournal(root, journal.operationId);
    return journal.targetManifest;
  }
  if (installedPacksGeneration === journal.oldManifest.generation) {
    await writeManifest(root, journal.oldManifest);
    await removeOperationJournal(root, journal.operationId);
    return journal.oldManifest;
  }

  throw new StoreRecoveryRequiredError(
    `Interrupted ${journal.kind} has SQLite generation ${installedPacksGeneration}, expected ${journal.oldManifest.generation} or ${journal.targetManifest.generation}`,
  );
}
