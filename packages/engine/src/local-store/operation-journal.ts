import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { StoreInvariantError } from "./errors";
import { parseInstalledPacksManifest, type InstalledPacksManifest } from "./manifest";
import type { StorageRoot } from "./types";

const OPERATION_JOURNAL_SCHEMA_VERSION = 1;
const OPERATIONS_DIRECTORY = "operations";

export type LocalStoreOperationKind = "install" | "upgrade" | "uninstall";

export interface OperationJournal {
  readonly schemaVersion: number;
  readonly operationId: string;
  readonly kind: LocalStoreOperationKind;
  readonly oldManifest: InstalledPacksManifest;
  readonly targetManifest: InstalledPacksManifest;
}

export function operationJournalPath(root: StorageRoot, operationId: string): string {
  if (!isSafeOperationId(operationId)) {
    throw new StoreInvariantError(`Unsafe operation journal id "${operationId}"`);
  }
  return join(root.path, OPERATIONS_DIRECTORY, `${operationId}.json`);
}

export async function writeOperationJournal(
  root: StorageRoot,
  journal: OperationJournal,
): Promise<void> {
  const directory = join(root.path, OPERATIONS_DIRECTORY);
  await mkdir(directory, { recursive: true });

  const path = operationJournalPath(root, journal.operationId);
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function loadOperationJournals(
  root: StorageRoot,
): Promise<readonly OperationJournal[]> {
  const directory = join(root.path, OPERATIONS_DIRECTORY);
  let entries: readonly string[];
  try {
    entries = await readdir(directory);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return [];
    throw new StoreInvariantError(`Unable to read operation journals: ${errorMessage(error)}`);
  }

  const journalPaths = entries.filter((entry) => entry.endsWith(".json")).sort();
  return Promise.all(journalPaths.map((entry) => loadOperationJournal(directory, entry)));
}

async function loadOperationJournal(directory: string, entry: string): Promise<OperationJournal> {
  const path = join(directory, entry);
  try {
    const content = await readFile(path, "utf8");
    const journal = parseOperationJournal(JSON.parse(content) as unknown);
    if (entry !== `${journal.operationId}.json`) {
      throw new StoreInvariantError(
        `Operation journal filename does not match id "${journal.operationId}"`,
      );
    }
    return journal;
  } catch (error: unknown) {
    if (error instanceof StoreInvariantError) throw error;
    throw new StoreInvariantError(
      `Unable to read operation journal "${entry}": ${errorMessage(error)}`,
    );
  }
}

export async function removeOperationJournal(
  root: StorageRoot,
  operationId: string,
): Promise<void> {
  await rm(operationJournalPath(root, operationId), { force: true });
}

export function createOperationJournal(
  operationId: string,
  kind: LocalStoreOperationKind,
  oldManifest: InstalledPacksManifest,
  targetManifest: InstalledPacksManifest,
): OperationJournal {
  return {
    schemaVersion: OPERATION_JOURNAL_SCHEMA_VERSION,
    operationId,
    kind,
    oldManifest,
    targetManifest,
  };
}

function parseOperationJournal(value: unknown): OperationJournal {
  if (value === null || typeof value !== "object") {
    throw new StoreInvariantError("Operation journal is not an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== OPERATION_JOURNAL_SCHEMA_VERSION ||
    !isSafeOperationId(record.operationId) ||
    !isOperationKind(record.kind)
  ) {
    throw new StoreInvariantError("Operation journal has an unsupported shape");
  }

  const oldManifest = parseInstalledPacksManifest(record.oldManifest);
  const targetManifest = parseInstalledPacksManifest(record.targetManifest);
  if (targetManifest.generation !== oldManifest.generation + 1) {
    throw new StoreInvariantError("Operation journal has non-sequential manifest generations");
  }

  return {
    schemaVersion: record.schemaVersion,
    operationId: record.operationId,
    kind: record.kind,
    oldManifest,
    targetManifest,
  };
}

function isOperationKind(value: unknown): value is LocalStoreOperationKind {
  return value === "install" || value === "upgrade" || value === "uninstall";
}

function isSafeOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]+$/.test(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
