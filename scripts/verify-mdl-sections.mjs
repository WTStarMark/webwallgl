#!/usr/bin/env node
/**
 * verify-mdl-sections —— MDL 段定位改「单趟扫描」后的离线对账。
 *
 * 为什么需要：`parseMDL` 原来对四个段签名各做一次扫描（MDAT/MDLS/MDLA/MDLE），
 * 改成 `findMdlSections` 一趟扫完之后，**判据只剩「偏移找对了没有」** —— 找错的后果
 * 不是报错而是静默降级：MDAT 漏掉 → 挂件不再跟随骨骼（3790987854 的头偏出脖子）、
 * MDLS 漏掉 → 整个 puppet 不渲染、MDLE 漏掉 → 静止姿势校正变单位阵。
 *
 * 判据（不做自证）：期望值由本文件里的参考扫描独立算出 —— 每个签名各自一趟朴素
 * 逐字节比较，与生产实现的「扫 'M' + 四分支分派」零共享代码。
 * 特别注意 MDAT 是 **`MDA`** 前缀（不是 MDL）：按 MDL 筛选会整块漏掉附着点表，
 * 所以判据里对 MDAT 单独留了一条语料级断言。
 *
 * 语料缺失（本机没装壁纸库）时跳过语料段而非失败：与其它 verifier 同策略。
 * 但**合成夹具段（〇）不读壁纸库**，无论有没有语料都照跑、失败即失败 —— 否则
 * masks 段（ver > 21）这种「语料里没有独立样本」的行为在开发机上永远无人看管。
 *
 *   node scripts/verify-mdl-sections.mjs          合成段 + 语料段（默认）
 *   node scripts/verify-mdl-sections.mjs --quick  只跑合成段（不碰壁纸库）
 *
 * 默认会读 `~/Library/Application Support/io.github.oneincase.wallpaperem/wallpapers`
 * 下 13 个 item 的 scene.pkg，实测约 **250 个 .mdl / 382MB**。只跑合成段（隔离被禁
 * 路径、或在多人并发时降内存）用 `--quick`，或用既有环境变量口子：
 *   WE_LIBRARY=/nonexistent node scripts/verify-mdl-sections.mjs   # 与 --quick 等效
 * 跳过语料段时**仍退出码 0**并显著标出，只有断言失败才非 0。
 */
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIB, ROOT, itemDir, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });

/** `--quick`：跳过语料段（不读壁纸库），只跑合成夹具段。与 `WE_LIBRARY=/nonexistent` 等效。 */
const QUICK = process.argv.includes("--quick");

/** 含 puppet / 真 3D 网格的壁纸（MDL 解析的覆盖面：蒙皮、附着点、静止姿势、真网格） */
const ITEMS = process.env.WE_MDL_ITEMS
  ? process.env.WE_MDL_ITEMS.split(",")
  : [
      "3662790108", // 247 个 mesh（本机最大的一批模型）
      "2955378002",
      "2998757800", // 骨骼拖拽（MDLV0016）
      "2477602742", // 三节火车（MDLV0013）
      "3735447194", // Puppet Warp
      "3233141951",
      "2566558804",
      "3226487183",
      "3186328539",
      "3797270925", // 新版 Puppet Warp 导出
      "3509243656", // 真 3D 网格
      "3281559867", // Kirby Gourmet Race：45 个多子网格模型 + 11 台相机实体 + 命名骨 MDLS
      // [2026-10-04] 3254178774 古风人物：**顶点区字节数同时被多个 stride 整除**
      // （10848 = 226×48（mesh 表声明的 flag 0xf 布局）也 = 339×32（源码族回退候选）），
      // 单网格猜测曾挑中 stride 32 ⇒ 单网格字段整体错位解读、模型炸成横扫屏幕的碎三角。
      // 全库 597 个模型里唯一一个 mesh0 与单网格字段不同源的样本，
      // 本文件末尾「子网格0 与单网格字段同源」那条断言就锁它。
      "3254178774",
    ];

/** 参考实现：单个签名一趟朴素逐字节比较（最显然正确的形式，不共享被测代码） */
function refFind(buf, sig) {
  const bad = buf.length - sig.length;
  outer: for (let p = 0; p <= bad; p++) {
    for (let k = 0; k < sig.length; k++) {
      if (buf[p + k] !== sig.charCodeAt(k)) continue outer;
    }
    return p;
  }
  return -1;
}

const mdlMath = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/mdl-math.js")).href);
const mdlParse = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/mdl-parse.js")).href);
const container = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/container.js")).href);
const mdlWrite = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/mdl-write.js")).href);

const SIGS = ["MDAT", "MDLS", "MDLA", "MDLE"];
let used = 0;
let files = 0;
let bytes = 0;
let withMdat = 0;
let withMdla = 0;
let withMdls = 0;
let parsedAtt = 0;
let refMs = 0;
let prodMs = 0;

// 语料段：`--quick` 下把 item 列表置空 —— used 保持 0，下面的「提前退出」分支会打印
// 「语料段已跳过：--quick」并只结算合成夹具段（跳过本身退出码 0，断言失败才非 0）。
const CORPUS_ITEMS = QUICK ? [] : ITEMS;

for (const id of CORPUS_ITEMS) {
  const pkgPath = join(itemDir(id), "scene.pkg");
  if (!fs.existsSync(pkgPath)) continue;
  used++;
  const pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
  const names = pkg.entries.filter((e) => /\.mdl$/i.test(e.name)).map((e) => e.name);
  let itemFiles = 0;
  for (const name of names) {
    const buf = container.getEntry(pkg, name);
    files++;
    itemFiles++;
    bytes += buf.length;

    let t = performance.now();
    const ref = {};
    for (const s of SIGS) ref[s] = refFind(buf, s);
    refMs += performance.now() - t;
    t = performance.now();
    const got = mdlMath.findMdlSections(buf);
    prodMs += performance.now() - t;

    for (const s of SIGS) {
      if (got[s] !== ref[s]) check(false, `${id}/${name}: ${s} 偏移 ${got[s]} ≠ 参考 ${ref[s]}`);
    }
    if (ref.MDAT >= 0) {
      withMdat++;
      // 「解析出附着点」只在语料层面断言：4 字节 "MDAT" 完全可能是顶点数据里的偶然
      // 命中（lucy.mdl 就是 —— count 字段读出 49008，被 parseAttachments 的合法性
      // 上限挡掉，返回空表；这是**改动前就有的**行为，偏移也对得上）。逐文件断言
      // 会产出假失败，所以这里只累计。
      if ((mdlParse.parseMDL(buf).attachments ?? []).length > 0) parsedAtt++;
    }
    if (ref.MDLA >= 0) withMdla++;
    if (ref.MDLS >= 0) withMdls++;
    // 无 MDLS 是合法的：真 3D 网格（3509243656 的天空盒/球体/圆柱）是非蒙皮模型，
    // 只有 MDLV 顶点区。所以这里不做「每个 mdl 都要有骨架」的断言（曾经这么写过，
    // 结果是 77 条假失败），只在语料层面要求两种形态都出现过。
  }
  if (itemFiles) console.log(`  ${id}: ${itemFiles} 个 .mdl  ✓ 段偏移与参考扫描逐位一致`);
}

// ════════════════════════════════════════════════════════════════════════════
// 〇、合成夹具：masks 段消费后的**游标精确推进** + 未知块（含 MDMP）不静默错位
//    （2026-10-12，G5/M4）不读壁纸库 ⇒ 语料缺失（used === 0）的机器上也照跑，
//    所以**必须插在下面那个提前退出之前**。
//
//    为什么合成：语料里 ver > 21 的 masks 段没有独立样本，而且本机可能根本没装库。
//    判据全部由本文件独立构造 —— 夹具自己写字节、自己按布局公式算期望偏移，
//    与生产读/写实现零共享代码（不 import Writer，也不调用 meshVertexLayout）。
// ════════════════════════════════════════════════════════════════════════════

/** 夹具专用小端写入器（刻意不复用 pkg/mdl-write.js 的 Writer） */
class FixWriter {
  constructor() {
    this.b = [];
  }
  u8(v) {
    this.b.push(v & 255);
    return this;
  }
  u16(v) {
    this.b.push(v & 255, (v >>> 8) & 255);
    return this;
  }
  u32(v) {
    this.b.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
    return this;
  }
  f32(v) {
    const d = new DataView(new ArrayBuffer(4));
    d.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i));
    return this;
  }
  ascii(s) {
    for (let i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i) & 255);
    return this;
  }
  cstr(s) {
    return this.ascii(s).u8(0);
  }
  zeros(n) {
    for (let i = 0; i < n; i++) this.b.push(0);
    return this;
  }
  get len() {
    return this.b.length;
  }
  done() {
    return new Uint8Array(this.b);
  }
}

/**
 * 两种顶点布局，贴住生产实现的 LAYOUTS 表（不是随手挑的）：
 *  · static48 —— meshFlag 0xf，stride 48：pos@0 / normal@12 / tangent@24(16B) / uv@40。
 *    只对 MDLV0023 成立（ver < 23 的候选表里根本没有 48）。
 *  · skin80 —— meshFlag 0x0180000e，stride 80：pos@0 / normal@12 / tangent@24(16B) /
 *    骨 4 索引@40(16B) / 4 权重@56(16B，和必须为 1) / uv@72。
 *    ver < 23 的候选表只有 52(lenOff 8/4) 与 80(lenOff 32) 两种 stride，所以不含 masks
 *    的对照组（ver = 21）必须用 80：`{lenOff:32, stride:80, uv:72, bone:40, weight:56}`。
 */
const LAYOUT_STATIC48 = { stride: 48, meshFlag: 0xf, uv: 40 };
const LAYOUT_SKIN80 = { stride: 80, meshFlag: 0x0180000e, uv: 72 };

function fixVertex(w, layout, x, y) {
  w.f32(x).f32(y).f32(0); // pos@0
  w.f32(0).f32(1).f32(0); // normal@12（单位向量）
  w.f32(1).f32(0).f32(0).f32(0); // tangent@24（vec4）
  if (layout.stride === 80) {
    for (let k = 0; k < 4; k++) w.u32(0); // 骨索引@40（夹具里 4 个槽都用 0 号骨）
    for (let k = 0; k < 4; k++) w.f32(0.25); // 权重@56：和恰为 1（自洽校验会查）
  }
  w.f32(0.25).f32(0.75); // uv@layout.uv
}

const FIX_VERTS_A = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];
const FIX_VERTS_B = [
  [100, 0],
  [101, 0],
  [100, 1],
  [101, 1],
];

/** masks 段的两个样本（变长 a/b 数组 —— 长度写错就会被游标抓住） */
const FIX_MASKS = [
  { tag: 1, json: '{"a":1}', a: [0, 0, 0], b: [0] },
  { tag: 2, json: '{"b":22}', a: [0], b: [0, 0] },
];

function fixHeader(w, { ver, mdlFlag, skinCount, meshCount }) {
  w.ascii("MDLV" + String(ver).padStart(4, "0"));
  w.u8(0).u32(mdlFlag).u32(skinCount).u32(meshCount);
}

/**
 * 追加一条网格记录。`dropMaskPayload` 只为负对照：声明 maskCount 但不写载荷。
 * 返回本条网格材质串的起始偏移（= 夹具自己记录的真值）。
 */
function fixMesh(w, { ver, layout, material, verts, masks = [], dropMaskPayload = false }) {
  const anchor = w.len;
  w.cstr(material);
  w.u32(0); // flagA = 0（≠2 ⇒ 无额外字段）
  if (ver >= 17) for (const v of [-1, -1, -1, 1, 1, 1]) w.f32(v); // AABB
  if (ver > 14) w.u32(layout.meshFlag); // meshFlag：决定 stride 与字段偏移
  w.u32(verts.length * layout.stride); // vertexBytes
  for (const [x, y] of verts) fixVertex(w, layout, x, y);
  w.u32(6 * 2); // indexBytes
  for (const i of [0, 1, 2, 0, 1, 2]) w.u16(i);
  if (ver >= 21) {
    w.u8(0); // unkA = 0
    w.u8(0); // hasParts = 0
  }
  if (ver > 21) {
    w.u32(masks.length); // maskCount
    if (!dropMaskPayload) {
      for (const m of masks) {
        w.u32(m.tag).u32(0); // 固定 8 字节，生产实现整体跳过
        w.cstr(m.json); // 材质 json
        w.u32(0); // json 之后固定 4 字节
        w.u32(m.a.length);
        for (const v of m.a) w.u32(v);
        w.u32(m.b.length);
        for (const v of m.b) w.u32(v);
      }
    }
  }
  return anchor;
}

/**
 * 独立复算第二条网格的起始偏移 —— 依据是 mdl 文档里的布局公式，不是生产代码。
 * masks 段按「每个 mask 的实际长度」逐字节累加（这正是游标必须精确的那一段）。
 */
function expectedSecondMeshOffset(ver, mat0, masks, stride) {
  let p = 0x15;
  p += mat0.length + 1; // 材质 cstr
  p += 4; // flagA
  if (ver >= 17) p += 24; // AABB
  if (ver > 14) p += 4; // meshFlag
  p += 4 + 4 * stride; // vertexBytes + 顶点
  p += 4 + 6 * 2; // indexBytes + 索引
  if (ver >= 21) p += 2; // unkA + hasParts
  if (ver > 21) {
    p += 4; // maskCount
    for (const m of masks) p += 8 + (m.json.length + 1) + 4 + (4 + m.a.length * 4) + (4 + m.b.length * 4);
  }
  return p;
}

const MAT0 = "m0.mdl.material.json";
const MAT1 = "m1.mdl.material.json";

/** 两网格夹具：ver 23 = 静态 48B 顶点 + masks 段；ver 21 = 蒙皮 80B 顶点 + 无 masks 字段 */
function buildTwoMeshFixture(ver) {
  const layout = ver > 21 ? LAYOUT_STATIC48 : LAYOUT_SKIN80;
  const masks = ver > 21 ? FIX_MASKS : [];
  const w = new FixWriter();
  fixHeader(w, { ver, mdlFlag: 0x01800009, skinCount: 1, meshCount: 2 });
  fixMesh(w, { ver, layout, material: MAT0, verts: FIX_VERTS_A, masks });
  const anchor1 = fixMesh(w, { ver, layout, material: MAT1, verts: FIX_VERTS_B, masks: [] });
  return { buf: w.done(), anchor1, layout, masks };
}

function parseOrNull(buf) {
  try {
    return mdlParse.parseMDL(buf);
  } catch (e) {
    return { __threw: String((e && e.message) || e) };
  }
}

for (const ver of [23, 21]) {
  const label = `合成夹具 MDLV00${ver}（${ver > 21 ? "含 masks 段 / stride 48" : "无 masks 字段 / stride 80"}）`;
  const f = buildTwoMeshFixture(ver);
  // 夹具自检：写入器实际落点 == 独立公式算出的落点（夹具本身错了就没资格当判据）
  const want = expectedSecondMeshOffset(ver, MAT0, f.masks, f.layout.stride);
  check(f.anchor1 === want, `${label}: 夹具自检失败 —— mesh1 实际起点 ${f.anchor1} ≠ 公式 ${want}`);
  const mdl = parseOrNull(f.buf);
  check(!mdl.__threw, `${label}: parseMDL 抛异常 ${mdl.__threw}`);
  const ms = mdl && mdl.meshes;
  check(!!ms && ms.length === 2, `${label}: 应解析出 2 条子网格（拿到 ${ms ? ms.length : "null"}）`);
  if (ms && ms.length === 2) {
    check(ms[0].materialPath === MAT0, `${label}: mesh0 材质串 = ${ms[0].materialPath}（期望 ${MAT0}）`);
    // ↓ 这条就是「masks 段消费后游标精确落在下一条网格开头」的判据
    check(ms[1].materialPath === MAT1, `${label}: mesh1 材质串 = ${ms[1].materialPath}（期望 ${MAT1}，游标错位就抓在这里）`);
    // positions 是扁平数组、**每顶点 3 个分量**：四个顶点的 x 应依次是 100 / 101 / 100 / 101
    const xs = [0, 3, 6, 9].map((i) => ms[1].positions[i]).join(",");
    check(
      xs === "100,101,100,101",
      `${label}: mesh1 顶点被错位解读（四个顶点的 x = ${xs}，期望 100,101,100,101）`,
    );
    check(ms[1].vertexCount === 4, `${label}: mesh1 顶点数 = ${ms[1].vertexCount}（期望 4）`);
    check(ms[1].indices.length === 6, `${label}: mesh1 索引数 = ${ms[1].indices.length}（期望 6）`);
  }
}

// 负对照：声明了 maskCount 却不写载荷 —— 生产实现必须**不能**给出正确的 mesh1。
// 若某次改动改成「忽略 masks 段、直接往下走」，这条会立刻变红（判据有鉴别力）。
{
  const w = new FixWriter();
  fixHeader(w, { ver: 23, mdlFlag: 0x01800009, skinCount: 1, meshCount: 2 });
  fixMesh(w, { ver: 23, layout: LAYOUT_STATIC48, material: MAT0, verts: FIX_VERTS_A, masks: FIX_MASKS, dropMaskPayload: true });
  fixMesh(w, { ver: 23, layout: LAYOUT_STATIC48, material: MAT1, verts: FIX_VERTS_B, masks: [] });
  const bad = parseOrNull(w.done());
  const silentlyRight =
    !bad.__threw && bad.meshes && bad.meshes.length === 2 && bad.meshes[1].positions[0] === 100;
  check(
    !silentlyRight,
    "负对照：masks 载荷缺失时仍「静默」解析出正确的 mesh1 —— masks 段判据没有鉴别力",
  );
}

/**
 * 未知块夹具：网格之后依次是 `MDMP0001`（不在 SECTION_TYPES 里）与合法 `MDAT0001`。
 * 期望：MDMP 整块落进 gap、段表只剩结构化 MDAT、写回逐字节相等且偏移不变。
 */
function buildUnknownBlockFixture() {
  const w = new FixWriter();
  fixHeader(w, { ver: 23, mdlFlag: 0x01800009, skinCount: 1, meshCount: 1 });
  fixMesh(w, { ver: 23, layout: LAYOUT_STATIC48, material: MAT0, verts: FIX_VERTS_A, masks: [] });
  const mdmpAt = w.len;
  w.ascii("MDMP0001").u8(7).u32(0xdeadbeef).u32(3).zeros(12); // 未知块：形态刻意与已知段接近
  const mdmpBytes = w.len - mdmpAt;
  const mdatAt = w.len;
  w.ascii("MDAT0001").u8(0).u32(mdatAt + 84).u16(1); // nextOff = 段尾（夹具自己算绝对值）
  w.u16(0).cstr("b0"); // 附着点：骨号 0 + 名字
  for (let i = 0; i < 16; i++) w.f32(i % 5 === 0 ? 1 : 0); // 16×f32 单位阵
  return { buf: w.done(), mdmpAt, mdmpBytes, mdatAt };
}

{
  const f = buildUnknownBlockFixture();
  const doc = (() => {
    try {
      return mdlWrite.readMdlDoc(f.buf);
    } catch (e) {
      check(false, `未知块夹具：readMdlDoc 抛异常 ${(e && e.message) || e}`);
      return null;
    }
  })();
  if (doc) {
    check(!doc.raw, "未知块夹具：网格表应能走通（拿到的是 raw 兜底）");
    check(!!doc.meshes && doc.meshes.length === 1, `未知块夹具：网格数 = ${doc.meshes && doc.meshes.length}（期望 1）`);
    check(
      doc.sections.length === 1 && doc.sections[0].type === "MDAT" && !doc.sections[0].raw,
      `未知块夹具：段表应只有 1 条结构化 MDAT（拿到 ${doc.sections.length} 条：${doc.sections.map((s) => s.type + (s.raw ? "(raw)" : "")).join(",")}）`,
    );
    check(doc.gap.length === f.mdmpBytes, `未知块夹具：MDMP(${f.mdmpBytes}B) 应整块落进 gap（gap = ${doc.gap.length}B）`);
    check(refFind(doc.gap, "MDMP0001") === 0, "未知块夹具：gap 起点应是 MDMP 签名");
    check(doc.trailing.length === 0, `未知块夹具：trailing 应为空（拿到 ${doc.trailing.length}B）`);

    const out = mdlWrite.writeMdlDoc(doc);
    let diff = out.length === f.buf.length ? -1 : -2;
    if (diff === -1) {
      for (let i = 0; i < out.length; i++)
        if (out[i] !== f.buf[i]) {
          diff = i;
          break;
        }
    }
    check(diff === -1, `未知块夹具：写回必须逐字节相等（长度 ${out.length} vs ${f.buf.length}，首个不同 @${diff}）`);
    const at = refFind(out, "MDMP0001");
    check(at === f.mdmpAt, `未知块夹具：写回后 MDMP 绝对偏移 ${at} ≠ 原 ${f.mdmpAt}（未知块被静默移位）`);
    check(refFind(out, "MDAT0001") === f.mdatAt, `未知块夹具：写回后 MDAT 绝对偏移 ${refFind(out, "MDAT0001")} ≠ 原 ${f.mdatAt}`);
  }
}

if (used === 0) {
  // 跳过语料段**不是失败**（退出码仍 0），但要在输出里显著标出，别让人把「没读语料」
  // 误当成「语料全绿」。只有断言真的失败才非 0。
  console.log(
    QUICK
      ? "\n⚠ 语料段已跳过（--quick）：只跑了合成夹具段，未读壁纸库"
      : `\n⚠ 语料段已跳过（本机壁纸库里没有样本：${LIB}）`,
  );
  console.log(errors.length === 0 ? "verify-mdl-sections 合成夹具段: 全部通过 ✓" : `verify-mdl-sections 合成夹具段: ${errors.length} 项失败 ✗`);
  process.exit(errors.length === 0 ? 0 : 1);
}

check(files > 0, `语料里必须真的出现 .mdl（拿到 ${files} 个）`);
// MDAT 是 `MDA` 不是 `MDL`：语料里必须真的有它，否则「按 MDL 筛前缀」这类回归检测不到
check(withMdat > 0, `语料必须覆盖到 MDAT（附着点表）—— 本轮 0 个，夹具失效`);
// 真判据：语料里必须至少有一个模型的附着点表**能解析出来**（MDAT 定位错了就全空）
check(parsedAtt > 0, `没有任何模型解析出附着点表（MDAT 定位或解析回归）`);
check(withMdla > 0, `语料必须覆盖到 MDLA（动画轨道）—— 本轮 0 个，夹具失效`);
check(withMdls > 0, `语料必须覆盖到 MDLS（骨架）—— 本轮 0 个，夹具失效`);

// ════════════════════════════════════════════════════════════════════════════
// 二、MDLS 逐骨记录布局 + 多子网格（2026-09-28，3281559867 Kirby Gourmet Race）
//
// 现象：整场模型炸开 —— elfilin 被画成盖住半屏的青色巨块、其余角色散架抽搐。
// 根因：MDLS 记录是 `[name cstr][i32 sim_type][u32 parent][u32 len=64][64B 矩阵]
// [JSON cstr]`，而重扫路径**只在矩阵尾字节是 '{' 时才跳过 JSON cstr**；空 JSON
// 时漏跳 1 字节 → 第二条骨起永久错位 → 整体校验不过 → 回退「固定布局」的垃圾骨架
// （parent 全 −1、矩阵全零/NaN）→ invBindWorld 求逆得 Infinity → 蒙皮顶点炸到
// 1e31，投影后的三角形横扫整个屏幕。
//
// 判据不使用 parseMDL 的任何内部结构：本文件自带一份**独立的最小读取器**
// refSkeleton()（逐骨顺序读 name/头/矩阵/JSON），与生产代码零共享。逐位比对
// 名字、parent、16 个矩阵分量。故意把 JSON 跳读删掉（复现原缺陷）→ 名字与
// parent 立刻在第二条骨起对不上，本节转红。
// ════════════════════════════════════════════════════════════════════════════

/** 独立实现：按参考引擎口径顺序读 MDLS 逐骨记录（与生产解析零共享代码） */
function refSkeleton(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = refFind(buf, "MDLS");
  if (at < 0) return null;
  const count = dv.getUint16(at + 13, true);
  if (!(count > 0)) return null;
  // 骨名是 UTF-8（本机语料里有中文/日文名：「主」「右眼」「全ての親」）；
  // 逐字节拼字符会把多字节序列读成乱码，这里按字节收集再解码。
  const cstr = (i) => {
    const bytes = [];
    while (i < buf.length && dv.getUint8(i) !== 0) bytes.push(dv.getUint8(i++));
    return { s: new TextDecoder("utf-8").decode(Uint8Array.from(bytes)), next: i + 1 };
  };
  const bones = [];
  let p = at + 17;
  for (let b = 0; b < count; b++) {
    const nm = cstr(p);
    const head = nm.next;
    const parent = dv.getInt32(head + 4, true);
    const size = dv.getUint32(head + 8, true);
    if (size !== 64) return null;
    const m = [];
    for (let k = 0; k < 16; k++) m.push(dv.getFloat32(head + 12 + k * 4, true));
    bones.push({ name: nm.s, parent, m });
    p = cstr(head + 12 + 64).next;
  }
  return bones;
}

let skelFiles = 0;
let skelBones = 0;
let nonFiniteBones = 0;
let badParentBones = 0;
let singularBones = 0;
let namedBones = 0;
let refDiff = 0;
for (const id of ITEMS) {
  const pkgPath = join(itemDir(id), "scene.pkg");
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
  for (const e of pkg.entries) {
    if (!/\.mdl$/i.test(e.name)) continue;
    const buf = container.getEntry(pkg, e.name);
    const ref = refSkeleton(buf);
    if (!ref) continue;
    let mdl;
    try {
      mdl = mdlParse.parseMDL(buf);
    } catch {
      continue; // 不支持的顶点布局会抛（历史行为，与本节的骨架判据无关）
    }
    skelFiles++;
    if (mdl.bones.length !== ref.length) {
      check(false, `${id}/${e.name}: 骨数 ${mdl.bones.length} ≠ 参考 ${ref.length}`);
      continue;
    }
    for (let i = 0; i < ref.length; i++) {
      const b = mdl.bones[i];
      const r = ref[i];
      skelBones++;
      if (b.name !== r.name) {
        refDiff++;
        if (refDiff <= 3) check(false, `${id}/${e.name} 骨${i}: 名字 '${b.name}' ≠ 参考 '${r.name}'`);
      }
      if (b.parent !== r.parent) {
        refDiff++;
        if (refDiff <= 3) check(false, `${id}/${e.name} 骨${i}: parent ${b.parent} ≠ 参考 ${r.parent}`);
      }
      if (b.name) namedBones++;
      if (!Number.isFinite(b.matrix[12]) || b.matrix.some((v) => !Number.isFinite(v))) nonFiniteBones++;
      if (b.parent < -1 || b.parent >= ref.length) badParentBones++;
      const det = b.matrix[0] * b.matrix[5] - b.matrix[4] * b.matrix[1];
      if (!(Math.abs(det) > 1e-9)) singularBones++;
    }
    // 行为断言（与「炸开」直接对应）：蒙皮矩阵的世界部分必须有限、量级合理。
    // 全零/NaN 的绑定矩阵求逆得 Infinity，这里就是那条链的关口。
    const inv = mdl.invBindWorld || [];
    const badInv = inv.filter((m) => !m || Array.from(m).some((v) => !Number.isFinite(v))).length;
    if (badInv) check(false, `${id}/${e.name}: invBindWorld 有 ${badInv} 根骨非有限（绑定矩阵求逆炸了）`);
  }
}

check(skelFiles > 0, `语料必须覆盖到可解析的 MDLS 骨架 —— 本轮 ${skelFiles} 个，夹具失效`);
check(refDiff === 0, `骨架逐骨与独立读取器不一致 ${refDiff} 处（MDLS 记录布局回归：名字/parent 从第二条骨起漂移）`);
check(nonFiniteBones === 0, `骨架绑定矩阵出现 ${nonFiniteBones} 处非有限分量`);
check(badParentBones === 0, `骨架出现 ${badParentBones} 处越界 parent`);
check(singularBones === 0, `骨架出现 ${singularBones} 处不可逆（2D 行列式 0/NaN）的绑定矩阵`);
// 「名字读出来了」是布局正确的必要条件：旧实现把矩阵后那条 cstr 当名字，命名骨全变空串
check(namedBones > 0, `骨架里一个非空骨名都没有（布局错位：读到的名字其实是 JSON 字段）`);

// ── 多子网格（mesh_count）─────────────────────────────────────────────────
// 判据取**文件自己声明的每网格 AABB**（MDLV>=17 的网格头里有一对 min/max）：
// 独立真值，且与顶点解析强耦合 —— 走错 stride/漏读材质列表都会让它对不上。
let meshFiles = 0;
let meshTotal = 0;
let multiFiles = 0;
let aabbChecked = 0;
let aabbBad = 0;
let aabbDegenerate = 0;
let mesh0Diff = 0;
for (const id of ITEMS) {
  const pkgPath = join(itemDir(id), "scene.pkg");
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
  for (const e of pkg.entries) {
    if (!/\.mdl$/i.test(e.name)) continue;
    const buf = container.getEntry(pkg, e.name);
    let mdl;
    try {
      mdl = mdlParse.parseMDL(buf);
    } catch {
      continue;
    }
    if (!mdl.meshes) continue;
    meshFiles++;
    meshTotal += mdl.meshes.length;
    if (mdl.meshes.length > 1) multiFiles++;
    // mesh0 必须与单网格字段同源（老路径与新路径不许各算一套）
    const m0 = mdl.meshes[0];
    if (
      m0.vertexCount !== mdl.vertexCount ||
      m0.indexCount !== mdl.indexCount ||
      m0.indexType !== mdl.indexType ||
      m0.positions.length !== mdl.positions.length
    ) {
      mesh0Diff++;
      check(false, `${id}/${e.name}: 子网格0 与单网格字段不一致`);
    } else {
      for (let i = 0; i < m0.positions.length; i++) {
        if (m0.positions[i] !== mdl.positions[i]) {
          mesh0Diff++;
          check(false, `${id}/${e.name}: 子网格0 顶点 ${i} 与单网格字段不一致`);
          break;
        }
      }
    }
    // 声明的 AABB vs 实际顶点包围盒
    for (let mi = 0; mi < mdl.meshes.length; mi++) {
      const mesh = mdl.meshes[mi];
      if (!mesh.aabb || !mesh.vertexCount) continue;
      if (mesh.aabb.some((v) => !Number.isFinite(v))) continue;
      // 全零 AABB 是导出器写的占位（2955378002 的 MDLV0019 puppet 实测），
      // 不是可校验的真值：跳过并计数，夹具有效性由 aabbChecked 兜底。
      if (mesh.aabb.every((v) => v === 0)) {
        aabbDegenerate++;
        continue;
      }
      const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let v = 0; v < mesh.vertexCount; v++) {
        for (let k = 0; k < 3; k++) {
          const c = mesh.positions[v * 3 + k];
          if (c < bb[k]) bb[k] = c;
          if (c > bb[3 + k]) bb[3 + k] = c;
        }
      }
      aabbChecked++;
      for (let k = 0; k < 6; k++) {
        const ref = mesh.aabb[k];
        const tol = Math.max(1e-3, Math.abs(ref) * 2e-3);
        if (Math.abs(bb[k] - ref) > tol) {
          aabbBad++;
          if (aabbBad <= 3) {
            check(false, `${id}/${e.name} 子网格${mi}: 顶点包围盒[${k}]=${bb[k].toFixed(2)} ≠ 文件声明 ${ref.toFixed(2)}`);
          }
          break;
        }
      }
    }
  }
}

check(meshFiles > 0, `语料必须覆盖到子网格遍历 —— 本轮 ${meshFiles} 个，夹具失效`);
check(multiFiles > 0, `语料里没有多子网格模型（mesh_count>1）—— 夹具失效，覆盖不到本次缺陷`);
check(aabbChecked > 0, `没有可校验的子网格 AABB —— 夹具失效（声明值应来自 MDLV>=17 的网格头）`);
check(aabbBad === 0, `${aabbBad}/${aabbChecked} 个子网格的顶点包围盒与文件声明不符（stride/材质列表走位）`);
check(mesh0Diff === 0, `子网格0 与单网格字段不同源 ${mesh0Diff} 处`);

// 3281559867 的舞台：15 个子网格，mesh1 是**地面**（扁平薄板）。
// 只画 mesh0（历史行为）时地面整块消失 —— 这条断言按几何形状锁住它。
{
  const pkgPath = join(itemDir("3281559867"), "scene.pkg");
  if (fs.existsSync(pkgPath)) {
    const pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
    const entry = pkg.entries.find((e) => e.name === "models/stage/stage.mdl");
    if (entry) {
      const mdl = mdlParse.parseMDL(container.getEntry(pkg, entry.name));
      check(mdl.meshes && mdl.meshes.length === 15, `舞台应有 15 个子网格，实得 ${mdl.meshes ? mdl.meshes.length : 0}`);
      const floor = mdl.meshes && mdl.meshes[1];
      if (floor && floor.aabb) {
        const [x0, y0, z0, x1, y1, z1] = floor.aabb;
        const thickness = y1 - y0;
        const width = x1 - x0;
        check(
          thickness > 0 && thickness < width * 0.05,
          `舞台 mesh1 应是地面薄板（厚 ${thickness.toFixed(1)} vs 宽 ${width.toFixed(1)}）`,
        );
      } else {
        check(false, "舞台 mesh1 缺失或没有 AABB");
      }
    }
  }
}

console.log(
  `\n参考扫描 ${refMs.toFixed(1)}ms / 生产单趟 ${prodMs.toFixed(1)}ms（${files} 个 .mdl / ${(bytes / 1e6).toFixed(1)}MB，` +
    `含 MDAT ${withMdat} / MDLS ${withMdls} / MDLA ${withMdla} 个，解析出附着点 ${parsedAtt} 个）`,
);
console.log(
  `骨架：${skelFiles} 个模型 / ${skelBones} 根骨逐位对齐独立读取器（命名骨 ${namedBones}）；` +
    `子网格：${meshFiles} 个模型 / ${meshTotal} 个子网格（多网格 ${multiFiles} 个），AABB 对账 ${aabbChecked} 个` +
    `（退化全零占位 ${aabbDegenerate} 个已跳过）`,
);
console.log(errors.length === 0 ? "verify-mdl-sections: 全部通过 ✓" : `verify-mdl-sections: ${errors.length} 项失败 ✗`);
process.exit(errors.length === 0 ? 0 : 1);
