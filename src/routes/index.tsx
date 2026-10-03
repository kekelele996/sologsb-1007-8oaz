import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { uid } from "../data";
import {
  importBatch,
  loadPendingRows,
  mergePendingRows,
  parseTermList,
  reclassifySegment,
  savePendingRows,
} from "../catalog";
import { downloadText, formatTime, loadProject, parseTime, saveProject } from "../persistence";
import type {
  Confidence,
  PendingImportRow,
  PersistedEnvelope,
  ProjectData,
  ReconcileResult,
  Segment,
  Term,
  TermListRow,
  TranscriptTrack,
} from "../types";

const CHANNEL_NAME = "sologsb-1007-editor";
const TAB_ID = uid("tab");

/** 编目组一轮清单的示例，可直接粘贴试用：合并、停用、改名、失败行各一。 */
const SAMPLE_TERM_LIST = JSON.stringify(
  {
    catalogVersion: "2026-10-03-r4",
    exportedAt: "2026-10-03T09:00:00+08:00",
    rows: [
      { code: "E-001", name: "抗日战争记忆", status: "active", version: 4 },
      { code: "T-003", status: "merged", mergeTargetCode: "T-001", version: 4 },
      { code: "P-002", status: "retired", version: 4 },
      { code: "E-099", name: "1958 年外调", status: "merged", mergeTargetCode: "E-404", version: 4 },
    ],
  },
  null,
  2,
);

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存";
  if (status === "offline") return "离线草稿";
  return "已自动保存";
}

const termTypeName = (type: Term["type"]) => (type === "topic" ? "主题" : type === "event" ? "事件" : "人物");

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  const emptySegment = (start: number, end: number, text: string, speakerId: string): Segment => ({
    id: uid("seg"),
    start,
    end,
    speakerId,
    text,
    confidence: 3,
    reviewed: false,
    flags: { lowConfidence: false, dialect: false, properNoun: false },
    termCodes: [],
    needsReclassify: false,
    brokenTerms: [],
    comments: [],
  });

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push(
        emptySegment(
          parseTime(match?.[1] ?? "0"),
          parseTime(match?.[2] ?? "1"),
          text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
          speakerName ? "sp-custom" : "sp-interviewer",
        ),
      );
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push(
        emptySegment(
          start,
          start + Math.max(3, text.length / 5),
          text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
          speakerName ? "sp-custom" : "sp-interviewer",
        ),
      );
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push(emptySegment(index * 6, index * 6 + 5.4, text, "sp-interviewer"));
    });
  }

  return {
    id: uid("track"),
    name: trackName || "导入轨",
    language: "待识别",
    status: "待校对",
    segments,
  };
}

export default function OralHistoryEditor() {
  const loaded = loadProject();
  const [project, setProject] = createSignal<ProjectData>(loaded.project);
  const [revision, setRevision] = createSignal(loaded.revision);
  const [past, setPast] = createSignal<ProjectData[]>([]);
  const [future, setFuture] = createSignal<ProjectData[]>([]);
  const [selectedId, setSelectedId] = createSignal(loaded.project.tracks[0]?.segments[0]?.id ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"saved" | "saving" | "offline">("saved");
  const [lastAction, setLastAction] = createSignal("示例项目已就绪");
  const [conflict, setConflict] = createSignal<PersistedEnvelope | null>(null);
  const [online, setOnline] = createSignal(true);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low">("all");
  const [catalogOpen, setCatalogOpen] = createSignal(false);
  const [catalogTab, setCatalogTab] = createSignal("import");
  const [catalogText, setCatalogText] = createSignal("");
  const [pendingRows, setPendingRows] = createSignal<PendingImportRow[]>(loadPendingRows());
  const [migration, setMigration] = useStateMigration(loaded);
  const [importSummary, setImportSummary] = createSignal<{
    ok: boolean;
    lines: string[];
  } | null>(null);
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let termListInputRef: HTMLInputElement | undefined;
  let saveTimer: number | undefined;
  let hydrated = false;
  let dirty = false;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
  const activeTrack = createMemo(() => {
    const data = project();
    return data.tracks.find((track) => track.id === data.activeTrackId) ?? data.tracks[0];
  });
  const activeSegment = createMemo(() => activeTrack()?.segments.find((item) => item.id === selectedId()) ?? null);
  const visibleSegments = createMemo(() => {
    const segments = activeTrack()?.segments ?? [];
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed || segment.needsReclassify);
    if (trackFilter() === "low") return segments.filter((segment) => segment.confidence <= 2 || segment.flags.lowConfidence || segment.needsReclassify);
    return segments;
  });
  const reclassifyCount = createMemo(() =>
    project().tracks.flatMap((track) => track.segments).filter((segment) => segment.needsReclassify).length,
  );
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed && !segment.needsReclassify).length / segments.length) * 100);
  });
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const termByCode = (code: string) => project().terms.find((term) => term.code === code);
  const termStats = createMemo(() => {
    const terms = project().terms;
    return {
      active: terms.filter((term) => term.status === "active" && !term.localOnly).length,
      merged: terms.filter((term) => term.status === "merged").length,
      retired: terms.filter((term) => term.status === "retired").length,
      localOnly: terms.filter((term) => term.localOnly).length,
    };
  });
  const parsedCatalog = createMemo(() => (catalogText().trim() ? parseTermList(catalogText()) : null));

  const commit = (label: string, mutate: (draft: ProjectData) => void) => {
    const current = structuredClone(project());
    const next = structuredClone(current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    batch(() => {
      setPast((items) => [...items.slice(-49), current]);
      setFuture([]);
      setProject(next);
      setRevision((value) => value + 1);
      setLastAction(label);
    });
    dirty = true;
  };

  const commitSegment = (label: string, mutate: (segment: Segment, draft: ProjectData) => void) => {
    const id = selectedId();
    commit(label, (draft) => {
      const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
      const segment = track?.segments.find((item) => item.id === id);
      if (segment) mutate(segment, draft);
    });
  };

  const undo = () => {
    const stack = past();
    if (!stack.length) return;
    const previous = stack[stack.length - 1];
    setFuture((items) => [structuredClone(project()), ...items].slice(0, 50));
    setPast(stack.slice(0, -1));
    setProject(previous);
    setRevision((value) => value + 1);
    setLastAction("已撤销上一步");
    dirty = true;
  };

  const redo = () => {
    const stack = future();
    if (!stack.length) return;
    const next = stack[0];
    setPast((items) => [...items.slice(-49), structuredClone(project())]);
    setFuture(stack.slice(1));
    setProject(next);
    setRevision((value) => value + 1);
    setLastAction("已重做");
    dirty = true;
  };

  const switchTrack = (trackId: string) => {
    commit("切换文本轨", (draft) => {
      draft.activeTrackId = trackId;
      setSelectedId(draft.tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "");
    });
  };

  const moveSelection = (direction: 1 | -1) => {
    const segments = activeTrack()?.segments ?? [];
    if (!segments.length) return;
    const index = Math.max(0, segments.findIndex((segment) => segment.id === selectedId()));
    const nextIndex = (index + direction + segments.length) % segments.length;
    setSelectedId(segments[nextIndex].id);
    document.getElementById(`segment-${segments[nextIndex].id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const splitSelection = () => {
    const segment = activeSegment();
    if (!segment || segment.text.trim().length < 2) return;
    const cursor = editorRef?.selectionStart ?? Math.floor(segment.text.length / 2);
    const safeCursor = Math.max(1, Math.min(cursor, segment.text.length - 1));
    const firstText = segment.text.slice(0, safeCursor).trim();
    const secondText = segment.text.slice(safeCursor).trim();
    if (!firstText || !secondText) return;
    const ratio = firstText.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    const secondId = uid("seg");
    commitSegment("拆分片段", (current, draft) => {
      const original = structuredClone(current);
      current.text = firstText;
      current.end = Number(boundary.toFixed(1));
      const trackIndex = draft.tracks.findIndex((track) => track.id === draft.activeTrackId);
      if (trackIndex >= 0) {
        const segmentIndex = draft.tracks[trackIndex].segments.findIndex((item) => item.id === current.id);
        draft.tracks[trackIndex].segments.splice(segmentIndex + 1, 0, {
          ...original,
          id: secondId,
          start: Number(boundary.toFixed(1)),
          text: secondText,
          reviewed: false,
          comments: [],
        });
      }
      setSelectedId(secondId);
    });
  };

  const mergeWithNext = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const index = track.segments.findIndex((item) => item.id === segment.id);
    const next = track.segments[index + 1];
    if (!next) return;
    commitSegment("合并下一片段", (current, draft) => {
      current.text = `${current.text.trim()} ${next.text.trim()}`;
      current.end = next.end;
      current.termCodes = [...new Set([...current.termCodes, ...next.termCodes])];
      current.comments.push(...next.comments);
      current.confidence = Math.min(current.confidence, next.confidence) as Confidence;
      const sourceTrack = draft.tracks.find((item) => item.id === draft.activeTrackId);
      sourceTrack?.segments.splice(index + 1, 1);
      current.reviewed = false;
    });
  };

  const toggleFlag = (flag: keyof Segment["flags"]) => {
    commitSegment("修改校对标记", (segment) => {
      segment.flags[flag] = !segment.flags[flag];
      segment.reviewed = false;
    });
  };

  const setConfidence = (confidence: Confidence) => {
    commitSegment("校正置信度", (segment) => {
      segment.confidence = confidence;
      segment.flags.lowConfidence = confidence <= 2;
      segment.reviewed = false;
    });
  };

  const addComment = () => {
    const body = commentDraft().trim();
    if (!body) return;
    commitSegment("添加批注", (segment) => {
      segment.comments.unshift({
        id: uid("comment"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      segment.reviewed = false;
    });
    setCommentDraft("");
  };

  const addReply = (commentId: string) => {
    const body = (replyDrafts()[commentId] ?? "").trim();
    if (!body) return;
    commitSegment("回复批注", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      comment?.replies.push({
        id: uid("reply"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
      });
    });
    setReplyDrafts((drafts) => ({ ...drafts, [commentId]: "" }));
  };

  const toggleComment = (commentId: string) => {
    commitSegment("更新批注状态", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  /** 校对员只能把片段挂到本机词库中状态为 active 的词条上。 */
  const toggleTerm = (termCode: string) => {
    commitSegment("挂载/摘除词条", (segment) => {
      if (!segment.termCodes.includes(termCode)) segment.termCodes = [...segment.termCodes, termCode];
      else segment.termCodes = segment.termCodes.filter((code) => code !== termCode);
    });
  };

  const confirmReclassify = () => {
    if (!activeSegment()?.termCodes.length) return;
    commitSegment("完成重新归类", (segment, draft) => reclassifySegment(draft, segment.id, segment.termCodes));
  };

  const exportSrt = () => {
    const lines = activeTrack().segments.map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${segment.text}\n`;
    });
    downloadText(`${project().title}-${activeTrack().name}.srt`, lines.join("\n"), "application/x-subrip;charset=utf-8");
  };

  const exportTermTemplate = () => {
    downloadText(`词条清单-${new Date().toISOString().slice(0, 10)}.json`, SAMPLE_TERM_LIST, "application/json;charset=utf-8");
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const imported = parseTimedTranscript(text, file.name.replace(/\.[^.]+$/, ""));
    if (!imported.segments.length) {
      setLastAction("未识别到带时间码的文本");
      return;
    }
    commit("导入转写文本", (draft) => {
      draft.tracks.push(imported);
      draft.activeTrackId = imported.id;
      setSelectedId(imported.segments[0].id);
    });
  };

  /**
   * 执行一轮清单对账。清单行只改词条表与片段挂载，
   * 批注、回复、校对标记一概不触碰；失败行进独立重试队列。
   * baseQueue 是重试后队列的基座（重试成功的行先从基座剔除，不再留下）。
   */
  const runTermImport = (
    rows: TermListRow[],
    catalogVersion: string | undefined,
    options: { silent: boolean; baseQueue?: PendingImportRow[] },
  ) => {
    const current = structuredClone(project());
    let outcome: { result: ReconcileResult; failures: PendingImportRow[] };
    try {
      outcome = importBatch(current, rows, catalogVersion);
    } catch (error) {
      const message = `清单解析后对账异常：${(error as Error).message}`;
      setImportSummary({ ok: false, lines: [message] });
      setLastAction(message);
      return;
    }

    const base = options.baseQueue;
    const queue = base !== undefined
      ? mergePendingRows(base, outcome.failures)
      : mergePendingRows(pendingRows(), outcome.failures);
    setPendingRows(queue);
    savePendingRows(queue);

    const r = outcome.result;
    const lines: string[] = [];
    if (r.applied) lines.push(`新增/更新 ${r.applied} 条`);
    if (r.merged) lines.push(`合并改挂 ${r.merged} 条`);
    if (r.retired) lines.push(`停用 ${r.retired} 条`);
    if (r.backfilled) lines.push(`按名称回填编号 ${r.backfilled} 条`);
    if (r.reclassified) lines.push(`${r.reclassified} 处片段关联标为待重新归类`);
    if (outcome.failures.length) lines.push(`${outcome.failures.length} 行失败，已回滚该行并进入重试队列`);
    if (!lines.length) lines.push("清单没有带来变化");
    const changed = r.applied + r.merged + r.retired + r.backfilled + r.reclassified + outcome.failures.length > 0;
    setImportSummary({ ok: outcome.failures.length === 0, lines });

    current.updatedAt = new Date().toISOString();

    if (options.silent) {
      if (!changed) return;
      setProject(current);
      setRevision((value) => value + 1);
      setLastAction(
        outcome.failures.length
          ? `打开时自动重试：${rows.length - outcome.failures.length}/${rows.length} 行对上，其余继续等待`
          : `打开时自动重试成功，${rows.length} 条已对上`,
      );
    } else {
      batch(() => {
        setPast((items) => [...items.slice(-49), structuredClone(project())]);
        setFuture([]);
        setProject(current);
        setRevision((value) => value + 1);
        setLastAction("导入编目组词条清单");
      });
    }
    dirty = true;
  };

  const submitCatalogText = () => {
    const parsed = parsedCatalog();
    if (!parsed || !parsed.rows.length) return;
    runTermImport(parsed.rows, parsed.manifest?.catalogVersion, { silent: false });
  };

  const importTermListFile = async (file: File) => {
    const text = await file.text();
    setCatalogText(text);
    setCatalogTab("import");
    setImportSummary(null);
    setCatalogOpen(true);
  };

  const retryRows = (onlyCode?: string) => {
    const rows = pendingRows().filter((row) => !onlyCode || row.code === onlyCode);
    if (!rows.length) return;
    // 本次参与重试的行先移出基座；成功的不再回来，仍失败的重新入队。
    const base = pendingRows().filter((row) => !rows.includes(row));
    runTermImport(rows, rows[0]?.catalogVersion, { silent: false, baseQueue: base });
  };

  const discardPending = (code: string) => {
    const next = pendingRows().filter((row) => row.code !== code);
    setPendingRows(next);
    savePendingRows(next);
    setLastAction(`已移出走失行 ${code}`);
  };

  const resolveConflict = (useIncoming: boolean) => {
    const incoming = conflict();
    if (!incoming) return;
    if (useIncoming) {
      setPast((items) => [...items.slice(-49), structuredClone(project())]);
      setProject(structuredClone(incoming.project));
      setRevision(incoming.revision + 1);
      setSelectedId(incoming.project.tracks.find((track) => track.id === incoming.project.activeTrackId)?.segments[0]?.id ?? "");
      setLastAction("已采用其他标签页的版本");
      dirty = true;
    } else {
      setRevision((value) => value + 1);
      setLastAction("已保留本页并覆盖冲突版本");
      dirty = true;
    }
    setConflict(null);
  };

  onMount(() => {
    hydrated = true;

    // 下次打开只重试上轮失败的那几条；成功的自动出队。
    const waiting = loadPendingRows();
    if (waiting.length) {
      runTermImport(waiting, waiting[0]?.catalogVersion, { silent: true, baseQueue: [] });
    }

    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "sologsb-1007-project-v1" || !event.newValue) return;
      try {
        const incoming = JSON.parse(event.newValue) as PersistedEnvelope;
        if (incoming.tabId !== TAB_ID && incoming.revision > revision()) setConflict(incoming);
      } catch {
        // Ignore unrelated or malformed storage events.
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        const envelope = saveProject(project(), revision(), TAB_ID);
        setSaveStatus("saved");
        setLastAction("已保存本地草稿");
        channel?.postMessage(envelope);
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        mergeWithNext();
      } else if (event.key.toLowerCase() === "r" && activeSegment()) {
        event.preventDefault();
        commitSegment("标记片段已校对", (segment) => { segment.reviewed = true; });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("keydown", handleKeydown);
    setOnline(navigator.onLine);
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("keydown", handleKeydown);
    });
  });

  channel?.addEventListener("message", (event: MessageEvent<PersistedEnvelope>) => {
    if (event.data.tabId !== TAB_ID && event.data.revision > revision()) setConflict(event.data);
  });

  createEffect(() => {
    const current = project();
    const currentRevision = revision();
    if (!hydrated) return;
    setSaveStatus(online() ? "saving" : "offline");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const envelope = saveProject(current, currentRevision, TAB_ID);
      setSaveStatus(online() ? "saved" : "offline");
      if (dirty) {
        channel?.postMessage(envelope);
        dirty = false;
      }
    }, 420);
  });

  onCleanup(() => {
    window.clearTimeout(saveTimer);
    channel?.close();
  });

  const clickSegment = (id: string) => {
    setSelectedId(id);
    queueMicrotask(() => editorRef?.focus());
  };

  return (
    <div class="app-shell">
      <Show when={migration()}>
        {(info) => (
          <div class="migration-banner" role="status">
            <div>
              <strong>旧草稿已迁移到编目词条库</strong>
              <span>
                抽出内嵌词条 {info().extracted} 条，按名称回填编号 {info().backfilled} 条；
                {info().unresolvedNames.length > 0
                  ? `回填不上、已保留待编目确认：${info().unresolvedNames.join("、")}`
                  : "全部按名称对上编目编号。"}
                批注与校对标记原样保留。
              </span>
            </div>
            <button class="btn btn-quiet" onClick={() => setMigration(null)}>知道了</button>
          </div>
        )}
      </Show>

      <Show when={conflict()}>
        {(incoming) => (
          <div class="conflict-banner" role="alert">
            <div>
              <strong>检测到另一个标签页修改了同一草稿</strong>
              <span>
                对方版本保存于 {new Date(incoming().savedAt).toLocaleTimeString()}。为避免静默覆盖，请选择要保留的版本。
              </span>
            </div>
            <div class="conflict-actions">
              <button class="btn btn-quiet" onClick={() => resolveConflict(false)}>保留本页</button>
              <button class="btn btn-danger" onClick={() => resolveConflict(true)}>载入对方版本</button>
            </div>
          </div>
        )}
      </Show>

      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span>口述</span><b>1007</b></div>
        <div class="project-heading">
          <input
            aria-label="项目标题"
            value={project().title}
            onChange={(event) => commit("修改项目标题", (draft) => { draft.title = event.currentTarget.value; })}
          />
          <div class="project-meta">
            <span>{project().interviewee}</span>
            <span>{project().recordingDate}</span>
            <span class={`save-state ${saveStatus()}`}>{statusText(saveStatus())}</span>
          </div>
        </div>
        <div class="top-actions">
          <span class={`network-chip ${online() ? "online" : "offline"}`}>{online() ? "在线" : "离线可编辑"}</span>
          <button class="icon-btn" title="撤销 Ctrl/Cmd+Z" disabled={!past().length} onClick={undo}>↶</button>
          <button class="icon-btn" title="重做 Ctrl/Cmd+Shift+Z" disabled={!future().length} onClick={redo}>↷</button>
          <button class="btn btn-quiet" onClick={() => setHelpOpen(true)}>快捷键 <kbd>?</kbd></button>
          <button class="btn btn-primary" onClick={exportSrt}>导出 SRT</button>
        </div>
      </header>

      <div class="workspace">
        <aside class="left-panel">
          <section class="panel-section overview-card">
            <div class="eyebrow">校对进度</div>
            <div class="progress-row">
              <strong>{completedPercent()}%</strong>
              <span>{project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed && !segment.needsReclassify).length} / {project().tracks.flatMap((track) => track.segments).length} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
            <Show when={reclassifyCount() > 0}>
              <p class="reclassify-note">⚠ {reclassifyCount()} 个片段因词条停用待重新归类。</p>
            </Show>
            <p>修改会自动保存在本机；断网后仍可继续校对。</p>
          </section>

          <section class="panel-section">
            <div class="section-title"><h2>文本轨道</h2><span>{project().tracks.length}</span></div>
            <div class="track-list">
              <For each={project().tracks}>
                {(track) => (
                  <button class={`track-card ${track.id === project().activeTrackId ? "active" : ""}`} onClick={() => switchTrack(track.id)}>
                    <span class="track-icon">{track.language === "English" ? "EN" : track.language === "福州话转写" ? "方" : "普"}</span>
                    <span class="track-info"><strong>{track.name}</strong><small>{track.segments.length} 段 · {track.status}</small></span>
                    <span class="track-dot" style={{ background: track.status === "已完成" ? "#15803d" : track.status === "校对中" ? "#d97706" : "#94a3b8" }} />
                  </button>
                )}
              </For>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.txt,.vtt"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => fileInputRef?.click()}><span>＋</span> 导入带时间码文本</button>
            <div class="hint">支持 SRT / VTT / 每行 `[00:12] 文本`</div>
          </section>

          <section class="panel-section catalog-card">
            <div class="section-title">
              <h2>词条库</h2>
              <span class="catalog-pill">编目组维护 · 本机只读</span>
            </div>
            <div class="catalog-stats">
              <span><b>{termStats().active}</b> 在用</span>
              <span><b>{termStats().merged}</b> 已合并</span>
              <span><b>{termStats().retired}</b> 已停用</span>
            </div>
            <Show when={termStats().localOnly > 0}>
              <p class="local-only-note">？ {termStats().localOnly} 条旧草稿词条回填不上编号，已标出待编目确认。</p>
            </Show>
            <input
              ref={termListInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importTermListFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => { setCatalogOpen(true); setCatalogTab(pendingRows().length ? "retry" : "import"); }}>
              <span>⇄</span> 导入词条清单
              <Show when={pendingRows().length}><em class="pending-badge">{pendingRows().length}</em></Show>
            </button>
            <button class="wide-action quiet" onClick={() => termListInputRef?.click()}>从文件读取清单</button>
            <div class="hint">按编目组编号对账：合并自动改挂，停用无接续的片段标待重新归类。</div>
          </section>
        </aside>

        <main class="transcript-panel">
          <div class="panel-toolbar">
            <div>
              <div class="eyebrow">当前轨道</div>
              <h1>{activeTrack().name}</h1>
            </div>
            <div class="filters" role="group" aria-label="片段筛选">
              <button class={trackFilter() === "all" ? "active" : ""} onClick={() => setTrackFilter("all")}>全部</button>
              <button class={trackFilter() === "unreviewed" ? "active" : ""} onClick={() => setTrackFilter("unreviewed")}>未校对</button>
              <button class={trackFilter() === "low" ? "active" : ""} onClick={() => setTrackFilter("low")}>低置信</button>
            </div>
          </div>

          <div class="transcript-list" role="listbox" aria-label="转写片段">
            <For each={visibleSegments()}>
              {(segment, index) => (
                <article
                  id={`segment-${segment.id}`}
                  role="option"
                  aria-selected={segment.id === selectedId()}
                  class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed && !segment.needsReclassify ? "reviewed" : ""} ${segment.needsReclassify ? "needs-reclassify" : ""}`}
                  onClick={() => clickSegment(segment.id)}
                >
                  <div class="segment-rail" style={{ background: speakerById(segment.speakerId)?.color ?? "#64748b" }} />
                  <div class="segment-time">
                    <span>{formatTime(segment.start, false)}</span>
                    <small>{formatTime(segment.end, false)}</small>
                  </div>
                  <div class="segment-body">
                    <div class="segment-meta">
                      <b>{speakerById(segment.speakerId)?.name ?? "未知发言人"}</b>
                      <span class={`confidence c${segment.confidence}`}>置信 {segment.confidence}/5</span>
                      <Show when={segment.flags.lowConfidence}><span class="pill alert">低置信</span></Show>
                      <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
                      <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
                      <Show when={segment.reviewed && !segment.needsReclassify}><span class="pill done">✓ 已校对</span></Show>
                      <Show when={segment.needsReclassify}><span class="pill reclass">⚠ 待重新归类</span></Show>
                    </div>
                    <p>{segment.text}</p>
                    <div class="segment-tags">
                      <For each={segment.termCodes.map(termByCode).filter(Boolean)}>
                        {(term) => <span style={{ "--tag-color": term!.color } as any}>#{term!.name}</span>}
                      </For>
                    </div>
                  </div>
                  <span class="segment-index">{index() + 1}</span>
                </article>
              )}
            </For>
            <Show when={!visibleSegments().length}>
              <div class="empty-state"><b>没有符合筛选条件的片段</b><span>切换到“全部”继续校对。</span></div>
            </Show>
          </div>
        </main>

        <aside class="inspector">
          <Show when={activeSegment()} fallback={<div class="empty-inspector"><b>选择一个片段</b><p>在中间列表点击片段后即可校正发言人、置信度、标记和批注。</p></div>}>
            {(segment) => (
              <Tabs defaultValue="correct" class="inspector-tabs">
                <Tabs.List class="tab-list">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">
                    词条
                    <Show when={segment().needsReclassify}><em class="tab-dot">!</em></Show>
                  </Tabs.Trigger>
                  <Tabs.Trigger value="comments">批注 <span>{segment().comments.length}</span></Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="correct" class="tab-content">
                  <div class="inspector-heading">
                    <div><span>片段 {activeTrack().segments.findIndex((item) => item.id === segment().id) + 1}</span><strong>{formatTime(segment().start, false)} — {formatTime(segment().end, false)}</strong></div>
                    <button class={`review-button ${segment().reviewed ? "done" : ""}`} onClick={() => commitSegment("标记片段已校对", (item) => { item.reviewed = true; })}>
                      {segment().reviewed ? "✓ 已校对" : "标记已校对"}
                    </button>
                  </div>

                  <label class="field-label" for="speaker-select">发言人</label>
                  <select
                    id="speaker-select"
                    value={segment().speakerId}
                    onChange={(event) => commitSegment("校正发言人", (item) => { item.speakerId = event.currentTarget.value; item.reviewed = false; })}
                  >
                    <For each={project().speakers}>{(speaker) => <option value={speaker.id}>{speaker.name} · {speaker.role}</option>}</For>
                  </select>

                  <div class="time-grid">
                    <label>开始<input type="text" value={formatTime(segment().start)} onChange={(event) => commitSegment("修改开始时间", (item) => { item.start = parseTime(event.currentTarget.value); })} /></label>
                    <label>结束<input type="text" value={formatTime(segment().end)} onChange={(event) => commitSegment("修改结束时间", (item) => { item.end = parseTime(event.currentTarget.value); })} /></label>
                  </div>

                  <label class="field-label" for="transcript-editor">转写文本</label>
                  <textarea
                    id="transcript-editor"
                    ref={editorRef}
                    rows="7"
                    value={segment().text}
                    onChange={(event) => commitSegment("校正转写文本", (item) => { item.text = event.currentTarget.value; item.reviewed = false; })}
                  />
                  <div class="textarea-help">光标停在句中后点击“拆分”，系统会保留两侧时间码比例。</div>

                  <div class="field-label">置信度</div>
                  <div class="confidence-picker" role="radiogroup" aria-label="置信度">
                    <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                      {(value) => <button class={segment().confidence === value ? "active" : ""} onClick={() => setConfidence(value)}>{value}</button>}
                    </For>
                  </div>

                  <div class="field-label">校对标记</div>
                  <div class="flag-list">
                    <Checkbox checked={segment().flags.lowConfidence} onChange={() => toggleFlag("lowConfidence")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>低置信词或句</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.dialect} onChange={() => toggleFlag("dialect")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>方言表达</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.properNoun} onChange={() => toggleFlag("properNoun")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>专有名词</Checkbox.Label>
                    </Checkbox>
                  </div>

                  <div class="split-actions">
                    <button onClick={splitSelection}>⌁ 按光标拆分</button>
                    <button disabled={activeTrack().segments.at(-1)?.id === segment().id} onClick={mergeWithNext}>合 合并下一段</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="annotate" class="tab-content">
                  <Show when={segment().needsReclassify}>
                    <div class="reclass-banner">
                      <strong>该片段的词条关联已断开</strong>
                      <p>
                        编目组停用了
                        <For each={segment().brokenTerms ?? []}>
                          {(name, i) => <b> {name}{i() < (segment().brokenTerms?.length ?? 0) - 1 ? "、" : ""}</b>}
                        </For>
                        且没有接续目标。请在下方勾选改挂的在用词条，批注与校对标记不会丢失。
                      </p>
                      <button class="btn btn-primary" disabled={!segment().termCodes.length} onClick={confirmReclassify}>
                        完成重新归类（{segment().termCodes.length} 个词条）
                      </button>
                    </div>
                  </Show>

                  <div class="content-title">
                    <h3>挂载词条</h3>
                    <p>词条库由编目组单独维护；这里只把当前片段挂到在用词条上，不能新建或改写词条。</p>
                  </div>
                  <For each={project().terms.filter((term) => term.status === "active")}>
                    {(term) => (
                      <button class={`tag-option ${segment().termCodes.includes(term.code) ? "selected" : ""}`} onClick={() => toggleTerm(term.code)}>
                        <i style={{ background: term.color }} />
                        <span><strong>#{term.name}</strong><small>{termTypeName(term.type)} · {term.code}{term.localOnly ? " · 待回填" : ` · v${term.version}`}</small></span>
                        <b>{segment().termCodes.includes(term.code) ? "✓" : "＋"}</b>
                      </button>
                    )}
                  </For>

                  <Show when={project().terms.some((term) => term.status !== "active")}>
                    <div class="content-title subsection"><h3>已合并 / 停用</h3><p>这些编号不可再挂载；已挂的片段已在导入时自动改挂或标待归类。</p></div>
                    <For each={project().terms.filter((term) => term.status !== "active")}>
                      {(term) => (
                        <div class={`tag-option disabled ${term.status}`}>
                          <i style={{ background: term.color }} />
                          <span>
                            <strong>#{term.name}</strong>
                            <small>
                              {term.code} · {term.status === "merged" ? "已合并" : "已停用"}
                              <Show when={term.status === "merged"}>
                                {" → "}
                                {(() => {
                                  const target = termByCode(term.mergeTargetCode ?? "");
                                  return target ? `${target.name}（${target.code}）` : term.mergeTargetCode;
                                })()}
                              </Show>
                            </small>
                          </span>
                        </div>
                      )}
                    </For>
                  </Show>
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注不会改写原文，可保留校对依据并继续讨论；导入词条清单不会清空批注。</p></div>
                  <div class="comment-compose">
                    <textarea rows="3" placeholder="记录读音、词义或专名依据…" value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)} />
                    <button class="btn btn-primary" onClick={addComment}>添加批注</button>
                  </div>
                  <For each={segment().comments} fallback={<div class="mini-empty">当前片段还没有批注。</div>}>
                    {(comment) => (
                      <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                        <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                        <p>{comment.body}</p>
                        <For each={comment.replies}>
                          {(reply) => <div class="reply"><b>{reply.author}</b><span>{reply.body}</span></div>}
                        </For>
                        <div class="reply-row">
                          <input
                            value={replyDrafts()[comment.id] ?? ""}
                            placeholder="回复…"
                            onInput={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.currentTarget.value }))}
                            onKeyDown={(event) => { if (event.key === "Enter") addReply(comment.id); }}
                          />
                          <button onClick={() => addReply(comment.id)}>回复</button>
                        </div>
                        <button class="resolve-link" onClick={() => toggleComment(comment.id)}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </article>
                    )}
                  </For>
                </Tabs.Content>
              </Tabs>
            )}
          </Show>
        </aside>
      </div>

      <footer class="statusbar">
        <span>最近操作：{lastAction()}</span>
        <span>版本 {revision() + 1} · 本地草稿</span>
        <span class="status-shortcuts">J/K 浏览　R 已校对　M 合并　? 帮助</span>
      </footer>

      <Dialog open={catalogOpen()} onOpenChange={(open) => { setCatalogOpen(open); if (open) setImportSummary(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content catalog-dialog">
            <Dialog.Title>导入编目组词条清单</Dialog.Title>
            <Dialog.Description>
              按词条编号对账。两边各自持有版本；合并的关联顺着目标改挂，停用又没接续的片段标待重新归类，批注和校对标记不会被空值冲掉。
            </Dialog.Description>

            <Tabs value={catalogTab()} onChange={setCatalogTab}>
              <Tabs.List class="tab-list">
                <Tabs.Trigger value="import">粘贴 / 读取清单</Tabs.Trigger>
                <Tabs.Trigger value="retry">
                  失败重试
                  <Show when={pendingRows().length}><em class="tab-dot">{pendingRows().length}</em></Show>
                </Tabs.Trigger>
              </Tabs.List>

              <Tabs.Content value="import" class="tab-content">
                <textarea
                  class="catalog-input"
                  rows="10"
                  placeholder='粘贴编目组导出的 JSON：{ "catalogVersion": "...", "rows": [{ "code": "T-001", ... }] }'
                  value={catalogText()}
                  onInput={(event) => { setCatalogText(event.currentTarget.value); setImportSummary(null); }}
                />
                <Show when={parsedCatalog()}>
                  {(parsed) => (
                    <div class="catalog-preview">
                      <Show when={parsed().manifest?.catalogVersion}>
                        <span class="pill proper">清单版本 {parsed().manifest!.catalogVersion}</span>
                      </Show>
                      <span class="pill done">{parsed().rows.length} 行可对账</span>
                      <For each={parsed().errors.slice(0, 4)}>
                        {(error) => <span class="pill alert">{error}</span>}
                      </For>
                      <Show when={parsed().errors.length > 4}><span class="pill alert">另有 {parsed().errors.length - 4} 行格式问题</span></Show>
                    </div>
                  )}
                </Show>
                <Show when={importSummary()}>
                  {(summary) => (
                    <div class={`import-summary ${summary().ok ? "ok" : "warn"}`}>
                      <For each={summary().lines}>{(line) => <p>· {line}</p>}</For>
                    </div>
                  )}
                </Show>
                <div class="dialog-footer catalog-actions">
                  <button class="btn btn-quiet" onClick={exportTermTemplate}>下载清单模板</button>
                  <button class="btn btn-quiet" onClick={() => setCatalogText(SAMPLE_TERM_LIST)}>填入示例</button>
                  <button
                    class="btn btn-primary"
                    disabled={!parsedCatalog() || parsedCatalog()!.rows.length === 0}
                    onClick={submitCatalogText}
                  >
                    按编号对账导入
                  </button>
                </div>
              </Tabs.Content>

              <Tabs.Content value="retry" class="tab-content">
                <div class="content-title">
                  <h3>上次没对上的行（{pendingRows().length}）</h3>
                  <p>一批中失败的行会整行回滚并留在这里；已对上的行不受影响。下次打开编辑器会自动重试，也可手动重试。</p>
                </div>
                <Show when={pendingRows().length} fallback={<div class="mini-empty">没有待重试的失败行。</div>}>
                  <div class="pending-list">
                    <For each={pendingRows()}>
                      {(row) => (
                        <div class="pending-row">
                          <div>
                            <strong>{row.code}</strong>
                            <small>{row.status ?? "active"}{row.mergeTargetCode ? ` → ${row.mergeTargetCode}` : ""} · 已重试 {row.attempts} 次</small>
                            <p>{row.lastError}</p>
                          </div>
                          <div class="pending-row-actions">
                            <button class="btn btn-quiet" onClick={() => retryRows(row.code)}>重试</button>
                            <button class="btn btn-quiet" onClick={() => discardPending(row.code)}>移出队列</button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                  <div class="dialog-footer">
                    <button class="btn btn-primary" onClick={() => retryRows()}>全部重试</button>
                  </div>
                </Show>
                <Show when={importSummary()}>
                  {(summary) => (
                    <div class={`import-summary ${summary().ok ? "ok" : "warn"}`}>
                      <For each={summary().lines}>{(line) => <p>· {line}</p>}</For>
                    </div>
                  )}
                </Show>
              </Tabs.Content>
            </Tabs>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>键盘校对</Dialog.Title>
            <Dialog.Description>光标在输入框中时，单键快捷键不会抢占文字输入。</Dialog.Description>
            <div class="shortcut-grid">
              <span><kbd>J</kbd><kbd>↓</kbd> 下一片段</span>
              <span><kbd>K</kbd><kbd>↑</kbd> 上一片段</span>
              <span><kbd>R</kbd> 标记已校对</span>
              <span><kbd>M</kbd> 合并下一片段</span>
              <span><kbd>Ctrl/⌘ Z</kbd> 撤销</span>
              <span><kbd>Ctrl/⌘ ⇧ Z</kbd> 重做</span>
              <span><kbd>Ctrl/⌘ S</kbd> 立即保存</span>
              <span><kbd>?</kbd> 显示本帮助</span>
            </div>
            <div class="dialog-footer"><button class="btn btn-primary" onClick={() => setHelpOpen(false)}>开始校对</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}

function useStateMigration(loaded: ReturnType<typeof loadProject>) {
  return createSignal(loaded.migrated ? loaded.migrationInfo ?? null : null);
}
