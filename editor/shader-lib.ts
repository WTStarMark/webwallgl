// shader 片段库（PLUGIN-ARCHITECTURE §3.2）：插件登记可复用的 GLSL 片段（噪声 / 色彩空间…），
// 效果源码里写 `#include "wwgl/<名>"`，生成工程文件时**内联展开** —— 产物里不留编辑器私有
// include，WE 不需要任何额外文件。WE 自己的 include（common.h 等）原样保留，交给引擎。
// 片段之间可以互相 include（按依赖先后展开，同一片段只展开一次，环依赖报错）。

import { createRegistry } from "./core";

// 内置 shader 片段独立成 .glsl 文件（issue #14）：高亮 / 维护友好，打包时剥注释/空行
// （expandShader 的 include 语义不变，`#include "wwgl/<名>"` 仍在 .glsl 里写）。
import HASH_SRC from "./shaders/snippets/hash.glsl";
import NOISE_SRC from "./shaders/snippets/noise.glsl";
import COLOR_SRC from "./shaders/snippets/color.glsl";


/**
 * .glsl 模块文本归一：文件末尾换行去掉，保持与旧内联模板逐字节一致
 * （expandShader 的产物写进 WE 工程，不能多个/少个换行）。
 */
const nl = (s: string) => s.replace(/\n+$/, "");

export type ShaderSnippet = {
  /** include 名，形如 wwgl/noise（不带引号） */
  id: string;
  code: string;
  description?: string;
};

export const SNIPPET_NAMESPACE = "wwgl/";

export const shaderSnippets = createRegistry<ShaderSnippet>("shaders", {
  validate: (s) => {
    if (!s.id.startsWith(SNIPPET_NAMESPACE)) throw new Error(`shader 片段名必须以 ${SNIPPET_NAMESPACE} 开头：${s.id}`);
  },
});

const INCLUDE_RE = /^[ \t]*#include[ \t]+"(wwgl\/[^"]+)"[ \t]*$/gm;

/** 展开源码里的编辑器片段 include；未登记的片段报错（不能把坏 include 写进 WE 工程） */
export function expandShader(src: string, lookup: (id: string) => ShaderSnippet | undefined = (id) => shaderSnippets.get(id)): string {
  if (!src.includes(`"${SNIPPET_NAMESPACE}`)) return src;
  const done = new Set<string>();
  const visit = (code: string, stack: string[]): string =>
    code.replace(INCLUDE_RE, (_line, id: string) => {
      if (stack.includes(id)) throw new Error(`shader 片段循环 include：${[...stack, id].join(" → ")}`);
      if (done.has(id)) return `// ${id}（已展开）`;
      const s = lookup(id);
      if (!s) throw new Error(`未登记的 shader 片段：${id}`);
      done.add(id);
      return `// ---- ${id} ----\n${visit(s.code, [...stack, id])}\n// ---- end ${id} ----`;
    });
  return visit(src, []);
}

/** 内置片段：插件效果常用的几样 */
export const BUILTIN_SNIPPETS: ShaderSnippet[] = [
  {
    id: "wwgl/hash",
    description: "hash12 / hash22：确定性伪随机",
    code: nl(HASH_SRC),
  },
  {
    id: "wwgl/noise",
    description: "wwglNoise(vec2)：值噪声；wwglFbm(vec2)：4 层分形",
    code: nl(NOISE_SRC),
  },
  {
    id: "wwgl/color",
    description: "rgb2hsv / hsv2rgb / 亮度",
    code: nl(COLOR_SRC),
  },
];

shaderSnippets.setFallback(BUILTIN_SNIPPETS);
