/**
 * verify-camera-constants —— 相机 / 视差 / 正交常量的判据（W6）。
 *
 * 这些常量是本渲染引擎与官方运行时对齐的接缝，数值一旦漂移，画面会**静默**走样：
 *   · fov 变了 → 取景变；near/far 变了 → 深度精度变（z-fighting 或近处被裁）；
 *   · 正交缺省变了 → 没写 width/height 的 2D 场景被拉伸；
 *   · 相机路径默认变了 → 运镜速度/循环语义变；
 *   · 抖动幅度比例变了 → 全屏晃飞或看不见；
 *   · 视差深度系数变了 → 整套视差的位移量变。
 *
 * 本脚本把它们钉住。分节：
 *   [1] buildCamera 透视默认与 clamp      → renderer/vendor/we-scene/render/math.js
 *   [2] 正交投影缺省与裁剪面              → 同上
 *   [3] 相机路径默认插值 / 循环 / 选段常量 → renderer/vendor/we-scene/render/camera-path.js
 *   [4] camerashake 幅度比例与方向表      → renderer/vendor/we-scene/render/renderer.js（**只读**）
 *   [5] 视差深度系数（legacy / mirage）   → render/math.js
 *
 * 常量取证的来源、判定与未解项见 `docs/re/we-native-camera-constants.md`。
 * §4 读的 renderer.js 属另一路工作流的写入范围，本脚本只读、不改 —— 它的判定若变化应由
 * 该路的判据负责，这里钉住的是「本库当前已定案并已在用的那套数值」。
 *
 * 断言方式：**先读源码取表达式，再代入合成输入求值**（不是字面量比对）——
 * 改常量会红，换成等价的另一种写法不会红；行为面另有直接调用公开函数的分支。
 * 全部夹具进程内合成，不读素材库、不开 GPU。
 */
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");
const R = join(ROOT, "renderer/vendor/we-scene/render/");
const read = (p) => fs.readFileSync(join(R, p), "utf8");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const num = (s) => Number(s);
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

const MATH = read("math.js");
const PATH = read("camera-path.js");
const RENDERER = read("renderer.js");

const M = await import(pathToFileURL(join(R, "math.js")).href);
const {
  buildCamera,
  mat4Perspective,
  parallaxDepthFactor,
  legacyParallaxOffset,
  mirageParallaxOffset,
  layerParallaxOffset,
} = M;

/** 从源码切一段出来（含起止标记的闭区间文本），找不到就返回 null */
function slice(text, from, to) {
  const a = text.indexOf(from);
  if (a < 0) return null;
  const b = text.indexOf(to, a + from.length);
  return b < 0 ? null : text.slice(a, b);
}

// ─────────────────────────────────────────────────────────────
console.log("\n[1] buildCamera 透视默认与 clamp（fov / nearz / farz）");
{
  const body = slice(MATH, "export function buildCamera(", "export function applyCameraZoom(");
  check(!!body, "能切出 buildCamera 函数体");

  const fov = body && /numField\(general\.fov,\s*([\d.]+)\)/.exec(body);
  check(!!fov && num(fov[1]) === 50, `fov 缺省 = 50（源码：${fov ? fov[0] : "未找到"}）`);

  const near = body && /Math\.max\(numField\(general\.nearz,\s*([\d.eE+-]+)\),\s*([\d.eE+-]+)\)/.exec(body);
  check(
    !!near && num(near[1]) === 0.01 && num(near[2]) === 1e-4,
    `nearz 缺省 = 0.01，下限 1e-4（源码：${near ? near[0] : "未找到"}）`,
  );

  const far = body && /Math\.max\(numField\(general\.farz,\s*([\d.eE+-]+)\),\s*near\s*\+\s*([\d.eE+-]+)\)/.exec(body);
  check(
    !!far && num(far[1]) === 10000 && num(far[2]) === 1,
    `farz 缺省 = 10000，下限 near+1（源码：${far ? far[0] : "未找到"}）`,
  );

  // 行为面：投影矩阵必须逐元素等于用这些常量手算的 mat4Perspective
  const W = 1920;
  const H = 1080;
  const aspect = W / H;
  const projOf = (general) =>
    buildCamera({ general, layers: [] }, W, H, "cover", "center", "center").projection;
  const same = (a, b) => a.length === b.length && [...a].every((v, i) => close(v, b[i]));

  const p1 = projOf({});
  check(same(p1, mat4Perspective(50, aspect, 0.01, 10000)), "空 general → mat4Perspective(50, aspect, 0.01, 10000) 逐元素一致");

  const p2 = projOf({ nearz: 1e-9 });
  check(same(p2, mat4Perspective(50, aspect, 1e-4, 10000)), "nearz=1e-9 被下限抬到 1e-4（不是直接用 1e-9）");

  const p3 = projOf({ nearz: 1, farz: 0.5 });
  check(same(p3, mat4Perspective(50, aspect, 1, 2)), "farz 小于 near+1 时被抬到 near+1=2（反向深度范围不会退化）");

  const p4 = projOf({ fov: 90, nearz: 0.1, farz: 5000 });
  check(same(p4, mat4Perspective(90, aspect, 0.1, 5000)), "显式 fov/nearz/farz 原样生效");

  const p5 = projOf({ fov: { value: 75 } });
  check(same(p5, mat4Perspective(75, aspect, 0.01, 10000)), "fov 的 {value} 包装形态被解包");
}

// ─────────────────────────────────────────────────────────────
console.log("\n[2] 正交投影缺省与裁剪面（orthogonalprojection.width/height / ±10000）");
{
  const ortho = slice(MATH, "const projW = general", "const win = fitWindow(");
  check(!!ortho, "能切出正交分支的 projW/projH 计算");
  check(
    !!ortho && /general\.orthogonalprojection\.width\s*\|\|\s*width/.test(ortho),
    "orthogonalprojection.width 缺省 = 画布 width",
  );
  check(
    !!ortho && /general\.orthogonalprojection\.height\s*\|\|\s*height/.test(ortho),
    "orthogonalprojection.height 缺省 = 画布 height",
  );

  const call = /mat4Ortho\(\s*win\.offX\s*,\s*win\.offX\s*\+\s*win\.viewW\s*,\s*win\.offY\s*\+\s*win\.viewH\s*,\s*win\.offY\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(MATH);
  check(
    !!call && num(call[1]) === -10000 && num(call[2]) === 10000,
    `正交裁剪面 z = [-10000, 10000]（源码：${call ? call[0].slice(0, 90) : "未找到"}）`,
  );

  const W = 1920;
  const H = 1080;
  // 只写 auto 的 orthogonalprojection = 声明了正交但没给尺寸 ⇒ 吃画布尺寸
  const c1 = buildCamera({ general: { orthogonalprojection: { auto: true } }, layers: [] }, W, H, "cover", "center", "center");
  check(c1.perspective === false && c1.projW === W && c1.projH === H, `无 width/height → projW/projH = 画布 ${W}×${H}`);

  const c2 = buildCamera({ general: { orthogonalprojection: { width: 1280, height: 720 } }, layers: [] }, W, H, "cover", "center", "center");
  check(c2.projW === 1280 && c2.projH === 720, "显式 width/height 原样生效（不被画布覆盖）");

  const c3 = buildCamera({ general: { orthogonalprojection: {} }, layers: [] }, W, H, "cover", "center", "center");
  check(c3.perspective === true, "orthogonalprojection 是空对象 ⇒ 按「未声明」算，落透视分支");

  // 裁剪面行为：mat4Ortho 的 [10] = -2/(far-near)、[14] = -(far+near)/(far-near)
  check(close(c1.projection[10], -2 / 20000), `正交 z 缩放 = -2/20000（实测 ${c1.projection[10]}）`);
  check(close(c1.projection[14], 0), `正交 z 平移 = 0（±10000 对称，实测 ${c1.projection[14]}）`);
}

// ─────────────────────────────────────────────────────────────
console.log("\n[3] 相机路径默认常量（fps / length / mode / 基准 fov·zoom / 选段）");
{
  check(/Number\(opts\.fps\)\s*>\s*0\s*\?\s*Number\(opts\.fps\)\s*:\s*30/.test(PATH), "fps 缺省 = 30");
  check(/Number\(opts\.length\)\s*>\s*0\s*\?\s*Number\(opts\.length\)\s*:\s*0/.test(PATH), "length 缺省 = 0");
  check(
    /opts\.mode === 'loop' \|\| opts\.mode === 'mirror' \? opts\.mode : 'single'/.test(PATH),
    "mode 只认 loop/mirror，其余（含缺失）落 'single'",
  );
  check(
    /const base = state\.base \|\| \{ eye: \[0, 0, 0\], center: \[0, 0, -1\], up: \[0, 1, 0\], fov: 50, zoom: 1 \}/.test(PATH),
    "首次 tick 的兜底基准 = 原点视角 / fov 50 / zoom 1",
  );
  check(
    /fov: Number\.isFinite\(Number\(pose\.fov\)\) \? Number\(pose\.fov\) : 50/.test(PATH),
    "宿主位姿缺 fov → 基准 fov 落 50",
  );
  check(
    /zoom: Number\.isFinite\(Number\(pose\.zoom\)\) \? Number\(pose\.zoom\) : 1/.test(PATH),
    "宿主位姿缺 zoom → 基准 zoom 落 1",
  );
  check(/queuemode === 'random'/.test(PATH) && /Math\.floor\(Math\.random\(\) \* clips\.length\)/.test(PATH), "queuemode='random' → 随机抽段");
  check(/state\.index = \(state\.index \+ 1\) % clips\.length/.test(PATH), "其它 queuemode → 顺序 index+1 环绕");

  const { createCameraPath, createSceneCameraPath } = await import(pathToFileURL(join(R, "camera-path.js")).href);

  const c0 = createCameraPath({ paths: [{}] }, "sequential").clips[0];
  check(c0.fps === 30 && c0.length === 0 && c0.mode === "single", "空 options 的 clip → fps=30 / length=0 / mode='single'");

  const c1 = createCameraPath({ paths: [{ options: { fps: -1, mode: "bogus" } }] }, "sequential").clips[0];
  check(c1.fps === 30 && c1.mode === "single", "非法 fps(-1) 与未知 mode('bogus') 落默认（不是 NaN / 透传）");

  const c2 = createCameraPath({ paths: [{ options: { mode: "mirror" } }] }, "sequential").clips[0];
  check(c2.mode === "mirror", "mode='mirror' 被显式识别");

  // 顺序选段：clips.length = 2，每段 duration = length/fps = 1s
  const two = { paths: [{ options: { fps: 1, length: 1 } }, { options: { fps: 1, length: 1 } }] };
  const seq = createCameraPath(two, "sequential");
  const first = seq.index;
  seq.tick(0, {});
  const afterInit = seq.index;
  seq.tick(1.5, {});
  check(first === 0 && afterInit === 0 && seq.index === 1, `sequential：初始 0 → 越过 1s 段后 index=1（实测 ${first}→${afterInit}→${seq.index}）`);

  const rnd = createCameraPath(two, "random");
  const origRandom = Math.random;
  Math.random = () => 0.9; // floor(0.9*2)=1
  rnd.tick(0, {});
  Math.random = origRandom;
  check(rnd.index === 1, `random：Math.random 桩 0.9 → index=1（实测 ${rnd.index}）`);

  // 场景级路径（scene.json 的 camera.paths）：timestamp 线性插值 + 整圈循环 + 端点保持
  const scene = createSceneCameraPath({
    paths: [
      {
        name: "a",
        duration: 2,
        transforms: [
          { timestamp: 0, eye: "0 0 0", center: "0 0 -1" },
          { timestamp: 2, eye: "2 0 0", center: "0 0 -1" },
        ],
      },
    ],
  });
  const at = (t) => scene.tick(t);
  check(scene.duration === 2, `整圈周期 = Σ duration = 2（实测 ${scene.duration}）`);
  check(at(0).eye[0] === 0 && close(at(1).eye[0], 1) && close(at(2 % 2).eye[0], 0), "段内按 timestamp 线性插值（t=1 → eye.x=1）");
  check(close(at(3).eye[0], 1) && close(at(-1).eye[0], 1), "整圈循环：t=3 与 t=-1 都映回 t=1");

  const hold = createSceneCameraPath({
    paths: [{ duration: 4, transforms: [{ timestamp: 1, eye: "1 0 0", center: "0 0 -1" }, { timestamp: 3, eye: "3 0 0", center: "0 0 -1" }] }],
  });
  check(hold.tick(0.5).eye[0] === 1 && hold.tick(3.5).eye[0] === 3, "关键帧区间外保持最近的一端（首帧前 / 末帧后）");
}

// ─────────────────────────────────────────────────────────────
console.log("\n[4] camerashake 幅度比例与方向表（只读 renderer.js）");
{
  const body = slice(RENDERER, "const SHAKE_DIRS = [", "// [we-scene patch] g_Daytime");
  check(!!body && /function cameraShakeOffset\(/.test(body), "能切出方向表 + cameraShakeOffset 函数体");

  const arr = (name) => {
    const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(body || "");
    return m ? m[1].split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)) : null;
  };
  // SHAKE_DIRS 是 8 个**嵌套**的二元组：`[-1, 1], [1, -1], …`，要按二元组抽取
  const dirsBlock = /const SHAKE_DIRS = \[([\s\S]*?)\n\s*\]/.exec(body || "");
  const dirs = dirsBlock
    ? [...dirsBlock[1].matchAll(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/g)].flatMap((m) => [num(m[1]), num(m[2])])
    : null;
  const base = arr("SHAKE_BASE");
  const rough = arr("SHAKE_ROUGH");
  check(
    !!dirs &&
      dirs.length === 16 &&
      dirs.every((v) => v === 1 || v === -1) &&
      dirs.join(",") === "-1,1,1,-1,-1,1,1,-1,1,1,-1,-1,1,1,-1,-1",
    `SHAKE_DIRS = 8 个对角方向（实测 ${dirs ? dirs.join(",") : "未找到"}）`,
  );
  check(
    !!base && base.join(",") === "0.8,1,0.45,0.6,0.8,1,0.45,0.6",
    `SHAKE_BASE 方向系数表 = {0.8,1.0,0.45,0.6}×2（实测 ${base ? base.join(",") : "未找到"}）`,
  );
  check(
    !!rough && rough.join(",") === "6,8,1,1,6,8,1,1",
    `SHAKE_ROUGH 粗糙度放大表（实测 ${rough ? rough.join(",") : "未找到"}）`,
  );
  check(/const beatPos = Math\.max\(0, time \* speed \* 2\) \/ \(Math\.PI \* 0\.5\)/.test(body || ""), "节拍 = (π/2)/(2·speed) 秒一拍");
  check(/if \(i & 1\) return \[0, 0\]/.test(body || ""), "奇数拍停在中心（速度过零）");
  check(/Math\.max\(0, Math\.min\(2, numProp2\(general\.camerashakeroughness, 0\)\)\)/.test(body || ""), "roughness clamp 到 [0,2]，缺省 0");
  check(/numProp2\(general\.camerashakeamplitude, 0\)/.test(body || ""), "camerashakeamplitude 缺省 0（= 不抖）");
  check(/numProp2\(general\.camerashakespeed, 1\)/.test(body || ""), "camerashakespeed 缺省 1");

  // 幅度比例常数：**这正是 wave-1 审计列为「无数据出处」的那一个**，必须锁住
  const scaleM = /const scale = amp \* Math\.min\(viewW, viewH\) \* ([\d.]+)\)?/.exec(body || "");
  check(!!scaleM, `幅度比例表达式存在（源码：${scaleM ? scaleM[0] : "未找到"}）`);
  const scaleExpr = scaleM ? `${scaleM[1]}` : "NaN";
  const evalScale = (amp, viewW, viewH) => {
    if (!/^[\d\s+\-*/().]+$/.test(scaleExpr)) return NaN;
    try {
      return Function("amp", "viewW", "viewH", `return amp * Math.min(viewW, viewH) * ${scaleExpr};`)(amp, viewW, viewH);
    } catch {
      return NaN;
    }
  };
  const s = evalScale(1, 1920, 1080);
  check(close(s, 10.8), `amp=1 / 1920×1080 → 抖动幅度 = 1% 短边 = 10.8 世界像素（实测 ${s}）`);
  const s2 = evalScale(0.5, 1000, 2000);
  check(close(s2, 5), `amp=0.5 / 1000×2000 → 取短边 1000 的 1% × 0.5 = 5（实测 ${s2}）`);
}

// ─────────────────────────────────────────────────────────────
console.log("\n[5] 视差深度系数（legacy 的 d/2 vs mirage 原式）");
{
  check(parallaxDepthFactor(2) === 1, `parallaxDepthFactor(2) = 1（d/2）`);
  check(parallaxDepthFactor(-3) === -1.5, `parallaxDepthFactor(-3) = -1.5（符号保留）`);
  check(parallaxDepthFactor(NaN) === 0 && parallaxDepthFactor(undefined) === 0, "非有限输入 → 0（不是 NaN 传播）");

  const lg = legacyParallaxOffset({ parallaxDepth: [2, 4] }, { active: true, lx: 10, ly: -5 });
  check(lg[0] === 10 && lg[1] === -10, `legacy：(d/2)⊗(lx,ly) → [10, -10]（实测 ${JSON.stringify(lg)}）`);
  const lgOff = legacyParallaxOffset({ parallaxDepth: [2, 4] }, { active: false, lx: 10, ly: -5 });
  check(lgOff[0] === 0 && lgOff[1] === 0, "legacy：ctx.active=false → 无位移");
  const lgNoDepth = legacyParallaxOffset({}, { active: true, lx: 10, ly: -5 });
  check(lgNoDepth[0] === 0 && lgNoDepth[1] === 0, "legacy：层没有 parallaxDepth → 无位移（缺省深度=0，不是某个非零默认）");

  const mg = mirageParallaxOffset(
    { parallaxDepthProp: [0.5, 0.5], parallaxAnchor: [100, 200] },
    { active: true, amount: 1, cx: 50, cy: 100, mx: 0, my: 0 },
  );
  check(close(mg[0], 25) && close(mg[1], -50), `mirage：(anchor−cam)⊗depth×amount，y 取负 → [25, -50]（实测 ${JSON.stringify(mg)}）`);

  const mBody = slice(MATH, "export function mirageParallaxOffset(", "export function layerParallaxOffset(");
  check(!!mBody && !/parallaxDepthFactor/.test(mBody), "mirage 路径**不**乘 d/2（无 parallaxDepthFactor 调用）");
  const lBody = slice(MATH, "export function legacyParallaxOffset(", "export function mirageParallaxOffset(");
  check(!!lBody && /fx \* lx/.test(lBody) && /fy \* ly/.test(lBody), "legacy 路径 = (d/2)⊗偏移（fx*lx / fy*ly）");
  check(/return Number\.isFinite\(n\) \? n \* 0\.5 : 0/.test(MATH), "parallaxDepthFactor 的 0.5 是源码里唯一的深度缩放常数");

  const viaDispatch = layerParallaxOffset(
    { parallaxDepth: [2, 4] },
    { active: true, lx: 10, ly: -5, mode: "legacy" },
  );
  const viaMirage = layerParallaxOffset(
    { parallaxDepthProp: [0.5, 0.5], parallaxAnchor: [100, 200] },
    { active: true, amount: 1, cx: 50, cy: 100, mx: 0, my: 0, mode: "mirage" },
  );
  check(
    viaDispatch[0] === 10 && close(viaMirage[0], 25),
    `layerParallaxOffset 按 ctx.mode 分发（legacy ${JSON.stringify(viaDispatch)} / mirage ${JSON.stringify(viaMirage)}）`,
  );
}

console.log(failed === 0 ? "\nverify-camera-constants: 全部通过 ✓" : `\nverify-camera-constants: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
