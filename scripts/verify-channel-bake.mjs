#!/usr/bin/env node
/**
 * verify-channel-bake —— 「通道图烘焙子网格不上可见画布」的离线判据。
 *
 * 背景（3441873795 Kirby，用户报「右上角有一个裂开的主体」）：Kirby_puppet.mdl 的 mesh1 是
 * 官方 `puppettexturechannels` 的烘焙几何（两个 1:1 覆盖 226×175 通道图的四边形，停在模型
 * 右上角的「图集散开位」）。把它当普通网格画到画布上，就是屏幕上那两个缩小、被竖直硬边切开的
 * 角色碎片；官方桌面端同一位置是干净的。
 *
 * 本判据盯三件事：
 *   ① **判定逻辑**（纯函数 renderer/src/channel-bake.ts）：真命中 + 四类不许命中 ——
 *      假阳性会让真几何凭空消失，是本补丁最大的风险，所以反例比正例更重要；
 *   ② **接线**（源码级禁令，照 verify-groups 的写法）：宿主必须判、必须挂 layer.meshSkip、
 *      渲染侧必须透传、绘制循环必须按**原始下标 gi** 跳且在 drawElements 之前；
 *   ③ **真机语料**（本机壁纸库有 3441873795 时才跑，用 WE_LIBRARY 指库根）：模型必须被判成
 *      「mesh1 跳过、mesh0 照画」，且两个四边形宽度之和 == 通道图宽度 226、UV 在 96/226 处
 *      切开 —— 这条算术是补丁的物理依据，漂了说明模型或判据被改坏了。
 */
import fs from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, itemDir, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });

// ---- 纯函数：TS 现编一份（与 verify-bake 同套路）
const { build } = await import("esbuild");
const out = await build({
  entryPoints: [join(ROOT, "renderer/src/channel-bake.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
});
const tmp = join(ROOT, "scripts", `.tmp-channel-bake-${process.pid}.mjs`);
fs.writeFileSync(tmp, out.outputFiles[0].text);
let CB;
try {
  CB = await import(pathToFileURL(tmp).href);
} finally {
  fs.unlinkSync(tmp);
}

// ---- ① 判定逻辑
// 真机数字：mesh0 x∈[-647,646] y∈[-600.5,599.5]；mesh1 x∈[443,745] y∈[431,650]（8 顶点）
const BASE = { minX: -647, maxX: 646, minY: -600.5, maxY: 599.5 };
const PATCH = { minX: 443, maxX: 745, minY: 431, maxY: 650 };
const KIRBY = {
  meshCount: 2,
  shader: "puppettexturechannels",
  materialPath: "materials/Kirby_channelmap.json",
  texture0: "Kirby_channelmap",
  vertexCount: 8,
  selfBox: PATCH,
  baseBox: BASE,
};
check(CB.isChannelBakeSubMesh(KIRBY) === true, "3441873795 的 mesh1 必须判成通道图烘焙件");
check(
  CB.isChannelBakeSubMesh({ ...KIRBY, meshCount: 1 }) === false,
  "单子网格模型不许判（2D puppet 主材质本来就可能用 puppettexturechannels）",
);
check(
  CB.isChannelBakeSubMesh({ ...KIRBY, shader: "genericimage3", materialPath: "materials/Kirby.json", texture0: "Kirby" }) === false,
  "美术件（genericimage3 / 贴图 Kirby）不许判",
);
check(
  CB.isChannelBakeSubMesh({ ...KIRBY, materialPath: "materials/foo.json", texture0: "foo" }) === true,
  "没有 channelmap 命名但几何停在散开位（8 顶点、越出 mesh0 盒）应兜底命中",
);
check(
  CB.isChannelBakeSubMesh({
    ...KIRBY,
    materialPath: "materials/foo.json",
    texture0: "foo",
    selfBox: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
  }) === false,
  "没有 channelmap 命名、几何又完全在 mesh0 盒内 ⇒ 必须放行（防假阳性）",
);
check(
  CB.isChannelBakeSubMesh({ ...KIRBY, materialPath: "materials/foo.json", texture0: "foo", vertexCount: 512 }) === false,
  "没有 channelmap 命名且顶点数是整块网格的量级 ⇒ 不兜底（防假阳性）",
);
check(CB.escapesBox(PATCH, BASE) === true, "escapesBox：散开位的两个四边形必须算出越界");
check(CB.escapesBox(BASE, BASE) === false, "escapesBox：盒内几何不许算出越界");
check(CB.boxOfVertices(new Float32Array([1, 2, 0, -3, 5, 0])) !== null, "boxOfVertices：正常顶点要出盒");
check(CB.boxOfVertices(null) === null && CB.boxOfVertices(new Float32Array([])) === null, "boxOfVertices：空数据返回 null 而不是崩");

// ---- ② 源码级接线（**四条，缺一条判定就在实机上从未生效** —— 本判据第一版只盯着
//      renderer.js/mdl.js 两侧，结果 3441873795 的两个漏洞全从缝里漏过去了，见下）
const sm = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
const rd = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
const mdlSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8");

// ① 判定必须落在**2D 木偶分支**（layer.image + model.puppet）：3441873795 的 Kirby 走的就是
//    这条；只给 3D 模型分支（layer.model）判会静默失效 —— 实测页面里 layer.meshSkip === null，
//    碎片照画（第一版翻车就翻在这里）。
const a2dStart = sm.indexOf("if (!model.puppet) continue;");
const a2dEnd = sm.indexOf("mdlItems.push({ mdl: mdlObj, tex: texObj, layer });", a2dStart);
const branch2d = a2dStart >= 0 && a2dEnd > a2dStart ? sm.slice(a2dStart, a2dEnd) : "";
check(a2dStart >= 0, "找不到 2D 木偶分支的锚点（if (!model.puppet) continue;）—— 结构变了，判据要跟着改");
check(/await\s+channelBakeSkipFlags\(/.test(branch2d), "2D 木偶分支必须调用 channelBakeSkipFlags 判定");
check(/\(layer as any\)\.meshSkip\s*=/.test(branch2d), "2D 木偶分支必须把标记挂到 layer.meshSkip 上");
// 负对照：把调用改个名，同一条判据必须报红（判据有牙）
check(/await\s+channelBakeSkipFlags\(/.test(branch2d.replace("await channelBakeSkipFlags(", "await xChannelBakeSkipFlags(")) === false,
  "负对照：2D 分支不判时会被同一条判据判出");

// ② 3D 模型分支也得判（两条分支共用同一个判定函数，不许只留一条）
check(/isChannelBakeSubMesh\(/.test(sm), "3D 模型分支必须调用 isChannelBakeSubMesh 判定");

// ③ **转发断点**（这是第一版翻车的第二个洞）：renderer 那侧的 opts 只是「提议」，
//    真正调 mdlRenderer.draw 的是 setPuppetRenderer 注入的回调，它**按字段挑着转发** ——
//    漏一行就等于判定在实机上从未生效（同仓库 F49 天空盒护栏踩过同一个坑）。
const cbAt = sm.indexOf("renderer.setPuppetRenderer(");
const drawAt = sm.indexOf("mdlRenderer.draw(", cbAt);
// ⚠️ 区域必须**越过** mdlRenderer.draw( 往后延伸：要转发的那几个字段就写在它的 opts 实参里，
// 截到 draw( 之前等于什么也检查不到（判据自己踩过一次）。
const cbRegion = cbAt >= 0 && drawAt > cbAt ? sm.slice(cbAt, drawAt + 6000) : "";
check(cbAt >= 0 && drawAt > cbAt, "找不到 setPuppetRenderer 回调 / mdlRenderer.draw 的锚点 —— 结构变了，判据要跟着改");
check(/meshSkip:\s*\(layer as any\)\.meshSkip/.test(cbRegion), "setPuppetRenderer 回调必须把 meshSkip 转发给 mdlRenderer.draw（漏这一行 = 判定在实机上从未生效）");
check(/meshSkip:\s*\(layer as any\)\.meshSkip/.test(cbRegion.replace(/meshSkip:\s*\(layer as any\)\.meshSkip[^\n]*\n/, "")) === false,
  "负对照：删掉转发行后判据有牙");

// ④ 渲染侧 → 引擎的两跳
check(/meshSkip:\s*layer\.meshSkip/.test(rd), "renderer.js 必须把 layer.meshSkip 透传给 puppetDrawFn");
const skipAt = mdlSrc.indexOf("opts.meshSkip[gi]");
const drawCallAt = mdlSrc.indexOf("gl.drawElements(gl.TRIANGLES, mesh.indexCount");
check(skipAt > 0, "绘制循环必须按 opts.meshSkip[gi] 跳过（gi = 原始子网格下标，用重排后的 k 会跳错网格）");
check(skipAt > 0 && drawCallAt > 0 && skipAt < drawCallAt, "跳过必须发生在 drawElements 之前");

// ---- ③ 真机语料（可选）
const pkgPath = join(itemDir("3441873795"), "scene.pkg");
if (!existsSync(pkgPath)) {
  console.log(`  · 跳过真机语料（未找到 ${pkgPath}；设 WE_LIBRARY 指向壁纸库根即可启用）`);
} else {
  const { parsePkg, getEntry } = await import(
    pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/container.js")).href
  );
  const { parseMDL } = await import(
    pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/mdl-parse.js")).href
  );
  const { parseTex, decodeMip0 } = await import(
    pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/texture.js")).href
  );
  const bytes = new Uint8Array(fs.readFileSync(pkgPath));
  const pkg = parsePkg(bytes);
  const mdlBuf = getEntry(pkg, "models/Kirby_puppet.mdl");
  check(!!mdlBuf, "真机语料：scene.pkg 里必须有 models/Kirby_puppet.mdl");
  if (mdlBuf) {
    const mdl = parseMDL(mdlBuf.slice());
    check(mdl.meshes && mdl.meshes.length === 2, `真机语料：Kirby 必须是 2 个子网格（实得 ${mdl.meshes?.length}）`);
    const boxOf = (m) => CB.boxOfVertices(m.positions);
    const base = boxOf(mdl.meshes[0]);
    // 关键：按**每个子网格自己的材质**喂判据（宿主就是这么做的；给 mesh0 硬塞烘焙件材质
    // 会造出一个现实中不存在的假阳性，本判据第一版就这么错过一次）。
    const matArgs = (i) => {
      const raw = getEntry(pkg, mdl.meshes[i].materialPath);
      if (!raw) return { shader: null, materialPath: mdl.meshes[i].materialPath, texture0: null };
      const doc = JSON.parse(new TextDecoder().decode(raw));
      const pass0 = doc?.passes?.[0];
      return {
        shader: pass0?.shader ?? null,
        materialPath: mdl.meshes[i].materialPath,
        texture0: Array.isArray(pass0?.textures) ? pass0.textures[0] : null,
      };
    };
    const a0 = matArgs(0);
    const a1 = matArgs(1);
    check(a0.shader === "genericimage3", `真机语料：mesh0 的 shader 必须是 genericimage3（实得 ${a0.shader}）`);
    check(a1.shader === "puppettexturechannels", `真机语料：mesh1 的 shader 必须是 puppettexturechannels（实得 ${a1.shader}）`);
    const skipOf = (i, a) =>
      CB.isChannelBakeSubMesh({
        meshCount: mdl.meshes.length,
        shader: a.shader,
        materialPath: a.materialPath,
        texture0: a.texture0,
        vertexCount: mdl.meshes[i].vertexCount,
        selfBox: boxOf(mdl.meshes[i]),
        baseBox: base,
      });
    check(skipOf(1, a1) === true, "真机语料：mesh1 必须判成跳过");
    check(skipOf(0, a0) === false, "真机语料：mesh0（美术件，genericimage3）不许被跳过");
    const cmTex = getEntry(pkg, "materials/Kirby_channelmap.tex");
    if (cmTex) {
      const tex = parseTex(cmTex.slice(), { name: "Kirby_channelmap.tex" });
      const m0 = decodeMip0(tex);
      // 两个四边形的宽度：mesh1 顶点 0..3 与 4..7 各是一个四边形
      const p = mdl.meshes[1].positions;
      const quads = [0, 4].map((o) => Math.max(p[o * 3], p[o * 3 + 3]) - Math.min(p[o * 3], p[o * 3 + 3]));
      check(m0.width === 226 && m0.height === 175, `真机语料：通道图必须是 226×175（实得 ${m0.width}×${m0.height}）`);
      check(quads[0] + quads[1] === m0.width, `真机语料：两个四边形宽度之和必须等于通道图宽度（${quads[0]}+${quads[1]} vs ${m0.width}）`);
      const uSplit = mdl.meshes[1].uvs[2];
      check(
        Math.abs(uSplit - quads[0] / m0.width) < 1e-3,
        `真机语料：UV 分割点必须落在 ${quads[0]}/${m0.width}（实得 ${uSplit.toFixed(4)}）`,
      );
    } else {
      check(false, "真机语料：scene.pkg 里缺少 materials/Kirby_channelmap.tex");
    }
  }
}

console.log(errors.length === 0 ? "\nverify-channel-bake: 全部通过 ✓" : `\nverify-channel-bake: ${errors.length} 项失败 ✗`);
process.exit(errors.length === 0 ? 0 : 1);