/**
 * 一次性实测探针：3264246690 人物 puppet 的「世界 origin/scale」到底是多少，
 * 以及「不传播父组 scale」的变体长什么样（用于与 preview.gif 对拍定分）。
 *
 * 非门禁。依赖本机 dev server（默认 1430）+ 本地壁纸库有 3264246690。
 *
 * 用法：
 *   node scripts/_probe-puppet-scale-3264246690.mjs --out DIR
 *   node scripts/_probe-puppet-scale-3264246690.mjs --out DIR --nopop   # 额外出「不传播」变体
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
const WITH_NOPOP = process.argv.includes("--nopop");

/** 场景挂载 + 层状态转储（cover，1600x900） */
const driverDump = `(async () => {
  const { createScene, httpSource } = await import("/renderer/src/api/index.ts");
  const d = document.createElement("div");
  d.style.cssText = "position:absolute;left:0;top:0;width:1600px;height:900px;";
  document.body.appendChild(d);
  const diags = [];
  const s = createScene(d, { muted: true, mountTimeoutMs: 30000, onDiagnostic: (m, l) => diags.push(l + ": " + m) });
  let err = null;
  try { await s.load(httpSource(${JSON.stringify(ORIGIN + "/media/dev/" + ITEM)}), { autoplay: false }); }
  catch (e) { err = String(e && e.message).slice(0, 200); }
  s.setFit("cover");
  await new Promise((r) => setTimeout(r, 800));
  const scene = window.__scene;
  const layers = (window.__sceneLayers || (scene && scene.layers) || []);
  const out = layers.map((l) => ({
    id: l.id, name: l.name, parent: l.parent ? l.parent.id : null,
    origin: l.origin, scale: l.scale, size: l.size,
    localOrigin: l.localOrigin, localScale: l.localScale,
    visible: l.visible, visibleSelf: l.visibleSelf,
    model: l.model ? (typeof l.model === "string" ? l.model : (l.model.puppet || l.model.image || JSON.stringify(Object.keys(l.model)).slice(0,120))) : null,
    image: l.image || null,
  }));
  window.__s = s;
  const c = d.querySelector("canvas");
  const keys = Object.keys(s).filter((k) => typeof s[k] === "function").slice(0, 80);
  let outline389 = null, outline47 = null, outline373 = null, outline377 = null;
  if (typeof s.getLayerOutline === "function") {
    try { outline389 = s.getLayerOutline(389); } catch (e) { outline389 = "err: " + e; }
    try { outline47 = s.getLayerOutline(47); } catch (e) { outline47 = "err: " + e; }
    try { outline373 = s.getLayerOutline(373); } catch (e) { outline373 = "err: " + e; }
    try { outline377 = s.getLayerOutline(377); } catch (e) { outline377 = "err: " + e; }
  }
  return JSON.stringify({ err, canvas: c ? c.width + "x" + c.height : null, layerCount: out.length, keys,
    outline: { "47": outline47, "373": outline373, "377": outline377, "389": outline389 }, layers: out });
})()`;

/**
 * 出「不传播父组 scale」变体：把无名组 373 的 scale 钉成 1，看子层 world 是否跟着变。
 * 子层 parent 已烘焙成 null，所以既不能按 parent.id 找，也不能只改子层字段
 * （脚本/更新在每帧的 rAF 里重算 world，改子层会被覆盖回传播形态）。
 */
const driverNoPop = `(async () => {
  const s = window.__s;
  const layers = window.__sceneLayers || window.__scene.layers;
  const byId = (id) => layers.find((l) => String(l.id) === String(id));
  const snap = () => [373, 377, 384, 389, 418].map(byId).filter(Boolean)
    .map((l) => ({ id: l.id, origin: l.origin.slice(), scale: l.scale.slice() }));
  const before = snap();
  // 把作者的 size 滑条 newproperty6 从 1.43 拨到 1.0 -> 组 scale=1 -> 子层只剩 localScale
  s.setProperties({ newproperty6: "1.0" });
  await new Promise((r) => setTimeout(r, 1200));
  const after = snap();
  return JSON.stringify({ props: s.getProperties ? s.getProperties() : null, before, after });
})()`;

async function main() {
  const session = await launchHeadless({ url: "about:blank", task: "puppet-scale-3264246690", width: 1600, height: 900 });
  try {
    instrument(session);
    await session.assertGpu();
    await session.pageCdp.send("Page.navigate", { url: `${ORIGIN}/renderer/index.html?type=canvas` });
    await sleep(1200);
    const dump = JSON.parse(await session.evaluate(driverDump, { awaitPromise: true, timeoutMs: 60000 }));
    fs.writeFileSync(path.join(OUTDIR, "puppet-layers.json"), JSON.stringify(dump, null, 2));
    console.log("[dump]", JSON.stringify({ err: dump.err, canvas: dump.canvas, layerCount: dump.layerCount }));
    for (const l of dump.layers) {
      if (["373", "377", "384", "389", "418"].includes(String(l.id))) {
        console.log("  layer", JSON.stringify(l));
      }
    }
    const png = await session.screenshot({ format: "png" });
    fs.writeFileSync(path.join(OUTDIR, "puppet-prop.png"), Buffer.from(png, "base64"));
    if (WITH_NOPOP) {
      const r = await session.evaluate(driverNoPop, { awaitPromise: true, timeoutMs: 60000 });
      fs.writeFileSync(path.join(OUTDIR, "nopop.json"), r);
      const png2 = await session.screenshot({ format: "png" });
      fs.writeFileSync(path.join(OUTDIR, "puppet-nopop.png"), Buffer.from(png2, "base64"));
      const parsed = JSON.parse(r);
      console.log("[nopop]", JSON.stringify({ np6: parsed.props && parsed.props.newproperty6, before: parsed.before, after: parsed.after }));
    }
  } finally {
    try { await session.close(); } catch { /* 忽略 */ }
  }
}

await main();
