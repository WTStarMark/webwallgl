/**
 * glsl-plugin —— 把 `.glsl` 源文件按模块导入的 Vite 构建插件（issue #14）。
 *
 * 为什么自研而不是 vite-plugin-glsl：
 *   1) 本仓三个库构建脚本（build-lib.mjs / build-plugin-sdk.mjs / vite.config.ts）都要用，
 *      而 vite-plugin-glsl 不在依赖里（pnpm 允许清单也窄），加依赖对库消费者有额外成本；
 *   2) 需要的动作只有两件 —— 当模块导入 + 打包时压掉 GLSL 注释/空行，第三方插件反而
 *      装了太多用不上的 include 语义（本仓有自己的 expandShader 内联展开）。
 *
 * 行为：
 *   - import x from "./foo.glsl" → 模块默认导出该文件的文本；
 *   - import { source } from "./foo.glsl" → 具名导出同一份文本（与默认导出同源）；
 *   - serve（开发）：原文返回 —— 注释留着，报错信息好读、断点好下；
 *   - build：剥掉行注释与块注释、空行——**但 `// {"material":…}` 契约注释必须原样保留** —— esbuild 不解析字符串内部的
 *     GLSL，注释只能在这一步清掉（issue #14 的产物体积问题就是这么来的）。
 *
 * 预处理**不动字符串字面量**（uniform 注释里的 `{"material":…}` 是契约，必须逐字节活过
 * 产物）；剥注释的正则只认「不在字符串里的注释」，实现见 stripComments。
 *
 * 同一个模块还导出嵌在 JS/TS 模板串里的 GLSL 那条路径（embeddedGlslPlugin /
 * stripEmbeddedGlsl，见文件下半部分）：引擎有一部分着色器源码是模板字面量而不是 .glsl 文件，
 * 压缩器看不见字符串内容，注释会原样进产物 —— 两条路径都走构建期剥注释。
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const EXT = ".glsl";

/** 非字符串区里的注释（行注释 / 块注释）去掉；换行保留（行列别乱） */
/**
 * WE shader 契约注释：`uniform <type> g_X; // {"material":"key",…}` —— scene.json 的
 * constantshadervalues 靠它把 material 名映到 uniform（editor/effects.ts 的 UNIFORM_RE 与
 * verify-editor 的 uniformNotes 都按这个文本正则抓）。注释剥除**不能**动它。
 */
const CONTRACT_RE = /^\s*\/\/\s*\{.*$/;

export function stripComments(src, { blank = false } = {}) {
  let out = "";
  let i = 0;
  /** 0 = 代码，1 = 双引号字符串，2 = 单引号字符串 */
  let str = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (str) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if ((str === 1 && c === '"') || (str === 2 && c === "'")) str = 0;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      str = c === '"' ? 1 : 2;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && n === "/") {
      // 行注释：契约注释（`// {…}`）逐字节保留，其余剥掉
      let end = i;
      while (end < src.length && src[end] !== "\n") end += 1;
      const line = src.slice(i, end);
      if (CONTRACT_RE.test(line)) out += line;
      // blank=true：等长空格顶回（长度不变 ⇒ 嵌在字符串里时不挪动后续列号）
      else if (blank) out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (c === "/" && n === "*") {
      let end = i + 2;
      while (end < src.length && !(src[end] === "*" && src[end + 1] === "/")) end += 1;
      end = Math.min(end + 2, src.length);
      for (let k = i; k < end; k += 1) if (src[k] === "\n") out += "\n";
      if (blank) {
        // 已吐过换行 ⇒ 只补非换行字符的空格，总数仍是「原文长度 - 换行数」
        for (let k = i; k < end; k += 1) if (src[k] !== "\n") out += " ";
      }
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 打包口径：注释去掉、空行收掉（只压空白，不动行内空格 —— GLSL 不敏感但报错行号要对） */
export function minifyGlsl(src) {
  return stripComments(src)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/**
 * 构建成 JS 模块的文本：默认导出 + 具名 source（两个口子都留，按喜好用）。
 *
 * 字符串模板写法刻意用「裸行」而不是 `\n` 转义拼接：压出来的 JS 只带一层转义，
 * minifyGlsl 的产物不把 `//` 注释带进字符串字面量（stripComments 先清过）。
 */
export const glslModule = (code) => `const source = ${JSON.stringify(code)};
export default source;
export { source };
`;

/**
 * 前缀块（frag 头部 / extra 声明段 / snippet 头）**必须保留一个结尾换行**：它们是被拼接
 * 的片段，末尾换行是结构的一部分（丢了就会把下一行注释吃进同一行）。文件名带 `.decl.glsl`
 * / `frag-head.glsl` / `common.vert.glsl` 的都属此类；其余（main 体、整段源码）剥掉。
 */
const PREFIX_RE = /(?:\.decl|frag-head|common\.vert|\.head)\.glsl$/;
export const isPrefixBlock = (p) => PREFIX_RE.test(p);

/** 归一结尾换行：prefix 保留恰好一个，其余剥光 */
export const normalizeTail = (code, prefix) => (prefix ? code.replace(/\n*$/, "\n") : code.replace(/\n+$/, ""));

/**
 * 许可头注释（署名 / 版权出处）原样拼进产物。剥注释会把它们清空，但这些是**署名声明**，
 * 写进工程的 effect.json / shader 里必须活着（作者与出处随工程自包含）。这类文件用
 * `.head.glsl` 后缀标记，剥完再把原文按行贴回（只贴注释行）。
 */
export function withHeaderComments(code, raw) {
  const heads = raw.split("\n").filter((l) => l.trimStart().startsWith("//"));
  return heads.length ? `${heads.join("\n")}\n${code}` : code;
}

export function glslPlugin({ minify } = {}) {
  const compress = minify ?? true;
  return {
    name: "we-glsl",
    /** @type {"pre"} */
    enforce: "pre",
    // build 一律压缩（issue #14 的产物体积）；dev serve 走 Vite dev server，不走 build
    load(id) {
      if (extname(id) !== EXT) return null;
      const raw = readFileSync(id, "utf8");
      let code = compress ? minifyGlsl(raw) : raw;
      if (isPrefixBlock(id) && id.endsWith(".head.glsl")) code = withHeaderComments(code, raw);
      return glslModule(normalizeTail(code, isPrefixBlock(id)));
    },
  };
}

/* ------------------------------------------------------------------------- *
 * 嵌在 JS/TS 模板串里的 GLSL（issue #14 的第二半）
 *
 * 引擎的着色器源码有一部分不是独立 `.glsl` 文件，而是 JS/TS 里的模板字面量：
 * `renderer/vendor/we-scene/render/renderer-glsl.js`（合成的合成 pass / 内联 effect）、
 * `.../render/mdl.js`、`.../render/particle-shaders.js`、`.../headers.ts`（WE 的
 * `#include` 公共头，交给作者效果 shader 编译）、`.../shaders-builtin.ts`、
 * `.../render/mdl-parse.js`。
 *
 * 这些串里的 `// …` 是 GLSL 注释，压缩器**看不见**（字符串内容不是它的领地）⇒ 打包后
 * 依然躺在产物里。用户看到「压缩版里还有 `// mode 编号同 WE common_blending.h 的 BLENDMODE`」
 * 就是这个原因（不是漏剥）。
 *
 * 处理口径与 `.glsl` 文件那条路径一致：构建期剥注释，**换行一个不动**（着色器编译报错带行号，
 * 行号必须还是源码行号），`// {"material":…}` 契约注释同样逐字节保留。
 * 插值 `${…}` 里的内容是 JS（可能有自己的 `//`），整段原样跳过。
 *
 * 这里刻意用「等长空格顶回」而不是直接删除：模板串里的注释被删会让同一行的后续列号前移，
 * 而我们是在 `transform` 钩子里改**代码字符串**，错位会让 sourcemap 指歪。顶空格后长度不变。
 * ------------------------------------------------------------------------- */

/** 认得出是 GLSL 的标记（源文件里绝大多数模板串是普通文本，不该被碰） */
const GLSL_MARK =
  /(^|\n)[ \t]*(?:#(?:version|ifdef|ifndef|define|else|elif|endif|extension|pragma)\b|precision[ \t]+(?:low|medium|high)p\b|uniform[ \t]|attribute[ \t]|varying[ \t]|void[ \t]+main[ \t]*\()/;

/**
 * 扫出所有模板字面量的 body 区间与其中的 `${…}` 插值区间。
 * 只做必需的事：跳过普通字符串 / 行注释 / 块注释 / 转义；不解析正则（模板串里不构成麻烦）。
 */
function templateLiterals(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === c || src[i] === "\n") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i += 1; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c !== "`") { i += 1; continue; }
    const start = i + 1;
    let j = start;
    const holes = [];
    while (j < n) {
      const ch = src[j];
      if (ch === "\\") { j += 2; continue; }
      if (ch === "`") break;
      if (ch === "$" && src[j + 1] === "{") {
        const hs = j;
        j += 2;
        let depth = 1;
        while (j < n && depth > 0) {
          const e = src[j];
          if (e === "\\") { j += 2; continue; }
          if (e === "`") { // 嵌套模板：跳到配对反引号
            j += 1;
            while (j < n) {
              if (src[j] === "\\") { j += 2; continue; }
              if (src[j] === "`") { j += 1; break; }
              j += 1;
            }
            continue;
          }
          if (e === '"' || e === "'") {
            const q = e;
            j += 1;
            while (j < n) {
              if (src[j] === "\\") { j += 2; continue; }
              if (src[j] === q) { j += 1; break; }
              j += 1;
            }
            continue;
          }
          if (e === "/" && src[j + 1] === "/") { while (j < n && src[j] !== "\n") j += 1; continue; }
          if (e === "/" && src[j + 1] === "*") {
            j += 2;
            while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
            j += 2;
            continue;
          }
          if (e === "{") depth += 1;
          else if (e === "}") depth -= 1;
          j += 1;
        }
        holes.push([hs, j]);
        continue;
      }
      j += 1;
    }
    out.push({ start, end: j, holes });
    i = j + 1;
  }
  return out;
}

/** 剥掉 JS/TS 源码里「GLSL 模板串」的注释（等长空格顶回，插值不动）；返回新源码 */
export function stripEmbeddedGlsl(code) {
  let out = "";
  let last = 0;
  let touched = false;
  for (const s of templateLiterals(code)) {
    const body = code.slice(s.start, s.end);
    if (!GLSL_MARK.test(body)) continue;
    let piece = "";
    let p = s.start;
    for (const [hs, he] of s.holes) {
      piece += stripComments(code.slice(p, hs), { blank: true });
      piece += code.slice(hs, he);
      p = he;
    }
    piece += stripComments(code.slice(p, s.end), { blank: true });
    if (piece === body) continue;
    out += code.slice(last, s.start) + piece;
    last = s.end;
    touched = true;
  }
  return touched ? out + code.slice(last) : code;
}

const ENGINE_GLSL_RE = /\/renderer\/vendor\/we-scene\/.*\.(?:js|ts)$/;

/** 构建插件：引擎目录里的 JS/TS 走一遍嵌 GLSL 剥注释（dev serve 不动，注释留着好读） */
export function embeddedGlslPlugin() {
  return {
    name: "we-embedded-glsl",
    /** @type {"pre"} */
    enforce: "pre",
    /** @type {"build"} */
    apply: "build",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!ENGINE_GLSL_RE.test(file)) return null;
      const out = stripEmbeddedGlsl(code);
      return out === code ? null : out;
    },
  };
}

export default glslPlugin;
