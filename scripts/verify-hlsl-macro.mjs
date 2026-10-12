#!/usr/bin/env node
/**
 * verify-hlsl-macro —— HLSL 预处理器「负字面量宏」的离线门禁（G10）。
 *
 * 现象：作者写 `#define SHADOWMASK_HORIZGAPWIDTH -1.3`，在
 * `Grille(uv.y, -SHADOWMASK_HORIZGAPWIDTH)` 处按**文本拼接**得到 `--1.3`。
 * HLSL 预处理器做的是词法级替换（替换文本自成 token 序列），`- -1.3` 合法；
 * 而 GLSL 编译器重新做词法分析，`--` 被当成自减运算符 →
 * `'--' : l-value required (can't modify a const)` → **整个 shadow_map pass 被跳过**。
 *
 * 修法（C 预处理器语义）：替换文本以一元 ± 开头且处于需要操作数的位置时括号化。
 * 本夹具不绑定具体宏名，覆盖：
 *   · 有空格 `a - NEG`、无空格 `a-NEG`（旧的事后折叠补丁只覆盖前者）
 *   · `a*-1.0` 这类字面量不受影响、正常宏行为逐字不变
 *   · 嵌套宏 / 多轮展开 / 函数宏 / 负值 combo / 顶层逗号宏体
 *   · `for (…; i--)` 的真自减不得被误伤
 *
 * 夹具全部**合成**，不读壁纸库；语料侧的现象证据（6 pass / 4 壁纸）由
 * docs/RENDERER-COMPLETION-PLAN.md G10 与 docs/re/we-shader-effect-model.md 记录。
 */
import fs from "node:fs";
import { join } from "node:path";
import { hlsl2glsl } from "../renderer/vendor/we-scene/render/hlsl2glsl.js";
import { ROOT, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });

/** 展开后的**非法符号序列**：两个相邻符号紧跟数字/小数点（`--1.3` / `+-1.3` / `-+2.0`）。 */
const ILLEGAL = /[+-][+-][ \t]*(?=[\d.])/g;

/** 裸文本替换（= 修复前的行为），用来证明夹具真的有鉴别力。 */
function naiveSubstitute(src, defs) {
  let out = src;
  for (const [name, body] of Object.entries(defs)) {
    out = out.replace(new RegExp("\\b" + name + "\\b", "g"), body);
  }
  return out;
}

const HEAD = [
  "uniform sampler2D g_Texture0;",
  "varying vec2 v_TexCoord;",
].join("\n");

const CASES = [
  {
    name: "有空格：Grille(uv.y, -NEG)",
    defs: { NEG: "-1.3" },
    src: `#define NEG -1.3
${HEAD}
void main() {
  vec4 albedo = texture2D(g_Texture0, v_TexCoord);
  float a = Grille(v_TexCoord.y, -NEG);
  gl_FragColor = albedo * a;
}`,
    expect: ["(-1.3)"],
    forbid: ["--"],
  },
  {
    name: "无空格：x-NEG（旧事后折叠补丁的漏网形态）",
    defs: { NEG: "-1.3" },
    src: `#define NEG -1.3
${HEAD}
void main() {
  float a = v_TexCoord.x-NEG;
  gl_FragColor = vec4(a);
}`,
    expect: ["(-1.3)"],
    forbid: ["--"],
  },
  {
    name: "右括号后无空格：(a)-NEG",
    defs: { NEG: "-2.5" },
    src: `#define NEG -2.5
${HEAD}
void main() {
  float a = (v_TexCoord.x)-NEG;
  gl_FragColor = vec4(a);
}`,
    expect: ["(-2.5)"],
    forbid: ["--"],
  },
  {
    name: "二元加：x+NEG",
    defs: { NEG: "-0.5" },
    src: `#define NEG -0.5
${HEAD}
void main() {
  float a = v_TexCoord.x+NEG;
  gl_FragColor = vec4(a);
}`,
    expect: ["(-0.5)"],
    forbid: [],
  },
  {
    name: "字面量不受影响：a*-1.0 保持原样",
    defs: {},
    src: `${HEAD}
void main() {
  float a = v_TexCoord.x*-1.0;
  float b = v_TexCoord.y + -2.0;
  gl_FragColor = vec4(a, b, 0.0, 1.0);
}`,
    expect: ["*-1.0", "+ -2.0"],
    forbid: [],
  },
  {
    name: "正常宏行为不变：正数宏 / 拼接",
    defs: { SCALE: "2.0" },
    src: `#define SCALE 2.0
${HEAD}
void main() {
  float a = v_TexCoord.x*SCALE;
  gl_FragColor = vec4(a);
}`,
    expect: ["2.0"],
    forbid: ["(2.0)"],
  },
  {
    name: "函数宏：结果本就括号化，不得二次包裹",
    defs: { ADD: "((a0)+(b0))" },
    src: `#define ADD(a0, b0) ((a0)+(b0))
${HEAD}
void main() {
  float a = -ADD(1.0, 2.0);
  gl_FragColor = vec4(a);
}`,
    expect: ["1.0"],
    forbid: ["--"],
  },
  {
    name: "嵌套宏：NEG 由 BASE 定义",
    defs: { BASE: "-1.3", NEG: "BASE" },
    src: `#define BASE -1.3
#define NEG BASE
${HEAD}
void main() {
  float a = -NEG;
  gl_FragColor = vec4(a);
}`,
    expect: ["(-1.3)"],
    forbid: ["--"],
  },
  {
    name: "多轮展开：A → B → C",
    defs: { A: "-1.0", B: "A", C: "B" },
    src: `#define A -1.0
#define B A
#define C B
${HEAD}
void main() {
  float a = -C;
  float b = v_TexCoord.x-C;
  gl_FragColor = vec4(a, b, 0.0, 1.0);
}`,
    expect: ["(-1.0)"],
    forbid: ["--"],
  },
  {
    name: "复合体：定义自身以宏开头",
    defs: { NEG: "-1.3", TWICE: "-NEG" },
    src: `#define NEG -1.3
#define TWICE -NEG
${HEAD}
void main() {
  float a = TWICE;
  gl_FragColor = vec4(a);
}`,
    expect: ["(-(-1.3))"],
    forbid: ["--"],
  },
  {
    name: "负值 combo：标识符替换同族",
    combos: { NEGCOMBO: -5 },
    src: `${HEAD}
void main() {
  float a = v_TexCoord.x-NEGCOMBO;
  float b = -NEGCOMBO;
  gl_FragColor = vec4(a, b, 0.0, 1.0);
}`,
    expect: ["(-5)"],
    forbid: ["--"],
  },
  {
    name: "顶层逗号宏体不括号化（vec2(PAIR) 仍合法）",
    defs: { PAIR: "-1.0, -2.0" },
    src: `#define PAIR -1.0, -2.0
${HEAD}
void main() {
  vec2 p = vec2(PAIR);
  gl_FragColor = vec4(p, 0.0, 1.0);
}`,
    expect: ["vec2(-1.0, -2.0)"],
    forbid: ["((-1.0, -2.0))"],
  },
  {
    name: "真自减不得被误伤",
    defs: {},
    src: `${HEAD}
void main() {
  float a = 0.0;
  for (int i = 4; i > 0; i--) { a += v_TexCoord.x; }
  gl_FragColor = vec4(a);
}`,
    expect: ["i--"],
    forbid: [],
  },
];

let cases = 0;
let exercised = 0;

for (const c of CASES) {
  cases++;
  const combos = c.combos || {};
  const sibling = c.sibling || "";
  const out = hlsl2glsl(c.src, "frag", combos, () => null, sibling);

  const illegal = [...out.matchAll(ILLEGAL)].map((m) => m[0]);
  check(
    illegal.length === 0,
    `${c.name}：展开后残留非法符号序列 ${JSON.stringify(illegal)}`,
  );
  for (const want of c.expect ?? []) {
    check(out.includes(want), `${c.name}：展开结果里找不到 ${JSON.stringify(want)}`);
  }
  for (const bad of c.forbid ?? []) {
    check(!out.includes(bad), `${c.name}：展开结果里不该出现 ${JSON.stringify(bad)}`);
  }

  // 夹具有效性：裸文本替换确实会拼出非法序列（否则这条用例证明不了修复）
  const naive = naiveSubstitute(c.src, c.defs || {});
  if (ILLEGAL.test(naive)) exercised++;
  ILLEGAL.lastIndex = 0;
}

check(cases >= 12, `合成夹具数量 ${cases} 太少`);
check(
  exercised > 0,
  "没有一条夹具能在裸文本替换下复现非法符号序列 —— 夹具失效，门禁形同虚设",
);

// 自注册守卫（先例 scripts/verify-editor.mjs:4824-4825）：脚本必须真的进稳定集，
// 否则本文件本地全绿、`verify-all` 却根本不跑它，门禁只是摆设。
{
  const all = fs.readFileSync(join(ROOT, "scripts/verify-all.mjs"), "utf8");
  check(/"verify-hlsl-macro"/.test(all), "verify-hlsl-macro 在 verify-all 稳定集（STABLE）里");
  const pkgJson = JSON.parse(fs.readFileSync(join(ROOT, "package.json"), "utf8"));
  check(
    pkgJson.scripts?.["verify:hlsl-macro"] === "node scripts/verify-hlsl-macro.mjs",
    "package.json 有 verify:hlsl-macro",
  );
}

console.log(`\nverify-hlsl-macro：${cases} 条合成夹具，裸文本替换下可复现非法序列 ${exercised} 条`);
if (errors.length) {
  console.log(`verify-hlsl-macro: ${errors.length} 项失败 ✗`);
  process.exit(1);
}
console.log("verify-hlsl-macro: 全部通过 ✓");
