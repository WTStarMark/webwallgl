#!/usr/bin/env node
/**
 * verify-bundle-hygiene —— 产物卫生：**发出的文本里不许留内部注释**（issue #14 的第二半）。
 *
 * 为什么需要（2026-10-12 用户报障）：
 *   「怎么打包后，压缩版依旧有 `// mode 编号同 WE common_blending.h 的 BLENDMODE` 和
 *     `/** 不透明源下的存储 / Cookie 兜底。 *​/` 等注释在里面？」
 *
 * 两处都不是「压缩器漏剥」——它们是**字符串载荷**，压缩器按规矩不能改字符串内容：
 *   1. `renderer/vendor/we-scene/render/renderer-glsl.js` 一类文件把 GLSL 源码放在模板字面量里
 *      （引擎内建的合成 pass / 内联 effect / WE 的 `#include` 公共头），串里的 `//` 是 GLSL 注释；
 *   2. `renderer/src/web-shim.js` **按文本发布**：`renderer/src/web.ts` 用 `?raw` 嵌进库产物、
 *      `scripts/build-app.mjs` 拷一份成 `app/web-shim.js` 交给宿主注入第三方页面 ⇒ 源码文本就是
 *      交付物，1974 行里有 14 KB 内部 JSDoc。
 *
 * 本仓既有的约定是「构建期去注释」（`scripts/lib/glsl-plugin.mjs` 早就给独立 `.glsl` 文件这么干了），
 * 本判据把同一约定钉在**另外两条载荷路径**上，并锁住三条实现：
 *   A. 嵌 GLSL 剥注释（`stripEmbeddedGlsl` / `embeddedGlslPlugin`）：注释没了、**行数一个不差**
 *      （着色器编译报错带行号）、`// {"material":…}` 契约注释逐字节活着、`${…}` 插值不动、
 *      非 GLSL 模板串与 JS 字符串一个字符都不许动；
 *   B. shim 构建期压缩（`scripts/lib/min-js.mjs` + `min-raw-plugin.mjs` + `build-app.mjs`）：
 *      压过的文本仍是合法 classic script，`__wePushPointer` / `__wePushWheel` / `__wePointerLeave`
 *      这些注入入口还在，注释没了；
 *   C. 压缩版 `charset: "utf8"`（`scripts/assemble-lib.mjs`）：默认 ascii 会把中文转义成 `\uXXXX`
 *      —— 三个压缩包各多 ~45 KB，而且**看起来就像漏剥的注释**（用户看到的正是转义形态）。
 *
 * 只读源码 + 纯函数对拍，不依赖 dist/ 是否是新的（产物新鲜度由 build 流程保证）。
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, createChecker } from "./lib/verify-kit.mjs";
import { stripEmbeddedGlsl, embeddedGlslPlugin } from "./lib/glsl-plugin.mjs";
import { minifyJsText } from "./lib/min-js.mjs";
import { minRawJsPlugin } from "./lib/min-raw-plugin.mjs";

const { check, errors } = createChecker({ echo: true });

const read = (rel) => fs.readFileSync(join(ROOT, rel), "utf8");
const lineCount = (s) => s.split("\n").length;

/* ── A. 嵌在模板串里的 GLSL ─────────────────────────────────────────────── */

/** 合成夹具：GLSL 串 + 契约注释 + 插值 + 不该被碰的 JS 字符串 / 普通模板串 */
const FIXTURE = [
  "const a = 1;",
  "const S = `#version 300 es",
  "precision highp float;",
  "uniform float g_A; // {\"material\":\"k\",\"type\":\"float\"}",
  "void main() {",
  "  // GLSL 行注释",
  "  /* GLSL 块",
  "     注释两行 */",
  "  gl_FragColor = vec4(1.0);",
  "  ${ident}",
  "} `;",
  "const js = \"// 这是 JS 字符串，不许动\";",
  "const plain = `普通模板串 // 不是 GLSL`;",
].join("\n");

const fixed = stripEmbeddedGlsl(FIXTURE);
check(fixed.length === FIXTURE.length, "嵌 GLSL 剥注释必须**等长**（空格顶回：模板串外的列号与 sourcemap 不许错位）");
check(lineCount(fixed) === lineCount(FIXTURE), "嵌 GLSL 剥注释必须**行数不变**（着色器报错的行号就是源码行号）");
check(!fixed.includes("GLSL 行注释"), "GLSL 行注释被剥掉");
check(!fixed.includes("注释两行"), "GLSL 块注释被剥掉（保留其中的换行）");
check(fixed.includes('{"material":"k","type":"float"}'), "`// {\"material\":…}` 契约注释逐字节保留（材质名映射靠它）");
check(fixed.includes("${ident}"), "`${…}` 插值原样保留（那是 JS，不是 GLSL）");
check(fixed.includes("// 这是 JS 字符串，不许动"), "JS 字符串字面量一个字符都不动");
check(fixed.includes("普通模板串 // 不是 GLSL"), "不含 GLSL 标记的模板串不动");
check(fixed.includes("gl_FragColor = vec4(1.0);"), "GLSL 代码本体保留");

// 真实引擎文件：六个文件里都有注释可剥，且必须等长 / 行数不变 / 契约注释数量不变
const ENGINE_FILES = [
  "renderer/vendor/we-scene/render/renderer-glsl.js",
  "renderer/vendor/we-scene/render/mdl.js",
  "renderer/vendor/we-scene/render/particle-shaders.js",
  "renderer/vendor/we-scene/headers.ts",
  "renderer/vendor/we-scene/shaders-builtin.ts",
];
const contractCount = (s) => (s.match(/\/\/\s*\{/g) ?? []).length;
/** 剥掉的注释字节：blank 模式是「等长顶空格」⇒ 按「字符被改写的位置数」计 */
const blankedBytes = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) n += 1;
  return n;
};
let stripped = 0;
const tmp = mkdtempSync(join(tmpdir(), "we-bundle-"));
for (const rel of ENGINE_FILES) {
  const src = read(rel);
  const out = stripEmbeddedGlsl(src);
  const name = rel.replace("renderer/vendor/we-scene/", "");
  const saved = blankedBytes(src, out);
  stripped += saved;
  check(out !== src, `${name}：模板串里的 GLSL 注释被剥掉`);
  check(out.length === src.length, `${name}：剥完等长（空格顶回）`);
  check(lineCount(out) === lineCount(src), `${name}：剥完行数不变`);
  check(contractCount(out) === contractCount(src), `${name}：契约注释数量不变`);
  if (rel.endsWith(".js")) {
    // 更强的判据：剥完仍是合法 ESM（语法没被改坏）
    const f = join(tmp, "m.mjs");
    writeFileSync(f, out);
    let ok = true;
    try {
      execFileSync(process.execPath, ["--check", f], { stdio: "ignore" });
    } catch {
      ok = false;
    }
    check(ok, `${name}：剥完仍能通过 node --check（语法未损）`);
  }
}
check(stripped > 0, `六个引擎文件共剥掉 ${stripped} 字节注释（应远大于 0）`);

// 用户看到的那条注释：必须在真实文件里被剥掉，而它所在的 GLSL 串本体还在
const glslSrc = read("renderer/vendor/we-scene/render/renderer-glsl.js");
const glslOut = stripEmbeddedGlsl(glslSrc);
check(glslSrc.includes("mode 编号同 WE common_blending.h"), "renderer-glsl.js 源码里确有那条 `// mode 编号同…` 注释");
check(!glslOut.includes("mode 编号同 WE common_blending.h"), "打包路径上那条注释被剥掉（用户报障的那处）");
check(glslOut.includes("WE_BLENDING_GLSL") && glslOut.includes("ApplyBlending"), "GLSL 串本体（WE_BLENDING_GLSL / ApplyBlending 分支）保留");
rmSync(tmp, { recursive: true, force: true });

/* ── B. shim 构建期压缩 ─────────────────────────────────────────────────── */

const shimSrc = read("renderer/src/web-shim.js");
check(shimSrc.includes("不透明源下的存储"), "web-shim.js 源码里确有那条 `/** 不透明源下的存储… */`（用户报障的第二处）");

const shimMin = await minifyJsText(shimSrc);
check(shimMin.length < shimSrc.length, `shim 压过之后更小（${shimSrc.length} → ${shimMin.length} 字节）`);
check(!shimMin.includes("不透明源下的存储"), "压过的 shim 不再带那条 JSDoc");
check(!shimMin.includes("/**"), "压过的 shim 没有块注释残留");
check(!/^\s*\/\//m.test(shimMin), "压过的 shim 没有以行注释开头的行");
for (const hook of ["__wePushPointer", "__wePushWheel", "__wePointerLeave"]) {
  check(shimMin.includes(hook), `压过的 shim 仍暴露 ${hook}（注入入口不能被压掉）`);
}
check(/["']use strict["']/.test(shimMin), "`use strict` 指令保留（压缩器不许动 directive）");
let classicOk = true;
try {
  new Function(shimMin); // 只编译不执行：classic script 语义下必须可解析
} catch {
  classicOk = false;
}
check(classicOk, "压过的 shim 仍是可解析的 classic script（没有变成 ESM）");

/* ── C. 构建流水线接线（实现被摘掉就红）──────────────────────────────────── */

check(typeof embeddedGlslPlugin === "function" && embeddedGlslPlugin().name === "we-embedded-glsl",
  "glsl-plugin.mjs 导出 embeddedGlslPlugin（构建期剥嵌 GLSL）");
check(minRawJsPlugin().name === "we-min-raw-js", "min-raw-plugin.mjs 导出 minRawJsPlugin（`?raw` 走构建期压缩）");

const buildLib = read("scripts/build-lib.mjs");
check(/embeddedGlslPlugin\(\)/.test(buildLib), "库构建（build-lib.mjs）装了 embeddedGlslPlugin");
check(/minRawJsPlugin\(\)/.test(buildLib), "库构建（build-lib.mjs）装了 minRawJsPlugin");

const viteCfg = read("vite.config.ts");
check(/embeddedGlslPlugin\(\)/.test(viteCfg), "站点构建（vite.config.ts）装了 embeddedGlslPlugin");
check(/minRawJsPlugin\(\)/.test(viteCfg), "站点构建（vite.config.ts）装了 minRawJsPlugin");

const buildApp = read("scripts/build-app.mjs");
check(/minifyJsText/.test(buildApp), "app 组装（build-app.mjs）用 minifyJsText 写 shim");
check(!/cpSync\(join\(root,\s*"renderer",\s*"src",\s*"web-shim\.js"\)/.test(buildApp),
  "build-app.mjs 不得再把 shim 原样 cpSync（那份文本会被宿主注入第三方页面）");
check(/import shimSource from "\.\/web-shim\.js\?raw"/.test(read("renderer/src/web.ts")),
  "web.ts 仍以 `?raw` 嵌入 shim（本判据 A/B 覆盖的正是它那条路径）");

const assemble = read("scripts/assemble-lib.mjs");
check(/charset:\s*"utf8"/.test(assemble),
  "assemble-lib.mjs 压缩用 charset:\"utf8\"（否则中文变 `\\uXXXX`：更大，且看着像漏剥的注释）");

console.log(
  errors.length === 0
    ? `verify-bundle-hygiene: 全部通过 ✓（嵌 GLSL 共剥 ${stripped} 字节；shim ${shimSrc.length} → ${shimMin.length} 字节）`
    : `verify-bundle-hygiene: ${errors.length} 项失败 ✗`,
);
process.exit(errors.length === 0 ? 0 : 1);
