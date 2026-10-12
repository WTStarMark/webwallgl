#!/usr/bin/env node
/**
 * verify-lifecycle —— 实例生命周期与代际（M4）的源码守卫。
 *
 * 依据：docs/ENGINE-REVIEW-2026-10.md §3.3。修的四类洞都是**异步装配路径**上的，
 * 离线跑不出行为（要 DOM + 真装配 + 时序竞态），所以这里守的是**接线**：
 * 把每条规则变成正则断言，删掉任何一条都会红。行为面由
 * `scripts/_probe-review-lifecycle.mjs`（无头、真装配）覆盖，两者互补。
 *
 * 为什么守卫必须先剥注释：第一版 GL 登记守卫没剥，被我自己的解释性注释判红过一次
 * （注释里写了要禁的那个写法）。见 docs/ENGINE-REVIEW-2026-10.md §10 的「判据自身的坑」。
 */
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// 剥注释用**字符串感知**的实现（朴素正则会吞掉字符串里含 /* 的真代码，实测踩过）。
import { stripComments } from "./lib/source-scan.mjs";
const read = (rel) => stripComments(fs.readFileSync(join(ROOT, rel), "utf8"));

// ───────────────────── 真行为子进程模式（`--child <name>`，见文末 [8]/[9]） ─────────────────────
// 真行为用例一律在**独立子进程**里跑，父进程只解析它吐出的 JSON 行：
//   · 子进程带 timeout 与 --max-old-space-size 上限；
//   · 被测路径万一退化（OOM / 挂死 / 崩溃）时，被带走的只是那个子进程
//     —— 历史事故：一次 4.6s 内的 SIGABRT 能把整个 verifier 一起杀掉，
//     于是「判据自己死了」被误读成「没有任何失败」。
// 子进程里**不跑**下面的源码守卫（那些在父进程跑），只跑被点名的那个真行为用例。
const childIdx = process.argv.indexOf("--child");
if (childIdx >= 0) {
  const childName = process.argv[childIdx + 1];
  const t0 = Date.now();
  const heap0 = process.memoryUsage().heapUsed;
  let fatal = null;
  try {
    await runChildScenario(childName);
  } catch (e) {
    fatal = String((e && e.stack) || e).split("\n").slice(0, 3).join(" ｜ ");
  }
  emitChild({
    id: "__meta",
    ok: fatal === null,
    msg: `子进程 ${childName} 走完（${Date.now() - t0}ms）`,
    detail: fatal || undefined,
    heapUsedDeltaKB: Math.round((process.memoryUsage().heapUsed - heap0) / 1024),
  });
  process.exit(fatal === null ? 0 : 1);
}

/** 子进程 → 父进程的唯一通道：一行一个 JSON（父进程逐行容错解析） */
function emitChild(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}

/** 记录型假 WebGL2：GL 常量给真值、资源创建给唯一对象、其余调用只记名。
 *  只为让真 renderer.js 能离线跑起来（不需要 GPU / DOM），不做任何 GL 语义模拟。 */
function makeRecorderGl() {
  const log = [];
  const created = () => ({ __glObj: true });
  const RET = {
    createShader: created,
    createProgram: created,
    createTexture: created,
    createVertexArray: created,
    createBuffer: created,
    createFramebuffer: created,
    createRenderbuffer: created,
    getUniformLocation: (_p, n) => ({ __loc: n }),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getAttribLocation: () => 0,
    getParameter: () => 256,
    checkFramebufferStatus: () => 0x8cd5,
    isContextLost: () => false,
    getExtension: (n) => {
      log.push({ name: "getExtension", args: [n] });
      return n === "WEBGL_lose_context" ? { loseContext: () => log.push({ name: "ext.loseContext", args: [] }) } : null;
    },
  };
  const target = { __log: log };
  return new Proxy(target, {
    get(t, k) {
      if (typeof k !== "string") return undefined;
      if (k in t) return t[k];
      if (k in RET) return RET[k];
      if (/^[A-Z][A-Z0-9_]*$/.test(k)) return 0x1000; // GL_* 常量
      const fn = (...a) => {
        log.push({ name: k, args: a });
      };
      RET[k] = fn;
      return fn;
    },
  });
}

/** 造一个假画布（真 renderer 只用到 getContext / add-removeEventListener / 尺寸） */
function makeFakeCanvas(gl, listeners) {
  return {
    width: 64,
    height: 64,
    getContext: () => gl,
    addEventListener: (n, f) => listeners.set(n, f),
    removeEventListener: (n) => listeners.delete(n),
  };
}

async function runChildScenario(name) {
  if (name === "context-loss") return childContextLoss();
  if (name === "unmount-gen") return childUnmountGen();
  throw new Error("未知子进程用例: " + name);
}

/** [8] 上下文丢失/恢复的真行为（真 renderer.js + 假 GL + 假画布） */
async function childContextLoss() {
  const { createRenderer } = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/renderer.js")).href);

  const listeners = new Map();
  const diags = [];
  let prevented = 0;
  const gl = makeRecorderGl();
  const r = createRenderer(makeFakeCanvas(gl, listeners), { diag: (m) => diags.push(String(m)), shaderResolver: async () => null });

  emitChild({
    id: "listeners",
    ok: listeners.has("webglcontextlost") && listeners.has("webglcontextrestored"),
    msg: "[8.1] 丢失/恢复必须挂上画布监听（宿主没有其它途径知道该重挂载）",
    detail: [...listeners.keys()].join(","),
  });

  listeners.get("webglcontextlost")({ preventDefault: () => prevented++ });
  emitChild({
    id: "lost-prevent-default",
    ok: prevented === 1,
    msg: "[8.2] webglcontextlost 必须 preventDefault()（不拦就没有恢复可能）",
    detail: `prevented=${prevented}`,
  });
  emitChild({ id: "lost-state", ok: r.contextLost() === true, msg: "[8.3] 丢失后 contextLost() 必须为 true（宿主据此冻结并重挂）" });
  emitChild({
    id: "lost-diag",
    ok: diags.length === 1 && /上下文丢失/.test(diags[0]) && /重挂载/.test(diags[0]),
    msg: "[8.4] 丢失必须上报一条含「上下文丢失 … 重挂载」的诊断",
    detail: `diags=${diags.length}`,
  });

  // 重复丢失：诊断只能一条（否则刷屏），但每次仍要 preventDefault（浏览器会重复派发）
  listeners.get("webglcontextlost")({ preventDefault: () => prevented++ });
  emitChild({
    id: "lost-diag-once",
    ok: diags.length === 1 && prevented === 2,
    msg: "[8.5] 重复丢失不得重复上报，但每次都要 preventDefault",
    detail: `diags=${diags.length} prevented=${prevented}`,
  });

  // 恢复：引擎**不**重建 GL 资源（句柄已失效），必须再上报一条并保持丢失态
  listeners.get("webglcontextrestored")({});
  emitChild({
    id: "restored-diag",
    ok: diags.length === 2 && /重挂载/.test(diags[1]),
    msg: "[8.6] 恢复后必须再上报一条（引擎不重建资源，宿主必须重挂）",
    detail: `diags=${diags.length}`,
  });
  emitChild({ id: "restored-keeps-lost", ok: r.contextLost() === true, msg: "[8.7] 恢复事件不得清掉丢失态（谎报已恢复 = 黑屏继续跑）" });

  // 浏览器已判死但没派事件：render() 必须零绘制短路，且补一条诊断（只补一次）
  {
    const gl2 = makeRecorderGl();
    gl2.isContextLost = () => true;
    const listeners2 = new Map();
    const diags2 = [];
    const r2 = createRenderer(makeFakeCanvas(gl2, listeners2), { diag: (m) => diags2.push(String(m)), shaderResolver: async () => null });
    const n0 = gl2.__log.length;
    await r2.render(null, [], 16, 16, 0, "cover", 0.5, 0.5, null);
    const draws = gl2.__log.slice(n0).filter((e) => /^(draw|uniform|bindTexture|texImage|viewport|clear)/.test(e.name));
    emitChild({
      id: "iscontextlost-shortcircuit",
      ok: draws.length === 0,
      msg: "[8.8] gl.isContextLost() 为真时 render() 必须零 GL 绘制调用直接返回（否则每帧全变 no-op，还骗出「rAF 照跑 fps 照计」）",
      detail: draws.map((e) => e.name).join(",") || "无调用",
    });
    emitChild({
      id: "iscontextlost-diag",
      ok: diags2.length === 1 && /上下文丢失/.test(diags2[0]),
      msg: "[8.9] 浏览器判死但没派事件时，短路路径也要补上报一条诊断",
      detail: `diags=${diags2.length}`,
    });
    await r2.render(null, [], 16, 16, 0, "cover", 0.5, 0.5, null);
    emitChild({ id: "iscontextlost-diag-once", ok: diags2.length === 1, msg: "[8.10] 第二次短路不得再上报（诊断一次性）" });
    r2.dispose();
  }

  // dispose 的顺序契约：先摘监听 → 释放 GL 资源 → 最后 loseContext
  {
    const n0 = gl.__log.length;
    r.dispose();
    const tail = gl.__log.slice(n0);
    const deleteIdxs = tail.map((e, i) => (/^delete/.test(e.name) ? i : -1)).filter((i) => i >= 0);
    const loseIdx = tail.findIndex((e) => e.name === "ext.loseContext");
    emitChild({
      id: "dispose-listeners",
      ok: listeners.size === 0,
      msg: "[8.11] dispose() 必须先摘掉自己的上下文监听（不摘会把自己的拆卸记成故障）",
      detail: `left=${[...listeners.keys()].join(",") || "无"}`,
    });
    emitChild({
      id: "dispose-order",
      ok: deleteIdxs.length > 0 && loseIdx > deleteIdxs[deleteIdxs.length - 1],
      msg: "[8.12] 释放 GL 资源（delete*）必须早于 loseContext（顺序反了 delete 全成 no-op）",
      detail: `deletes=${deleteIdxs.length} loseContext@${loseIdx}`,
    });
  }
}

/** [9] 装配-卸载代际的真行为（esbuild 现编 shell.ts → data: URL 真跑） */
async function childUnmountGen() {
  const { build } = await import("esbuild");
  const res = await build({
    entryPoints: [join(ROOT, "renderer/src/shell.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "silent",
  });
  // 走 data: URL 而不是临时文件：整段 bundle 不落盘，DOM 桩也只活在这个子进程里
  const code = res.outputFiles[0].text;

  const calls = [];
  globalThis.window = { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 100, innerHeight: 100 };
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    documentElement: { style: {} },
    body: { style: {}, appendChild() {} },
    createElement: () => ({ style: {}, remove() {} }),
  };
  globalThis.cancelAnimationFrame = (id) => calls.push({ name: "cancelAnimationFrame", arg: id });
  globalThis.requestAnimationFrame = () => 1;
  const realRevoke = globalThis.URL.revokeObjectURL;
  globalThis.URL.revokeObjectURL = (u) => {
    calls.push({ name: "revokeObjectURL", arg: u });
  };

  const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

  const rt = mod.createRuntime({});
  emitChild({ id: "gen-init", ok: rt.gen === 0, msg: "[9.1] 新 runtime 的代际必须从 0 开始", detail: `gen=${rt.gen}` });

  // 真装配期句柄的替身：每个回调都读**当下**的 rt.gen —— 于是「自增是否在最前」看得见
  const seen = [];
  rt.renderer = { dispose: () => seen.push({ what: "renderer.dispose", gen: rt.gen }) };
  rt.videoPairs = [{ destroy: () => seen.push({ what: "videoPairs.destroy", gen: rt.gen }) }];
  rt.sceneCleanup = () => seen.push({ what: "sceneCleanup", gen: rt.gen });
  rt.raf = 4242;
  rt.objectUrls = ["blob:fake/1"];

  mod.clear(rt);
  const idx = (n) => seen.findIndex((s) => s.what === n);
  const count = (n) => seen.filter((s) => s.what === n).length;
  emitChild({ id: "gen-first-clear", ok: rt.gen === 1, msg: "[9.2] 第一次 clear 必须把代际推到 1", detail: `gen=${rt.gen}` });
  emitChild({
    id: "gen-before-teardown",
    ok: seen.length === 3 && seen.every((s) => s.gen === 1),
    msg: "[9.3] 代际自增必须发生在同一轮**所有**拆卸动作之前（在飞的装配体只靠 rt.gen 判断自己作废）",
    detail: JSON.stringify(seen),
  });
  emitChild({
    id: "teardown-order",
    ok: idx("videoPairs.destroy") >= 0 && idx("videoPairs.destroy") < idx("sceneCleanup") && idx("sceneCleanup") < idx("renderer.dispose"),
    msg: "[9.4] 拆卸顺序：rAF/视频对 → sceneCleanup → renderer.dispose（清理抛错被 try/catch 吞，但顺序不能反）",
    detail: seen.map((s) => s.what).join(" → "),
  });
  emitChild({
    id: "raf-cancelled",
    ok: calls.some((c) => c.name === "cancelAnimationFrame" && c.arg === 4242),
    msg: "[9.5] clear 必须取消在跑的 rAF（否则旧场景继续往已拆的画布画）",
  });
  emitChild({
    id: "blob-revoked",
    ok: calls.some((c) => c.name === "revokeObjectURL" && c.arg === "blob:fake/1"),
    msg: "[9.6] clear 必须 revoke 旧场景的 blob URL",
  });
  emitChild({
    id: "fields-cleared",
    ok:
      rt.iframe === undefined &&
      rt.canvas === undefined &&
      rt.renderer === undefined &&
      rt.videoPairs === undefined &&
      rt.objectUrls === undefined &&
      rt.sceneCleanup === undefined &&
      rt.raf === undefined,
    msg: "[9.7] clear 后装配期句柄必须全部置空（留着等于把已拆的东西继续暴露给宿主）",
    detail: JSON.stringify({ iframe: rt.iframe ?? null, canvas: rt.canvas ?? null, renderer: rt.renderer ?? null, raf: rt.raf ?? null }),
  });

  mod.clear(rt);
  emitChild({ id: "gen-second-clear", ok: rt.gen === 2, msg: "[9.8] 第二次 clear 必须继续自增（1 → 2）", detail: `gen=${rt.gen}` });
  emitChild({
    id: "teardown-once",
    ok: count("renderer.dispose") === 1 && count("sceneCleanup") === 1,
    msg: "[9.9] 第二次 clear 不得重复 dispose（句柄已置空；重复 = 二次释放）",
    detail: `renderer.dispose=${count("renderer.dispose")} sceneCleanup=${count("sceneCleanup")}`,
  });

  if (realRevoke) globalThis.URL.revokeObjectURL = realRevoke;
}


console.log("\n[1] 代际令牌：Runtime.gen 由 clear() 自增");
{
  const shell = read("renderer/src/shell.ts");
  check(/gen\?: number;/.test(shell), "Runtime 类型必须声明 gen");
  check(/gen: 0,/.test(shell), "createRuntime 必须初始化 gen: 0");
  check(
    /export function clear\(rt: Runtime\) \{\s*rt\.gen = \(rt\.gen \?\? 0\) \+ 1/.test(shell),
    "clear() 必须**在最前面**自增 rt.gen（后半段会拆画布/iframe，任何在飞的装配体都不该再落地）",
  );
}

console.log("\n[2] mountWeb：两个 await 之后都要核对代际（双 load 孤儿 iframe 的根因）");
{
  const web = read("renderer/src/web.ts");
  check(/const g = rt\.gen;/.test(web), "mountWeb 的异步体必须捕获本代代际");
  const afterProject = /const defaults = await fetchProjectWire\(entry\);\s*\n\s*if \(g !== rt\.gen\) return;/.test(web);
  check(afterProject, "拉完 project wire 之后必须核对代际（否则两代都会 attachIframe）");
  const beforeAttach = /if \(g !== rt\.gen\) \{\s*URL\.revokeObjectURL\(blobUrl\);\s*return;\s*\}/.test(web);
  check(beforeAttach, "blobUrl 创建后、attachIframe 前必须再核对一次，并在放弃时 revoke（否则连内存都留）");
}

console.log("\n[3] SceneInstance：终态 + 代际 + 挂起收尾");
{
  const m = read("renderer/src/api/mount.ts");
  check(/let destroyed = false;/.test(m), "必须有 destroyed 终态标志");
  check(/const isCurrent = \(g: number\) => g === gen && !destroyed;/.test(m), "isCurrent 必须同时看代际与终态");
  check(
    /destroy\(opts\?: \{ releasePkgCache\?: boolean \}\) \{[\s\S]{0,400}?destroyed = true;\s*gen\+\+;/.test(m),
    "destroy() 必须**先**置终态并作废代际，**再**拆运行时（顺序反了会留复活窗口）",
  );
  // 终态语义是**明确拒绝**（不是静默 no-op）：destroy 已清掉 onDiagnostic，库形态下
  // 「no-op + 上报」仍是静默的，所以契约是拒绝 —— 守卫跟着契约走，改回 return 就红。
  const loadGuard =
    /if \(destroyed\) \{[\s\S]{0,400}?throw new Error\("实例已销毁[\s\S]{0,200}?const g = beginGen\(\)[\s\S]{0,300}?await resolveMountConfig[\s\S]{0,300}?if \(destroyed\) \{[\s\S]{0,200}?releaseOwnCanvas\(cfg[\s\S]{0,200}?throw new Error\("实例已销毁[\s\S]{0,200}?if \(!isCurrent\(g\)\) return;/.test(m);
  check(loadGuard, "load() 必须：终态拒绝 → 开新代 → await 后「destroyed 拒绝 + 回收自建画布 / 被取代静默退出」");
  const applyGuard =
    /const applyOptions = async \(o: MountOptions\) => \{[\s\S]{0,300}?throw new Error\("实例已销毁[\s\S]{0,300}?const g = beginGen\(\)[\s\S]{0,300}?if \(!isCurrent\(g\)\) return;/.test(m);
  check(applyGuard, "applyOptions() 同款：终态拒绝 + 开新代 + await 后核对");
  check(/const armFailure = \(g: number\)/.test(m) && /if \(isCurrent\(g\)\) reject\(e\);/.test(m), "armFailure 必须带代际（事件总线是实例级的，旧代失败会误伤新代）");
  check(/const armWatchdog = \(g: number\)/.test(m) && /if \(!isCurrent\(g\)\) return;/.test(m), "armWatchdog 必须带代际（被取代的那代不该再报超时）");
  // 只看代码：正则里**不能**带注释文本（stripComments 会把注释剥掉，带注释的模式永远不匹配
  // —— 这条守卫的第一版就这么错了一次）
  check(
    /const pending = settlePending;\s*settlePending = null;\s*pending\?\.\(\);/.test(m),
    "destroy() 必须收尾挂起的 mount()/load()（否则又变回「既不 resolve 也不 reject」的黑洞）",
  );
  check(/Object\.defineProperty\(err, "instance"/.test(m), "mount() 失败时必须把实例附在 err.instance（看门狗刻意不替调用方销毁，那就得让它拿得到句柄）");
}

console.log("\n[4] 旧代在飞的帧不得触发新代首帧（disposed 与 paused 必须分开）");
{
  for (const [file, tag] of [
    ["renderer/src/scene-mount.ts", "scene-mount"],
    ["renderer/src/media.ts", "media"],
  ]) {
    const src = read(file);
    const idx = src.indexOf("if (disposed) return;");
    const fire = src.indexOf("if (rt.onFirstFrame) {");
    check(idx >= 0 && fire >= 0 && idx < fire, `${tag}：触发 rt.onFirstFrame 之前必须有 disposed 早退`);
    check(
      /if \(disposed \|\| rt\.paused \|\| occlPaused\(rt\)\) return;/.test(src),
      `${tag}：disposed/paused 的合并早退仍在（paused 只是本代停着，首帧仍要落地）`,
    );
  }
}

console.log("\n[5] 画布所有权：建过 GL 的画布一律不复用");
{
  const m = read("renderer/src/api/mount.ts");
  check(/function ensureSceneCanvas\(el: HTMLElement\): HTMLCanvasElement/.test(m), "ensureSceneCanvas 不再有 reuse 捷径参数");
  check(
    /if \(existing\.getAttribute\("data-webwallgl-gl"\) !== "1"\) return existing;\s*existing\.remove\(\);/.test(m),
    "建过 GL 上下文（data-webwallgl-gl=1）的画布必须换新 —— loseContext 异步生效，复用即黑屏",
  );
}

console.log("\n[6] 多实例隔离：探针归属 / 补丁幂等 / 调试钩子门控（§3.4）");
{
  const shell = read("renderer/src/shell.ts");
  // 清理表必须含 2026-10 补的 6 个漏项（实测它们都在往 window 写）
  for (const k of ["__shared", "__effectScripts", "__memStats", "__animEventsFired", "__animEventLog", "__localAssets"]) {
    check(shell.includes(`"${k}"`), `探针清理表必须包含 ${k}`);
  }
  check(/const probeOwner = new Map<string, Runtime>\(\)/.test(shell), "必须有探针归属表（多实例时卸载 A 不该删 B 的调试面）");
  check(
    /if \(probeOwner\.get\(k\) !== rt\) continue;/.test(shell),
    "clearSceneDebugGlobals 必须按归属删（无条件全局 delete 会删掉还活着的实例的探针）",
  );
  check(/export function ownSceneDebugGlobals\(rt: Runtime\)/.test(shell), "必须导出归属登记入口");
  const sm = read("renderer/src/scene-mount.ts");
  check(/ownSceneDebugGlobals\(rt\);/.test(sm), "scene-mount 装配末尾必须登记探针归属");

  // console.warn 补丁：栈顶判定 + 已卸载层透传
  check(/if \(console\.warn === myWarn\) console\.warn = prevWarn;/.test(sm), "console.warn 补丁只在栈顶仍是自己时还原（否则会摘掉别的实例的补丁）");
  check(/if \(disposed\) return prevWarn\(\.\.\.args\);/.test(sm), "已卸载的那层补丁必须透传（不能把别人的日志上报到旧 rt）");

  // 调试钩子门控：三个语义钩子都要过 hooksOn()
  check(
    /const hooksOn = \(\) => \(rt\.debugHooks \?\? rt\.fullscreen\) === true;/.test(sm),
    "必须有 hooksOn（页面形态默认开、库实例默认关）",
  );
  check(/const noMaterialProps = hooksOn\(\) && /.test(sm), "__noMaterialProps 必须过门控");
  check(/if \(hooksOn\(\) && \(globalThis as any\)\.__noBuiltinMatTint\) return;/.test(sm), "__noBuiltinMatTint 必须过门控");
  check(/const patch = hooksOn\(\) \? /.test(sm), "__shaderPatch 必须过门控");
  const m = read("renderer/src/api/mount.ts");
  check(/rt\.debugHooks = o\.debugHooks === true;/.test(m), "库侧必须把 MountOptions.debugHooks 接到 rt（默认关）");
  const ty = read("renderer/src/api/types.ts");
  check(/debugHooks\?: boolean;/.test(ty), "MountOptions 必须暴露 debugHooks");
  check(/fullscreen: opts\?\.fullscreen === true,/.test(shell), "createRuntime 必须把 fullscreen 记在 rt 上（门控的判据）");
}

console.log("\n[7] GL 资源所有权（M3 作用域）：puppet 侧也要能枚举释放");
{
  const mdl = read("renderer/vendor/we-scene/render/mdl.js");
  check(/const liveMeshes = new Set\(\)/.test(mdl), "mdl 的网格缓存是 WeakMap（枚举不出来），必须另存可枚举的 liveMeshes 供释放");
  check(/liveMeshes\.add\(m\)/.test(mdl), "ensureMesh 必须把新建网格登记进 liveMeshes");
  check(
    /dispose\(\) \{[\s\S]{0,600}?gl\.deleteVertexArray\(m\.vao\)[\s\S]{0,300}?gl\.deleteProgram\(prog\)/.test(mdl),
    "mdl 必须提供 dispose（删 VAO/VBO + program）",
  );
  const sm = read("renderer/src/scene-mount.ts");
  check(/thisMdl\.dispose\?\.\(\)/.test(sm), "装配层必须在 sceneCleanup 里调 mdlRenderer.dispose()");
}

// ────────────── [8]/[9] 真行为（子进程 + 超时 + 堆上限 + 有界分配） ──────────────
// 为什么单列这两节：上面 [1]~[7] 全是源码正则守卫 —— 能证明「接线还在」，
// 证明不了「跑起来真的是这个行为」。本节把两条真行为路径拉到离线门禁里：
//   [8] 上下文丢失/恢复：真 renderer.js + 假 GL/假画布（不需要 GPU 与 DOM）；
//   [9] 装配-卸载代际：esbuild 现编 shell.ts → 真 createRuntime/clear。
// 每个用例一个子进程（见文件头的子进程模式说明），父进程按 JSON 行逐条判。
async function realLifecycleBehavior() {
  console.log("\n[8]/[9] 真行为（子进程 + 超时 + 堆上限）：上下文丢失/恢复 与 装配-卸载代际");
  const { spawnSync } = await import("node:child_process");
  const TIMEOUT_MS = 30000;
  const HEAP_CAP_KB = 32 * 1024;
  const CASES = [
    { id: "context-loss", heapMB: 128 },
    { id: "unmount-gen", heapMB: 512 },
  ];
  for (const c of CASES) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [`--max-old-space-size=${c.heapMB}`, fileURLToPath(import.meta.url), "--child", c.id], {
      timeout: TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const ms = Date.now() - t0;
    // 子进程被 OOM/信号带走时 stdout 可能半行截断：逐行容错解析，缺项自己会说话
    const rows = [];
    for (const line of (r.stdout || "").split("\n")) {
      const s = line.trim();
      if (!s.startsWith("{")) continue;
      try {
        rows.push(JSON.parse(s));
      } catch {
        /* 半行截断，忽略 */
      }
    }
    const died = !!r.error || r.signal !== null || r.status !== 0;
    check(
      !died,
      `[${c.id}] 子进程必须正常退出（exit=${r.status} signal=${r.signal || "-"} ${ms}ms 堆上限=${c.heapMB}MB${r.error ? " err=" + String(r.error.message).slice(0, 90) : ""}）—— 被信号带走/超时通常意味着被测路径退化`,
    );
    const meta = rows.find((x) => x.id === "__meta");
    check(rows.length >= 2 && !!meta, `[${c.id}] 子进程必须产出用例结果（实得 ${rows.length} 行；缺项通常意味着中途崩了）`);
    for (const row of rows) {
      if (row.id === "__meta") continue;
      check(row.ok === true, `${row.msg || row.id}${row.ok ? "" : ` ｜ 实得：${row.detail ?? "（无细节）"}`}`);
    }
    if (meta) {
      check(
        typeof meta.heapUsedDeltaKB === "number" && meta.heapUsedDeltaKB < HEAP_CAP_KB,
        `[${c.id}] 有界分配：子进程堆增量必须 < 32MB（实得 ${meta.heapUsedDeltaKB}KB）`,
      );
      if (!meta.ok) check(false, `[${c.id}] 子进程自报致命错误：${meta.detail}`);
    }
    if (r.stderr && r.stderr.trim()) console.error(`  · [${c.id}] 子进程 stderr：${r.stderr.trim().split("\n")[0].slice(0, 160)}`);
  }
}

await realLifecycleBehavior();

console.log(failed === 0 ? "\nverify-lifecycle: 全部通过 ✓" : `\nverify-lifecycle: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
