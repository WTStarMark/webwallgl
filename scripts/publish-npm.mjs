#!/usr/bin/env node
/**
 * npm 发布：build:lib 产出的三个包目录（docs/EDITOR-PLAN.md §0.5），按依赖顺序发布：
 *   dist/lib-core    → @webwallgl/core
 *   dist/lib         → webwallgl
 *   dist/lib-editor  → @webwallgl/editor（peerDependencies 锁同版本 webwallgl，必须排在它后面）
 *
 *   npm run publish:npm                 # 构建 + 预检 + 发布
 *   npm run publish:npm -- --dry-run    # 只看会发什么，不真发
 *   npm run publish:npm -- --latest     # 预发布版本也打 latest tag（默认打 beta）
 *   node scripts/publish-npm.mjs --otp=123456   # 2FA 验证码（非交互终端时用）
 *
 * 同版本已发布的包直接跳过（中途失败后重跑可以续发剩下的）；三个都已发布才报错。
 *
 * CI（GitHub Actions 打标签触发）：node scripts/publish-npm.mjs --ci
 *   走 npm 可信发布（Trusted Publishing / OIDC）：不查登录、不落长期 token，
 *   发布时由 npm 用 GitHub OIDC 现场换取短期凭证；npmjs 上**每个包**都要登记
 *   本仓库 + 工作流文件名，且 npm >= 11.5.1。npm 只允许给已存在的包登记，
 *   所以 @webwallgl/core、@webwallgl/editor 的首个版本要先在本机手动发一次。
 *
 * 前置（本机一次性）：npm login --registry https://registry.npmjs.org 完成浏览器授权；
 * npm 上已建好 webwallgl 组织（作用域包 @webwallgl/*）。
 * 注意：本机 ~/.npmrc 默认走 npmmirror 镜像（装包用），镜像站不能发布，
 * 本脚本所有 registry 调用都显式指定官方源，不影响日常装包。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY = "https://registry.npmjs.org/";
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const forceLatest = argv.includes("--latest");
const ci = argv.includes("--ci");
// 账号开了 2FA 且不在交互终端时（npm 无法拉起浏览器授权）：--otp=123456 透传给 npm publish
const otp = argv.find((a) => a.startsWith("--otp="))?.slice("--otp=".length);

const PACKAGES = [
  { dir: join(root, "dist", "lib-core"), need: ["webwallgl-core.mjs", "index.d.ts", "types.d.ts", "LICENSE"] },
  {
    dir: join(root, "dist", "lib"),
    need: [
      "webwallgl.mjs",
      "webwallgl.global.min.js",
      "webwallgl.d.ts",
      "types.d.ts",
      "README.md",
      "LICENSE",
      "imgs/wechat.png",
      "imgs/alipay.png",
    ],
  },
  { dir: join(root, "dist", "lib-editor"), need: ["webwallgl-editor.mjs", "index.d.ts", "types.d.ts", "LICENSE"] },
];

// ---- 预检 1：发布物完整（缺任何一件都不发）----
const missing = [];
for (const p of PACKAGES) {
  for (const f of ["package.json", ...p.need]) if (!existsSync(join(p.dir, f))) missing.push(join(p.dir, f));
}
if (missing.length) throw new Error(`发布物缺文件（先跑 npm run build:lib）：\n  ${missing.join("\n  ")}`);
for (const p of PACKAGES) p.pkg = JSON.parse(readFileSync(join(p.dir, "package.json"), "utf8"));

const versions = new Set(PACKAGES.map((p) => p.pkg.version));
if (versions.size !== 1) throw new Error(`三个包版本不一致：${[...versions].join(" / ")}`);
const version = PACKAGES[0].pkg.version;

// ---- 预检 2：registry 上已有同名版本的跳过（npm 不允许同版本覆盖）----
const isPublished = (name) => {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version", "--registry", REGISTRY], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false; // 404 = 未占用，正常
  }
};
const todo = PACKAGES.filter((p) => {
  if (!isPublished(p.pkg.name)) return true;
  console.log(`跳过 ${p.pkg.name}@${version}：已发布`);
  return false;
});
if (!todo.length) {
  // CI 由打标签触发：本机已手动发完同版本时标签照推，不算失败
  if (ci) {
    console.log(`三个包的 ${version} 都已发布，无事可做`);
    process.exit(0);
  }
  throw new Error(`三个包的 ${version} 都已发布过 —— npm 不允许同版本覆盖，先升版本再发布`);
}

if (dryRun) {
  console.log(`--dry-run：跳过登录检查，只看打包清单（${version}）`);
} else if (ci) {
  // 可信发布：凭证在 publish 时用 GitHub OIDC 现场换取，whoami 无从验证；
  // 发布者身份由 npmjs 的 Trusted Publisher 登记（仓库 + 工作流文件名）保证。
  console.log("CI 可信发布：跳过登录预检（OIDC 在 publish 时换取短期凭证）");
} else {
  // ---- 预检 3：已登录 npm（官方源）----
  try {
    const who = execFileSync("npm", ["whoami", "--registry", REGISTRY], { encoding: "utf8" }).trim();
    console.log(`npm 账号：${who}（registry.npmjs.org）`);
  } catch {
    throw new Error("未登录 npm 官方源 —— 先执行：npm login --registry https://registry.npmjs.org");
  }
}

// ---- dist-tag：预发布版本（1.0.0-beta1 这类）默认打 beta，避免 npm i webwallgl 拉到测试版 ----
const pre = version.includes("-");
const tag = pre && !forceLatest ? "beta" : "latest";
if (pre) {
  console.log(
    forceLatest
      ? `预发布版本 ${version}，按 --latest 要求打 latest tag`
      : `预发布版本 ${version} → dist-tag beta（用户装 npm i webwallgl@beta）`,
  );
}

for (const p of todo) {
  const args = ["publish", p.dir, "--access", "public", "--tag", tag, "--registry", REGISTRY];
  if (dryRun) args.push("--dry-run");
  if (otp) args.push(`--otp=${otp}`);
  const shown = args.map((a) => (a.startsWith("--otp=") ? "--otp=******" : /[\s/]/.test(a) ? JSON.stringify(a) : a));
  console.log(`\n> npm ${shown.join(" ")}\n`);
  execFileSync("npm", args, { stdio: "inherit" });
  if (!dryRun) console.log(`已发布 ${p.pkg.name}@${version}（tag: ${tag}）`);
}
if (!dryRun) {
  console.log(`\n  npm: https://www.npmjs.com/package/webwallgl`);
  console.log(`  jsDelivr CDN: https://cdn.jsdelivr.net/npm/webwallgl@${version}/webwallgl.global.min.js`);
}
