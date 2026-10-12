#!/usr/bin/env node
/**
 * verify-blink —— 眨眼 = **每骨不透明度包络**，不是零件级启发式。
 *
 * 背景（本仓反复复发的那条缺陷）：官方 WE 让「眼球 / 虹膜 / 睫毛」在闭眼时消失，
 * 靠的是 MDLA 的 blend_curves（每骨一条 0..1 包络，mdla>=3 每条动画都带）：
 *
 *   官方 assets/shaders/genericimage4.vert（SKINNING_ALPHA combo）
 *     uniform float g_BonesAlpha[BONECOUNT];
 *     v_VertexAlpha *= saturate(g_BonesAlpha[a_BlendIndices.x]*a_BlendWeights.x + .y*.y + …);
 *   assets/shaders/genericimage4.frag:194        color.a *= v_VertexAlpha;
 *   Wallpaper/Compiler/ModelCompiler.cpp:1329-1347  hasAlphaCurves() → WE_CB_SKINNING_ALPHA
 *   Wallpaper/Compiler/PuppetRig.cpp:11-30/:298-305 alpha 乘算（逐层 clamp(1+w*(c-1),0,1)）
 *
 * 2026-09-28 ~ 2026-10-07 本仓没有这条通道，改用 `collapsedPartSquash`：按「零件本帧包围盒
 * 高度比 + 静止尺度 + 同骨组」猜哪些零件该跟着淡出，阈值随语料漂移 —— 每换一批人物壁纸
 * 就要重调一遍，正是「人物眨眼错误多次出现」的根源。2026-10-12 起该启发式整体删除，
 * 改为逐位实现官方通道（mdl.js 顶点/片元着色器 + mdl-skin.js 的 computeBoneAlphas）。
 *
 * 判据分三层：
 *   A. 源码锁：启发式必须**不存在**（重新引入即红），alpha 通道必须完整存在；
 *   B. 解析锁：全库语料里每条 blend_curve 的样本数 == frameCount+1、取值 ∈ [0,1]；
 *   C. 行为锁：带曲线的那些 puppet 必须能算出「某骨 alpha → 0」（作者写的闭眼），
 *      不帶曲线的必须恒为 null（不许再有引擎猜出来的淡出）；
 *      以及 LayerBoneAlpha 的 blend 语义（blend=1 → 0，blend=0.5 → 0.5）。
 */
import fs from "node:fs";
import { join } from "node:path";
import { ROOT, LIB, imp, createChecker, dec } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker();
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
const { parseMDL, computeBoneAlphas } = await imp("renderer/vendor/we-scene/render/mdl.js");

// ---------------------------------------------------------------- A. 源码锁
const mdlSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8");
const skinSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl-skin.js"), "utf8");
const parseSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl-parse.js"), "utf8");

/** 去掉注释后再查「死名字」：墓志注里可以写它删掉了什么，但活代码里不许再有。
 *  **必须先剥行注释再剥块注释**：本仓注释里会出现形如 models/editor 加通配的路径
 *  片段，那个斜杠加星号会被块注释正则当成注释起点，一路吞到下一个星号加斜杠
 *  （mdl.js 里实测吞掉 2174 字节，把伪网格的 parts 透传行一起删了，检查假红）。 */
const stripComments = (s) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
const mdlCode = stripComments(mdlSrc);
const skinCode = stripComments(skinSrc);
for (const dead of [
  "collapsedPartSquash",
  "shouldSyncCoveredParts",
  "hasDeepPartCollapse",
  "PART_SQUASH",
  "u_partScale",
  "u_partPivot",
  "syncCoveredParts",
]) {
  check(!mdlCode.includes(dead), `零件级压扁启发式不得复活：mdl.js 活代码里不应再出现 ${dead}`);
}
check(!skinCode.includes("collapsedPartSquash"), "mdl-skin.js 活代码不应再引用 collapsedPartSquash");

const vertStart = mdlSrc.indexOf("const mdlVertSrc");
const fragStart = mdlSrc.indexOf("const MDL_FRAG");
const vert = vertStart >= 0 && fragStart > vertStart ? mdlSrc.slice(vertStart, fragStart) : "";
const frag = fragStart >= 0 ? mdlSrc.slice(fragStart, fragStart + 9000) : "";
check(/uniform float u_boneAlpha\[/.test(vert), "顶点着色器声明 uniform float u_boneAlpha[maxBones]（官方 g_BonesAlpha[]）");
check(/uniform float u_alphaOn;/.test(vert), "顶点着色器声明 uniform float u_alphaOn（本帧是否走 alpha 通道）");
check(/out float v_alpha;/.test(vert), "顶点着色器输出 v_alpha（官方 v_VertexAlpha）");
check(/acc \+= u_boneAlpha\[bi\] \* w;/.test(vert), "顶点 alpha = Σ 骨 alpha × 权重（官方 genericimage4.vert:170-173 的权重和）");
check(/va = clamp\(acc, 0\.0, 1\.0\);/.test(vert), "顶点 alpha 取 saturate");
check(/if \(u_alphaOn > 0\.5 && u_boneCount > 0\)/.test(vert), "非蒙皮网格不进 alpha 分支（u_boneCount=0 时恒 1.0）");
check(/in float v_alpha;/.test(frag), "片元着色器接收 v_alpha");
check(/if \(t\.a \* u_color\.a \* v_alpha < 0\.004\) discard;/.test(frag), "全透明判据含 v_alpha（淡出的零件不写深度）");
check(/fragColor = t \* u_color \* vec4\(mul, v_alpha\);/.test(frag), "片元 color.a *= v_alpha（官方 genericimage4.frag:194）");

const drawStart = mdlSrc.indexOf("draw(mvp, mdl, opts, texture) {");
const drawEnd = mdlSrc.indexOf("gl.bindVertexArray(null)", drawStart);
const draw = drawStart >= 0 && drawEnd > drawStart ? mdlSrc.slice(drawStart, drawEnd) : "";
check(draw.length > 0, "找得到 draw() 体");
check(/const ba = count > 0 \? computeBoneAlphas\(mdl, opts\.time \|\| 0, opts\.animLayers\) : null/.test(draw),
  "draw 每帧按当前时间算每骨 alpha");
check(/gl\.uniform1fv\(uni\.boneAlpha, ba\.subarray\(0, count\)\)/.test(draw), "alpha 数组按骨数上传");
check(/gl\.uniform1f\(uni\.alphaOn, 1\)/.test(draw), "有曲线时打开 alpha 通道");
check(/gl\.uniform1f\(uni\.alphaOn, 0\)/.test(draw), "无曲线时**必须显式关闭**（GL 默认值 0，不能依赖）");
check(/gl\.drawElements\(gl\.TRIANGLES, mesh\.indexCount, idxType, 0\)/.test(draw), "整张网格一次画完（不再按零件拆 draw）");

check(/export function computeBoneAlphas\(mdl, time, animLayers\)/.test(skinSrc), "mdl-skin.js 导出 computeBoneAlphas");
check(/let a = 1 \+ w \* \(v - 1\)/.test(skinSrc), "alpha 逐层公式 = clamp(1 + w*(curve-1), 0, 1)（PuppetRig.cpp LayerBoneAlpha）");
check(/out\[i\] \*= a/.test(skinSrc), "多条可见层之间**相乘**（官方 m_final_alphas 累积）");
check(/const fr = frameIndices\(L\.anim, t, c\.length\)/.test(skinSrc), "曲线与轨道共用 frameIndices（官方共用一个 interp_info）");
check(/const w = Math\.min\(Math\.max\(typeof L\.blend === 'number' \? L\.blend : 1, 0\), 1\)/.test(skinSrc),
  "alpha 用的是**图层 blend**（官方 layer.anim_layer.blend），clamp 到 [0,1]");
check(/if \(!mdl\.hasAlphaCurves \|\| !anims \|\| !anims\.length\) return null;?/.test(skinSrc),
  "hasAlphaCurves=false 直接返回 null（等于官方不给材质开 SKINNING_ALPHA combo）");

check(/function parseAnimBoneCurves\(/.test(parseSrc), "mdl-parse.js 解析 blend_curves 块（ParseAnimBoneCurves）");
check(/function parseAnimTail\(/.test(parseSrc), "mdl-parse.js 按官方字段序走完每条动画尾部（trans / 曲线 / aabb / scalar / 事件）");
check(/hasAlphaCurves/.test(parseSrc), "parseMDL 产出 mdl.hasAlphaCurves（任一曲线值 < 1-1e-4）");
check(/parseAnimEventsExact/.test(parseSrc), "事件表按 event_count 精确读取（不再靠 '{' 锚扫）");

// ── 第二机制：MDL 掩码块 = Puppet Warp Clipping Mask（官方 clippingmaskimage4） ──
// 这是「闭眼时虹膜消失」的真正按钮：作者把虹膜/高光件列进 a、把眼睑件列进 b，掩码图
// 只盖住 b 件所在 UV；b 件把掩码铺成屏幕空间覆盖，a 件只在被覆盖处可见。3629379075
// （若叶睦 眼睛部件）就是这一条 —— 它的动画里**没有任何 blend_curves**，旧启发式靠
// 「按包围盒猜着压/删」伪造效果，所以缺陷反复复发。判据见 docs/CASEBOOK.md 的掩码章。
check(/uniform sampler2D u_maskTex;/.test(frag), "片元着色器声明掩码贴图 uniform（官方 g_Texture1）");
check(/uniform float u_maskOn;/.test(frag) && /uniform float u_maskWrite;/.test(frag) && /uniform vec2 u_viewport;/.test(frag),
  "片元着色器声明 u_maskOn / u_maskWrite / u_viewport");
check(/float am = mix\(al \* al \* al \* al, al, mtex\);/.test(frag) || /mix\(al\*al\*al\*al, al, mtex\)/.test(frag),
  "掩码写入趟：mix(pow(albedoAlpha,4), albedoAlpha, mask)（官方 clippingmaskimage4.frag 原文）");
check(/fragColor\.a \*= texture\(u_maskTex, gl_FragCoord\.xy \/ u_viewport\)\.r;/.test(frag),
  "裁剪趟：屏幕坐标采样掩码缓冲乘进片元 alpha");
check(/const mblocks = partsTable && mdl\.maskBlocks && mdl\.maskBlocks\.length > 0/.test(draw),
  "draw() 只对真有掩码块的模型走逐零件路径");
check(/blendEquation\(gl\.MAX\)/.test(draw), "掩码写入趟用 MAX 混合累积覆盖率（并集）");
check(/blendEquation\(gl\.FUNC_ADD\)/.test(draw), "掩码趟结束后必须复位 blendEquation(FUNC_ADD)（否则后续图层全被 MAX 掉）");
check(/partIdsA\.indexOf\(pi\) >= 0/.test(draw), "按零件下标查 a 列决定是否裁掉该零件（a/b 是 parts[] 下标，不是 part.id）");
check(/gl\.drawElements\(gl\.TRIANGLES, p\.size, idxType, p\.start \* iw\)/.test(draw),
  "逐零件 drawElements（官方每个 part 一次 DrawIndexed，索引单位偏移 start*iw）");
// ★趟次（2026-10-12 出帧定案）：被掩码裁剪的零件必须**单独一趟画在未被裁剪的几何之后**。
// 官方引擎为掩码生成独立子网格（`GenMaskSubmeshFromMdl`，ModelCompiler.cpp:1313），被裁剪件
// 与基础网格分开绘制，因此能盖住（而不是被盖住）眼睑/睫毛。3629379075 的虹膜件在 parts[] 里
// 排在睫毛件之前，按文件顺序混在一趟画 ⇒ 虹膜被整条盖掉（干净睫毛线）；官方 f54 却是
// 「闭眼 + 一条琥珀残带 + 白色高光点」。改趟次后与官方同形，且 3671936032/3808922316
// 的眼区逐像素误差不变或略降（5.4/5.4、24.7→24.0）。
check(/const blkOf = \(pi\) =>/.test(draw) && /const drawPart = \(pi\) =>/.test(draw),
  "逐零件绘制必须抽成 blkOf/drawPart，才能按「是否被裁剪」分两趟");
check(/for \(let pi = 0; pi < partsTable\.length; pi\+\+\) if \(!blkOf\(pi\)\) drawPart\(pi\)/.test(draw) &&
  /for \(let pi = 0; pi < partsTable\.length; pi\+\+\) if \(blkOf\(pi\)\) drawPart\(pi\)/.test(draw),
  "被裁剪件（a 列）必须单独一趟、画在未被裁剪的几何之后（官方独立掩码子网格的趟次语义）");
check(/parts: mdl\.parts \|\| singleSub\?\.parts \|\| null/.test(mdlCode),
  "伪网格（meshes.length === 1）也必须透传 parts，否则掩码分支永不触发");
check(/maskBlocks/.test(parseSrc) && /partIdsA/.test(parseSrc) && /partIdsB/.test(parseSrc) && /matPath/.test(parseSrc),
  "mdl-parse.js 解析掩码块并产出 maskBlocks[{leadingA,matPath,partIdsA,partIdsB}]");
const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
check(/maskTextures: \(layer as any\)\.maskTextures \|\| null/.test(mountSrc),
  "宿主把 maskTextures 透传给 mdlRenderer.draw（漏转发等于这条通道在实机上从未生效）");
// ★掩码像素级取证（2026-10-12，靠逐步 getError + readPixels 才挖到）暴露的三个「静默失效」
// 断点，每个都让这条通道在实机上变成空操作，而画面上只会表现为「眨眼还是老样子」：
// ① 宿主有两处模型装载（puppet 路径 与 网格/材质路径），只接一处 ⇒ 另一处的层没有
//    maskTextures（实测全部 WE 标准 puppet 都走 puppet 路径）；② 掩码贴图是**包装对象**
//    （原始 GL 纹理在 `.glTex`），漏拆包直接抛 bindTexture；③ 在 draw() 里新建纹理会把
//    它留在**当前活动单元**（TEXTURE0），一旦它同时是当前 FBO 的颜色附件就构成纹理反馈
//    环 ⇒ 掩码写入趟每次 drawElements 只回报 GL_INVALID_OPERATION(1282) 且零片元写入。
check(/const wireMaskTextures = async \(layer: any, mdlObj: any\)/.test(mountSrc),
  "宿主必须把掩码贴图接线抽成一个函数（两处装载共用一份实现）");
{
  const calls = (mountSrc.match(/await wireMaskTextures\(layer, mdlObj\)/g) || []).length;
  check(calls >= 2,
    `掩码贴图接线必须在**两处**模型装载路径都调用（实测 ${calls} 处）；只接一处时另一条路径上的掩码静默失效`);
}
check(/const maskImg = \(mm0 && mm0\.glTex \? mm0\.glTex : mm0\)/.test(draw),
  "掩码贴图必须按包装对象拆包（`.glTex`，与 meshTextures 同一约定），否则 bindTexture 抛异常");
check(/const withTextureUnit = \(unit, fn\) =>/.test(mdlCode) &&
  /const tex = withTextureUnit\(1, \(\) =>/.test(mdlCode) &&
  /withTextureUnit\(1, \(\) => \{\n      const t = gl\.createTexture\(\)/.test(mdlCode),
  "在 draw() 里新建的 GL 纹理（白图 / 掩码缓冲）必须走 withTextureUnit（保存-还回活动单元绑定）—— 留在 TEXTURE0 会造成纹理反馈环，掩码写入趟的 drawElements 全部 INVALID_OPERATION 且静默零输出");
check(/gl\.bindTexture\(gl\.TEXTURE_2D, prevBind\)/.test(mdlCode),
  "withTextureUnit 结束必须把该单元的原绑定还回去");

// ---------------------------------------------------------------- 语料
function loadScene(id) {
  const dir = join(LIB, id);
  const pkgPath = join(dir, "scene.pkg");
  if (fs.existsSync(pkgPath)) {
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
    return { scene: JSON.parse(dec.decode(getEntry(pkg, "scene.json"))), get: (rel) => getEntry(pkg, rel) };
  }
  const loose = join(dir, "scene.json");
  if (!fs.existsSync(loose)) return null;
  return { scene: JSON.parse(fs.readFileSync(loose, "utf8")), get: (rel) => fs.readFileSync(join(dir, rel)) };
}

function puppet(id, layerName) {
  const loaded = loadScene(id);
  if (!loaded) return null;
  for (const obj of loaded.scene.objects || []) {
    if (layerName && obj.name !== layerName) continue;
    const image = obj.image;
    if (typeof image !== "string" || !image.endsWith(".json")) continue;
    let model;
    try { model = JSON.parse(dec.decode(loaded.get(image))); } catch { continue; }
    if (!model?.puppet) continue;
    try { return parseMDL(loaded.get(model.puppet)); } catch { return null; }
  }
  return null;
}

/** 该 anim 每根骨在所有帧上的最低 alpha（blend=1、单层可见）。返回 {min, zeroBones, frames} */
function minAlphaPerBone(mdl, anim) {
  const fps = anim.fps > 0 ? anim.fps : 30;
  const n = (anim.frameCount || 0) + 1;
  const layers = [{ animation: anim.id, visible: true, additive: false, blend: 1, rate: 1 }];
  const mins = new Array(mdl.bones.length).fill(1);
  let any = false;
  // 曲线样本数 = frameCount+1，逐帧精确取（不抽样：眨眼可以只有 2 帧宽）
  for (let f = 0; f < n; f++) {
    const a = computeBoneAlphas(mdl, f / fps, layers);
    if (!a) continue;
    any = true;
    for (let i = 0; i < mins.length; i++) if (a[i] < mins[i]) mins[i] = a[i];
  }
  return { mins, any, zeroBones: mins.map((v, i) => [i, v]).filter((x) => x[1] < 0.02).map((x) => x[0]) };
}

let corpus = 0;
const scanned = { puppets: 0, anims: 0, withCurves: 0, badLen: 0, badVal: 0 };
// 掩码语料（第二机制）：带 maskBlocks 的 puppet 数、块数、a/b 下标非法数，以及
// 「有掩码但整条动画没有任何 blend_curves」的 puppet 数 —— 后一类正是旧启发式
// 曾经伪造效果的地方（3629379075），掩码通道是它们唯一的正确机制。
const maskScan = { puppets: 0, blocks: 0, bad: 0, noCurves: 0 };

// B. 解析锁：全库扫一遍（≈5s），把「字节走位被改坏」锁住
{
  for (const d of fs.readdirSync(LIB)) {
    const pkgPath = join(LIB, d, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg, scene;
    try { pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath))); scene = JSON.parse(dec.decode(getEntry(pkg, "scene.json"))); } catch { continue; }
    for (const obj of scene.objects || []) {
      if (typeof obj.image !== "string" || !obj.image.endsWith(".json")) continue;
      let model;
      try { model = JSON.parse(dec.decode(getEntry(pkg, obj.image))); } catch { continue; }
      if (!model?.puppet) continue;
      let mdl;
      try { mdl = parseMDL(getEntry(pkg, model.puppet)); } catch { continue; }
      scanned.puppets++;
      // 掩码块：a/b 必须是**零件表下标**（不是 part.id —— 作者表里 id 从 1 起跳，
      // 而官方 ModelCompiler.cpp 的 GenMaskSubmeshFromMdl 注释明说用 parts[] 位置）。
      const mbs = mdl.maskBlocks || null;
      if (mbs && mbs.length) {
        maskScan.puppets++;
        maskScan.blocks += mbs.length;
        const nParts = (mdl.parts && mdl.parts.length) || 0;
        for (const mb of mbs) {
          const a = mb.partIdsA || [];
          const b = mb.partIdsB || [];
          if (!mb.matPath || typeof mb.matPath !== "string") maskScan.bad++;
          if (a.length === 0 || b.length === 0) maskScan.bad++;
          if (a.some((i) => !(i >= 0 && i < nParts)) || b.some((i) => !(i >= 0 && i < nParts))) maskScan.bad++;
          // a∩b 允许非空：3791967416「眼睛」实测 a=[10] b=[5,6,7,8,9,10]（同一零件
          // 既是掩码载体又被自己裁剪 —— 等价于不裁剪）。只锁下标合法 + 两列非空。
        }
        const anyCurve = (mdl.animations || []).some((x) => x.blendCurves);
        if (!anyCurve) maskScan.noCurves++;
      }
      for (const a of mdl.animations || []) {
        scanned.anims++;
        if (!a.blendCurves) continue;
        scanned.withCurves++;
        for (const c of a.blendCurves) {
          if (!c) continue;
          if (c.length !== a.frameCount + 1) scanned.badLen++;
          for (const v of c) if (v < 0 || v > 1) { scanned.badVal++; break; }
        }
      }
    }
  }
  if (scanned.puppets > 0) {
    console.log(`   语料 ${scanned.puppets} 个 puppet / ${scanned.anims} 条动画，其中 ${scanned.withCurves} 条带 blend_curves`);
    check(scanned.badLen === 0, `每条 blend_curve 的样本数必须 == frameCount+1（实际 ${scanned.badLen} 条不符）`);
    check(scanned.badVal === 0, `blend_curve 取值必须在 [0,1]（实际 ${scanned.badVal} 条越界）`);
    check(scanned.withCurves > 0, "语料里应有带 blend_curves 的动画");
    console.log(`   掩码语料 ${maskScan.puppets} 个 puppet / ${maskScan.blocks} 个掩码块（其中 ${maskScan.noCurves} 个完全没有 blend_curves ⇒ 只可能靠掩码闭眼）`);
    check(maskScan.bad === 0, `掩码块的 a/b 必须是合法零件下标且两列非空（实际 ${maskScan.bad} 处非法）`);
    check(maskScan.puppets >= 20, `语料里应有一批带掩码块的 puppet（实测 ${maskScan.puppets}）`);
    check(maskScan.noCurves >= 1,
      `必须存在「有掩码块但没有任何 blend_curves」的 puppet（实测 ${maskScan.noCurves}）—— 它们在双机制里只靠掩码闭眼，是旧启发式的复发点`);
  }
}

function need(id, layer) {
  const mdl = puppet(id, layer);
  if (!mdl) {
    console.log(`   skip ${id} ${layer || ""}：库里没有这份 puppet`);
    return null;
  }
  corpus++;
  return mdl;
}

/** 该 puppet 是否在任意帧、任意骨上淡到 0（= 作者写了「某零件在某个瞬间消失」） */
function reachesZero(mdl) {
  for (const a of mdl.animations || []) {
    if (!a.blendCurves) continue;
    const r = minAlphaPerBone(mdl, a);
    if (r.zeroBones.length) return r;
  }
  return null;
}

// C. 行为锁：带曲线者必须算得出淡出，且骨号与作者素材对得上
{
  // 3808922316「眼睛」anim2717：骨 #22/#23/#24（三级父子链）曲线 min=0 @f83，
  // 对应零件 48×40 / 36×41 / 33×34（眼球 + 高光 + 眼白），是这张的闭眼机制。
  const mdl = need("3808922316", "眼睛");
  if (mdl) {
    check(mdl.hasAlphaCurves === true, "3808922316 眼睛应带 blend_curves（官方靠它闭眼）");
    const r = reachesZero(mdl);
    check(!!r, "3808922316 眼睛必须能算出「某骨 alpha → 0」");
    if (r) {
      for (const b of [22, 23, 24]) check(r.mins[b] < 0.02, `3808922316 骨 #${b} 应淡到 0（实际最低 ${r.mins[b]?.toFixed(3)}）`);
      check(r.mins.some((v, i) => ![22, 23, 24].includes(i) && v === 1), "同一帧里别的骨必须保持 alpha=1（只有眨眼组淡出）");
    }
  }
}
{
  // 3791967416「小眼睛」anim6542：骨 #6/#7（零件 50×65 / 53×49）min=0
  const mdl = need("3791967416", "小眼睛");
  if (mdl) {
    check(mdl.hasAlphaCurves === true, "3791967416 小眼睛应带 blend_curves");
    const r = reachesZero(mdl);
    if (r) for (const b of [6, 7]) check(r.mins[b] < 0.02, `3791967416 骨 #${b} 应淡到 0（实际 ${r.mins[b]?.toFixed(3)}）`);
  }
}
{
  // 3351179520「头发」anim2471「眨眼」：11 根骨（#7,8,9,10,11,18,30,31,33,34,36）min=0
  const mdl = need("3351179520", "头发");
  if (mdl) {
    check(mdl.hasAlphaCurves === true, "3351179520 头发应带 blend_curves");
    const r = reachesZero(mdl);
    check(!!r && r.zeroBones.length >= 8, `3351179520 应有一整组骨淡到 0（实际 ${r ? r.zeroBones.length : 0} 根）`);
  }
}
{
  // 3226487183「中间默认主体」：CASEBOOK 里有整章（加算层 kf0 sy=0 的错帧史），
  // 这张的眨眼同样是曲线淡出 —— 必须由 alpha 通道负责，而不是零件压扁。
  const mdl = need("3226487183", "中间默认主体");
  if (mdl) {
    check(mdl.hasAlphaCurves === true, "3226487183 中间默认主体应带 blend_curves");
    check(!!reachesZero(mdl), "3226487183 必须能算出 alpha→0");
  }
}
{
  // 负向对照：3671936032「人物」的闭眼是**骨缩放**写的（眼白骨 scale→0.00059），
  // 一条曲线都没有 —— 官方在这张上也不可能淡出虹膜。这条断言锁住「不许再有
  // 引擎猜出来的淡出」：computeBoneAlphas 必须恒为 null。
  const mdl = need("3671936032", "人物");
  if (mdl) {
    check(mdl.hasAlphaCurves === false, "3671936032 人物不应带 blend_curves（闭眼写在骨缩放里）");
    const layers = [{ animation: mdl.animations[0].id, visible: true, additive: false, blend: 1, rate: 1 }];
    let bad = 0;
    for (const t of [0, 0.5, 0.8, 0.833, 1, 2, 5]) if (computeBoneAlphas(mdl, t, layers)) bad++;
    check(bad === 0, "3671936032 任何时刻都不应产生 alpha 通道（实际 " + bad + " 次非 null）");
  }
}
for (const [id, layer] of [["3655429099", "08眼组"], ["3629379075", "若叶睦 眼睛部件"], ["3521337568", "Lucy"]]) {
  const mdl = need(id, layer);
  if (!mdl) continue;
  check(mdl.hasAlphaCurves === false, `${id} ${layer} 没有 blend_curves：闭眼只能靠骨缩放（3671936032 型）或掩码块，不许再有引擎猜出来的淡出`);
}
// 掩码表（第二机制的正向锁）：3629379075 的闭眼全靠它 —— 该 puppet 的动画里一条
// blend_curves 都没有，虹膜骨 scale 全程 ≈1，只有掩码能把虹膜在眼睑合上时裁掉。
{
  const mdl = need("3629379075", "若叶睦 眼睛部件");
  if (mdl) {
    const mbs = mdl.maskBlocks || [];
    check(mbs.length === 6, `3629379075 若叶睦 眼睛部件 应有 6 个掩码块（实测 ${mbs.length}）`);
    const key = mbs.map((m) => `${m.matPath} a=[${m.partIdsA}] b=[${m.partIdsB}]`).join(" ; ");
    const has = (a, b) => mbs.some((m) => m.partIdsA.join(",") === a && m.partIdsB.join(",") === b);
    check(has("11", "0,1,2,3") && has("12", "0,1,2,3"),
      `两只虹膜件（parts[11]/parts[12]，id8）必须被四个眼睑件 parts[0..3] 裁剪：${key}`);
    check(has("13", "0,1,2,3") && has("14", "0,1,2,3") && has("15", "0,1,2,3"),
      `三个高光件 parts[13]/[14]/[15] 同样被裁剪：${key}`);
    check(mbs.every((m) => /^masks\/clipping_mask_/.test(m.matPath || "")),
      `掩码材质必须指向 materials/masks/clipping_mask_*.tex（实际 ${mbs.map((m) => m.matPath).join(",")}）`);
    const bIdx = mbs.flatMap((m) => m.partIdsB);
    check(bIdx.every((i) => i < (mdl.parts || []).length), "b 列下标必须在零件表范围内");
  }
}

// LayerBoneAlpha 语义：blend=1 → 曲线值 0 处 alpha=0；blend=0.5 → 0.5
{
  const mdl = need("3808922316", "眼睛");
  if (mdl) {
    const anim = (mdl.animations || []).find((a) => a.blendCurves);
    if (anim) {
      // 找一根「曲线样本里真有 0」的骨
      let bone = -1, frame = -1;
      for (let i = 0; i < anim.blendCurves.length && bone < 0; i++) {
        const c = anim.blendCurves[i];
        if (!c) continue;
        for (let f = 0; f < c.length; f++) if (c[f] === 0) { bone = i; frame = f; break; }
      }
      check(bone >= 0, "3808922316 应能找到一根曲线值恰为 0 的骨");
      if (bone >= 0) {
        const fps = anim.fps > 0 ? anim.fps : 30;
        const t = frame / fps;
        const at = (blend, visible = true) => {
          const a = computeBoneAlphas(mdl, t, [{ animation: anim.id, visible, additive: false, blend, rate: 1 }]);
          return a ? a[bone] : null;
        };
        const full = at(1);
        check(full !== null && full < 1e-6, `blend=1 时曲线 0 处 alpha 必须为 0（实际 ${full}）`);
        const half = at(0.5);
        check(half !== null && Math.abs(half - 0.5) < 1e-6, `blend=0.5 时 alpha 必须是 0.5（LayerBoneAlpha 公式，实际 ${half}）`);
        check(at(1, false) === null, "层 visible=false 时不参与 alpha（官方 m_layers 里那条不乘）");
        const off = computeBoneAlphas(mdl, 0, []);
        check(off === null || off[bone] === 1, "空层表 → 官方不乘 alpha（退回动画 0 时曲线值为 1）");
      }
    }
  }
}

console.log(corpus ? `   语料 ${corpus} 个 puppet 逐骨验过` : "   语料跳过（本机没有壁纸库）");
console.log(errors.length === 0 ? "verify-blink: 全部通过 ✓" : `verify-blink: ${errors.length} 项失败 ✗`);
for (const e of errors) console.log("  ✗ " + e);
process.exit(errors.length === 0 ? 0 : 1);
