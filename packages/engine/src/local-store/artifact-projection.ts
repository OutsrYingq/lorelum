import { canonicalContent, canonicalContentDigest, normalizeSnapshotPath } from "./canonicalize";
import { InvalidPreparedPackError, StoreInvariantError } from "./errors";
import type { PreparedPack, SnapshotFile } from "./types";

export const LOCAL_STORE_PROJECTION_PATH = ".lorelum/local-store-projection.json";
const LOCAL_STORE_PROJECTION_SCHEMA_VERSION = 1;

export interface ArtifactProjectionPractice {
  readonly id: string;
  readonly canonicalContent: string;
  readonly contentDigest: string;
  readonly sourcePath: string;
}

export interface ArtifactProjection {
  readonly schemaVersion: number;
  readonly pack: {
    readonly name: string;
    readonly version: string;
  };
  readonly practices: readonly ArtifactProjectionPractice[];
}

export function createArtifactProjection(
  pack: { readonly name: string; readonly version: string },
  practices: readonly ArtifactProjectionPractice[],
): ArtifactProjection {
  return {
    schemaVersion: LOCAL_STORE_PROJECTION_SCHEMA_VERSION,
    pack: { name: pack.name, version: pack.version },
    practices: [...practices].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function projectionSnapshotFile(projection: ArtifactProjection): SnapshotFile {
  return {
    relativePath: LOCAL_STORE_PROJECTION_PATH,
    bytes: new TextEncoder().encode(JSON.stringify(projection)),
  };
}

export function readArtifactProjection(files: readonly SnapshotFile[]): ArtifactProjection {
  const file = files.find((entry) => entry.relativePath === LOCAL_STORE_PROJECTION_PATH);
  if (file === undefined) {
    throw new StoreInvariantError("Active artifact has no LocalStore projection");
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)) as unknown;
  } catch (error: unknown) {
    throw new StoreInvariantError(
      `Active artifact has an unreadable LocalStore projection: ${errorMessage(error)}`,
    );
  }
  const projection = parseArtifactProjection(value);
  const filePaths = new Set(files.map((entry) => entry.relativePath));
  for (const practice of projection.practices) {
    if (!filePaths.has(practice.sourcePath)) {
      throw new StoreInvariantError(
        `LocalStore projection source "${practice.sourcePath}" is absent from the artifact`,
      );
    }
  }
  return projection;
}

export function assertProjectionMatchesPreparedPack(
  projection: ArtifactProjection,
  prepared: Pick<PreparedPack, "input" | "practiceSourcePaths">,
): void {
  if (
    projection.pack.name !== prepared.input.pack.name ||
    projection.pack.version !== prepared.input.pack.version
  ) {
    throw new StoreInvariantError(
      "LocalStore projection Pack metadata does not match the snapshot",
    );
  }
  if (projection.practices.length !== prepared.input.practices.length) {
    throw new StoreInvariantError("LocalStore projection Practices do not match the snapshot");
  }

  const practicesById = new Map(
    prepared.input.practices.map((practice) => [practice.id, practice]),
  );
  for (const projectedPractice of projection.practices) {
    const practice = practicesById.get(projectedPractice.id);
    if (practice === undefined) {
      throw new StoreInvariantError(
        `LocalStore projection references unknown Practice "${projectedPractice.id}"`,
      );
    }
    const sourcePath = prepared.practiceSourcePaths.get(projectedPractice.id);
    if (
      sourcePath === undefined ||
      normalizeSnapshotPath(sourcePath) !== projectedPractice.sourcePath ||
      canonicalContent(practice) !== projectedPractice.canonicalContent ||
      canonicalContentDigest(projectedPractice.canonicalContent) !== projectedPractice.contentDigest
    ) {
      throw new StoreInvariantError(
        `LocalStore projection does not match Practice "${projectedPractice.id}"`,
      );
    }
  }
}

function parseArtifactProjection(value: unknown): ArtifactProjection {
  if (!isRecord(value)) {
    throw new StoreInvariantError("LocalStore projection must be an object");
  }
  if (value.schemaVersion !== LOCAL_STORE_PROJECTION_SCHEMA_VERSION) {
    throw new StoreInvariantError(
      `Unsupported LocalStore projection schema version "${String(value.schemaVersion)}"`,
    );
  }
  if (
    !isRecord(value.pack) ||
    !isNonEmptyString(value.pack.name) ||
    !isNonEmptyString(value.pack.version)
  ) {
    throw new StoreInvariantError("LocalStore projection has invalid Pack metadata");
  }
  if (!Array.isArray(value.practices)) {
    throw new StoreInvariantError("LocalStore projection Practices must be an array");
  }

  const seenPracticeIds = new Set<string>();
  const practices = value.practices.map((practice) => {
    if (!isRecord(practice)) {
      throw new StoreInvariantError("LocalStore projection Practice must be an object");
    }
    if (
      !isNonEmptyString(practice.id) ||
      !isNonEmptyString(practice.canonicalContent) ||
      !isDigest(practice.contentDigest) ||
      !isNonEmptyString(practice.sourcePath)
    ) {
      throw new StoreInvariantError("LocalStore projection Practice has invalid fields");
    }
    const sourcePath = normalizeProjectionSourcePath(practice.sourcePath);
    if (canonicalContentDigest(practice.canonicalContent) !== practice.contentDigest) {
      throw new StoreInvariantError(
        `LocalStore projection Practice "${practice.id}" has an invalid content digest`,
      );
    }
    if (seenPracticeIds.has(practice.id)) {
      throw new StoreInvariantError(
        `LocalStore projection has duplicate Practice "${practice.id}"`,
      );
    }
    seenPracticeIds.add(practice.id);
    return {
      id: practice.id,
      canonicalContent: practice.canonicalContent,
      contentDigest: practice.contentDigest,
      sourcePath,
    };
  });

  return {
    schemaVersion: LOCAL_STORE_PROJECTION_SCHEMA_VERSION,
    pack: { name: value.pack.name, version: value.pack.version },
    practices,
  };
}

function normalizeProjectionSourcePath(path: string): string {
  try {
    const normalized = normalizeSnapshotPath(path);
    if (normalized !== path) {
      throw new StoreInvariantError(
        `LocalStore projection has non-normalized source path "${path}"`,
      );
    }
    return normalized;
  } catch (error: unknown) {
    if (error instanceof StoreInvariantError) throw error;
    if (error instanceof InvalidPreparedPackError) {
      throw new StoreInvariantError(
        `LocalStore projection has unsafe source path "${path}"`,
        error,
      );
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
