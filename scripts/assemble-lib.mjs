#!/usr/bin/env node
/**
 * 库发布物组装（docs/LIBRARY-PLAN.md 第 6 步）。三个 npm 包，各一个目录、各一份 package.json：
 *
 *   dist/lib/         webwallgl
 *     webwallgl.mjs（可读 ESM，mediabunny 走 dependency）/ webwallgl.global.min.js（UMD，自包含）
 *     webwallgl.d.ts / types.d.ts / README.md / LICENSE / imgs/
 *   dist/lib-core/    @webwallgl/core
 *     webwallgl-core.mjs / index.d.ts / types.d.ts / LICENSE
 *   dist/lib-editor/  @webwallgl/editor（peerDependencies 锁死同版本 webwallgl）
 *     webwallgl-editor.mjs / index.d.ts / types.d.ts / LICENSE
 *
 * tsc 从 api/types.ts（公共类型唯一真源，零 import）生成类型声明到 dist/lib/types/，
 * 本脚本拷进三个包；UMD 用 esbuild 压成 .min 后删掉可读版。npm 包不带 sourcemap。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

// `.pathname` 在 Windows 上是 "/D:/..."，join 后成 "\D:\..."，
// 会让后续 existsSync / esbuild 全部找不到文件。必须 fileURLToPath。
const root = fileURLToPath(new URL("..", import.meta.url));
const libDir = join(root, "dist", "lib");
const coreDir = join(root, "dist", "lib-core");
const editorDir = join(root, "dist", "lib-editor");
const apiDir = join(root, "renderer", "src", "api");

for (const f of [
  join(libDir, "webwallgl.mjs"),
  join(libDir, "webwallgl.global.js"),
  join(coreDir, "webwallgl-core.mjs"),
  join(editorDir, "webwallgl-editor.mjs"),
]) {
  if (!existsSync(f)) throw new Error(`缺少 ${f} —— 先跑 npm run build:lib`);
}

// tsc 产物：dist/lib/types/types.d.ts（rootDir 折叠后直接落在 types/ 下）
const emitted = join(libDir, "types", "types.d.ts");
if (!existsSync(emitted)) {
  throw new Error("缺少 tsc 类型产物 —— 先跑 tsc -p tsconfig.lib-types.json");
}
const typesDts = readFileSync(emitted, "utf8");
rmSync(join(libDir, "types"), { recursive: true, force: true });

// 播放包：entry.d.ts 里 `from "./types"` 正好解析到同目录的 types.d.ts
writeFileSync(join(libDir, "webwallgl.d.ts"), readFileSync(join(apiDir, "entry.d.ts"), "utf8"));
writeFileSync(join(libDir, "types.d.ts"), typesDts);

// 公共包 / 编辑器包：手写契约类型改名为包内 index.d.ts；编辑器包对播放包的
// re-export（源码里写 "./webwallgl"，便于仓内比对）改写成包名 "webwallgl"
writeFileSync(join(coreDir, "index.d.ts"), readFileSync(join(apiDir, "core.d.ts"), "utf8"));
writeFileSync(join(coreDir, "types.d.ts"), typesDts);
const editorDts = readFileSync(join(apiDir, "editor.d.ts"), "utf8").replace(
  /from\s+(["'])\.\/webwallgl\1/g,
  'from "webwallgl"',
);
if (/["']\.\/webwallgl["']/.test(editorDts)) throw new Error("editor.d.ts 里仍有 ./webwallgl 引用未改写");
writeFileSync(join(editorDir, "index.d.ts"), editorDts);
writeFileSync(join(editorDir, "types.d.ts"), typesDts);

// UMD 可读版 → 压缩版。**不能传 format**：给 transform 指定 format:"iife" 会把 UMD 源码
// 整个包进 esbuild 的 __commonJS 闭包，闭包内部存在局部 module/exports，
// UMD 探测走 CommonJS 分支把 API 挂到内部 shim 上，globalThis.WebWallGL
// 永远不会被赋值 —— <script> 引入后报「WebWallGL is not defined」且无任何报错。
// 不传 format 时 esbuild 只做纯压缩，UMD 包装原样保留。
{
  const umd = join(libDir, "webwallgl.global.js");
  const result = await esbuild.transform(readFileSync(umd, "utf8"), {
    minify: true,
    sourcefile: "webwallgl.global.js",
    loader: "js",
    legalComments: "none",
    // 非 ASCII 直接以 UTF-8 落地。默认 charset:"ascii" 会把中文字符串转义成 `\uXXXX`
    // （每个汉字 6 字节 vs 3 字节），而且**看起来像漏剥的注释**。
    charset: "utf8",
  });
  writeFileSync(join(libDir, "webwallgl.global.min.js"), result.code);
  rmSync(umd);
}

// README 只随播放包（npm 包页渲染）；README 里的收款码走 jsDelivr 绝对地址，图片另拷一份进包内 imgs/
copyFileSync(join(root, "README.md"), join(libDir, "README.md"));
for (const dir of [libDir, coreDir, editorDir]) copyFileSync(join(root, "LICENSE"), join(dir, "LICENSE"));
mkdirSync(join(libDir, "imgs"), { recursive: true });
for (const img of readdirSync(join(root, "public", "imgs"))) {
  copyFileSync(join(root, "public", "imgs", img), join(libDir, "imgs", img));
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const common = {
  version: pkg.version,
  license: "MIT",
  author: pkg.email ? `${pkg.author} <${pkg.email}>` : pkg.author,
  // 仓库元数据取自根 package.json，npm 包页据此回链 GitHub
  ...(pkg.repository ? { repository: pkg.repository } : {}),
  ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
  ...(pkg.bugs ? { bugs: pkg.bugs } : {}),
  type: "module",
  sideEffects: false,
};
const KEYWORDS = ["wallpaper-engine", "wallpaper", "webgl", "renderer", "scene", "browser"];
const writePkg = (dir, body) => writeFileSync(join(dir, "package.json"), JSON.stringify(body, null, 2) + "\n");

// 打包器走 import → 可读 ESM（bundler 自行压缩）；script/CDN 默认走压缩 UMD
writePkg(libDir, {
  name: "webwallgl",
  description: "Wallpaper Engine scene wallpaper renderer for the browser (npm / CDN)",
  ...common,
  keywords: [...KEYWORDS, "canvas", "animated-background", "particles"],
  files: ["webwallgl.mjs", "webwallgl.global.min.js", "webwallgl.d.ts", "types.d.ts", "imgs"],
  main: "./webwallgl.global.min.js",
  module: "./webwallgl.mjs",
  types: "./webwallgl.d.ts",
  unpkg: "./webwallgl.global.min.js",
  jsdelivr: "./webwallgl.global.min.js",
  exports: {
    ".": {
      types: "./webwallgl.d.ts",
      import: "./webwallgl.mjs",
      default: "./webwallgl.global.min.js",
    },
    "./package.json": "./package.json",
  },
  dependencies: { mediabunny: pkg.dependencies.mediabunny },
});

writePkg(coreDir, {
  name: "@webwallgl/core",
  description: "WebWallGL engine core: Wallpaper Engine .pkg / .tex decoding and fit math (zero dependencies)",
  ...common,
  keywords: [...KEYWORDS, "pkg", "tex"],
  files: ["webwallgl-core.mjs", "index.d.ts", "types.d.ts"],
  module: "./webwallgl-core.mjs",
  types: "./index.d.ts",
  exports: {
    ".": { types: "./index.d.ts", default: "./webwallgl-core.mjs" },
    "./package.json": "./package.json",
  },
  publishConfig: { access: "public" },
});

// 编辑器包与播放包共享内部 Runtime 形状（runtime-link），版本必须严格一致；
// 用 peer 而非 dependency：消费方自己也装了 webwallgl 时必须共用那一份，不能再装第二份引擎
writePkg(editorDir, {
  name: "@webwallgl/editor",
  description: "WebWallGL editor API: editable scene graph, picking, frame capture, .pkg export (superset of webwallgl)",
  ...common,
  keywords: [...KEYWORDS, "editor"],
  files: ["webwallgl-editor.mjs", "index.d.ts", "types.d.ts"],
  module: "./webwallgl-editor.mjs",
  types: "./index.d.ts",
  exports: {
    ".": { types: "./index.d.ts", default: "./webwallgl-editor.mjs" },
    "./package.json": "./package.json",
  },
  peerDependencies: { webwallgl: pkg.version },
  publishConfig: { access: "public" },
});

console.log("dist 组装完成：webwallgl（dist/lib）/ @webwallgl/core（dist/lib-core）/ @webwallgl/editor（dist/lib-editor）");
