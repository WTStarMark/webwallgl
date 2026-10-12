/**
 * 网页壁纸 HTML 注入（host 侧）：读 renderer/src/web-shim.js，插到作者脚本之前（<head> 后，或
 * <head> 之前的第一个 <script> 之前）。
 * 不得 import renderer/src（verify-arch）；只按路径读文件。
 *
 * 与 renderer/src/web-rewrite.ts 的插入规则**逐条同构**（host/ 不得 import renderer/src，只能镜像）：
 * 判重 = 真正的 `<script … data-we-shim…>…</script>` 元素（不看值，见 SHIM_TAG_RE）；
 * 插入点 = 「<head> 之后」与「第一个 <script> 之前」中**更早**者，避免作者脚本抢先执行；
 * 无 <head> 时才在 <html> 后造 head，残缺 HTML 整段包裹。
 * 刻意不同处（不是漂移）：本路径不注入 <base> 与 seed 脚本 —— /web/ 走原始 URL（不是 blob），
 * 相对路径本来就能解析，且 host 侧没有库属性种子。
 * 同源 /web/ 必须走原始 URL（不能 blob）：Spine/WebGL 贴图在 origin null 下会跨域脏画布。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// 打包后的应用（scripts/build-app.mjs）里 shim 拷在服务器旁边，经 WWGL_WEB_SHIM 指定
const shimPath = () => process.env.WWGL_WEB_SHIM || join(here, "..", "renderer", "src", "web-shim.js");
const SHIM_ATTR = "data-we-shim-src";

/**
 * 判重：必须是**真正的 `<script … data-we-shim…>` 元素**，不是「整篇文档里出现过这个属性名」。
 *
 * 属性名是素材可控字符串：注释、`<meta content>`、内联 JSON、甚至作者脚本正文里的一句
 * `document.querySelector('[data-we-shim]')` 都会命中，命中即**不注入**。注入失败是静默的：
 * shim 是 rAF 节流、指针桥、音频泵的载体，少了它只是「帧率不设限、指针/音频不响应」。
 * 早期这里写 `html.includes('data-we-shim="1"') || html.includes(SHIM_ATTR)`，三类合成伪造
 * 样本全部被短路 —— 与 renderer/src/web-rewrite.ts 的旧写法是同一个 bug，现与它的
 * `SHIM_TAG_RE` 同构（见 scripts/verify-web.mjs host 侧判据、scripts/verify-sandbox.mjs §三）。
 *
 * 值仍不看：宿主自己注入时用 `data-we-shim="host"`，本文件用自己的 `data-we-shim-src` —— 只看
 * 「有没有一套已经装好的 shim」。旧写法认不出 `host` 这个值，同一文档会装两套 shim，rAF 节流
 * 叠加（实测 15fps 上限被限两次 → 7.5fps，用户观感「卡得不行」）。
 * 作者自己的无关脚本恰好带 `data-we-shim-src="1"` 是同一枚硬币的另一面：属性在场即声明「已有
 * shim」，**刻意保留**、不改行为。
 *
 * **注释不算在场**：判重前先 blankHtmlComments 剥掉 HTML 注释（注释内容浏览器不解析，作者把
 * 标记写进注释同样能让注入静默消失，且宿主侧没有任何诊断）。
 */
const SHIM_TAG_RE = /<script\b[^>]*\bdata-we-shim(?:-src)?\b[^>]*>[\s\S]*?<\/script\s*>/i;

/**
 * 判重与选点专用：把 HTML 注释整段**置空**（等长空格 ⇒ 索引仍与原串一一对应，切片一律用原串）。
 * 与 renderer/src/web-rewrite.ts 的 blankHtmlComments **逐条同构**（host/ 不得跨层 import，只能
 * 镜像）：注释里的 `<script data-we-shim…>` 不执行却能让判重命中 ⇒ 注入静默消失；注释里的
 * `<head>`/`<script>` 也不是真锚点。未闭合注释吞到末尾（`(?:-->|$)`，与浏览器解析一致），
 * `<!--[if IE]>…<![endif]-->` 条件注释整段置空。
 */
function blankHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => " ".repeat(m.length));
}

let cachedShim = null;

export function loadWebShimSource() {
  // 每次读盘：shim 热改后 /web/ HTML 立刻生效（缓存曾导致 2905017768 黑屏修了仍黑）
  cachedShim = readFileSync(shimPath(), "utf8");
  return cachedShim;
}

function escapeScriptClose(js) {
  return js.replace(/<\/script/gi, "<\\/script");
}

/**
 * @param {string} html
 * @param {{ shimSource?: string }} [opts]
 */
export function injectWebShim(html, opts = {}) {
  if (!html) html = "";
  // 注释置空视图：判重只看真实存在的 shim 元素（注释里的标记不算在场）。
  if (SHIM_TAG_RE.test(blankHtmlComments(html))) return html;
  const shimSource = opts.shimSource ?? loadWebShimSource();
  const script = `<script ${SHIM_ATTR}="1">\n${escapeScriptClose(shimSource)}\n</script>`;

  // 锚点在注释置空视图上找：注释里的 <head>/<script> 不是真锚点（注进注释区间会被浏览器吞掉，
  // 注到 `<!doctype>` 之前会触发怪异模式）。视图与原串**等长**，所以索引/长度可直接用于原串切片。
  const anchors = blankHtmlComments(html);
  const headOpen = /<head(\s[^>]*)?>/i.exec(anchors);
  // 作者可以在 <head> 之前放脚本（`<!doctype html><script>…</script><html><head>`）：解析器会
  // 把它提前进 head、排在 head 内容之前 ⇒ 它能先跑并把 `window.__weShimInstalled` 置上，我们的
  // shim 进来就整体 return（等于没注入，静默）。插入点取「<head> 之后」与「第一个 <script> 之前」
  // 中**更早**的那个（与 renderer/src/web-rewrite.ts 的插点规则同构）。
  const firstScript = /<script\b/i.exec(anchors);
  if (headOpen && firstScript && firstScript.index < headOpen.index) {
    return html.slice(0, firstScript.index) + script + html.slice(firstScript.index);
  }
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  const htmlOpen = /<html(\s[^>]*)?>/i.exec(anchors);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + `<head>${script}</head>` + html.slice(at);
  }
  return `<!DOCTYPE html><html><head>${script}</head><body>${html}</body></html>`;
}

export function isHtmlPath(filePath) {
  return /\.html?$/i.test(filePath);
}
