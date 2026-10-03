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
  untrack,
} from "solid-js";
import { uid } from "../data";
import { entryCounts, failedItemCount, parseCatalogFile, retryBatch, runImport } from "../catalog";
import { downloadText, formatTime, loadProject, parseTime, saveProject } from "../persistence";
import type { Confidence, PersistedEnvelope, ProjectData, Segment, TranscriptTrack } from "../types";

const CHANNEL_NAME = "sologsb-1007-editor";
const TAB_ID = uid("tab");

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存";
  if (status === "offline") return "离线草稿";
  return "已自动保存";
}

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start: parseTime(match?.[1] ?? "0"),
        end: parseTime(match?.[2] ?? "1"),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        entryIds: [],
        pendingReclassify: false,
        pendingEntryCodes: [],
        comments: [],
      });
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start,
        end: start + Math.max(3, text.length / 5),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        entryIds: [],
        pendingReclassify: false,
        pendingEntryCodes: [],
        comments: [],
      });
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push({
        id: uid("seg"),
        start: index * 6,
        end: index * 6 + 5.4,
        speakerId: "sp-interviewer",
        text,
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        entryIds: [],
        pendingReclassify: false,
        pendingEntryCodes: [],
        comments: [],
      });
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
  const [batchOpen, setBatchOpen] = createSignal(false);
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low">("all");
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let catalogInputRef: HTMLInputElement | undefined;
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
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed);
    if (trackFilter() === "low") return segments.filter((segment) => segment.confidence <= 2 || segment.flags.lowConfidence);
    return segments;
  });
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed).length / segments.length) * 100);
  });
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const entryById = (entryId: string) => project().entries.find((entry) => entry.id === entryId);
  const counts = createMemo(() => entryCounts(project()));
  const pendingMigrationCount = createMemo(() => counts().pending);
  const latestBatch = createMemo(() => project().importBatches[0] ?? null);
  const latestFailedCount = createMemo(() => failedItemCount(latestBatch()));

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
      selectedIdSet(draft.tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "");
    });
  };

  const selectedIdSet = (id: string) => setSelectedId(id);

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
      current.entryIds = [...new Set([...current.entryIds, ...next.entryIds])];
      current.pendingEntryCodes = [...new Set([...current.pendingEntryCodes, ...next.pendingEntryCodes])];
      current.pendingReclassify = current.pendingEntryCodes.length > 0;
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

  const toggleEntry = (entryId: string) => {
    commitSegment("更新词条关联", (segment) => {
      segment.entryIds = segment.entryIds.includes(entryId)
        ? segment.entryIds.filter((id) => id !== entryId)
        : [...segment.entryIds, entryId];
      segment.reviewed = false;
    });
  };

  const exportSrt = () => {
    const lines = activeTrack().segments.map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${segment.text}\n`;
    });
    downloadText(`${project().title}-${activeTrack().name}.srt`, lines.join("\n"), "application/x-subrip;charset=utf-8");
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

  const importCatalogFile = async (file: File) => {
    const text = await file.text();
    let incoming: ReturnType<typeof parseCatalogFile>;
    try {
      incoming = parseCatalogFile(text);
    } catch (err) {
      setLastAction(err instanceof Error ? err.message : "词条清单解析失败");
      return;
    }
    if (!incoming.length) {
      setLastAction("词条清单为空");
      return;
    }
    commit("导入词条清单", (draft) => {
      const batch = runImport(draft, incoming, file.name.replace(/\.[^.]+$/, ""));
      const failed = batch.items.filter((item) => !item.ok).length;
      setLastAction(
        failed
          ? `词条清单已对账：${batch.items.length - failed} 条对上，${failed} 条失败（已保留对上的条目）`
          : `词条清单已对账：${batch.items.length} 条全部对上`,
      );
      setBatchOpen(true);
    });
  };

  const retryFailed = (batchId: string) => {
    commit("重试失败词条", (draft) => {
      const batch = retryBatch(draft, batchId);
      if (!batch) return;
      const failed = batch.items.filter((item) => !item.ok).length;
      setLastAction(failed ? `重试完成：仍有 ${failed} 条对不上` : "失败词条已全部补上编号");
    });
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
              <span>{project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed).length} / {project().tracks.flatMap((track) => track.segments).length} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
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

          <section class="panel-section tag-summary">
            <div class="section-title"><h2>词条库</h2><span>{project().entries.length}</span></div>
            <div class="entry-counts">
              <span>活跃 <b>{counts().active}</b></span>
              <span>合并 <b>{counts().merged}</b></span>
              <span>停用 <b>{counts().deactivated}</b></span>
              <Show when={counts().pending}>
                <span class="pending">待编号 <b>{counts().pending}</b></span>
              </Show>
            </div>
            <p>词条由编目组维护；导入新清单后按编号对账，合并会自动改接关联，停用无后继的片段标为待重新归类。</p>
            <input
              ref={catalogInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importCatalogFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => catalogInputRef?.click()}><span>↥</span> 导入编目组词条清单</button>
            <button class="wide-action quiet" onClick={() => setBatchOpen(true)}>对账记录 {latestFailedCount() ? `· ${latestFailedCount()} 条待重试` : ""}</button>
          </section>
        </aside>

        <main class="transcript-panel">
          <Show when={pendingMigrationCount()}>
            <div class="catalog-banner migration" role="status">
              <div>
                <strong>{pendingMigrationCount()} 个内嵌词条还没有编目组编号</strong>
                <span>已从旧草稿抽出建库，导入最新词条清单后将按名称自动回填编号；回填不上的会保留并标出。</span>
              </div>
              <div class="conflict-actions">
                <button class="btn btn-quiet" onClick={() => catalogInputRef?.click()}>导入词条清单</button>
              </div>
            </div>
          </Show>
          <Show when={!pendingMigrationCount() && latestFailedCount()}>
            <div class="catalog-banner retry" role="status">
              <div>
                <strong>上次导入有 {latestFailedCount()} 条词条对不上</strong>
                <span>已对上的条目都保留着，只需补导清单后重试失败的条目。</span>
              </div>
              <div class="conflict-actions">
                <button class="btn btn-quiet" onClick={() => latestBatch() && retryFailed(latestBatch()!.id)}>重试失败条目</button>
                <button class="btn btn-quiet" onClick={() => setBatchOpen(true)}>查看记录</button>
              </div>
            </div>
          </Show>
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
                  class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed ? "reviewed" : ""}`}
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
                      <Show when={segment.pendingReclassify}><span class="pill reclassify">待重新归类</span></Show>
                      <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                    </div>
                    <p>{segment.text}</p>
                    <div class="segment-tags">
                      <For each={segment.entryIds.map(entryById).filter(Boolean)}>
                        {(entry) => <span style={{ "--tag-color": entry!.color } as any}>#{entry!.name}</span>}
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
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
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
                  <div class="content-title"><h3>关联词条</h3><p>词条由编目组维护；一个片段可关联多个词条，合并/停用由清单导入后自动改接。</p></div>
                  <For each={project().entries}>
                    {(entry) => {
                      const attached = segment().entryIds.includes(entry.id);
                      const retired = entry.status !== "active";
                      return (
                        <button
                          class={`tag-option ${attached ? "selected" : ""} ${retired ? "retired" : ""}`}
                          disabled={retired}
                          title={retired ? `该词条已${entry.status === "merged" ? "合并" : "停用"}${entry.mergedInto ? `，接续于 ${entry.mergedInto}` : ""}` : entry.code}
                          onClick={() => toggleEntry(entry.id)}
                        >
                          <i style={{ background: entry.color }} />
                          <span>
                            <strong>#{entry.name} <em class="entry-code">{entry.code || "待编号"}</em></strong>
                            <small>
                              {entry.type === "topic" ? "主题" : entry.type === "event" ? "事件" : "人物"}
                              {entry.status === "merged" ? " · 已合并" : entry.status === "deactivated" ? " · 已停用" : ""}
                              {entry.pendingMigration ? " · 待回填编号" : ""}
                            </small>
                          </span>
                          <b>{attached ? "✓" : "＋"}</b>
                        </button>
                      );
                    }}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注不会改写原文，可保留校对依据并继续讨论。</p></div>
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

      <Dialog open={batchOpen()} onOpenChange={setBatchOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content batch-dialog-content">
            <Dialog.Title>词条导入与对账</Dialog.Title>
            <Dialog.Description>
              编目组每轮导出词条清单后在此导入。按词条编号对账：被合并的关联改接到合并目标，停用又无接续的片段标为待重新归类；批注和校对标记不会被清单覆盖。
            </Dialog.Description>
            <div class="dialog-footer batch-import-row">
              <button class="btn btn-primary" onClick={() => catalogInputRef?.click()}>导入词条清单（JSON）</button>
            </div>
            <div class="batch-list">
              <For each={project().importBatches} fallback={<div class="mini-empty">还没有导入过词条清单。</div>}>
                {(batch) => (
                  <article class={`batch-card ${batch.status}`}>
                    <header>
                      <strong>{batch.sourceName}</strong>
                      <span>{new Date(batch.importedAt).toLocaleString()}</span>
                    </header>
                    <div class="batch-summary">
                      <Show when={batch.status === "done"}><span class="batch-ok">全部 {batch.items.length} 条对上</span></Show>
                      <Show when={batch.status === "partial"}>
                        <span class="batch-ok">{batch.items.filter((item) => item.ok).length} 条对上</span>
                        <span class="batch-fail">{failedItemCount(batch)} 条失败（已保留对上的条目）</span>
                      </Show>
                      <Show when={batch.status === "failed"}><span class="batch-fail">整批未对上，已回滚</span></Show>
                      <Show when={failedItemCount(batch)}>
                        <button class="btn btn-quiet" onClick={() => retryFailed(batch.id)}>只重试失败条目</button>
                      </Show>
                    </div>
                    <ul class="batch-items">
                      <For each={batch.items}>
                        {(item) => (
                          <li class={item.ok ? "ok" : "fail"}>
                            <span class="batch-item-code">{item.code}</span>
                            <span class="batch-item-name">{item.name}</span>
                            <Show when={item.ok} fallback={<em class="batch-item-error">{item.error}</em>}>
                              <em class="batch-item-action">
                                {item.action === "upsert" ? "已更新" : item.action === "backfill" ? "已回填编号" : item.action === "redirect" ? "关联已改接" : "已停用·待重新归类"}
                              </em>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </article>
                )}
              </For>
            </div>
            <div class="dialog-footer"><button class="btn btn-quiet" onClick={() => setBatchOpen(false)}>关闭</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
