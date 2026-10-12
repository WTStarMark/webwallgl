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

export function stripComments(src) {
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
      i = end;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
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

export default glslPlugin;
