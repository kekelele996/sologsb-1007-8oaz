import type {
  PendingImportRow,
  ProjectData,
  ReconcileResult,
  Segment,
  Term,
  TermListRow,
  TermListManifest,
} from "./types";

/* ---------------------------------- 校验 ---------------------------------- */

const TERM_TYPES: Term["type"][] = ["topic", "event", "person"];
const TERM_STATUSES: Term["status"][] = ["active", "merged", "retired"];

/** 清单行级校验：只拒绝结构上无法对账的行，缺省字段与旧值合并。 */
export function validateRow(raw: unknown): { row?: TermListRow; error?: string } {
  if (typeof raw !== "object" || raw === null) return { error: "行不是对象" };
  const candidate = raw as Record<string, unknown>;
  const code = typeof candidate.code === "string" ? candidate.code.trim() : "";
  if (!code) return { error: "缺少词条编号 code" };
  if (!/^[\w.\-一-龥]+$/.test(code)) return { error: "词条编号含非法字符" };

  const row: TermListRow = { code };

  if (candidate.name !== undefined) {
    if (typeof candidate.name !== "string" || !candidate.name.trim()) return { row, error: "名称为空" };
    row.name = candidate.name.trim();
  }
  if (candidate.type !== undefined) {
    if (!TERM_TYPES.includes(candidate.type as Term["type"])) return { row, error: `未知类型 ${String(candidate.type)}` };
    row.type = candidate.type as Term["type"];
  }
  if (candidate.color !== undefined) {
    if (typeof candidate.color !== "string" || !/^#[0-9a-fA-F]{3,8}$/.test(candidate.color.trim())) {
      return { row, error: "颜色格式无效" };
    }
    row.color = candidate.color.trim();
  }
  if (candidate.status !== undefined) {
    if (!TERM_STATUSES.includes(candidate.status as Term["status"])) return { row, error: `未知状态 ${String(candidate.status)}` };
    row.status = candidate.status as Term["status"];
  }
  if (candidate.mergeTargetCode !== undefined && candidate.mergeTargetCode !== null) {
    if (typeof candidate.mergeTargetCode !== "string" || !candidate.mergeTargetCode.trim()) {
      return { row, error: "合并目标编号为空" };
    }
    row.mergeTargetCode = candidate.mergeTargetCode.trim();
  }
  if (candidate.version !== undefined) {
    const version = Number(candidate.version);
    if (!Number.isInteger(version) || version < 0) return { row, error: "版本号不是非负整数" };
    row.version = version;
  }
  return { row };
}

/** 解析编目组导出的清单：接受 {catalogVersion, rows: [...]} 或裸数组。 */
export function parseTermList(text: string): { manifest: TermListManifest | null; rows: TermListRow[]; errors: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { manifest: null, rows: [], errors: [`清单不是合法 JSON：${(error as Error).message}`] };
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : typeof data === "object" && data !== null && Array.isArray((data as TermListManifest).rows)
      ? (data as TermListManifest).rows
      : [];
  if (!list.length) return { manifest: null, rows: [], errors: ["清单为空或缺少 rows 数组"] };

  const manifest = Array.isArray(data) ? null : ({ ...(data as object) } as TermListManifest);
  const rows: TermListRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    const { row, error } = validateRow(raw);
    if (!row) {
      errors.push(`第 ${index + 1} 行：${error}`);
      return;
    }
    if (error) {
      errors.push(`第 ${index + 1} 行（${row.code}）：${error}`);
      return;
    }
    if (seen.has(row.code)) {
      errors.push(`第 ${index + 1} 行（${row.code}）：编号在本批清单内重复`);
      return;
    }
    seen.add(row.code);
    rows.push(row);
  });
  return { manifest: manifest ? { ...manifest, rows } : null, rows, errors };
}

/* ------------------------------- 合并链解析 -------------------------------- */

/**
 * 在词条表上解析合并链：A merged→B merged→C(active) 返回 C。
 * 链上出现停用、目标缺失或成环（含链过长）视为无接续。
 */
export function resolveMergeTarget(terms: Term[], code: string): string | null {
  const seen = new Set<string>([code]);
  let current = code;
  for (let depth = 0; depth < 32; depth++) {
    const term = terms.find((item) => item.code === current);
    if (!term || term.status !== "merged" || !term.mergeTargetCode) return null;
    current = term.mergeTargetCode;
    if (seen.has(current)) return null; // 合并环
    seen.add(current);
    const target = terms.find((item) => item.code === current);
    if (!target || target.status === "retired") return null;
    if (target.status === "active") return current;
    // target 仍为 merged，继续顺链
  }
  return null;
}

export function normalizeName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

/* ----------------------------- 一批清单的对账 ------------------------------ */

export interface BatchOutcome {
  result: ReconcileResult;
  /** 失败行：保持对账前状态，下次打开只重试这些。 */
  failures: PendingImportRow[];
}

/**
 * 按词条编号对账一批清单（就地修改 project 中能对上的行）：
 * - active：更新词条字段；名称命中本地待回填词条时，把关联顺到编目编号。
 * - merged：关联顺着合并目标改过去；目标缺失/停用/成环的行失败、本行回滚。
 * - retired：关联断开，片段标待重新归类。
 * 一批中只回滚失败行本身，已对上的行保留。校对批注与校对标记不在本函数触碰。
 */
export function importBatch(
  project: ProjectData,
  rows: TermListRow[],
  catalogVersion: string | undefined,
): BatchOutcome {
  const result: ReconcileResult = { applied: 0, merged: 0, retired: 0, backfilled: 0, reclassified: 0, reports: [] };
  const failures: PendingImportRow[] = [];
  const makePending = (row: TermListRow, error: string): PendingImportRow => ({
    ...row,
    catalogVersion,
    failedAt: new Date().toISOString(),
    lastError: error,
    attempts: 1,
  });

  // 第一轮：把结构合法的行暂存到词条表副本，用于参照完整性判定，不碰片段。
  const staged: Term[] = project.terms.map((term) => ({ ...term }));
  const originals = new Map<string, Term | undefined>();
  const stagedCodes = new Set<string>();
  for (const row of rows) {
    const existing = staged.find((term) => term.code === row.code);
    originals.set(row.code, existing ? { ...existing } : undefined);
    const status = row.status ?? "active";
    const payload: Term = {
      code: row.code,
      name: row.name ?? existing?.name ?? "",
      type: row.type ?? existing?.type ?? "topic",
      color: row.color ?? existing?.color ?? "#64748b",
      status,
      mergeTargetCode: status === "merged" ? row.mergeTargetCode ?? existing?.mergeTargetCode : undefined,
      version: row.version ?? existing?.version ?? 0,
      localOnly: existing?.localOnly,
    };
    if (existing) Object.assign(existing, payload);
    else staged.push(payload);
    stagedCodes.add(row.code);
  }

  // 第二轮：不动点剔除不合法行：版本倒退、合并目标缺失/停用/成环（会级联）。
  const failedCodes = new Set<string>();
  const failureReason = new Map<string, string>();
  const markFailed = (code: string, reason: string) => {
    if (!failedCodes.has(code)) {
      failedCodes.add(code);
      failureReason.set(code, reason);
    }
  };
  // 版本倒退：清单行版本低于本机已有的同编号版本，本行不生效。
  for (const row of rows) {
    const original = originals.get(row.code);
    if (original && typeof row.version === "number" && row.version < original.version) {
      markFailed(row.code, `清单版本 v${row.version} 低于本机 v${original.version}，已停用该轮数据`);
    }
  }
  for (let guard = 0; guard < staged.length + 1; guard++) {
    let grew = false;
    for (const code of stagedCodes) {
      if (failedCodes.has(code)) continue;
      const term = staged.find((item) => item.code === code)!;
      if (term.status !== "merged") continue;
      const target = term.mergeTargetCode;
      if (!target || !staged.some((item) => item.code === target)) {
        markFailed(code, `合并目标 ${target ?? "（空）"} 不在清单或本机词库中`);
        grew = true;
        continue;
      }
      if (staged.some((item) => item.code === target && item.status === "retired")) {
        markFailed(code, `合并目标 ${target} 已停用且无接续`);
        grew = true;
        continue;
      }
      const live = staged.filter((item) => !failedCodes.has(item.code));
      if (resolveMergeTarget(live, code) === null) {
        markFailed(code, "合并链无法到达有效词条（目标在本批中失败或成环）");
        grew = true;
      }
    }
    if (!grew) break;
  }

  // 失败行从暂存表剔除，并把该行入库前的旧词条放回（新编号则不留痕）。
  for (const code of failedCodes) {
    const row = rows.find((item) => item.code === code)!;
    failures.push(makePending(row, failureReason.get(code) ?? "本行随本批失败回滚"));
    staged.splice(staged.findIndex((item) => item.code === code), 1);
    const original = originals.get(code);
    if (original) staged.push({ ...original });
  }

  // 第三轮：暂存表提交到项目词条表（仅成功行）。
  project.terms = staged;

  // 第四轮：逐行处理片段关联与本地词条名称回填。
  const segments = project.tracks.flatMap((track) => track.segments);
  for (const row of rows) {
    if (failedCodes.has(row.code)) {
      result.reports.push({ code: row.code, status: "failed", error: failures.find((item) => item.code === row.code)?.lastError });
      continue;
    }
    const term = project.terms.find((item) => item.code === row.code)!;
    if (term.status === "merged") {
      const targetCode = resolveMergeTarget(project.terms, row.code)!;
      for (const segment of segments) {
        if (segment.termCodes.includes(row.code)) {
          segment.termCodes = segment.termCodes.map((code) => (code === row.code ? targetCode : code));
        }
      }
      result.merged++;
      result.reports.push({ code: row.code, status: "merged" });
    } else if (term.status === "retired") {
      const count = breakLinks(segments, row.code, term.name);
      result.retired++;
      result.reclassified += count;
      result.reports.push({ code: row.code, status: "retired" });
    } else {
      // active：名称命中本地未回填词条时，把它的关联顺到编目编号。
      const local = project.terms.find(
        (item) => item.localOnly && item.code !== row.code && normalizeName(item.name) === normalizeName(term.name),
      );
      if (local) {
        for (const segment of segments) {
          if (segment.termCodes.includes(local.code)) {
            segment.termCodes = segment.termCodes.map((code) => (code === local.code ? term.code : code));
          }
        }
        project.terms = project.terms.filter((item) => item.code !== local.code);
        term.localOnly = false;
        result.backfilled++;
        result.reports.push({ code: row.code, status: "backfilled" });
      } else if (term.localOnly) {
        term.localOnly = false;
        result.backfilled++;
        result.reports.push({ code: row.code, status: "backfilled" });
      } else {
        result.applied++;
        result.reports.push({ code: row.code, status: "applied" });
      }
    }
  }
  dedupeLinks(segments);
  // 兜底：修复历史数据中可能残留的悬空/合并链挂载。
  sweepStaleLinks(project);
  return { result, failures };
}

/** 断开某编号的挂载；没有接续目标的片段标待重新归类。 */
function breakLinks(segments: Segment[], code: string, name: string): number {
  let count = 0;
  for (const segment of segments) {
    if (!segment.termCodes.includes(code)) continue;
    segment.termCodes = segment.termCodes.filter((item) => item !== code);
    segment.needsReclassify = true;
    segment.brokenTerms = [...new Set([...(segment.brokenTerms ?? []), name || code])];
    count++;
  }
  return count;
}

function dedupeLinks(segments: Segment[]) {
  for (const segment of segments) segment.termCodes = [...new Set(segment.termCodes)];
}

/** 全表扫描：顺着当前词条表修复残留的 merged/retired/悬空挂载（迁移后用）。 */
export function sweepStaleLinks(project: ProjectData): number {
  const segments = project.tracks.flatMap((track) => track.segments);
  let changed = 0;
  for (const segment of segments) {
    const next: string[] = [];
    let broken = false;
    for (const code of segment.termCodes) {
      const term = project.terms.find((item) => item.code === code);
      if (!term) {
        broken = true;
        segment.brokenTerms = [...new Set([...(segment.brokenTerms ?? []), code])];
        continue;
      }
      if (term.status === "active") {
        next.push(code);
      } else if (term.status === "merged") {
        const target = resolveMergeTarget(project.terms, code);
        if (target) next.push(target);
        else {
          broken = true;
          segment.brokenTerms = [...new Set([...(segment.brokenTerms ?? []), term.name || code])];
        }
      } else {
        broken = true;
        segment.brokenTerms = [...new Set([...(segment.brokenTerms ?? []), term.name || code])];
      }
    }
    const deduped = [...new Set(next)];
    if (broken) {
      segment.needsReclassify = true;
      changed++;
    }
    if (deduped.join("|") !== segment.termCodes.join("|")) changed++;
    segment.termCodes = deduped;
  }
  return changed;
}

/* -------------------------------- 旧数据迁移 -------------------------------- */

/**
 * 旧草稿（schema 1，tags/segment.tagIds）迁移：
 * 内嵌词条先抽出来建库（code = local-<旧id>），再按名称回填编目编号；
 * 回填不上的保留并标 localOnly。批注、校对标记原样保留。
 */
export function migrateFromV1(
  v1: unknown,
  catalog: Term[],
): { project: ProjectData; extracted: number; backfilled: number; unresolvedNames: string[] } {
  const old = v1 as { project?: ProjectData };
  const source = (old.project ?? old) as ProjectData;
  const project = structuredClone(source);

  const rawTags = ((source as unknown as { tags?: Array<{ id: string; label: string; type: Term["type"]; color: string }> }).tags ?? [])
    .filter((tag) => tag && typeof tag.id === "string");

  // 名称（规范化后）→ 编目词条；同名取一个，编目侧应保证唯一。
  const byName = new Map<string, Term>();
  for (const term of catalog) {
    if (term.status === "active" && term.name && !byName.has(normalizeName(term.name))) {
      byName.set(normalizeName(term.name), term);
    }
  }

  const idMap = new Map<string, string>();
  const localTerms: Term[] = [];
  const unresolvedNames: string[] = [];
  for (const tag of rawTags) {
    const match = byName.get(normalizeName(tag.label));
    if (match) {
      idMap.set(tag.id, match.code);
    } else {
      const code = `local-${tag.id}`;
      idMap.set(tag.id, code);
      localTerms.push({ code, name: tag.label, type: tag.type, color: tag.color, status: "active", version: 0, localOnly: true });
      unresolvedNames.push(tag.label);
    }
  }

  for (const track of project.tracks ?? []) {
    for (const segment of track.segments ?? []) {
      const oldTagIds = ((segment as unknown as { tagIds?: string[] }).tagIds ?? []).slice();
      segment.termCodes = [...new Set(oldTagIds.map((id) => idMap.get(id)).filter((code): code is string => Boolean(code)))];
      segment.needsReclassify = false;
      segment.brokenTerms = [];
    }
  }

  project.terms = [...structuredClone(catalog), ...localTerms];
  delete (project as Partial<ProjectData> & { tags?: unknown }).tags;
  project.updatedAt = new Date().toISOString();

  return {
    project,
    extracted: rawTags.length,
    backfilled: rawTags.length - localTerms.length,
    unresolvedNames: [...new Set(unresolvedNames)],
  };
}

/* -------------------------------- 失败队列 -------------------------------- */

const PENDING_KEY = "sologsb-1007-pending-terms-v1";

export function loadPendingRows(): PendingImportRow[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const data = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]");
    return Array.isArray(data) ? (data as PendingImportRow[]) : [];
  } catch {
    return [];
  }
}

export function savePendingRows(rows: PendingImportRow[]) {
  if (typeof localStorage === "undefined") return;
  if (rows.length) localStorage.setItem(PENDING_KEY, JSON.stringify(rows));
  else localStorage.removeItem(PENDING_KEY);
}

/** 新进失败行并入队列（按 code 去重，重试次数累加）。 */
export function mergePendingRows(existing: PendingImportRow[], incoming: PendingImportRow[]): PendingImportRow[] {
  const byCode = new Map(existing.map((row) => [row.code, structuredClone(row)]));
  for (const row of incoming) {
    const old = byCode.get(row.code);
    byCode.set(row.code, old
      ? { ...row, attempts: old.attempts + 1, failedAt: new Date().toISOString() }
      : row);
  }
  return [...byCode.values()];
}

/** 校对员把待重新归类片段挂到有效词条后，清除标记；批注和校对标记不动。 */
export function reclassifySegment(project: ProjectData, segmentId: string, termCodes: string[]) {
  for (const track of project.tracks) {
    const segment = track.segments.find((item) => item.id === segmentId);
    if (!segment) continue;
    segment.termCodes = [
      ...new Set(termCodes.filter((code) => project.terms.some((term) => term.code === code && term.status === "active"))),
    ];
    segment.needsReclassify = false;
    segment.brokenTerms = [];
    return;
  }
}
