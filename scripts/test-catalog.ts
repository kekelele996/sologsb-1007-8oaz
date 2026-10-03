import { createSeedProject } from "../src/data.ts";
import {
  importBatch,
  mergePendingRows,
  migrateFromV1,
  parseTermList,
  resolveMergeTarget,
  sweepStaleLinks,
} from "../src/catalog.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const term = (p, code) => p.terms.find((t) => t.code === code);
const seg = (p, id) => p.tracks.flatMap((t) => t.segments).find((s) => s.id === id);

console.log("1) 一批对账：合并改挂 / 停用标待归类 / 失败行回滚且不影响已对上行");
{
  const p = createSeedProject();
  const before = JSON.stringify(seg(p, "seg-1").comments);

  const list = {
    catalogVersion: "r4",
    rows: [
      { code: "E-001", name: "抗日战争记忆", status: "active", version: 4 },
      { code: "T-003", status: "merged", mergeTargetCode: "T-001", version: 4 },
      { code: "P-002", status: "retired", version: 4 },
      { code: "E-099", name: "1958 年外调", status: "merged", mergeTargetCode: "E-404", version: 4 },
    ],
  };
  const parsed = parseTermList(JSON.stringify(list));
  check("清单全部解析通过", parsed.rows.length === 4 && parsed.errors.length === 0);

  // 种子片段原本没挂 P-002，先给 seg-7 挂上，再验证停用断开。
  seg(p, "seg-7").termCodes.push("P-002");

  const { result, failures } = importBatch(p, parsed.rows, "r4");
  check("3 行成功、1 行失败", failures.length === 1 && failures[0].code === "E-099", JSON.stringify(failures));
  check("失败原因指向缺失目标", /E-404/.test(failures[0].lastError), failures[0].lastError);

  // 合并：seg-5/fy-2 挂的是 T-003，应顺到 T-001
  check("seg-5 关联 T-003→T-001", seg(p, "seg-5").termCodes.includes("T-001") && !seg(p, "seg-5").termCodes.includes("T-003"));
  check("fy-2 关联 T-003→T-001", seg(p, "fy-2").termCodes.includes("T-001"));
  check("T-003 标记为 merged", term(p, "T-003").status === "merged");
  check("合并链解析到 T-001", resolveMergeTarget(p.terms, "T-003") === "T-001");

  // 停用：seg-7 挂 P-002（陈师傅）→ 断开关联 + 待重新归类 + 记录断链名称
  const seg7 = seg(p, "seg-7");
  check("seg-7 断开 P-002", !seg7.termCodes.includes("P-002"));
  check("seg-7 标记待重新归类", seg7.needsReclassify === true);
  check("断链快照含陈师傅", (seg7.brokenTerms ?? []).includes("陈师傅"));
  check("P-002 已停用", term(p, "P-002").status === "retired");

  // active 更新名称
  check("E-001 名称更新且空字段不冲颜色", term(p, "E-001").name === "抗日战争记忆" && term(p, "E-001").color === "#dc2626");

  // 失败行不入库
  check("失败行 E-099 未留下", !term(p, "E-099"));
  check("对账计数正确", result.applied === 1 && result.merged === 1 && result.retired === 1 && result.reclassified === 1,
    JSON.stringify(result));

  // 批注/校对标记不被触碰
  check("批注完整保留", JSON.stringify(seg(p, "seg-1").comments) === before);
  check("校对标记保留", seg(p, "seg-3").reviewed === true && seg(p, "seg-3").flags.properNoun === true);
}

console.log("2) 失败行下次重试：目标词条出现后对上并出队");
{
  const p = createSeedProject();
  const batch1 = importBatch(p, [
    { code: "X-1", status: "merged", mergeTargetCode: "X-2", version: 1 },
  ], "r1");
  check("X-2 缺失时 X-1 失败", batch1.failures.length === 1 && !term(p, "X-1"));

  // 模拟队列
  let queue = mergePendingRows([], batch1.failures);
  check("失败进入重试队列", queue.length === 1 && queue[0].attempts === 1);

  // 编目组下一轮先给 X-2
  const batch2 = importBatch(p, [{ code: "X-2", name: "新主题", type: "topic", color: "#123456", status: "active", version: 2 }], "r2");
  check("X-2 入库成功", batch2.failures.length === 0 && term(p, "X-2")?.status === "active");

  // 只重试失败的那一条
  const waiting = queue;
  queue = mergePendingRows([], importBatch(p, waiting, "r1").failures);
  check("重试后 X-1 入库并合并到 X-2", term(p, "X-1")?.status === "merged" && resolveMergeTarget(p.terms, "X-1") === "X-2");
  check("重试成功出队", queue.length === 0);
}

console.log("3) 版本倒退行失败，旧值保留");
{
  const p = createSeedProject();
  importBatch(p, [{ code: "T-001", name: "码头生活（修订）", status: "active", version: 9 }], "r9");
  check("v9 已入库", term(p, "T-001").version === 9 && term(p, "T-001").name === "码头生活（修订）");
  const out = importBatch(p, [{ code: "T-001", name: "旧名称", status: "active", version: 4 }], "r4");
  check("低版本行失败", out.failures.length === 1);
  check("本机名称未被旧清单冲掉", term(p, "T-001").name === "码头生活（修订）" && term(p, "T-001").version === 9);
}

console.log("4) 多级合并链 A→B→C 与成环失败");
{
  const p = createSeedProject();
  const out = importBatch(p, [
    { code: "C-1", name: "终点", type: "topic", color: "#111111", status: "active", version: 1 },
    { code: "B-1", status: "merged", mergeTargetCode: "C-1", version: 1 },
    { code: "A-1", status: "merged", mergeTargetCode: "B-1", version: 1 },
  ], "r1");
  check("三级链全部成功", out.failures.length === 0 && resolveMergeTarget(p.terms, "A-1") === "C-1");

  // 片段挂 A-1，导入后顺链到 C-1
  p.tracks[0].segments[0].termCodes = ["A-1"];
  sweepStaleLinks(p);
  check("顺链把片段挂载改到终点 C-1", p.tracks[0].segments[0].termCodes[0] === "C-1");

  const ring = importBatch(p, [
    { code: "C-1", status: "merged", mergeTargetCode: "A-1", version: 2 },
  ], "r2");
  check("制造合并环的行失败", ring.failures.length === 1);
  check("C-1 仍为 active", term(p, "C-1").status === "active");
}

console.log("5) 停用的合并目标导致合并行失败");
{
  const p = createSeedProject();
  const out = importBatch(p, [
    { code: "R-1", name: "将停用", type: "topic", color: "#222222", status: "retired", version: 1 },
    { code: "M-1", status: "merged", mergeTargetCode: "R-1", version: 1 },
  ], "r1");
  check("M-1 失败、R-1 停用成功", out.failures.some((f) => f.code === "M-1") && term(p, "R-1")?.status === "retired");
  check("M-1 未入库", !term(p, "M-1"));
}

console.log("6) 旧草稿迁移：内嵌词条抽出建库、按名称回填、回填不上保留标出");
{
  const seed = createSeedProject();
  const v1 = {
    schema: 1,
    revision: 7,
    tabId: "old-tab",
    savedAt: 1,
    project: {
      ...structuredClone(seed),
      terms: undefined,
      tags: [
        { id: "tag-a", label: "码头生活", type: "topic", color: "#2563eb" },
        { id: "tag-b", label: "旧稿独有词", type: "event", color: "#000000" },
      ],
    },
  };
  // 构造 tagIds
  for (const t of v1.project.tracks) for (const s of t.segments) s.tagIds = s.termCodes;
  v1.project.tracks[0].segments[0].tagIds = ["tag-a"];
  v1.project.tracks[0].segments[1].tagIds = ["tag-b"];
  v1.project.tracks[0].segments[1].comments = [{ id: "c1", author: "校对员", body: "批注不能丢", createdAt: "x", resolved: false, replies: [] }];

  const { project, extracted, backfilled, unresolvedNames } = migrateFromV1(v1, seed.terms);
  check("抽出 2 条、回填 1 条", extracted === 2 && backfilled === 1);
  check("回填不上的名称被标出", unresolvedNames.length === 1 && unresolvedNames[0] === "旧稿独有词");
  check("tag-a 按名称回填为 T-001", project.tracks[0].segments[0].termCodes[0] === "T-001");
  const seg1 = project.tracks[0].segments[1];
  check("tag-b 保留为 local- 编号并 localOnly", seg1.termCodes[0] === "local-tag-b");
  const localTerm = project.terms.find((t) => t.code === "local-tag-b");
  check("本地词条标记 localOnly", localTerm?.localOnly === true && localTerm.status === "active");
  check("迁移保留批注", seg1.comments[0]?.body === "批注不能丢");
  check("迁移保留校对标记", project.tracks[0].segments[0].reviewed === true);

  // 编目组下轮发来同名正式编号 → 名称回填，关联顺过去，本地词条消失
  const out = importBatch(project, [{ code: "E-901", name: "旧稿独有词", type: "event", color: "#333333", status: "active", version: 1 }], "r1");
  check("名称回填成功计数", out.result.backfilled === 1);
  check("片段关联顺到正式编号", project.tracks[0].segments[1].termCodes.includes("E-901"));
  check("本地临时词条移除", !project.terms.some((t) => t.code === "local-tag-b"));
  check("回填后批注仍在", project.tracks[0].segments[1].comments[0]?.body === "批注不能丢");
}

console.log("7) 空值不冲本机字段（缺省字段与旧值合并）");
{
  const p = createSeedProject();
  const out = importBatch(p, [{ code: "T-002", status: "active", version: 5 }], "r5");
  check("无 name/color/type 的行不报错", out.failures.length === 0);
  check("名称颜色类型保留", term(p, "T-002").name === "家族迁徙" && term(p, "T-002").color === "#7c3aed" && term(p, "T-002").type === "topic");
  check("版本更新为 5", term(p, "T-002").version === 5);
}

console.log("8) 队列合并按 code 去重、次数累加");
{
  const base = [{ code: "E-1", name: "x", failedAt: "t", lastError: "e", attempts: 2 }];
  const merged = mergePendingRows(base, [{ code: "E-1", failedAt: "t2", lastError: "e2", attempts: 1 }, { code: "E-2", failedAt: "t3", lastError: "e3", attempts: 1 }]);
  check("按编号去重为 2 行", merged.length === 2);
  check("重试次数累加", merged.find((r) => r.code === "E-1")?.attempts === 3);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
