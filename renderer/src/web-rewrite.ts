/**
 * 网页壁纸 HTML 改写：在作者脚本之前插入 WE shim + <base>。
 * 纯字符串操作，Node 可测（verify-web）。
 */

/**
 * shim 已在 HTML 里的判据：必须是**真正的 `<script …>` 元素**（开标签带属性 + 闭合标签），
 * 不是「整篇文档里出现过这个属性名」。
 *
 * 为什么不能用存在性匹配：属性名是**素材可控字符串** —— 注释、`<meta content>`、无关标签的
 * 属性、内联 JSON，甚至作者脚本正文里的一句 `document.querySelector('[data-we-shim]')`
 * 都会命中，命中即**不注入**。注入失败是静默的：shim 是 rAF 节流、指针桥、音频泵、种子
 * 脚本的载体，少了它只是「帧率不设限、指针/音频不响应」，宿主侧没有任何报错。
 * 旧写法（`/\bdata-we-shim(?:-src)?\b/i`）实测三类合成样本全部被短路，见
 * scripts/verify-sandbox.mjs 的 §三（那三条样本现在是必须注入的红线）。
 *
 * 值仍不看：宿主自己注入时用 `data-we-shim="host"`，本文件自己的是 `data-we-shim-src` ——
 * 只看「有没有一套已经装好的 shim」。早期这里写死 `data-we-shim="1"`（本文件自己的注入值），
 * 宿主注 `host` 时匹配不上就会再注一遍，同一文档两套 shim，rAF 节流、指针桥、音频泵全部
 * 叠加（实测 15fps 上限被限两次 → 7.5fps，用户观感「卡得不行」）。
 *
 * 已知边界（记在 docs/COMPLIANCE.md §四）：素材仍可显式写一个带该属性的 `<script>` 元素来
 * 拒绝注入 —— 而那正是 dsh-wallpaper-engine 的 `/scene-files` 互操作契约本身（宿主注
 * `data-we-shim="host"`），要取消它得先改宿主契约与 scripts/verify-web.mjs 的宿主用例。
 * 「作者自己的无关脚本恰好带 `data-we-shim-src="1"`」是**同一枚硬币的另一面**：属性在场即
 * 声明「已有 shim」，刻意保留，不改行为（见 scripts/verify-web.mjs 的 host 侧同构判据）。
 *
 * **注释不算在场**：判重前必须先把 HTML 注释剥掉（见 blankHtmlComments）—— 注释内容浏览器
 * 不解析，作者把标记写进注释同样能让注入静默消失。
 */
const SHIM_TAG_RE = /<script\b[^>]*\bdata-we-shim(?:-src)?\b[^>]*>[\s\S]*?<\/script\s*>/i;
const SHIM_ATTR = "data-we-shim-src";

/**
 * 判重与选点专用：把 HTML 注释整段**置空**（用等长空格，索引仍与原串一一对应，切片一律用原串）。
 *
 * 为什么判重前必须剥注释：注释内容浏览器**不解析、不执行**，但 shim 标记是素材可控字符串 ——
 * 作者只要写 `<!-- <script data-we-shim-src="1"></script> -->`，`SHIM_TAG_RE` 就会命中，
 * 于是我们**不注入**：rAF 节流、指针桥、音频泵、种子脚本全丢，宿主侧没有任何诊断
 * （M7 §2.3 第 4 条「注入不可被素材短路」正是要禁掉这个形态）。
 *
 * 选点也用同一张视图：注释里的 `<head>` / `<script>` 不是真锚点 —— 把 shim 注进注释区间会被
 * 浏览器一起吞掉；注释里的 `<script>` 还会把插入点提到 `<!doctype>` 之前，触发怪异模式。
 *
 * 未闭合注释按「吞到文档末尾」处理（`(?:-->|$)`，与浏览器解析一致）；`<!--[if IE]>…<![endif]-->`
 * 条件注释整段置空（现代引擎本来就不执行其中的脚本）。
 *
 * 与 host/we-web-html.mjs 的同名函数**逐条同构**（host/ 不得跨层 import，只能镜像）。
 */
function blankHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => " ".repeat(m.length));
}

/** 作者自带的 <base> 标签（改写判断用）。 */
const BASE_TAG_RE = /<base\b[^>]*>/gi;

/** 取 <base> 的 href；没有 href 属性返回 null（只带 target 的 base 不设基准 URL）。 */
function baseHrefOf(tag: string): string | null {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim();
}

/**
 * 作者写的 <base href> 能不能直接在 **blob 挂载**的文档里用。
 *
 * 只有**绝对 URL** 能：http(s) / data / blob / 协议相对 `//` 与文档地址无关，作者
 * 多半真的把资源放在别处（CDN），覆盖它反而会打断。`file:` 与各种相对写法
 * （`./`、`/`、`../`、`sub/`）都不行 —— blob 文档没有目录概念，它们会解析到 blob 自己。
 */
function baseHrefWorksInBlob(href: string): boolean {
  if (/^file:/i.test(href)) return false;
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
}

/** 从入口 URL 推出目录（含末尾 /），供 <base href> */
export function entryDirUrl(entryUrl: string): string {
  try {
    const u = new URL(entryUrl);
    const path = u.pathname;
    const i = path.lastIndexOf("/");
    u.pathname = i < 0 ? "/" : path.slice(0, i + 1);
    u.hash = "";
    u.search = "";
    return u.href;
  } catch {
    const s = entryUrl.replace(/[#?].*$/, "");
    const i = s.lastIndexOf("/");
    return i < 0 ? s : s.slice(0, i + 1);
  }
}

/**
 * 是否已含会挡住 inline shim 的 CSP（script-src 无 unsafe-inline）。
 * 工坊网页壁纸几乎没有 CSP；命中则调用方应走诊断并退回裸 src。
 */
export function hasBlockingCsp(html: string): boolean {
  const re = /<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const content =
      /content\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ??
      /content\s*=\s*'([^']*)'/i.exec(tag)?.[1] ??
      "";
    if (!/script-src/i.test(content)) continue;
    if (/script-src[^;]*'unsafe-inline'/i.test(content)) continue;
    if (/script-src[^;]*\*/i.test(content)) continue;
    return true;
  }
  return false;
}

function escapeScriptClose(js: string): string {
  // 防止 shim 源码里的 </script> 提前结束宿主 script 标签
  return js.replace(/<\/script/gi, "<\\/script");
}

/**
 * 把 shim 源码与可选 <base> / 种子脚本插入 HTML。
 *
 * **已经注入过 shim 时不重复注入**（宿主可能自带 shim，见 SHIM_MARK_RE），
 * 但 **`<base>` 仍然照补**：跨源入口是经 blob URL 挂载的，blob 没有目录概念，
 * 相对路径全靠这个 <base> 解析（早期版本在这里"原样返回"，一旦宿主自己注入过，
 * 相对子资源就会全部 404）。
 *
 * `<base>` 与作者自带的 base 的冲突按**能不能在 blob 文档里用**来判（见
 * baseHrefWorksInBlob）：作者写绝对 URL 时不动它，写相对值时**就地改写**为入口目录 ——
 * 早期这里是「已有 base 就直接跳过注入」，于是自带 `<base href="./">` 的壁纸整页白屏。
 *
 * `seedScript`：紧跟 shim 的 classic script 正文（如 `__weSeedProps(...)`），
 * 在作者脚本之前执行，解决「父页 load 后再灌属性已晚」的时序。
 */
export function rewriteHtml(
  html: string,
  shimSource: string,
  opts: { baseHref?: string; seedScript?: string },
): string {
  if (!html) html = "";
  let out = html;
  // 注释置空视图：判重只看真实存在的 shim 元素（注释里的标记不算在场）。
  const injected = SHIM_TAG_RE.test(blankHtmlComments(out));

  // <base>：跨源入口经 blob URL 挂载，blob 没有目录概念，相对路径全靠它解析。
  // 作者自带的 base 分两类（实测，2026-09-25）：
  //   · 绝对 URL → 留着；
  //   · 相对（`./` / `/` / `../`）→ **必须就地改写**：SPA/Angular 构建常自带
  //     `<base href="./">`（CRA 不带），blob 文档里 `.` 解析到 blob 自己 ⇒ 相对子资源
  //     一个请求都发不出 ⇒ 整页白屏。合成夹具 A/B 实测：同一份 HTML 去掉 base 时
  //     app.js 正常执行并回传信标，加回 `<base href="./">` 后脚本完全不加载；而媒体源
  //     对同一路径实测 200 —— 不是服务端问题。
  //   浏览器只认**第一个带 href 的** base，所以找到它就结束（只带 target 的 base 跳过）。
  const baseTag = opts.baseHref ? `<base href="${opts.baseHref.replace(/"/g, "&quot;")}">` : "";
  let basePlaced = false;
  if (baseTag) {
    BASE_TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BASE_TAG_RE.exec(out))) {
      const href = baseHrefOf(m[0]);
      if (href === null) continue;
      if (baseHrefWorksInBlob(href)) {
        basePlaced = true; // 作者的绝对 base 有效，不动
      } else {
        out = out.slice(0, m.index) + baseTag + out.slice(m.index + m[0].length);
        basePlaced = true; // 就地改写，不再往 head 里塞第二个
      }
      break;
    }
  }
  const base = baseTag && !basePlaced ? baseTag : "";
  const script = injected
    ? ""
    : `<script ${SHIM_ATTR}="1">\n${escapeScriptClose(shimSource)}\n</script>`;
  const seed =
    injected || !opts.seedScript || !opts.seedScript.trim()
      ? ""
      : `<script>\n${escapeScriptClose(opts.seedScript)}\n</script>`;
  const inject = `${base}${script}${seed}`;
  if (!inject) return out;

  // 优先插进 <head> 最前（任何作者 script 之前）。
  //
  // 但**作者可以在 <head> 之前放脚本**（`<!doctype html><script>…</script><html><head>`）：
  // 解析器会把它提前进 head、排在 head 内容之前 ⇒ 它能先跑并把 `window.__weShimInstalled`
  // 置上，我们的 shim 进来就整体 `return`（等于没注入，静默）。所以插入点取
  // 「<head> 开标签之后」与「第一个 <script 之前」中**更早**的那个。
  //
  // 锚点也在注释置空视图上找：注释里的 <head>/<script> 不是真锚点（注进注释区间会被吞掉，
  // 注到 `<!doctype>` 之前会触发怪异模式）。锚点命中串来自视图、切片仍用原串 —— 视图与原串
  // 等长，索引与长度都一一对应（base 改写可能改过长度，所以在改完之后重算视图）。
  const anchors = blankHtmlComments(out);
  const headOpen = /<head(\s[^>]*)?>/i.exec(anchors);
  const firstScript = /<script\b/i.exec(anchors);
  if (headOpen && firstScript && firstScript.index < headOpen.index) {
    return out.slice(0, firstScript.index) + inject + out.slice(firstScript.index);
  }
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return out.slice(0, at) + inject + out.slice(at);
  }

  // 无 head：在 <html> 后造一个 head
  const htmlOpen = /<html(\s[^>]*)?>/i.exec(anchors);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return out.slice(0, at) + `<head>${inject}</head>` + out.slice(at);
  }

  // 残缺 HTML：整段前缀
  return `<!DOCTYPE html><html><head>${inject}</head><body>${out}</body></html>`;
}
