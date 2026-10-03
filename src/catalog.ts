import { uid } from "./data";
import type {
  CatalogEntry,
  Entry,
  EntryType,
  ImportBatch,
  ImportItemResult,
  ProjectData,
  Segment,
} from "./types";

const DEFAULT_COLORS: Record<EntryType, string> = {
  topic: "#2563eb",
  event: "#b45309",
  person: "#be185d",
};

/** 解析编目组导出的词条清单 JSON；格式不对直接抛错，整批不落地 */
export function parseCatalogFile(text: string): CatalogEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("清单不是有效的 JSON 文件");
  }
  const raw = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(raw)) throw new Error("清单缺少 entries 词条数组");

  const entries: CatalogEntry[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`第 ${index + 1} 条不是有效词条`);
    const record = item as Record<string, unknown>;
    const code = String(record.code ?? "").trim();
    const name = String(record.name ?? "").trim();
    if (!code) throw new Error(`第 ${index + 1} 条缺少词条编号`);
    if (!name) throw new Error(`词条 ${code} 缺少名称`);
    const status = record.status === "merged" || record.status === "deactivated" ? record.status : "active";
    const type = (["topic", "event", "person"].includes(String(record.type))
      ? record.type
      : undefined) as EntryType | undefined;
    const mergedInto = record.mergedInto ? String(record.mergedInto).trim() : undefined;
    entries.push({ code, name, type, status, mergedInto });
  });
  return entries;
}

const allSegments = (draft: ProjectData): Segment[] => draft.tracks.flatMap((track) => track.segments);

const entryByCode = (draft: ProjectData) => {
  const map = new Map<string, Entry>();
  for (const entry of draft.entries) if (entry.code) map.set(entry.code, entry);
  return map;
};

/** 旧草稿抽出、还没编号的词条，导入时按名称回填 */
const findPendingByName = (draft: ProjectData, name: string) =>
  draft.entries.find((entry) => entry.pendingMigration && !entry.code && entry.name === name);

/** 沿接续关系找到最终活跃词条；断链、循环、停用无后继都算失败 */
function resolveTerminal(
  startCode: string,
  incoming: Map<string, CatalogEntry>,
  local: Map<string, Entry>,
  seen = new Set<string>(),
): { ok: true; code: string } | { ok: false; error: string } {
  if (seen.has(startCode)) return { ok: false, error: `词条 ${startCode} 的接续关系存在循环` };
  seen.add(startCode);

  const inc = incoming.get(startCode);
  if (inc) {
    if (inc.status === "active") return { ok: true, code: startCode };
    if (!inc.mergedInto) return { ok: false, error: `词条 ${startCode} 已停用且没有接续目标` };
    return resolveTerminal(inc.mergedInto, incoming, local, seen);
  }

  const loc = local.get(startCode);
  if (loc) {
    if (loc.status === "active") return { ok: true, code: startCode };
    if (!loc.mergedInto) return { ok: false, error: `词条 ${startCode} 已停用且没有接续目标` };
    return resolveTerminal(loc.mergedInto, incoming, local, seen);
  }

  return { ok: false, error: `找不到接续目标 ${startCode}` };
}

/** 接续目标若不在本地，就用清单快照建出来 */
function ensureTarget(draft: ProjectData, code: string, incoming: Map<string, CatalogEntry>, local: Map<string, Entry>): Entry {
  const existing = local.get(code);
  if (existing) return existing;
  const inc = incoming.get(code);
  if (!inc) throw new Error(`接续目标 ${code} 不在清单中`);
  const entry: Entry = {
    id: uid("entry"),
    code,
    name: inc.name,
    type: inc.type ?? "topic",
    color: DEFAULT_COLORS[inc.type ?? "topic"],
    status: "active",
  };
  draft.entries.push(entry);
  local.set(code, entry);
  return entry;
}

function restoreProject(draft: ProjectData, snap: ProjectData) {
  draft.entries = snap.entries;
  draft.tracks = snap.tracks;
  draft.importBatches = snap.importBatches;
}

/**
 * 按编号对账逐条应用。
 * 只动词条库字段和片段的 entryIds；片段正文、批注、校对标记、置信度一律不碰，
 * 清单带过来的空值不会冲掉校对员的任何结果。
 */
function applyItem(
  draft: ProjectData,
  item: CatalogEntry,
  incoming: Map<string, CatalogEntry>,
): ImportItemResult {
  const local = entryByCode(draft);
  const code = item.code;
  const pending = findPendingByName(draft, item.name);
  let entry = local.get(code);
  if (!entry && pending) {
    // 旧数据按名称回填编号
    pending.code = code;
    pending.pendingMigration = false;
    entry = pending;
    local.set(code, entry);
  }

  if (item.status === "active") {
    if (!entry) {
      entry = {
        id: uid("entry"),
        code,
        name: item.name,
        type: item.type ?? "topic",
        color: DEFAULT_COLORS[item.type ?? "topic"],
        status: "active",
      };
      draft.entries.push(entry);
      local.set(code, entry);
    } else {
      entry.name = item.name;
      if (item.type) entry.type = item.type;
      entry.status = "active";
      entry.mergedInto = undefined;
      entry.pendingMigration = false;
    }
    // 词条恢复活跃后，清掉片段上因它而起的待重新归类标记
    for (const segment of allSegments(draft)) {
      if (segment.pendingEntryCodes.includes(code)) {
        segment.pendingEntryCodes = segment.pendingEntryCodes.filter((c) => c !== code);
        segment.pendingReclassify = segment.pendingEntryCodes.length > 0;
      }
    }
    return { code, name: item.name, action: pending ? "backfill" : "upsert", ok: true };
  }

  // 合并 / 停用且有接续：关联顺着接续目标改过去
  if (item.mergedInto) {
    const terminal = resolveTerminal(item.mergedInto, incoming, local);
    if (!terminal.ok) return { code, name: item.name, action: "redirect", ok: false, error: terminal.error };
    const target = ensureTarget(draft, terminal.code, incoming, local);
    const sourceId = entry?.id;
    if (!entry) {
      entry = {
        id: uid("entry"),
        code,
        name: item.name,
        type: item.type ?? "topic",
        color: DEFAULT_COLORS[item.type ?? "topic"],
        status: item.status,
        mergedInto: terminal.code,
      };
      draft.entries.push(entry);
      local.set(code, entry);
    } else {
      entry.name = item.name;
      if (item.type) entry.type = item.type;
      entry.status = item.status;
      entry.mergedInto = terminal.code;
      entry.pendingMigration = false;
    }
    for (const segment of allSegments(draft)) {
      if (sourceId && segment.entryIds.includes(sourceId)) {
        segment.entryIds = [...new Set(segment.entryIds.map((id) => (id === sourceId ? target.id : id)))];
        segment.pendingEntryCodes = segment.pendingEntryCodes.filter((c) => c !== code);
        segment.pendingReclassify = segment.pendingEntryCodes.length > 0;
      }
    }
    return { code, name: item.name, action: "redirect", ok: true };
  }

  // 停用又没接续：关联保留，片段标成待重新归类
  if (!entry) {
    entry = {
      id: uid("entry"),
      code,
      name: item.name,
      type: item.type ?? "topic",
      color: DEFAULT_COLORS[item.type ?? "topic"],
      status: "deactivated",
    };
    draft.entries.push(entry);
  } else {
    entry.status = "deactivated";
    entry.mergedInto = undefined;
    entry.pendingMigration = false;
  }
  for (const segment of allSegments(draft)) {
    if (segment.entryIds.includes(entry.id)) {
      if (!segment.pendingEntryCodes.includes(code)) segment.pendingEntryCodes.push(code);
      segment.pendingReclassify = true;
    }
  }
  return { code, name: item.name, action: "deactivate", ok: true };
}

/** 汇总所有批次快照中的词条，供链解析补缺；新清单优先 */
function combinedIncoming(draft: ProjectData, preferred: Map<string, CatalogEntry>): Map<string, CatalogEntry> {
  const combined = new Map<string, CatalogEntry>();
  for (const batch of draft.importBatches) {
    for (const entry of batch.entries) combined.set(entry.code, entry);
  }
  for (const [code, entry] of preferred) combined.set(code, entry);
  return combined;
}

/** 用给定清单重试某一批的失败条目；已对上的一律不动 */
function retryWithMap(draft: ProjectData, batch: ImportBatch, map: Map<string, CatalogEntry>): boolean {
  let recovered = false;
  for (const result of batch.items) {
    if (result.ok) continue;
    const item = batch.entries.find((entry) => entry.code === result.code);
    if (!item) {
      result.error = "清单快照中找不到该词条";
      continue;
    }
    const snap = structuredClone(draft);
    const applied = applyItem(draft, item, map);
    if (applied.ok) {
      result.ok = true;
      result.action = applied.action;
      result.error = undefined;
      recovered = true;
    } else {
      restoreProject(draft, snap);
      result.error = applied.error;
    }
  }
  if (recovered) {
    batch.status = batch.items.every((item) => item.ok)
      ? "done"
      : batch.items.some((item) => item.ok)
        ? "partial"
        : "failed";
    batch.importedAt = new Date().toISOString();
  }
  return recovered;
}

/**
 * 导入一批词条清单。逐条对账、逐条落库：
 * 单条失败只回滚这一条，已经对上的保留；整批结果（含清单快照）写入 importBatches。
 * 新清单同时用于重试历史失败条目——只重试失败的那几条，已对上的不重复处理。
 */
export function runImport(draft: ProjectData, incoming: CatalogEntry[], sourceName: string): ImportBatch {
  const byCode = new Map<string, CatalogEntry>();
  for (const item of incoming) byCode.set(item.code, item);

  const items: ImportItemResult[] = [];
  for (const item of byCode.values()) {
    const snap = structuredClone(draft);
    const result = applyItem(draft, item, byCode);
    if (!result.ok) restoreProject(draft, snap);
    items.push(result);
  }

  const combined = combinedIncoming(draft, byCode);
  for (const batch of draft.importBatches) {
    if (batch.status === "done") continue;
    retryWithMap(draft, batch, combined);
  }

  const batch: ImportBatch = {
    id: uid("batch"),
    sourceName,
    importedAt: new Date().toISOString(),
    status: items.every((item) => item.ok) ? "done" : items.some((item) => item.ok) ? "partial" : "failed",
    entries: incoming,
    items,
  };
  draft.importBatches = [batch, ...draft.importBatches].slice(0, 10);
  return batch;
}

/** 只重试失败的条目；已对上的不动 */
export function retryBatch(draft: ProjectData, batchId: string): ImportBatch | null {
  const batch = draft.importBatches.find((item) => item.id === batchId);
  if (!batch) return null;
  retryWithMap(draft, batch, combinedIncoming(draft, new Map()));
  return batch;
}

export interface EntryCounts {
  active: number;
  merged: number;
  deactivated: number;
  pending: number;
}

export const entryCounts = (draft: ProjectData): EntryCounts => ({
  active: draft.entries.filter((entry) => entry.status === "active").length,
  merged: draft.entries.filter((entry) => entry.status === "merged").length,
  deactivated: draft.entries.filter((entry) => entry.status === "deactivated").length,
  pending: draft.entries.filter((entry) => entry.pendingMigration).length,
});

export const failedItemCount = (batch: ImportBatch | null | undefined) =>
  batch ? batch.items.filter((item) => !item.ok).length : 0;
