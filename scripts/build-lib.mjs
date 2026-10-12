#!/usr/bin/env node
/**
 * 库构建：三个 npm 包（docs/EDITOR-PLAN.md §0.5），各写各的目录：
 *   dist/lib/         webwallgl          播放包（宿主 WallpaperEM 的 file: 依赖落点，路径不能动）
 *   dist/lib-core/    @webwallgl/core    引擎底座（pkg/.tex 解码、fitWindow），自包含 ESM
 *   dist/lib-editor/  @webwallgl/editor  编辑器增量；`webwallgl` 走 external，不再内联第二份引擎
 *
 * 为什么是脚本而不是 `vite -c` 配置文件：Vite 6 的配置文件只接受单对象，多次构建用 JS API
 * 顺序调用最直接。每个配置必须 configFile:false，否则会自动加载 vite.config.ts
 * （站点构建配置）把 editor/main 全卷进来。
 *
 * 发布体积约束（npm 包曾到 38 MB）：
 *   - 不出 sourcemap（npm 不带 .map）；
 *   - 播放包 ESM 把 mediabunny 留给 bundler（作为 dependency 安装）；UMD 是 <script> CDN
 *     入口，没有模块解析，只能内联；
 *   - 只出可读 ESM（bundler 自行压缩）与 UMD；UMD 由 assemble-lib.mjs 压成 .min 后删掉可读版。
 */
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { glslPlugin, embeddedGlslPlugin } from "./lib/glsl-plugin.mjs";
import { minRawJsPlugin } from "./lib/min-raw-plugin.mjs";

const entry = (p) => fileURLToPath(new URL(`../renderer/src/api/${p}`, import.meta.url));
const PLAYER_ENTRY = entry("index.ts");

const base = (outDir, emptyOutDir, external = []) => ({
  configFile: false,
  publicDir: false, // 库产物不带 public/（降级页等属宿主资产）
  // .glsl 独立文件在打包期转 JS 模块并剥掉 GLSL 注释/空行（issue #14）；
  // 嵌在 JS/TS 模板串里的 GLSL 与 `?raw` 的 web-shim 同理 —— 压缩器看不见字符串内容
  plugins: [glslPlugin(), embeddedGlslPlugin(), minRawJsPlugin()],
  build: {
    target: "es2022",
    outDir,
    emptyOutDir,
    minify: false,
    sourcemap: false,
    rollupOptions: { external },
  },
});

const isMediabunny = (id) => id === "mediabunny" || id.startsWith("mediabunny/");

// 编辑器包里 `export * from "./index"` 指向播放包公共面 —— 改写成对 webwallgl 的外部引用，
// 否则 rollup 会把整个播放引擎再打一遍
function playerAsExternal() {
  return {
    name: "we-player-external",
    enforce: "pre",
    async resolveId(source, importer, opts) {
      if (source === "webwallgl") return { id: "webwallgl", external: true };
      if (!importer || !source.startsWith(".")) return null;
      const r = await this.resolve(source, importer, { ...opts, skipSelf: true });
      if (r && r.id === PLAYER_ENTRY) return { id: "webwallgl", external: true };
      return null;
    },
  };
}

// ① 播放包 ESM（webwallgl.mjs，npm + bundler 主路径）。唯一清空 dist/lib 的构建。
const playerEs = base("dist/lib", true, isMediabunny);
playerEs.build.lib = {
  entry: PLAYER_ENTRY,
  formats: ["es"],
  fileName: () => "webwallgl.mjs",
};

// ② 播放包 UMD（全局变量 WebWallGL，<script> CDN 入口）：依赖全部内联
const playerUmd = base("dist/lib", false);
playerUmd.build.lib = {
  entry: PLAYER_ENTRY,
  name: "WebWallGL",
  formats: ["umd"],
  fileName: () => "webwallgl.global.js",
};

// ③ 公共包（@webwallgl/core）
const core = base("dist/lib-core", true);
core.build.lib = {
  entry: entry("core.ts"),
  formats: ["es"],
  fileName: () => "webwallgl-core.mjs",
};

// ④ 编辑器包（@webwallgl/editor）：播放面从 webwallgl re-export，自身只含编辑器实现
const editor = base("dist/lib-editor", true, isMediabunny);
editor.plugins = [playerAsExternal(), ...editor.plugins];
editor.build.lib = {
  entry: entry("editor.ts"),
  formats: ["es"],
  fileName: () => "webwallgl-editor.mjs",
};

for (const [name, cfg] of [
  ["① 播放包 ESM（webwallgl）", playerEs],
  ["② 播放包 UMD（webwallgl）", playerUmd],
  ["③ 公共包（@webwallgl/core）", core],
  ["④ 编辑器包（@webwallgl/editor）", editor],
]) {
  console.log(`[build-lib] ${name} …`);
  await build(cfg);
}
console.log("[build-lib] 三包构建完成 → dist/lib/ · dist/lib-core/ · dist/lib-editor/");
