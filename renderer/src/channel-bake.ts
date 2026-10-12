/**
 * channel-bake —— 「通道图烘焙子网格」判定：这类几何**不上可见画布**。
 *
 * 现象（3441873795 Kirby，issue #184「右上角有一个裂开的主体」）：
 *   `Kirby_puppet.mdl` 有 **2 个子网格**：
 *     · mesh0 = 391 顶点，材质 `genericimage3`、贴图 `Kirby`（1484×1391 美术图）—— 画面上的角色；
 *     · mesh1 = **8 顶点 = 两个四边形**，材质 shader `puppettexturechannels`（官方通道图烘焙
 *       着色器），槽 0 贴图 `Kirby_channelmap`（**226×175**）。
 *   两个四边形按 **1:1 像素**覆盖那张通道图：宽度 96 + 130 = **226**，UV 在 u = 0.4248
 *   （= 96/226）处切开；位置停在模型**右上角**（模型包围盒 x∈[-647,646]、y∈[-600.5,599.5]，
 *   四边形却在 x∈[443,745]、y∈[431,650]）—— 这是 WE 编译器的「图集散开位」。
 *   官方 Wallpaper Engine 桌面端同一位置**干净**：这类几何是烘焙目标，不是画面。
 *
 * 本仓此前把它当普通网格画到画布上，于是屏幕上出现两个缩小、被竖直硬边切开的角色拷贝
 * （通用网格路径没透传逐子网格贴图 ⇒ 槽 0 回落成整层贴图 = 美术图，所以看到的是「角色
 * 碎片」而不是粉色的通道图本身）。
 *
 * 判据**刻意保守**（宁可漏判成"多画一块"，也不误伤真几何）：
 *   ① `meshCount >= 2`：单子网格的 2D puppet 主材质本来就可能是 `puppettexturechannels`
 *      （见 effects-parse 的 `isEngineMeshShader`），那种情况不许碰；
 *   ② 该子网格材质 `passes[0].shader` 归一化后 === `puppettexturechannels`；
 *   ③ 材质路径 / 槽 0 贴图名含 `channelmap`（WE 编译器生成的通道图命名）；
 *      **或**兜底：顶点数 ≤ 16 且该网格在任一轴超出 mesh0 包围盒 2% 以上（停在散开位）。
 *
 * 范围：只决定「不在可见画布上画」。真正的通道图烘焙（离屏 RT + puppet warp 逐像素形变）
 * 是另一件事，本模块不做 —— 判出也不改变任何离屏行为。
 */

/** 轴对齐包围盒（模型局部坐标，Y 向上，与 scene.json 同口径）。 */
export interface MeshBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 从顶点位置数组（x,y,z 交错）算 AABB；空/非法数据返回 null。 */
export function boxOfVertices(positions: ArrayLike<number> | null | undefined): MeshBox | null {
  if (!positions || positions.length < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, maxX, minY, maxY };
}

/** 兜底判据：散开位至少要超出基础包围盒的这个比例才算（相对 mesh0 的宽/高）。 */
const ESCAPE_RATIO = 0.02;
/** 兜底判据的顶点数上限：烘焙件是覆盖 RT 的少量四边形。 */
const PATCH_MAX_VERTS = 16;

const norm = (s: unknown): string => (typeof s === "string" ? s.toLowerCase() : "");

/** 通道图命名信号：材质路径或槽 0 贴图名里带 channelmap。 */
export function hasChannelMapName(materialPath?: string | null, texture0?: string | null): boolean {
  return norm(materialPath).includes("channelmap") || norm(texture0).includes("channelmap");
}

/** 该包围盒是否在任一轴上超出基础包围盒 2% 以上（= 停在「图集散开位」）。 */
export function escapesBox(self: MeshBox | null | undefined, base: MeshBox | null | undefined): boolean {
  if (!self || !base) return false;
  const padX = Math.max(1, base.maxX - base.minX) * ESCAPE_RATIO;
  const padY = Math.max(1, base.maxY - base.minY) * ESCAPE_RATIO;
  return (
    self.minX < base.minX - padX ||
    self.maxX > base.maxX + padX ||
    self.minY < base.minY - padY ||
    self.maxY > base.maxY + padY
  );
}

/**
 * 这个子网格是不是「通道图烘焙件」（判据与理由见文件头注）。
 * 纯函数、无 DOM / 无 GL，离线判据（scripts/verify-channel-bake.mjs）直接调。
 */
export function isChannelBakeSubMesh(args: {
  /** 模型子网格总数 */
  meshCount: number;
  /** 该子网格材质 passes[0].shader */
  shader?: string | null;
  /** 该子网格的材质 json 路径 */
  materialPath?: string | null;
  /** 该子网格材质 passes[0].textures[0] */
  texture0?: string | null;
  /** 该子网格顶点数 */
  vertexCount?: number;
  /** 该子网格的 AABB */
  selfBox?: MeshBox | null;
  /** mesh0 的 AABB */
  baseBox?: MeshBox | null;
}): boolean {
  if (!(args.meshCount >= 2)) return false;
  if (norm(args.shader) !== "puppettexturechannels") return false;
  if (hasChannelMapName(args.materialPath, args.texture0)) return true;
  const verts = Number(args.vertexCount);
  if (!(verts > 0 && verts <= PATCH_MAX_VERTS)) return false;
  return escapesBox(args.selfBox, args.baseBox);
}

/**
 * 从**已解析的 MDL** 直接算出每个子网格是否「通道图烘焙件」（要读材质时用调用方给的读法）。
 * 返回 null = 一个都没命中（渲染侧拿到 null 就是改动前行为）。
 *
 * 为什么要有这一份：装配侧有**两条**分支（`layer.model` 的 3D 模型层 / `layer.image` 的 2D
 * 木偶层），两条都会把模型挂到图层上，判定只能有一份 —— 3441873795 的 Kirby 走的是 2D 那条，
 * 只在 3D 分支里判会**静默失效**（实测：页面里 `layer.meshSkip === null`，碎片照画）。
 */
export async function channelBakeSkipFlags(
  mdl: { meshes?: Array<{ materialPath?: string | null; vertexCount?: number; positions?: ArrayLike<number> } | null> | null } | null | undefined,
  readAsset: (path: string) => Promise<unknown>,
  // 走 any：调用方的 readMaterialDoc 收 Uint8Array（与 scene-mount 的既有签名逐位对齐），
  // 这里只关心它返回的 passes[0].shader / textures。
  readMaterialDoc: (entry: any) => { passes?: Array<{ shader?: string; textures?: Array<string | null> }> } | null | undefined,
): Promise<boolean[] | null> {
  const meshes = mdl?.meshes;
  if (!meshes || meshes.length < 2) return null;
  const flags: boolean[] = new Array(meshes.length).fill(false);
  const baseBox = boxOfVertices(meshes[0]?.positions);
  let hit = false;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    const materialPath = mesh?.materialPath ?? null;
    if (!materialPath) continue;
    let pass0: { shader?: string; textures?: Array<string | null> } | null = null;
    try {
      const entry = await readAsset(materialPath);
      if (entry) pass0 = readMaterialDoc(entry)?.passes?.[0] ?? null;
    } catch {
      pass0 = null; // 材质读不到就按「不认识」处理（判据 ③ 的兜底条款仍然有效）
    }
    if (isChannelBakeSubMesh({
      meshCount: meshes.length,
      shader: pass0?.shader,
      materialPath,
      texture0: Array.isArray(pass0?.textures) ? pass0.textures[0] : null,
      vertexCount: mesh?.vertexCount,
      selfBox: boxOfVertices(mesh?.positions),
      baseBox,
    })) {
      flags[i] = true;
      hit = true;
    }
  }
  return hit ? flags : null;
}
