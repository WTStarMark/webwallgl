// .glsl / .vert / .frag 源文件的模块形态（issue #14）。
// 构建期由 scripts/lib/glsl-plugin.mjs（Vite）或 scripts/build-plugin-sdk.mjs（esbuild）
// 转成「默认导出 = 该文件文本」的 JS 模块；打包时剥掉 GLSL 注释/空行（契约注释保留）。
// dev server 走同一插件，行为一致。
declare module "*.glsl" {
  /** GLSL 源码文本（打包时已剥掉普通注释与空行，`// {"material":…}` 契约注释保留） */
  const source: string;
  export default source;
  export { source };
}

declare module "*.vert" {
  const source: string;
  export default source;
  export { source };
}

declare module "*.frag" {
  const source: string;
  export default source;
  export { source };
}
