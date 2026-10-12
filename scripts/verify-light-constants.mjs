/**
 * verify-light-constants.mjs —— 场景光照常量的离线判据（原生常量对账 W3，task-23）。
 *
 * 三层判据，全部离线、只读本仓源码，不碰壁纸素材库：
 *   [本仓×本仓] 解析侧缺省（scene/parse.js）与消费侧兜底（render/renderer.js）必须同值 ——
 *               两边写岔了，作者没写 `radius`/`intensity`/`exponent` 的灯会按两套默认值
 *               装配与衰减，画面差异只在缺字段的语料上出现。
 *   [式子形状]  headers.ts 的 V1 衰减（含 flt_min 门）与 overbright 阈值、以及
 *               renderer-glsl.js 的 `lightRadiance` 同名实现，必须与文档台账里的式子
 *               逐字一致；两份实现是同一原生公式的两个落点，必须同形同值。
 *   [原生×本仓] docs/re/we-native-lighting-constants.md §1 的 [原生] observation 取值
 *               与代码一致。`unknown` 行跳过并在末尾列出（plan §0：证据不足不得改常量）。
 *
 * 期望值不在这里发明：原生列来自该文档的 evidence_id + 地址台账，本仓列来自实测。
 * 任何一侧被改错，本脚本退出码 1。
 *
 * 运行：node scripts/verify-light-constants.mjs
 */
import fs from "node:fs";
import { join } from "node:path";
import { ROOT, imp, createChecker } from "./lib/verify-kit.mjs";

const { fail, errors } = createChecker();
const notes = [];
const ok = (m) => notes.push(m);
/** 判据：`claim` 是**成立时**的陈述；失败时打印 `detail`（缺省用 claim 本身）。 */
const want = (cond, claim, detail) => (cond ? ok(claim) : fail(detail || claim));
const read = (rel) => fs.readFileSync(join(ROOT, rel), "utf8");
const count = (hay, needle) => hay.split(needle).length - 1;

// ── 1. 解析侧缺省（renderer/vendor/we-scene/scene/parse.js）[本仓] ─────────────
const parseSrc = read("renderer/vendor/we-scene/scene/parse.js");

const DECL = [
  ["lightRadius 缺省 1000",
    "lightRadius: parseNum(o.radius && typeof o.radius === 'object' ? o.radius.value : o.radius, 1000)"],
  ["intensity 缺省 1",
    "intensity: parseNum(o.intensity && typeof o.intensity === 'object' ? o.intensity.value : o.intensity, 1)"],
  ["exponent 缺省 2",
    "exponent: parseNum(o.exponent && typeof o.exponent === 'object' ? o.exponent.value : o.exponent, 2)"],
  ["lightLane：`l` 前缀 → v1，其余 → legacy",
    "lightLane: typeof o.light === 'string' && /^l/.test(o.light) ? 'v1' : 'legacy'"],
  ["lightType 归一：strip `l` 后 spot/directional，其余 point",
    "const t = String(o.light || '').replace(/^l/, '')"],
  ["lightType 三值域",
    "return t === 'spot' || t === 'directional' ? t : 'point'"],
  ["isLight：非空字符串 `light`",
    "isLight: typeof o.light === 'string' && o.light !== ''"],
];
for (const [label, needle] of DECL) want(parseSrc.includes(needle), `parse.js 解析侧：${label}`, `parse.js 解析侧缺 ${label}（期望源码含 "${needle}"）`);

// `lightParams` 默认表（只解析不渲染，D2）逐字段
const PARAMS = [
  ["castshadow", "castshadow: bool(o.castshadow, false)"],
  ["cascadedistance0", "cascadeDistance: num(o.cascadedistance0, 0)"],
  ["cascadedistance1", "cascadeDistance1: num(o.cascadedistance1, 0)"],
  ["cascadedistance2", "cascadeDistance2: num(o.cascadedistance2, 0)"],
  ["density", "density: num(o.density, 1)"],
  ["volumetricsexponent", "volumetricsExponent: num(o.volumetricsexponent, 1)"],
  ["castvolumetrics", "castVolumetrics: bool(o.castvolumetrics, false)"],
  ["innercone", "innerCone: num(o.innercone, 0)"],
  ["outercone", "outerCone: num(o.outercone, 0)"],
  ["usecookie", "cookieEnabled: bool(o.usecookie, false)"],
  ["lightsourcesize", "sourceSize: num(o.lightsourcesize, 0)"],
];
for (const [field, needle] of PARAMS) {
  want(parseSrc.includes(needle), `parse.js lightParams.${field} 缺省表：${needle}`,
    `parse.js lightParams.${field} 缺省表漂移（期望源码含 "${needle}"）`);
}

// ── 2. 消费侧兜底 + 分派表（render/renderer.js）[本仓，行为断言] ──────────────
const R = await imp("renderer/vendor/we-scene/render/renderer.js");

want(R.lightRadiusOf({}) === 1000, "lightRadiusOf({}) 兜底 1000",
  `lightRadiusOf({}) = ${R.lightRadiusOf({})}，期望 1000`);
want(R.lightRadiusOf({ lightRadius: 12 }) === 12, "lightRadiusOf 读装配侧字段 lightRadius",
  `lightRadiusOf({lightRadius:12}) = ${R.lightRadiusOf({ lightRadius: 12 })}，期望 12`);
want(R.lightRadiusOf({ radius: 7 }) === 7, "lightRadiusOf 兼容裸 radius 夹具",
  `lightRadiusOf({radius:7}) = ${R.lightRadiusOf({ radius: 7 })}，期望 7`);
want(R.lightExponentOf({}) === 2, "lightExponentOf({}) 兜底 2",
  `lightExponentOf({}) = ${R.lightExponentOf({})}，期望 2`);
want(R.lightExponentOf({ exponent: 0.5 }) === 0.5, "lightExponentOf 读 exponent",
  `lightExponentOf({exponent:0.5}) = ${R.lightExponentOf({ exponent: 0.5 })}，期望 0.5`);

const white = R.lightColorIntensity({});
want(Array.isArray(white) && white.every((v) => v === 1), "intensity 兜底 1（色兜底 [1,1,1]）",
  `intensity 兜底应为 1（色 [1,1,1]），得 ${JSON.stringify(white)}`);
const tinted = R.lightColorIntensity({ color: [0.5, 0.25, 0.125], intensity: 2 });
want(JSON.stringify(tinted) === JSON.stringify([1, 0.5, 0.25]), "V1 色槽 = color × intensity",
  `色×强度 = color×intensity，得 ${JSON.stringify(tinted)}`);

want(R.MAX_SCENE_LIGHTS === 4, "MAX_SCENE_LIGHTS = 4（老通道 4 槽）",
  `MAX_SCENE_LIGHTS = ${R.MAX_SCENE_LIGHTS}，期望 4`);

const MODEL = [["generic4", "v1"], ["genericimage4", "v1"], ["chroma4", "v1"], ["fur4", "v1"],
  ["foliage4", "v1"], ["genericparticle", "v1"], ["genericropeparticle", "v1"],
  ["generic3", "v0"], ["genericimage3", "v0"], ["genericimage2", "lit2d"], ["", "lit2d"], ["weird", "lit2d"]];
for (const [shader, expect] of MODEL) {
  const got = R.lightModelForShader(shader);
  want(got === expect, `lightModelForShader(${JSON.stringify(shader)}) → ${expect}`,
    `lightModelForShader(${JSON.stringify(shader)}) = ${got}，期望 ${expect}`);
}
want(R.lightLaneForModel("v1") === "v1" && R.lightLaneForModel("v0") === "v1" &&
  R.lightLaneForModel("lit2d") === "legacy", "lightLaneForModel：lit2d → legacy，其余 → v1");

// 槽位语义：按场景序取前 4、跨通道不串、不可见灯占槽留零
const mkLight = (o, i) => Object.assign({ isLight: true, lightLane: "v1", visible: true, origin: [i, 0, 0], color: [1, 1, 1], lightRadius: 100, exponent: 2 }, o);
const six = R.collectSceneLights([0, 1, 2, 3, 4, 5].map((i) => mkLight({}, i)), null, "v1");
want(six.count === 4, "collectSceneLights 6 盏 V1 灯只占 4 槽", `6 盏 V1 灯应装 4 槽，得 ${six.count}`);
want(six.radii.length === 4 && six.radii[0] === 100, "collectSceneLights radii 槽长 4、[0] = 半径",
  `radii 槽长/取值异常：len=${six.radii.length} [0]=${six.radii[0]}`);
const hidden = R.collectSceneLights([mkLight({}, 0), mkLight({ visible: false }, 1), mkLight({}, 2)], null, "v1");
want(hidden.count === 3 && hidden.used[1] === null && hidden.radii[1] === 0,
  "不可见灯占槽留零（不压缩下标）",
  `不可见灯应占槽留零：count=${hidden.count} used[1]=${hidden.used[1]} radii[1]=${hidden.radii[1]}`);
const lanes = R.collectSceneLights([mkLight({ lightLane: "v1" }, 0), mkLight({ lightLane: "legacy" }, 1)], null, "v1");
want(lanes.count === 1 && lanes.positions[0] === 0, "V1 通道不收 legacy 灯（按 lightLane 装箱）",
  `V1 通道不应收 legacy 灯，得 count=${lanes.count}`);
want(lanes.positions.length === 12, "灯位置槽 = 4 × vec3（12 float）");

// ── 3. 着色器侧式子（headers.ts + renderer-glsl.js）[本仓] ───────────────────
const hdr = read("renderer/vendor/we-scene/headers.ts");
const glsl = read("renderer/vendor/we-scene/render/renderer-glsl.js");

const SHAPE = [
  [hdr, "headers.ts V1 衰减 falloff", "falloff = clamp(1.0 - dist / max(radius, 1e-4), 0.0, 1.0)"],
  [hdr, "headers.ts flt_min 常量（2^-14）", "fltMin = 6.103515625e-5"],
  [hdr, "headers.ts 衰减幂（含 flt_min 门）", "mix(0.0, pow(falloff + fltMin, exponent), step(fltMin, falloff))"],
  [hdr, "headers.ts overbright 阈值 2.0", "(clamp(lightLen - 2.0, 0.0, 1.0) * 0.5) / max(0.01, lightLen)"],
  [hdr, "headers.ts 老通道辐照度 d²", "lightColor.xyz / (lightDistance * lightDistance)"],
  [glsl, "renderer-glsl.js lightRadiance 签名",
    "vec3 lightRadiance(vec3 lightColor, float radius, float exponent, float distance, int model)"],
  [glsl, "renderer-glsl.js 模型 0 衰减", "float falloff = clamp(1.0 - distance / max(radius, 0.0001), 0.0, 1.0);"],
  [glsl, "renderer-glsl.js 模型 0 幂", "return lightColor * mix(0.0, pow(falloff + fltMin, exponent), step(0.0, falloff - fltMin));"],
  [glsl, "renderer-glsl.js 模型 1 衰减", "return lightColor * (radius * radius) / max(distance * distance, 0.0001);"],
];
for (const [src, label, needle] of SHAPE) want(src.includes(needle), `${label} 逐字在位`,
  `${label} 缺失/改写（期望 "${needle}"）`);

// overbright 有三处落点（`CombineLighting` 2 参 / 3 参重载 + common_pbr_2.h 那份同名实现），
// 必须同值：改一处漏一处，同一盏灯会在不同路径上亮得不一样。
const OVERBRIGHT = "(clamp(lightLen - 2.0, 0.0, 1.0) * 0.5) / max(0.01, lightLen)";
want(count(hdr, OVERBRIGHT) === 3, "headers.ts overbright 式 3 处同值（:503 / :512 / :917）",
  `headers.ts overbright 式应出现 3 次（:503 / :512 / :917），实为 ${count(hdr, OVERBRIGHT)} 次`);

// flt_min = 2^-14：headers.ts 的 V1 衰减只有一处用它（:464）；renderer-glsl.js 的 lightRadiance 同常量。
want(count(hdr, "6.103515625e-5") === 1, "headers.ts flt_min 恰好 1 处（:464）",
  `headers.ts flt_min 常量应恰好 1 处（:464），实为 ${count(hdr, "6.103515625e-5")} 处`);
want(glsl.includes("float fltMin = 6.103515625e-5;"), "renderer-glsl.js lightRadiance 用同一 flt_min");
want(6.103515625e-5 === 2 ** -14, "flt_min 字面量 = 2^-14（精确）",
  `flt_min 字面量应为 2^-14，实为 ${6.103515625e-5}`);
// 两条实现的写法不同但等价：step(fltMin, falloff) ≡ step(0, falloff - fltMin)
want(hdr.includes("step(fltMin, falloff)") && glsl.includes("step(0.0, falloff - fltMin)"),
  "两条 V1 衰减实现的 flt_min 门保持等价对（step(fltMin,falloff) ↔ step(0,falloff−fltMin)）",
  "两条 V1 衰减实现的 flt_min 门写法不再是等价对（step(fltMin,falloff) ↔ step(0,falloff−fltMin)）");

// ── 4. 原生对账（docs/re/we-native-lighting-constants.md §1）[原生] × [本仓] ──
// NATIVE 的值来自该文档 §1 台账（每条带 evidence_id + 地址）；null = 尚无原生证据，
// 按 plan §0 记 unknown（不得据此改常量，也不在本脚本里断言）。
const NATIVE = {
  lightRadiusDefault: null,
  intensityDefault: null,
  exponentDefault: null,
  lightSlotCap: null,
  overbrightThreshold: null,
  ambientColorDefault: null,
  skyLightColorDefault: null,
  spotConeDefaults: null,
  lanePrefix: null,
};
const nativeUnknown = Object.entries(NATIVE).filter(([, v]) => v === null).map(([k]) => k);
if (NATIVE.lightRadiusDefault !== null) want(R.lightRadiusOf({}) === NATIVE.lightRadiusDefault, "lightRadius 缺省 == 原生取值");
if (NATIVE.intensityDefault !== null) want(white[0] === NATIVE.intensityDefault, "intensity 缺省 == 原生取值");
if (NATIVE.exponentDefault !== null) want(R.lightExponentOf({}) === NATIVE.exponentDefault, "exponent 缺省 == 原生取值");
if (NATIVE.lightSlotCap !== null) want(R.MAX_SCENE_LIGHTS === NATIVE.lightSlotCap, "光源槽上限 == 原生取值");
if (NATIVE.overbrightThreshold !== null) {
  want(hdr.includes(`clamp(lightLen - ${NATIVE.overbrightThreshold.toFixed(1)}, 0.0, 1.0)`), "overbright 阈值 == 原生取值");
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
for (const n of notes) console.log("  ✓ " + n);
console.log(`\nverify-light-constants: ${notes.length} 条通过，${errors.length} 条失败`);
if (nativeUnknown.length) console.log(`  · 原生列尚无证据（记 unknown，按 plan §0 不改常量）：${nativeUnknown.join(", ")}`);
if (errors.length) {
  for (const e of errors) console.log("  ✗ " + e);
  process.exit(1);
}
console.log("  ✓ 全部判据通过");
