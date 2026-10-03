export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface Speaker {
  id: string;
  name: string;
  role: string;
  color: string;
}

/** 词条库由编目组单独维护；校对员本机只读，不新建、不改写词条本身。 */
export interface Term {
  /** 编目组分配的稳定编号，对账主键。迁移产生的临时编号为 `local-<id>`。 */
  code: string;
  name: string;
  type: "topic" | "event" | "person";
  color: string;
  /** active 可挂载；merged 已并入 mergeTargetCode；retired 停用。 */
  status: "active" | "merged" | "retired";
  /** 合并目标编号，仅 status === "merged" 时存在。 */
  mergeTargetCode?: string;
  /** 编目组清单版本号；本地迁移词条为 0。 */
  version: number;
  /** 迁移产生、尚未按名称对上编目编号的词条。 */
  localOnly?: boolean;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speakerId: string;
  text: string;
  confidence: Confidence;
  reviewed: boolean;
  flags: {
    lowConfidence: boolean;
    dialect: boolean;
    properNoun: boolean;
  };
  /** 片段挂载的词条编号（原 tagIds）。 */
  termCodes: string[];
  /** 停用又没有接续目标，等待校对员重新归类。 */
  needsReclassify: boolean;
  /** 触发重新归类时的词条名称快照，供界面提示，不参与对账。 */
  brokenTerms?: string[];
  comments: ReviewComment[];
}

export interface TranscriptTrack {
  id: string;
  name: string;
  language: string;
  status: "待校对" | "校对中" | "已完成";
  segments: Segment[];
}

export interface ProjectData {
  id: string;
  title: string;
  interviewee: string;
  recordingDate: string;
  activeTrackId: string;
  speakers: Speaker[];
  terms: Term[];
  tracks: TranscriptTrack[];
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: 2;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}

/** 编目组导出、编辑器导入的一轮词条清单。 */
export interface TermListRow {
  code: string;
  name?: string;
  type?: "topic" | "event" | "person";
  color?: string;
  status?: "active" | "merged" | "retired";
  mergeTargetCode?: string;
  version?: number;
}

export interface TermListManifest {
  catalogVersion?: string;
  exportedAt?: string;
  rows: TermListRow[];
}

/** 一条清单的原始 JSON，以及解析后的行。 */
export interface ParsedTermList {
  manifest: TermListManifest | null;
  rows: TermListRow[];
}

export interface ReconcileResult {
  applied: number;
  merged: number;
  retired: number;
  backfilled: number;
  reclassified: number;
  /** 逐行结果；error 非空的行不生效，进入失败队列。 */
  reports: Array<{
    code: string;
    status: "applied" | "merged" | "retired" | "backfilled" | "skipped" | "failed";
    error?: string;
  }>;
}

/** 导入失败、下次打开只重试的那几条，单独存放，不随草稿回滚。 */
export interface PendingImportRow extends TermListRow {
  /** 导入时编目组清单的版本标记，仅用于界面展示。 */
  catalogVersion?: string;
  failedAt: string;
  lastError: string;
  attempts: number;
}
