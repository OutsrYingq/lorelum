import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { StoreBusyError } from "./errors";
import type { StorageRoot } from "./types";

const LOCK_DATABASE_FILE = "mutation-lock.sqlite";
const LOCK_TIMEOUT_MS = 5_000;
const processLocks = new Map<string, Promise<void>>();

export async function withMutationLock<T>(
  root: StorageRoot,
  operation: () => Promise<T>,
): Promise<T> {
  const releaseProcessLock = await acquireProcessLock(root);
  let database: Database | undefined;
  try {
    database = await acquireDatabaseLock(root);
    return await operation();
  } finally {
    try {
      releaseDatabaseLock(database);
    } finally {
      releaseProcessLock();
    }
  }
}

function mutationLockPath(root: StorageRoot): string {
  return join(root.path, LOCK_DATABASE_FILE);
}

async function acquireProcessLock(root: StorageRoot): Promise<() => void> {
  const key = resolve(root.path);
  const previous = processLocks.get(key) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrent = resolveCurrent;
  });
  const queue = previous.then(() => current);
  processLocks.set(key, queue);
  await previous;

  return () => {
    releaseCurrent?.();
    if (processLocks.get(key) === queue) {
      processLocks.delete(key);
    }
  };
}

async function acquireDatabaseLock(root: StorageRoot): Promise<Database> {
  const path = mutationLockPath(root);
  await mkdir(root.path, { recursive: true });
  const database = new Database(path, { strict: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${LOCK_TIMEOUT_MS}; BEGIN IMMEDIATE`);
    return database;
  } catch (error: unknown) {
    database.close();
    if (isBusyError(error)) throw new StoreBusyError(path);
    throw error;
  }
}

function releaseDatabaseLock(database: Database | undefined): void {
  if (database === undefined) return;
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

function isBusyError(error: unknown): error is { readonly code: string } {
  return error instanceof Error && "code" in error && error.code === "SQLITE_BUSY";
}
