/**
 * min-js —— 构建期把「按文本发布的 JS」压成无注释文本（esbuild transform，只压空白与标识符）。
 *
 * 为什么需要它：`renderer/src/web-shim.js` 不是一个模块，而是**注入第三方 iframe 的 classic
 * script 文本** —— `renderer/src/web.ts` 用 `?raw` 把它嵌进库产物，`scripts/build-app.mjs`
 * 又拷一份成 `app/web-shim.js` 交给宿主注入 /web/ HTML。源码按可读形态留在仓里（判据、调试都
 * 读它），**发出去的那两份在构建期压掉注释**：那 78 KB 里有 14 KB 是内部 JSDoc，注释对运行时
 * 无用，却会随注入文本一起落到作者的页面里（issue #14 的「产物体积」同一条线）。
 *
 * 口径：
 *   - `target` 默认 `esnext` —— 只做压缩、不做降级（注入目标是我们的 Chromium / 现代浏览器，
 *     降级只会凭空改写语义）；
 *   - 不传 `format` —— shim 是 classic script，压完仍是 classic script（没有 import/export）；
 *   - `charset: "utf8"` —— 非 ASCII 直接以 UTF-8 落地（默认 ascii 会把中文转义成 `\uXXXX`，
 *     产物更大且更难读）。
 */
import { transform } from "esbuild";

/** @param {string} src @returns {Promise<string>} */
export async function minifyJsText(src, { target = "esnext" } = {}) {
  const result = await transform(src, {
    minify: true,
    legalComments: "none",
    charset: "utf8",
    loader: "js",
    target,
  });
  return result.code;
}

export default minifyJsText;
