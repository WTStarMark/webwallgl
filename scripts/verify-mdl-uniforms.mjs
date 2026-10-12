#!/usr/bin/env node
/**
 * verify-mdl-uniforms —— MDL 顶点着色器的每个 uniform 都必须**每条绘制路径都赋值**，
 * 而且「本帧是否走每骨 alpha 通道」这个开关必须无条件写。
 *
 * 为什么需要（2026-09-28 的真实回归）：给「零件同步压扁」加 `u_partScale/u_partPivot`
 * 时，只在**白名单分支**里设了这两个 uniform。GL 的 uniform 默认值是 `(0,0)`，
 * 而顶点着色器里 `local.xy = u_partPivot + (local.xy − u_partPivot) * u_partScale`
 * 在 (0,0) 下会把整张网格乘成 0 —— 于是**除白名单两张之外的所有 puppet 全塌到原点**：
 * 3798926489 / 3791967416 / 3737267090 / 3707219547 等整批人物消失（实测对照见
 * docs/CASEBOOK.md「五订正」）。整套 verify 当时一条都没红：25 个 verifier 里没有一个
 * 会去「真画一遍非白名单的 puppet 网格」。
 *
 * 2026-10-12：零件级压扁启发式（连同它那对 uniform）整体删除，改为官方的每骨
 * 不透明度包络（`u_boneAlpha[]` + `u_alphaOn` + `v_alpha`，见 verify-blink 头注）。
 * 同一类隐患换了个位置：`u_alphaOn` 若只在「有曲线」的分支里设 1，那么在同一个
 * GL program 上先画了带曲线的人物、再画不带曲线的网格时，后者会继续吃到上一次的
 * `u_alphaOn=1` 而按**上一个模型的骨 alpha 数组**淡出（残留状态 / 越界读）。
 * 所以判据是「**两个分支都显式写**」，不是「至少写一次」。
 *
 * 判据（离线、正则锁实现，与 verify-camera 的实现锁同一风格）：
 *   1. 顶点着色器里出现的每个 `uniform`，在 `draw()` 体内都必须有对应的 `gl.uniform*`
 *      写入 —— 漏一个就是「默认值参与运算」的隐患；
 *   2. `u_alphaOn` 必须在 `if (ba)` 与 `else` **两个分支各写一次**（1 / 0）；
 *   3. alpha 数组必须在任何 `drawElements` **之前**上传；
 *   4. 启发式那对 uniform（`u_partScale/u_partPivot`）与那条 `local.xy = …` 不得复活，
 *      同时 alpha 的 LBS 公式必须还在（否则本 verifier 会在着色器被删空时空转通过）。
 * 这四条都是「实现被改坏就红」的锁。
 */
import fs from "node:fs";
import { join } from "node:path";
import { ROOT, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });

const SRC = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8");

/** 取顶点着色器源码：`const mdlVertSrc = (maxBones) => \`…\`` 到片元着色器模板串之间 */
const vertStart = SRC.indexOf("const mdlVertSrc");
const vertEnd = SRC.indexOf("const MDL_FRAG");
const vert = vertStart >= 0 && vertEnd > vertStart ? SRC.slice(vertStart, vertEnd) : "";
check(vert.length > 0, "找得到 mdlVertSrc 顶点着色器源码");

/** draw() 体内（`draw(mvp, mdl, opts, texture) {` 到 `gl.bindVertexArray(null)`） */
const drawStart = SRC.indexOf("draw(mvp, mdl, opts, texture) {");
const drawEnd = SRC.indexOf("gl.bindVertexArray(null)", drawStart);
const draw = drawStart >= 0 && drawEnd > drawStart ? SRC.slice(drawStart, drawEnd) : "";
check(draw.length > 0, "找得到 draw() 体");

// 1) 每个 uniform 都要有写入（JS 侧局部名 = 着色器名去掉 u_ 前缀，如 u_skin → uni.skin）
const uniformNames = [...vert.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*(\[[^\]]*\])?\s*;/gm)].map((m) => m[1]);
check(uniformNames.length >= 6, `顶点着色器 uniform 数量 ${uniformNames.length}（≥6：mvp/skin/boneCount/keepZ/boneAlpha/alphaOn）`);
for (const name of uniformNames) {
  const local = name.startsWith("u_") ? name.slice(2) : name;
  const written = new RegExp(`gl\\.uniform\\w+\\(uni\\.${local}\\b`).test(draw);
  check(written, `uniform ${name} 在 draw() 里有写入（漏设 → 参与运算的是 GL 默认值 / 上一次的残留）`);
}

// 2) u_alphaOn 必须两个分支都显式写：有曲线 = 1，无曲线 = 0
const onWrites = [...draw.matchAll(/gl\.uniform1f\(uni\.alphaOn,\s*([01](?:\.0)?)\)/g)].map((m) => m[1]);
check(onWrites.length >= 2, `u_alphaOn 必须在 if/else 两个分支各写一次（实际 ${onWrites.length} 次）`);
check(onWrites.includes("1"), "有 blend_curves 的分支必须写 u_alphaOn = 1");
check(onWrites.includes("0"), "无曲线的分支必须写 u_alphaOn = 0（不能靠 GL 默认 / 上一个模型残留）");
check(/if\s*\(ba\)\s*\{[^}]*uni\.alphaOn,\s*1/.test(draw), "u_alphaOn = 1 写在 `if (ba)` 分支里");
check(/\}\s*else\s*\{[^}]*uni\.alphaOn,\s*0/.test(draw), "u_alphaOn = 0 写在 `else` 分支里");

// 3) alpha 数组必须在第一次 drawElements 之前上传
const alphaUpload = draw.search(/gl\.uniform1fv\(uni\.boneAlpha/);
const firstDraw = draw.search(/gl\.drawElements\(/);
check(alphaUpload >= 0, "draw() 里有 `gl.uniform1fv(uni.boneAlpha, …)`");
check(firstDraw >= 0, "draw() 里有 `gl.drawElements(…)`");
check(alphaUpload >= 0 && firstDraw >= 0 && alphaUpload < firstDraw, "骨 alpha 数组在任何 drawElements **之前**上传");

// 4) 旧启发式不得复活；alpha 通道必须真的在着色器里
check(!/u_partScale|u_partPivot/.test(vert), "顶点着色器不得再出现 u_partScale/u_partPivot（启发式已删）");
check(!/gl\.uniform2f\(uni\.(partScale|partPivot)/.test(draw), "draw() 不得再写 partScale/partPivot");
check(/u_boneAlpha\[bi\]\s*\*\s*w/.test(vert), "顶点着色器按骨权重累加 u_boneAlpha（官方 g_BonesAlpha LBS）");
check(/v_alpha\s*=\s*va;/.test(vert), "顶点着色器输出 v_alpha");
check(/v_alpha/.test(SRC.slice(vertEnd, vertEnd + 9000)), "片元着色器使用 v_alpha（color.a *= v_alpha）");
check(/computeBoneAlphas\(mdl,\s*opts\.time\s*\|\|\s*0,\s*opts\.animLayers\)/.test(draw),
  "每帧用**当前时间**（opts.time）算 alpha，而不是缓存一次（否则眨眼会冻住）");

console.log(
  errors.length === 0
    ? "verify-mdl-uniforms: 全部通过 ✓"
    : `verify-mdl-uniforms: ${errors.length} 项失败 ✗`,
);
process.exit(errors.length === 0 ? 0 : 1);
