/**
 * 一次性实测探针：3264246690「适配完整显示」（contain）背景层拉伸变形修复前后对比。
 *
 * 非门禁，只产出两张 PNG（cover 基准 + contain 修复后）+ 一句话结论，方便肉眼/工具比对。
 * 依赖：本机 dev server 在跑（默认 1430）且挂了本地壁纸库（3264246690 在库）。
 *
 * 用法：
 *   node scripts/_probe-contain-fix-3264246690.mjs            # 输出两张 PNG 到 /tmp
 *   node scripts/_probe-contain-fix-3264246690.mjs --out DIR  # 指定输出目录
 */
import fs from "node:fs";
import path from "node:path";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const ITEM = "3264246690";
const ORIGIN = "http://localhost:1430";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const outIdx = process.argv.indexOf("--out");
const OUTDIR = outIdx >= 0 ? process.argv[outIdx + 1] : "/tmp";
fs.mkdirSync(OUTDIR, { recursive: true });

/**
 * 驱动：load 场景 → 等首帧静止（autoplay:false 确定性首帧）→ setFit('cover'|'contain') → 截图。
 * 两次运行之间只改 fit，其余全部一致，这样两张图的差异只可能来自 fit 变换本身。
 */
function driver(fit) {
  return `(async () => {
    const { createScene, httpSource } = await import("/renderer/src/api/index.ts");
    const ORIGIN = ${JSON.stringify(ORIGIN)};
    const diags = [];
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;left:0;top:0;width:1600px;height:900px;";
    document.body.appendChild(d);
    const s = createScene(d, {
      muted: true, mountTimeoutMs: 30000,
      onDiagnostic: (m, l) => diags.push(l + ": " + m),
    });
    const src = httpSource(ORIGIN + "/media/dev/${ITEM}");
    let err = null;
    try { await s.load(src, { autoplay: false }); } catch (e) { err = String(e && e.message).slice(0, 160); }
    s.setFit(${JSON.stringify(fit)});
    await new Promise((r) => setTimeout(r, 1200));
    const c = d.querySelector("canvas");
    return JSON.stringify({ err, canvas: c ? c.width + "x" + c.height : null, diags: diags.slice(0, 4) });
  })()`;
}

async function main() {
  const session = await launchHeadless({ url: "about:blank", task: "contain-fix-3264246690", width: 1600, height: 900 });
  const results = {};
  try {
    instrument(session);
    await session.assertGpu();
    await session.pageCdp.send("Page.navigate", { url: `${ORIGIN}/renderer/index.html?type=canvas` });
    await sleep(1200);
    for (const fit of ["cover", "contain"]) {
      const state = JSON.parse(await session.evaluate(driver(fit), { awaitPromise: true, timeoutMs: 60000 }));
      const png = await session.screenshot({ format: "png" });
      const file = path.join(OUTDIR, `contain-fix-${ITEM}-${fit}.png`);
      fs.writeFileSync(file, Buffer.from(png, "base64"));
      results[fit] = { ...state, file };
      console.log(`[${fit}]`, JSON.stringify(state), "→", file);
    }
  } finally {
    try { await session.close(); } catch { /* 忽略 */ }
  }
  console.log("\n结论：两张图应只差「窗口适配变换」本身（cover 裁切填满 vs contain 居中留边）；");
  console.log("人物（puppet）与背景层（大字/胶带/时钟）的纵横比在两张图里都应一致不变形。");
  console.log(JSON.stringify(results, null, 2));
}

await main();
