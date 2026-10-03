import { createSeedProject, uid } from "./data";
import type { Entry, PersistedEnvelope, ProjectData, Segment } from "./types";

export const STORAGE_KEY = "sologsb-1007-project-v2";
export const LEGACY_STORAGE_KEY = "sologsb-1007-project-v1";
export const SESSION_KEY = "sologsb-1007-session";

const DEFAULT_ENTRY_COLORS: Record<Entry["type"], string> = {
  topic: "#2563eb",
  event: "#b45309",
  person: "#be185d",
};

/**
 * 旧数据迁移：草稿里内嵌的词条先抽出来建库。
 * v1 草稿把标签内联在 project.tags / segment.tagIds 上，
 * 这里抽成 entries（暂无编号，标 pendingMigration），关联改挂 entryIds。
 */
export function migrateProject(raw: unknown): ProjectData {
  const project = raw as ProjectData & {
    tags?: Array<{ id: string; label: string; type: Entry["type"]; color: string }>;
  };

  if (!Array.isArray(project.entries)) {
    const legacyTags = Array.isArray(project.tags) ? project.tags : [];
    project.entries = legacyTags.map((tag) => ({
      id: tag.id,
      code: "",
      name: tag.label,
      type: tag.type,
      color: tag.color || DEFAULT_ENTRY_COLORS[tag.type],
      status: "active" as const,
      pendingMigration: true,
    }));
  }

  for (const track of project.tracks ?? []) {
    for (const segment of track.segments ?? []) {
      const legacy = segment as Segment & { tagIds?: string[] };
      if (!Array.isArray(segment.entryIds)) {
        segment.entryIds = Array.isArray(legacy.tagIds) ? legacy.tagIds : [];
      }
      segment.pendingReclassify ??= false;
      segment.pendingEntryCodes ??= [];
    }
  }

  project.importBatches ??= [];
  return project;
}

function readEnvelopeFrom(key: string): PersistedEnvelope | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "") as PersistedEnvelope;
    if (parsed?.project?.tracks?.length) return parsed;
  } catch {
    // Malformed payload falls through to the next source.
  }
  return null;
}

export function loadProject(): { project: ProjectData; revision: number } {
  if (typeof localStorage === "undefined") {
    return { project: createSeedProject(), revision: 0 };
  }
  const parsed = readEnvelopeFrom(STORAGE_KEY) ?? readEnvelopeFrom(LEGACY_STORAGE_KEY);
  if (parsed) {
    return { project: migrateProject(parsed.project), revision: parsed.revision ?? 0 };
  }
  return { project: createSeedProject(), revision: 0 };
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

export { uid };
