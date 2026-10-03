import { migrateFromV1 } from "./catalog";
import { createSeedProject } from "./data";
import type { PersistedEnvelope, ProjectData, Term } from "./types";

export const STORAGE_KEY = "sologsb-1007-project-v1";
export const SESSION_KEY = "sologsb-1007-session";

export interface LoadedState {
  project: ProjectData;
  revision: number;
  /** 本次载入是否完成了旧版草稿迁移。 */
  migrated: boolean;
  migrationInfo?: { extracted: number; backfilled: number; unresolvedNames: string[] };
}

/**
 * 载入本机草稿：
 * - schema 2（terms/termCodes）直接使用；
 * - schema 1（tags/tagIds）先抽内嵌词条建库，再按名称向当前词库回填编号，
 *   回填不上的保留并标出；批注与校对标记原样保留。
 */
export function loadProject(): LoadedState {
  const fallback = (): LoadedState => ({ project: createSeedProject(), revision: 0, migrated: false });
  if (typeof localStorage === "undefined") return fallback();

  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "");
  } catch {
    return fallback();
  }
  if (!raw || typeof raw !== "object") return fallback();
  const envelope = raw as { schema?: number; revision?: number; project?: ProjectData };

  if (envelope.schema === 2 && envelope.project?.tracks?.length && Array.isArray(envelope.project.terms)) {
    return { project: envelope.project as ProjectData, revision: envelope.revision ?? 0, migrated: false };
  }

  // 旧版数据：以种子项目携带的编目词库作为回填参照。
  if (envelope.schema === 1 || (!envelope.schema && Array.isArray((envelope.project as { tags?: unknown[] } | undefined)?.tags))) {
    const seedCatalog: Term[] = createSeedProject().terms;
    const { project, extracted, backfilled, unresolvedNames } = migrateFromV1(envelope, seedCatalog);
    if (!project.tracks.length) return fallback();
    const migrated: LoadedState = {
      project,
      revision: (envelope.revision ?? 0) + 1,
      migrated: true,
      migrationInfo: { extracted, backfilled, unresolvedNames },
    };
    // 迁移后立即按新 schema 落盘，避免每次打开重复迁移。
    saveProject(project, migrated.revision, "migration");
    return migrated;
  }

  return fallback();
}

export function saveProject(project: ProjectData, revision: number, tabId: string) {
  const envelope: PersistedEnvelope = {
    schema: 2,
    revision,
    tabId,
    savedAt: Date.now(),
    project,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  return envelope;
}

export function readEnvelope(): PersistedEnvelope | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope;
  } catch {
    return null;
  }
}

export function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function formatTime(seconds: number, withMillis = true) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const head = [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
  return withMillis ? `${head}.${String(ms).padStart(3, "0")}` : head;
}

export function parseTime(value: string) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(normalized) || 0;
}
