#!/usr/bin/env node
/**
 * verify-fog —— 场景「距离雾 / 高度雾」的数值契约判据（计划 M1.3）。
 *
 * 为什么需要它：雾的实现有两条腿 ——
 *   · 着色器侧：`renderer/vendor/we-scene/render/mdl.js` 的 `applySceneFog()`（t² 曲线）；
 *   · 装配侧：`renderer/src/scene-mount.ts` 把场景 `general.fogdistance*` / `general.fogheight*`
 *     字段换算成 uniform 里的 Params 四元组。
 * 这两条腿的判据原先**只**出现在 FLAKY 的 `scripts/verify-particles.mjs`
 * （而且那些断言是粒子雾 + 真实语料，要读素材库），所以雾被改坏时稳定集里没有任何一条会红。
 * 本脚本补的就是这条缺口：**夹具全部合成**，不读 WE 素材库、不读 `~/Library`。
 *
 * 判据形态（三条腿，各自独立）：
 *   [A] 着色器公式与 uniform 布局（源码，单点真值）：起止/跨度/两级浓度四个分量各就各位、
 *       t² 曲线、先高度后距离、加法材质走 alpha 衰减、解析式（无 raymarch/阴影依赖）。
 *   [B] 字段 → Params 换算（**真跑源码切片**）：把 scene-mount.ts 里那段 sceneFog IIFE
 *       原样取出来，只剥掉类型注解，用 `new Function` 求值，喂合成 `scene.general` 夹具。
 *       不在这里抄第二份换算逻辑 —— 被测的就是产品源码本身。
 *   [C] 绑定契约（源码）：FOG 门控（keepZ + fog + model 长度为 16）、缺失向量退 ZERO 常量、
 *       加法材质标志位。**运行时上传面**由稳定集里的 `verify-mdl-depth.mjs` §⑩ 覆盖，这里不重复。
 *
 * 「搬语义不抄常数」的落地方式：浮点常数只在夹具里作为**已知输入**出现（6.53 / 500 / 0.98
 * 与 verify-mdl-depth.mjs 记录的真实语料锚点一致），期望值一律由契约表述断言
 * （起点 = 起点浓度、跨度 = 终点 − 起点、跨度恒为正有限……），不从实现里复制中间量。
 *
 * 取证边界：本脚本只读本仓源码，不碰任何素材语料（见文末自证判据）。
 */
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const raw = (rel) => fs.readFileSync(join(ROOT, rel), "utf8");
const MDL = "renderer/vendor/we-scene/render/mdl.js";
const MOUNT = "renderer/src/scene-mount.ts";

/** 切片：scene-mount.ts 里生成 sceneFog 的那段 IIFE（从声明到 `})();`） */
function extractSceneFogIIFE() {
  const src = raw(MOUNT);
  const start = src.indexOf("const sceneFog = (() => {");
  if (start < 0) return null;
  const end = src.indexOf("})();", start);
  if (end < 0) return null;
  return src.slice(start, end + 5);
}

// ─────────────────────────── [A] 着色器公式与 uniform 布局 ───────────────────────────
console.log("\n[A] 雾的着色器契约（mdl.js: applySceneFog，t² 解析曲线）");
{
  const src = raw(MDL);

  check(/vec4 applySceneFog\(vec4 c\)/.test(src), "必须存在 applySceneFog(vec4)（雾的唯一实现点）");

  // uniform 声明：4 个雾向量 + 2 个开关（缺一个都会让装配侧传了没用）
  check(/uniform float u_fogOn;/.test(src), "u_fogOn 必须声明（关雾路径要能整段短路）");
  check(/uniform float u_fogAdditive;/.test(src), "u_fogAdditive 必须声明（加法材质走 alpha 而非 rgb）");
  check(/uniform highp vec3 u_eye;/.test(src), "u_eye 必须声明（距离雾的观察点）");
  check(/uniform highp vec4 u_fogDist;/.test(src) && /uniform highp vec4 u_fogHeight;/.test(src), "u_fogDist / u_fogHeight 必须声明为 vec4（四个分量各有语义）");
  check(/uniform vec3 u_fogDistColor;/.test(src) && /uniform vec3 u_fogHeightColor;/.test(src), "两级雾色必须各有一个 vec3 uniform");

  // Params 布局：x=起点 y=跨度 z=起点浓度 w=浓度增量（注释与代码都要对得上）
  check(/\(start, end-start, startDensity, endDensity-startDensity\)/.test(src), "Params 四元组的语义必须是 (起点, 跨度, 起点浓度, 浓度增量)");

  const heightBranch = /if \(u_fogHeight\.y != 0\.0\) \{\s*float t = clamp\(\(v_wpos\.y - u_fogHeight\.x\) \/ u_fogHeight\.y, 0\.0, 1\.0\);\s*fh = u_fogHeight\.z \+ u_fogHeight\.w \* t \* t;/.test(src);
  check(heightBranch, "高度雾：t = clamp((世界 y − u_fogHeight.x) / u_fogHeight.y)，因子 = z + w·t²（平方曲线，不是线性）");

  const distBranch = /if \(u_fogDist\.y != 0\.0\) \{\s*float t = clamp\(\(length\(u_eye - v_wpos\) - u_fogDist\.x\) \/ u_fogDist\.y, 0\.0, 1\.0\);\s*fd = u_fogDist\.z \+ u_fogDist\.w \* t \* t;/.test(src);
  check(distBranch, "距离雾：t 用 length(u_eye − v_wpos)（到眼点距离，不是深度/z），因子同为 z + w·t²");

  const iHeight = src.indexOf("fh = u_fogHeight.z + u_fogHeight.w * t * t;");
  const iDist = src.indexOf("fd = u_fogDist.z + u_fogDist.w * t * t;");
  check(iHeight >= 0 && iDist > iHeight, "两段叠加顺序必须是「先高度后距离」（写反会让雾色的混合基准变化）");
  check(/c\.rgb = mix\(c\.rgb, u_fogHeightColor, fh\);/.test(src) && /c\.rgb = mix\(c\.rgb, u_fogDistColor, fd\);/.test(src), "rgb 必须用 mix(color, fogColor, 因子) 而非加减");

  check(
    /if \(u_fogAdditive > 0\.5\) \{\s*float f = clamp\(max\(fd, fh\), 0\.0, 1\.0\);\s*c\.a \*= 1\.0 - f \* f;/.test(src),
    "加法材质：rgb 之外还要按 max(两因子) 衰减 alpha（1 − f²）；漏了这条加法层会整块过曝",
  );

  check(
    src.indexOf("fragColor = applySceneFog(fragColor);") > 0 && /if \(u_fogOn > 0\.5\) fragColor = applySceneFog\(fragColor\);/.test(src),
    "着色器入口必须只在 u_fogOn > 0.5 时套雾（关雾要逐位等价旧行为）",
  );

  // 解析式：雾里不得出现阴影/光线步进（那是 volumetrics* 的活，混进来会让雾变成 O(步数)）
  const fogBody = src.slice(src.indexOf("vec4 applySceneFog(vec4 c)"), src.indexOf("vec4 applySceneFog(vec4 c)") + 1200);
  check(!/sampler|texture2D|texSample/.test(fogBody), "applySceneFog 必须是纯解析式（不得采样阴影图/做 raymarch —— 体积光是另一条链）");
}

// ───────────────── [B] 字段 → Params 换算（真跑 scene-mount.ts 的源码切片） ─────────────────
console.log("\n[B] 场景字段 → Params 换算（真跑 scene-mount.ts 切片，合成的 scene.general 夹具）");
{
  const iife = extractSceneFogIIFE();
  if (!iife) {
    check(false, `必须能在 ${MOUNT} 里定位到 \`const sceneFog = (() => {\` … \`})();\` 这段换算（形状变了就要同步改本判据）`);
  } else {
    // TS → JS：本切片里只有两种类型语法 —— `(scene as any)` 与参数上的 `: any|string|number`。
    // 断言剥之前标记都在（源码形状没变），剥之后全消失，再交给 new Function 编译；
    // 将来若引入别的注解，编译会直接抛错（响亮失败），不会静默漏判。
    const hadAsAny = /\(scene as any\)/.test(iife);
    const hadAnnotations = /:\s*(any|string|number)\b/.test(iife);
    check(hadAsAny && hadAnnotations, "切片里必须仍带 `(scene as any)` 与类型注解（若源码改了形状，本判据要跟着改，不能静默跳过）");

    let stripped = 0;
    let js = iife.replace("(scene as any)", () => (stripped++, "(scene)"));
    js = js.replace(/:\s*(any|string|number)\b/g, () => (stripped++, ""));
    check(!/:\s*(any|string|number)\b/.test(js) && !/as any/.test(js), `类型注解必须全部剥净（共剥 ${stripped} 处）`);

    let sceneFog = null;
    try {
      // eslint-disable-next-line no-new-func —— 被测对象就是产品源码本身，不是"第二份实现"
      sceneFog = new Function("scene", `${js}\n;return sceneFog;`);
    } catch (e) {
      check(false, `切片必须能被求值（实得语法错误：${String(e && e.message).slice(0, 160)}）`);
    }

    if (sceneFog) {
      /** 夹具 → 换算结果；`noGeneral` 时连 general 键都不给 */
      const map = (general, noGeneral = false) => sceneFog(noGeneral ? {} : { general });

      let noGeneral;
      try {
        const r = map(undefined, true);
        noGeneral = r === null ? true : `实得 ${JSON.stringify(r)}（应为 null）`;
      } catch (e) {
        noGeneral = `抛了异常：${String(e && e.message).slice(0, 120)}`;
      }
      check(noGeneral === true, `场景里没有 general 键时必须安全返回 null（不能抛）${noGeneral === true ? "" : ` ｜ ${noGeneral}`}`);

      check(map({ clearcolor: "0 0 0" }) === null, "两个雾开关都不在时不产 FOG（u_fogOn 才能保持 0，逐位等价旧行为）");
      check(map({ fogdistance: false, fogheight: false }) === null, "显式 false 与缺省同义：不产 FOG");

      // 已知锚点（与 verify-mdl-depth.mjs:325 记录的真实语料换算一致：start 6.53 / end 500 / 0 → 0.98）
      const a = map({
        fogdistance: true,
        fogdistancestart: 6.53,
        fogdistanceend: 500,
        fogdistancestartdensity: 0,
        fogdistanceenddensity: 0.98,
        fogdistancecolor: "0.01 0.02 0.03",
      });
      check(!!a && a.height === null && a.heightColor === null, "只开距离雾时必须只产距离雾（高度那一路为 null，由绑定层退常量）");
      if (a) {
        check(a.dist[0] === 6.53, `直线雾起点必须落在 Params[0]（实得 ${a.dist[0]}）`);
        check(a.dist[0] + a.dist[1] === 500, `Params[1] 必须是「终点 − 起点」的跨度（实得 ${a.dist[0]} + ${a.dist[1]}）`);
        check(a.dist[2] === 0 && a.dist[2] + a.dist[3] === 0.98, `Params[2]/[3] 必须是「起点浓度 / 浓度增量」，使终点浓度 = 0.98（实得 ${a.dist[2]} + ${a.dist[3]}）`);
        check(a.distColor.length === 3 && a.distColor[0] === 0.01 && a.distColor[1] === 0.02 && a.distColor[2] === 0.03, "雾色必须按 rgb 三个分量解出（空格分隔串）");
      }

      // 默认值：官方只写开关时的语义（起点 0 / 终点 start+1 / 起点浓度 0 / 终点浓度 1）
      const b = map({ fogdistance: true });
      check(!!b && b.dist[0] === 0 && b.dist[0] + b.dist[1] === 1, "只给开关时默认起点 0、默认终点 = 起点 + 1");
      check(!!b && b.dist[2] === 0 && b.dist[2] + b.dist[3] === 1, "只给开关时默认起点浓度 0、终点浓度 1");

      // end == start：官方会除零，换算必须给一个**正的有限跨度**（否则 t = 0/0，整屏 NaN 黑）
      const c = map({ fogdistance: 1, fogdistancestart: 7, fogdistanceend: 7 });
      check(!!c && c.dist[1] > 0 && Number.isFinite(c.dist[1]) && c.dist[1] <= 1e-3, `终点 == 起点时跨度必须为正且极小（除零保护；实得 ${c && c.dist[1]}）`);

      // 编辑器会把值包成 { value: ... }（实测 scene.json 两种形态都有）
      const d = map({ fogdistance: { value: "true" }, fogdistancestart: { value: "3" }, fogdistanceend: { value: 9 }, fogdistancecolor: { value: "1 0.5 0.25" } });
      check(!!d && d.dist[0] === 3 && d.dist[0] + d.dist[1] === 9, "{ value: … } 包装必须被解包（解包失败会静默退回默认值，雾变成 0→1）");
      check(!!d && d.distColor[0] === 1 && d.distColor[1] === 0.5 && d.distColor[2] === 0.25, "{ value: … } 包装的雾色同样要解包");

      // 开关的字面量集合：true / 1 / "1" / "true"
      const onForms = [true, 1, "1", "true"];
      const offForms = [false, 0, "0", "false", "", null, undefined];
      check(
        onForms.every((v) => !!map({ fogdistance: v })) && offForms.every((v) => map({ fogdistance: v }) === null),
        "雾开关只认 true / 1 / \"1\" / \"true\" 四种开法，其余一律当关（含 \"0\" / \"\" / null）",
      );

      // 高度雾同等对待，且两路可以同时开
      const f = map({ fogheight: 1, fogheightstart: 1, fogheightend: 5, fogheightcolor: "0.9 0.9 1" });
      check(!!f && f.dist === null && f.distColor === null, "只开高度雾时距离那一路必须为 null");
      check(!!f && f.height[0] === 1 && f.height[0] + f.height[1] === 5, "高度雾起点/跨度同样落在 Params[0]/[1]（世界 y 起止）");
      check(!!f && f.heightColor[0] === 0.9 && f.heightColor[2] === 1, "高度雾色必须解出");
      const both = map({ fogdistance: 1, fogdistanceend: 4, fogheight: 1, fogheightend: 2 });
      check(!!both && !!both.dist && !!both.height, "两路可同时开（着色器先高度后距离叠加）");

      // 非数值/畸形输入：必须退默认而不是产 NaN（NaN 会顺着 uniform 把整屏颜色打成黑或白）
      const h = map({ fogdistance: 1, fogdistancestart: "abc", fogdistanceend: "xyz", fogdistancestartdensity: "q" });
      check(!!h && h.dist[0] === 0 && h.dist[0] + h.dist[1] === 1 && h.dist[2] === 0, "非数值字段必须退默认（起点 0 / 终点 +1 / 起点浓度 0），不得产 NaN");
      const i = map({ fogdistance: 1, fogdistancestart: "", fogdistanceend: "" });
      check(!!i && Number.isFinite(i.dist[0]) && i.dist[1] > 0, `空串会 Number("") = 0，跨度必须仍为正有限（实得 ${i && JSON.stringify(i.dist)}）`);
      const j = map({ fogdistance: 1, fogdistancecolor: "nope" });
      check(!!j && j.distColor.length === 3 && j.distColor.every((x) => Number.isFinite(x)), "畸形雾色必须退成 3 个有限数（不能出 undefined/NaN）");

      // 全夹具不变量：所有分量必须是有限数，且跨度恒为正（着色器用它做分母）
      const all = [a, b, c, d, f, both, h, i, j].filter(Boolean);
      const flat = all.flatMap((o) => [o.dist, o.distColor, o.height, o.heightColor]).filter(Boolean).flat();
      check(flat.length > 0 && flat.every((x) => typeof x === "number" && Number.isFinite(x)), `所有夹具的 Params/雾色分量必须是有限数（共 ${flat.length} 个）`);
      const spans = all.map((o) => o.dist && o.dist[1]).filter((x) => x !== null && x !== undefined);
      check(spans.length > 0 && spans.every((x) => x > 0 && Number.isFinite(x)), "距离雾跨度在全部夹具里都必须为正有限（mdl.js 拿它当分母）");
    }
  }
}

// ───────────────────────────── [C] 绑定契约（装配 → uniform） ─────────────────────────────
console.log("\n[C] 绑定契约：FOG 门控 / 缺失向量退常量 / 加法材质标志（运行时上传面见 verify-mdl-depth §⑩）");
{
  const src = raw(MDL);

  check(
    /const FOG = opts\.keepZ && opts\.fog && opts\.model && opts\.model\.length === 16 \? opts\.fog : null/.test(src),
    "FOG 门控必须同时要求 keepZ、fog 与 16 元 model（少了 model 长度校验会拿到半截矩阵，雾的运算是错的但不报错）",
  );
  check(/gl\.uniform1f\(uni\.fogOn, FOG \? 1 : 0\)/.test(src), "u_fogOn 必须由 FOG 门控驱动（关时传 0，着色器整段短路）");

  for (const [u, prop, zero] of [
    ["u_fogDist", "fogDist", "ZERO4"],
    ["u_fogDistColor", "fogDistColor", "ZERO3"],
    ["u_fogHeight", "fogHeight", "ZERO4"],
    ["u_fogHeightColor", "fogHeightColor", "ZERO3"],
  ]) {
    // 源码形态：gl.uniform4fv(uni.fogDist, FOG.dist || ZERO4)
    const field = prop.slice(3, 4).toLowerCase() + prop.slice(4);
    check(
      new RegExp(`gl\\.uniform[34]fv\\(uni\\.${prop}, FOG\\.${field} \\|\\| ${zero}\\)`).test(src),
      `${u} 缺省时必须退 ${zero}（传 undefined 会让整批 uniform 调用报错/静默失效）`,
    );
  }
  check(/gl\.uniform3fv\(uni\.eye, FOG\.eye\)/.test(src), "观察点必须来自调用方（场景眼位），不能在引擎里猜");

  check(
    /gl\.uniform1f\(uni\.fogAdditive, b === 'additive' \? 1 : 0\)/.test(src),
    "加法材质标志必须每网格重传（b === 'additive'），不能整个场景只传一次",
  );

  for (const u of ["u_fogOn", "u_fogAdditive", "u_eye", "u_fogDist", "u_fogDistColor", "u_fogHeight", "u_fogHeightColor"]) {
    check(new RegExp(`getUniformLocation\\(prog, '${u}'\\)`).test(src), `必须缓存 ${u} 的 location（每帧查一次 location 是白花）`);
  }
}

// ────────────────────────── [D] 自证：本判据必须离线（不碰语料） ──────────────────────────
console.log("\n[D] 自证：判据本身不得触碰素材语料");
{
  // 反向字符串拼接：针脚不能出现在本文件源码里，否则判据会命中自己
  const banned = ["WE_" + "LIBRARY", "read" + "ItemFile", "read" + "ProjectJson", "steam" + "apps", "Application" + " Support"];
  const self = raw("scripts/verify-fog.mjs");
  const hits = banned.filter((b) => self.includes(b));
  check(hits.length === 0, `判据自身不得读素材库（禁止项命中 ${hits.length ? hits.join(",") : "无"}）`);
  const imports = [...self.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  check(
    imports.every((s) => s.startsWith("node:")),
    `判据只能 import node: 内置模块（实得 ${imports.join(", ") || "无"}）`,
  );
}

console.log(failed === 0 ? "\nverify-fog: 全部通过 ✓" : `\nverify-fog: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
