import type { Database } from "bun:sqlite";

import type { AntiPattern, Practice } from "@lorelum/format";

import type { ArtifactProjection } from "./artifact-projection";
import { canonicalContent, canonicalContentDigest } from "./canonicalize";
import { StoreInvariantError } from "./errors";
import type { InstalledPacksManifest } from "./manifest";
import type { InstalledPack, EffectivePractice, LocalStoreState } from "./types";

interface SourceRow {
  readonly pack_name: string;
  readonly practice_id: string;
  readonly content_digest: string;
  readonly source_path: string;
}

interface EffectivePracticeRow {
  readonly practice_id: string;
  readonly content_digest: string;
  readonly canonical_content: string;
  readonly title: string;
  readonly stage: string;
  readonly tech_stack_json: string;
  readonly applies_when: string;
  readonly severity: NonNullable<Practice["severity"]>;
  readonly body: string;
  readonly anti_patterns_json: string;
  readonly effective_revision: number;
}

interface ActivePackRow {
  readonly pack_name: string;
  readonly pack_version: string;
  readonly artifact_digest: string;
  readonly storage_key: string;
  readonly installed_at: string;
}

export class LocalStoreRepository {
  constructor(private readonly database: Database) {}

  state(): LocalStoreState {
    return {
      installedPacksGeneration: this.metadataNumber("installed_packs_generation"),
      effectiveRevision: this.metadataNumber("effective_revision"),
    };
  }

  installedPack(name: string): InstalledPack | null {
    const row = this.database
      .query<ActivePackRow, [string]>(
        `SELECT pack_name, pack_version, artifact_digest, storage_key, installed_at
         FROM active_packs WHERE pack_name = ?`,
      )
      .get(name);
    return row === null ? null : toInstalledPack(row);
  }

  allInstalledPacks(): readonly InstalledPack[] {
    return this.database
      .query<ActivePackRow, []>(
        `SELECT pack_name, pack_version, artifact_digest, storage_key, installed_at
         FROM active_packs ORDER BY pack_name`,
      )
      .all()
      .map(toInstalledPack);
  }

  sourcesForPractice(practiceId: string): readonly SourceRow[] {
    return this.database
      .query<SourceRow, [string]>(
        `SELECT pack_name, practice_id, content_digest, source_path
         FROM practice_sources WHERE practice_id = ? ORDER BY pack_name`,
      )
      .all(practiceId);
  }

  sourcesForPack(packName: string): readonly SourceRow[] {
    return this.database
      .query<SourceRow, [string]>(
        `SELECT pack_name, practice_id, content_digest, source_path
         FROM practice_sources WHERE pack_name = ? ORDER BY practice_id`,
      )
      .all(packName);
  }

  effectivePractice(practiceId: string): EffectivePractice | null {
    const row = this.database
      .query<EffectivePracticeRow, [string]>(
        `SELECT practice_id, content_digest, canonical_content, title, stage, tech_stack_json,
                applies_when, severity, body, anti_patterns_json, effective_revision
         FROM effective_practices WHERE practice_id = ?`,
      )
      .get(practiceId);
    return row === null ? null : this.toEffectivePractice(row);
  }

  allEffectivePractices(): readonly EffectivePractice[] {
    return this.database
      .query<EffectivePracticeRow, []>(
        `SELECT practice_id, content_digest, canonical_content, title, stage, tech_stack_json,
                applies_when, severity, body, anti_patterns_json, effective_revision
         FROM effective_practices ORDER BY practice_id`,
      )
      .all()
      .map((row) => this.toEffectivePractice(row));
  }

  deletePack(packName: string): void {
    this.database
      .query<unknown, [string]>("DELETE FROM active_packs WHERE pack_name = ?")
      .run(packName);
  }

  savePack(pack: InstalledPack): void {
    this.database
      .query<unknown, [string, string, string, string, string]>(
        `INSERT INTO active_packs(pack_name, pack_version, artifact_digest, storage_key, installed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pack_name) DO UPDATE SET
           pack_version = excluded.pack_version,
           artifact_digest = excluded.artifact_digest,
           storage_key = excluded.storage_key,
           installed_at = excluded.installed_at`,
      )
      .run(pack.name, pack.version, pack.artifactDigest, pack.storageKey, pack.installedAt);
  }

  addSource(packName: string, practiceId: string, contentDigest: string, sourcePath: string): void {
    this.database
      .query<unknown, [string, string, string, string]>(
        `INSERT INTO practice_sources(pack_name, practice_id, content_digest, source_path)
         VALUES (?, ?, ?, ?)`,
      )
      .run(packName, practiceId, contentDigest, sourcePath);
  }

  deleteSourcesForPack(packName: string): void {
    this.database
      .query<unknown, [string]>("DELETE FROM practice_sources WHERE pack_name = ?")
      .run(packName);
  }

  saveEffectivePractice(
    practice: Practice,
    practiceCanonicalContent: string,
    contentDigest: string,
    effectiveRevision: number,
  ): void {
    this.database
      .query<
        unknown,
        [string, string, string, string, string, string, string, string, string, string, number]
      >(
        `INSERT INTO effective_practices(
           practice_id, content_digest, canonical_content, title, stage, tech_stack_json,
           applies_when, severity, body, anti_patterns_json, effective_revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(practice_id) DO UPDATE SET
           content_digest = excluded.content_digest,
           canonical_content = excluded.canonical_content,
           title = excluded.title,
           stage = excluded.stage,
           tech_stack_json = excluded.tech_stack_json,
           applies_when = excluded.applies_when,
           severity = excluded.severity,
           body = excluded.body,
           anti_patterns_json = excluded.anti_patterns_json,
           effective_revision = excluded.effective_revision`,
      )
      .run(
        practice.id,
        contentDigest,
        practiceCanonicalContent,
        practice.title,
        practice.stage,
        JSON.stringify(practice.tech_stack),
        practice.applies_when,
        practice.severity ?? "warn",
        practice.body ?? "",
        JSON.stringify(practice.anti_patterns ?? []),
        effectiveRevision,
      );
  }

  deleteEffectivePractice(practiceId: string): void {
    this.database
      .query<unknown, [string]>("DELETE FROM effective_practices WHERE practice_id = ?")
      .run(practiceId);
  }

  setState(state: LocalStoreState): void {
    this.setMetadata("installed_packs_generation", String(state.installedPacksGeneration));
    this.setMetadata("effective_revision", String(state.effectiveRevision));
  }

  assertConsistent(manifest: InstalledPacksManifest): void {
    const manifestPacks = manifest.packs;
    const databasePacks = this.allInstalledPacks();
    if (
      manifestPacks.length !== databasePacks.length ||
      manifestPacks.some((pack, index) => !sameInstalledPack(pack, databasePacks[index]))
    ) {
      throw new StoreInvariantError("SQLite active Packs do not match the installed-pack manifest");
    }

    const sources = this.database
      .query<SourceRow, []>(
        `SELECT pack_name, practice_id, content_digest, source_path
         FROM practice_sources ORDER BY practice_id, pack_name`,
      )
      .all();
    const manifestPackNames = new Set(manifestPacks.map((pack) => pack.name));
    const sourcesByPractice = new Map<string, SourceRow[]>();
    for (const source of sources) {
      if (!manifestPackNames.has(source.pack_name)) {
        throw new StoreInvariantError(
          `SQLite source references inactive Pack "${source.pack_name}"`,
        );
      }
      const practiceSources = sourcesByPractice.get(source.practice_id) ?? [];
      practiceSources.push(source);
      sourcesByPractice.set(source.practice_id, practiceSources);
    }

    const effectivePractices = this.allEffectivePractices();
    const effectiveByPractice = new Map(
      effectivePractices.map((practice) => [practice.id, practice]),
    );
    for (const [practiceId, practiceSources] of sourcesByPractice) {
      const effective = effectiveByPractice.get(practiceId);
      if (effective === undefined) {
        throw new StoreInvariantError(
          `SQLite sources for Practice "${practiceId}" have no effective Practice`,
        );
      }
      if (practiceSources.some((source) => source.content_digest !== effective.contentDigest)) {
        throw new StoreInvariantError(
          `SQLite sources for Practice "${practiceId}" disagree with effective content`,
        );
      }
    }
    for (const effective of effectivePractices) {
      if (!sourcesByPractice.has(effective.id)) {
        throw new StoreInvariantError(
          `SQLite effective Practice "${effective.id}" has no active source`,
        );
      }
    }
  }

  assertMatchesProjections(
    manifest: InstalledPacksManifest,
    projections: ReadonlyMap<string, ArtifactProjection>,
  ): void {
    this.assertConsistent(manifest);
    if (projections.size !== manifest.packs.length) {
      throw new StoreInvariantError("LocalStore projections do not match active Packs");
    }

    const expectedSources: SourceRow[] = [];
    const expectedEffectivePractices = new Map<string, ArtifactProjection["practices"][number]>();
    for (const pack of manifest.packs) {
      const projection = projections.get(pack.name);
      if (projection === undefined) {
        throw new StoreInvariantError(`Active Pack "${pack.name}" has no LocalStore projection`);
      }
      if (projection.pack.name !== pack.name || projection.pack.version !== pack.version) {
        throw new StoreInvariantError(
          `LocalStore projection does not match active Pack "${pack.name}"`,
        );
      }

      for (const practice of projection.practices) {
        expectedSources.push({
          pack_name: pack.name,
          practice_id: practice.id,
          content_digest: practice.contentDigest,
          source_path: practice.sourcePath,
        });
        const existing = expectedEffectivePractices.get(practice.id);
        if (
          existing !== undefined &&
          (existing.contentDigest !== practice.contentDigest ||
            existing.canonicalContent !== practice.canonicalContent)
        ) {
          throw new StoreInvariantError(
            `LocalStore projections conflict for Practice "${practice.id}"`,
          );
        }
        expectedEffectivePractices.set(practice.id, practice);
      }
    }

    const actualSources = this.database
      .query<SourceRow, []>(
        `SELECT pack_name, practice_id, content_digest, source_path
         FROM practice_sources ORDER BY pack_name, practice_id`,
      )
      .all();
    const sortedExpectedSources = [...expectedSources].sort(compareSourceRows);
    if (
      actualSources.length !== sortedExpectedSources.length ||
      actualSources.some((source, index) => !sameSourceRow(source, sortedExpectedSources[index]))
    ) {
      throw new StoreInvariantError(
        "SQLite Practice sources do not match sealed artifact projections",
      );
    }

    const actualEffectivePractices = this.allEffectivePractices();
    if (
      actualEffectivePractices.length !== expectedEffectivePractices.size ||
      actualEffectivePractices.some((effective) => {
        const expected = expectedEffectivePractices.get(effective.id);
        if (
          expected === undefined ||
          expected.contentDigest !== effective.contentDigest ||
          expected.canonicalContent !== effective.canonicalContent
        ) {
          return true;
        }
        this.assertEffectivePracticeMaterialized(effective);
        return false;
      })
    ) {
      throw new StoreInvariantError(
        "SQLite Effective Practices do not match sealed artifact projections",
      );
    }
  }

  private assertEffectivePracticeMaterialized(effective: EffectivePractice): void {
    const materializedCanonicalContent = canonicalContent({
      id: effective.id,
      title: effective.title,
      stage: effective.stage,
      tech_stack: [...effective.techStack],
      applies_when: effective.appliesWhen,
      severity: effective.severity,
      body: effective.body,
      anti_patterns: [...effective.antiPatterns],
    });
    if (materializedCanonicalContent !== effective.canonicalContent) {
      throw new StoreInvariantError(
        `SQLite Effective Practice "${effective.id}" fields do not match canonical content`,
      );
    }
    if (canonicalContentDigest(effective.canonicalContent) !== effective.contentDigest) {
      throw new StoreInvariantError(
        `SQLite Effective Practice "${effective.id}" canonical content does not match its digest`,
      );
    }
  }

  private toEffectivePractice(row: EffectivePracticeRow): EffectivePractice {
    const sourcePackNames = this.sourcesForPractice(row.practice_id).map(
      (source) => source.pack_name,
    );
    return {
      id: row.practice_id,
      title: row.title,
      stage: row.stage,
      techStack: JSON.parse(row.tech_stack_json) as string[],
      appliesWhen: row.applies_when,
      severity: row.severity,
      body: row.body,
      antiPatterns: JSON.parse(row.anti_patterns_json) as AntiPattern[],
      canonicalContent: row.canonical_content,
      contentDigest: row.content_digest,
      effectiveRevision: row.effective_revision,
      sourcePackNames,
    };
  }

  private metadataNumber(key: string): number {
    const row = this.database
      .query<{ value: string }, [string]>("SELECT value FROM store_metadata WHERE key = ?")
      .get(key);
    const value = Number(row?.value ?? "0");
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StoreInvariantError(`SQLite metadata "${key}" is not a non-negative integer`);
    }
    return value;
  }

  private setMetadata(key: string, value: string): void {
    this.database
      .query<unknown, [string, string]>(
        `INSERT INTO store_metadata(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}

function sameInstalledPack(left: InstalledPack, right: InstalledPack | undefined): boolean {
  return (
    right !== undefined &&
    left.name === right.name &&
    left.version === right.version &&
    left.artifactDigest === right.artifactDigest &&
    left.storageKey === right.storageKey &&
    left.installedAt === right.installedAt
  );
}

function toInstalledPack(row: ActivePackRow): InstalledPack {
  return {
    name: row.pack_name,
    version: row.pack_version,
    artifactDigest: row.artifact_digest,
    storageKey: row.storage_key,
    installedAt: row.installed_at,
  };
}

function compareSourceRows(left: SourceRow, right: SourceRow): number {
  return sourceRowKey(left).localeCompare(sourceRowKey(right));
}

function sameSourceRow(left: SourceRow, right: SourceRow | undefined): boolean {
  return right !== undefined && sourceRowKey(left) === sourceRowKey(right);
}

function sourceRowKey(source: SourceRow): string {
  return [source.pack_name, source.practice_id, source.content_digest, source.source_path].join(
    "\0",
  );
}
