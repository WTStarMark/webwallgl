/**
 * min-raw-plugin —— Vite 构建插件：`<文件>?raw` 的导入在**构建期**换成压过的文本。
 *
 * 为什么需要它：`renderer/src/web.ts:19` 用 `import shimSource from "./web-shim.js?raw"`
 * 把 shim 当文本嵌进库产物，而 Vite 内建的 `?raw` 是「原样读文件」⇒ 源码里的 14 KB 内部
 * JSDoc 会一起进产物。`enforce: "pre"` 让本插件的 load 先命中，直接返回压过的文本模块
 * （形状与 Vite 一致：`export default "<文本>"`）。
 *
 * dev serve 不动（`apply: "build"`）：开发时要能在 Sources 面板里读原文、下断点。
 */
import { readFileSync } from "node:fs";
import { minifyJsText } from "./min-js.mjs";

const RAW_QUERY_RE = /(?:^|&)raw(?:&|$)/;

export function minRawJsPlugin({ match = /web-shim\.js$/ } = {}) {
  return {
    name: "we-min-raw-js",
    /** @type {"pre"} */
    enforce: "pre",
    /** @type {"build"} */
    apply: "build",
    async load(id) {
      const q = id.indexOf("?");
      if (q < 0) return null;
      const file = id.slice(0, q);
      if (!RAW_QUERY_RE.test(id.slice(q + 1))) return null;
      if (!match.test(file)) return null;
      const text = await minifyJsText(readFileSync(file, "utf8"));
      return `export default ${JSON.stringify(text)};`;
    },
  };
}

export default minRawJsPlugin;
