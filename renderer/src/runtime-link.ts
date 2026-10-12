// 公共实例 → 内部 Runtime 的私有关联。播放包的 SceneInstance 不暴露 rt；
// 编辑器包（api/editor）经这里取回 rt.sceneCtl.editor，播放宿主零感知。
//
// 表挂在 globalThis 的全局 Symbol 上：npm 拆包后 @webwallgl/editor 自带一份本模块，
// 与 webwallgl 里那份必须共用同一张表，否则 editorOf 永远取不到 rt。
import type { Runtime } from "./shell";

const KEY = Symbol.for("webwallgl.runtime-link");
const g = globalThis as { [KEY]?: WeakMap<object, Runtime> };
const links = (g[KEY] ??= new WeakMap<object, Runtime>());

export function linkRuntime(instance: object, rt: Runtime): void {
  links.set(instance, rt);
}

export function runtimeOf(instance: object): Runtime | undefined {
  return links.get(instance);
}
