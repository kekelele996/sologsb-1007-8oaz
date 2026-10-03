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

export type EntryType = "topic" | "event" | "person";
export type EntryStatus = "active" | "merged" | "deactivated";

/** 词条：由编目组维护、随清单导入；校对员只在本机把片段挂到词条上 */
export interface Entry {
  id: string;
  /** 词条编号，编目组对账主键；旧数据刚抽出时为空 */
  code: string;
  name: string;
  type: EntryType;
  color: string;
  status: EntryStatus;
  /** 合并或停用后的接续词条编号 */
  mergedInto?: string;
  /** 旧草稿内嵌、尚未按名称回填编号 */
  pendingMigration?: boolean;
}

/** 编目组导出的词条清单项 */
export interface CatalogEntry {
  code: string;
  name: string;
  type?: EntryType;
  status: EntryStatus;
  mergedInto?: string;
}

export type ImportItemAction = "upsert" | "backfill" | "redirect" | "deactivate";

export interface ImportItemResult {
  code: string;
  name: string;
  action: ImportItemAction;
  ok: boolean;
  error?: string;
}

/** 一批导入的对账记录；entries 为清单快照，失败条目据此重试 */
export interface ImportBatch {
  id: string;
  sourceName: string;
  importedAt: string;
  status: "done" | "partial" | "failed";
  entries: CatalogEntry[];
  items: ImportItemResult[];
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
  entryIds: string[];
  /** 关联了已停用且无接续的词条，等待校对员重新归类 */
  pendingReclassify: boolean;
  /** 导致待重新归类的词条编号（词条恢复后逐条清除） */
  pendingEntryCodes: string[];
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
  entries: Entry[];
  tracks: TranscriptTrack[];
  importBatches: ImportBatch[];
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: 1 | 2;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}
