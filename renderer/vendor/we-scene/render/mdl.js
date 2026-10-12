// [we-scene patch] MDL（Puppet Warp 骨骼网格）解析与渲染
// 格式（依据本机壁纸库 23 个 MDLV0023 模型实测得到，全部校验通过）：
//   MDLV0023 头
//     0x00  char[8]   "MDLV0023"
//     0x15  cstr      材质路径（如 "materials/01腿-后.json"）
//     +32   u32       顶点区字节数（= vertexCount × 80）★ 相对材质路径 null 之后
//             常见顶点 80B：pos vec3 @0 / boneIdx u32×4 @40 / weights f32×4 @56 / uv vec2 @72
//             新版 84B（formatMarker 0x0181000e）：boneIdx@44 / weights@60 / uv@76
//     后接  u32       索引区字节数，随后 u16 索引
//   MDLS0004 骨架（魔数 + u8 + u32 nextOff + u32 boneCount，逐骨条目）
//     每骨：u8 flag / u32 id / i32 parent / u32 matSize(=64) / f32[16] 绑定矩阵 / cstr JSON
//     绑定矩阵为**列主序**（平移在 [12],[13],[14]），与 WebGL 一致。
//   MDLA0006 动画（魔数 + u8 + u32 endPos + u32 animCount，逐动画条目）
//     每动画：u32 id / u32 unk / cstr 名称 / cstr 模式("loop") / f32 fps
//             u32 frameCount / u32 unk / u32 trackCount
//             每轨：u32 boneId / u32 trackBytes / 关键帧×(trackBytes/36)
//               关键帧 36B：f32[3] 平移 / f32[4] 四元数 xyzw / f32[2] 缩放 xy
//             动画条目末尾固定 35B 填充（据此 endPos 与实际游标精确吻合）
//     关键帧存**绝对局部变换**：frame 0 的平移与绑定矩阵平移完全相等
//     ⇒ 蒙皮矩阵 = World(anim) · World(bind)⁻¹，frame 0 为单位变换。
// 网格坐标 = 图层局部像素、**Y 轴朝上**；UV 与之精确对应：
//     u = (x + W/2) / W ,  v = (H/2 - y) / H   （W/H = 图层 size，实测误差 0）
// 因此渲染时把 y 取反即回到 y-down 的场景世界空间（与 renderer.js 的层空间一致）。
// 历史 bug（导致「人物不动 + 贴图错乱」）：
//   1) 顶点区偏移硬编码 0x47，实际为「材质路径长度 + 32」，材质路径长短不同即错位
//      → 顶点/UV 全部读到错误字节 = 贴图错乱；
//   2) 骨骼矩阵按行主序解读（实为列主序），且要求 MDLE 块存在，
//      多数模型没有 MDLE 便直接返回未蒙皮顶点；
//   3) MDLA 动画块完全未解析 = 人物不动。

// [we-scene patch] 模块结构（本仓库拆分，见 docs/ARCHITECTURE.md）：
//   mdl-math.js  列主序 4x4 工具 + 二进制读取原语
//   mdl-parse.js MDLV/MDLS/MDLA/MDLE 二进制解析
//   mdl-skin.js  关键帧采样 + 蒙皮矩阵求值
//   mdl.js       本文件：GPU 预算 + shader 源 + createMDLRenderer + 公共出口
// 以下 re-export 维持既有 import 方（main.ts / verify-*.mjs）的路径不变。
import { parseMDL } from './mdl-parse.js'
import { linkProgram } from './gl-util.js'
import { computeSkinMatrices, computeBoneAlphas, bindWorldOf, mat4MulOut, attachmentWorld, attachmentBind, attachmentEffectiveOffset, parentMeshToWorldDelta, applyAttachmentBindOrigins, followAttachments, skinnedMeshes } from './mdl-skin.js'
import { IDENTITY } from './mdl-math.js'


// 蒙皮上限。此前设为 24 并注明「实测最多 16 骨」，实际本机库里 WLOP DOME GIRL 有 64 骨、
// Lucy 有 61 骨：超限骨骼在顶点着色器里被 `bi >= u_boneCount` 跳过，权重丢失，
// 顶点落到错误位置 —— 表现为人物五官/头发/躯体撕裂错位。
// WebGL2 只保证 MAX_VERTEX_UNIFORM_VECTORS ≥ 256 个 vec4（mat4 占 4 个 → 64 骨），
// 但实测本机 ANGLE/Metal 上报 1024。故不写死上限：createMDLRenderer 按 GPU 实际
// 上报值算出可用骨数（留 32 个 vec4 给 u_mvp 等），链接失败时逐级减半回退。
const MAX_BONES_HARD_CAP = 128
const MAX_BONES_FLOOR = 24

function boneBudget(gl) {
  const vecs = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) || 256
  // [we-scene patch 2026-10-12] 每骨 1 个 mat4（4 个 vec4）+ 1 个 float（u_boneAlpha）。
  // 标量数组按 4 个元素占一个 vec4 计 ⇒ 每骨 4.25；这里按「每个标量元素独占一个 vec4」
  // 保守取 5，避免驱动链接失败。本机上报 1024 个 vec4，(1024-32)/5 = 198 > 硬上限 128，
  // 所以本机骨预算与改动前逐位一致；只有 < 640 个 vec4 的设备才会少几根骨。
  const usable = Math.floor((vecs - 32) / 5)
  return Math.max(MAX_BONES_FLOOR, Math.min(MAX_BONES_HARD_CAP, usable))
}

// 顶点着色器在 GPU 上做蒙皮。网格坐标为「图层局部像素、y 轴朝上」，
// u_mvp 由宿主构造（含 y 方向、图层旋转缩放、场景投影）。
// u_keepZ：顶点 z 是否参与投影。**默认 0 = 压平到 z=0**，这是 2D puppet 的正确行为
// —— 那类网格坐标是图层局部像素，z 只是建模残留（本机库 3737267090 的
// 人物网格 z∈[111,435]，是「贴图平面」之外的建模偏移，放过去会让它按深度被
// 其它层挡住）。透视场景（3509243656 三体）里的真 3D 网格必须保留 z，否则
// 球体被压成过相机的一张薄片：天空盒（半径 8 的球心就在相机上）只剩一条边、
// 星空铺不满，星芒球变成边缘朝上的小点 —— 整个画面近乎全黑。
// UV 恒等直传：朝向差异一律由 u_mvp 的几何翻转表达，翻 UV 会把贴图镜像到未翻转的网格上。
const mdlVertSrc = (maxBones) => `#version 300 es
in vec3 a_pos;
in vec2 a_uv;
in vec4 a_bone;
in vec4 a_weight;
in vec3 a_normal;
uniform mat4 u_mvp;
uniform mat3 u_normalMat;
uniform mat4 u_skin[${maxBones}];
uniform int u_boneCount;
uniform float u_keepZ;
// [we-scene patch 2026-10-12] 每骨不透明度包络 = 官方 WE 的「眨眼 / 零件淡出」机制。
// 官方 genericimage4.vert（SKINNING_ALPHA combo，见 ModelCompiler AddPuppetShaderInfo）：
//   uniform float g_BonesAlpha[BONECOUNT];
//   v_VertexAlpha *= saturate(g_BonesAlpha[a_BlendIndices.x]*a_BlendWeights.x
//                             + .y*.y + .z*.z + .w*.w);
// 片元侧 genericimage4.frag:194 的 color.a *= v_VertexAlpha 与本实现同义。
// 数值由 mdl-skin.js 的 computeBoneAlphas 从 MDLA blend_curves 求得。
// u_alphaOn = 0 时整段短路 ⇒ 与改动前逐位一致（没有曲线的模型照旧）。
uniform float u_boneAlpha[${maxBones}];
uniform float u_alphaOn;
uniform mat4 u_model;
out vec2 v_uv;
out vec3 v_wnormal;
out highp vec3 v_wpos;
out float v_alpha;
void main() {
  vec4 p = vec4(a_pos, 1.0);
  vec4 skinned = vec4(0.0);
  float total = 0.0;
  if (u_boneCount > 0) {
    for (int i = 0; i < 4; i++) {
      float w = a_weight[i];
      if (w <= 0.0) continue;
      int bi = int(a_bone[i]);
      if (bi < 0 || bi >= u_boneCount) continue;
      skinned += (u_skin[bi] * p) * w;
      total += w;
    }
  }
  vec4 local = total > 0.0 ? skinned / total : p;
  // 每骨不透明度：该顶点骨骼 alpha 的**权重和**（官方公式原文，不除权重和；权重本身就
  // 归一到 1）。u_alphaOn = 0 时恒 1.0。非蒙皮网格（u_boneCount = 0）不进这段。
  float va = 1.0;
  if (u_alphaOn > 0.5 && u_boneCount > 0) {
    float acc = 0.0;
    for (int i = 0; i < 4; i++) {
      float w = a_weight[i];
      if (w <= 0.0) continue;
      int bi = int(a_bone[i]);
      if (bi < 0 || bi >= u_boneCount) continue;
      acc += u_boneAlpha[bi] * w;
    }
    va = clamp(acc, 0.0, 1.0);
  }
  v_alpha = va;
  vec4 lp = vec4(local.xy, local.z * u_keepZ, 1.0);
  gl_Position = u_mvp * lp;
  // 世界坐标只给场景雾用（官方 generic4.vert 的 v_ViewDir = g_EyePosition - worldPos）
  v_wpos = (u_model * lp).xyz;
  v_uv = a_uv;
  // [we-scene patch 2026-09-28] 3D 网格的光照法线（世界向）。u_normalMat 由宿主按
  // 图层世界矩阵的旋转部分给（见 draw 的 opts.normalMat）。2D puppet 没有法线属性，
  // 属性槽喂的是常量 (0,0,1)，且 u_lightOn=0 时片元里整段光照被短路，逐位不影响。
  v_wnormal = u_normalMat * a_normal;
}`

// UV 对层 FBO 同样是恒等的，不要在这里翻 v。层 FBO 虽然「视觉上倒置」
// （NDC 顶存的是图像底行，见 renderer.js 的 layerQuadVerts），但写入时用的
// 就是源贴图的 v：NDC 顶那一行由 v=1 的顶点写入。于是采样恒有
// FBO(v) == 源贴图(v)，效果链是就地变换、不改变 UV 语义。
// 实测翻了会让腿采样到空白区域直接消失、人物2 碎成一片。
const MDL_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec3 v_wnormal;
// [we-scene patch 2026-10-12] 每骨不透明度（顶点侧加权和，官方 genericimage4 的 v_VertexAlpha）
in float v_alpha;
uniform sampler2D u_tex;
uniform vec4 u_color;
// [we-scene patch 2026-09-28] 场景光照（**只对带法线的真 3D 网格生效**）：
//   base = 场景 ambientcolor（作者素材实测：背光面 = 反照率 × ambientcolor，3281559867
//          舞台墙面 0.58×、贴图均值 233 → 135）
//   add  = 平行光 color × intensity × K（K 见 scene-mount 的 SCENE_LIGHT_K）
//   结果 = clamp(base + add × max(0, N·L), 0, 1)
// u_lightOn = 0 时逐位等价于改动前（t * u_color）。
uniform vec3 u_lightDir;
uniform vec3 u_lightBase;
uniform vec3 u_lightAdd;
uniform float u_lightOn;
// [we-scene patch 2026-10-05] 场景雾（官方 common_fog.h 逐条对齐，generic4 默认 FOG=1）。
// Params = (start, end-start, startDensity, endDensity-startDensity)：
//   t = saturate((d - start) / (end - start))，混合系数 = startDensity + Δdensity·t²
// d = 到眼点的距离（距离雾）/ 世界 y（高度雾）。u_fogOn = 0 时整段短路，逐位等价旧行为。
in highp vec3 v_wpos;
uniform float u_fogOn;
uniform float u_fogAdditive;
uniform highp vec3 u_eye;
uniform highp vec4 u_fogDist;
uniform vec3 u_fogDistColor;
uniform highp vec4 u_fogHeight;
uniform vec3 u_fogHeightColor;
// [we-scene patch 2026-10-12] **Puppet Warp Clipping Mask**（官方 MDL 掩码块，见
// mdl-parse.js 的 maskBlocks 与 parseMeshes 的掩码遍历）。官方实现：
//   assets/shaders/clippingmaskimage4.frag：
//     float mask = texSample2D(g_Texture1, v_TexCoord.xy).r;            // 掩码图
//     color.a = mix(pow(albedoAlpha, 4.0), albedoAlpha, mask);          // 未覆盖处压 alpha
//   掩码件（MaskBlock 的 b 列）负责把掩码图铺到屏幕上，被裁剪件（a 列）只在
//   掩码件画到的地方可见 —— 作者正是用它做「眼睑合上时把眼球/虹膜裁掉」
//   （ModelCompiler.cpp:1201-1310 的注释：later parts overdraw earlier ones =
//   eyelid covering pupil at peak blink）。
// 本实现（与官方「cheap composition / color max blending」同构）：
//   1) 把 b 件用 u_maskWrite=1 画进一张屏幕空间的掩码缓冲，混合用 MAX 累积覆盖率；
//   2) 画 a 件时把缓冲在**屏幕坐标**采样，乘进片元 alpha。
// u_maskOn = 0 时两段都短路 ⇒ 与没有掩码块的模型逐位一致。
uniform sampler2D u_maskTex;
uniform float u_maskOn;
uniform float u_maskWrite;
uniform vec2 u_viewport;
out vec4 fragColor;
vec4 applySceneFog(vec4 c) {
  float fd = 0.0;
  float fh = 0.0;
  if (u_fogHeight.y != 0.0) {
    float t = clamp((v_wpos.y - u_fogHeight.x) / u_fogHeight.y, 0.0, 1.0);
    fh = u_fogHeight.z + u_fogHeight.w * t * t;
    c.rgb = mix(c.rgb, u_fogHeightColor, fh);
  }
  if (u_fogDist.y != 0.0) {
    float t = clamp((length(u_eye - v_wpos) - u_fogDist.x) / u_fogDist.y, 0.0, 1.0);
    fd = u_fogDist.z + u_fogDist.w * t * t;
    c.rgb = mix(c.rgb, u_fogDistColor, fd);
  }
  if (u_fogAdditive > 0.5) {
    float f = clamp(max(fd, fh), 0.0, 1.0);
    c.a *= 1.0 - f * f;
  }
  return c;
}
void main() {
  vec4 t = texture(u_tex, v_uv);
  // [we-scene patch 2026-10-04] **全透明的像素不是遮挡物**（F50）。
  //
  // 3477054430（Cat with headphones on the roof）的树是「卡片网格」：贴图 65% 的像素
  // alpha=0（树冠四周的画布留白），而树卡片在层序上排在楼房网格**之前**。alpha=0 的像素
  // 颜色贡献本来就是 0（SRC_ALPHA 混合下），但它们照写深度 ⇒ 后画的楼房整片被 LEQUAL
  // 拒掉，画面上就是「每棵树四周一个黑方块」（用户报「树图层黑色方块」）。实测定界：
  // 把该网格贴图换成纯透明洋红 1×1，区域里洋红 0%、黑洞反而更大 —— 证明颜色走的是
  // 混合、深度照写。
  //
  // 只在**完全**透明（含图层 alpha）时 discard：实心/半透明边缘照旧写深度，所以
  // 猫与城市之间的层间遮挡（F49）不受影响，作者画的柔边也保留。官方 generic4.frag
  // 的 ALPHATOCOVERAGE 分支做的是同一件事（阈值 0.5 + fwidth 抗锯齿），我们取更保守的
  // 阈值以免把柔边整圈削成硬边（官方那条留给 ALPHATOCOVERAGE combo 真正接上时再用）。
  if (t.a * u_color.a * v_alpha < 0.004) discard;
  // 掩码写入趟：只输出「本件此刻的覆盖率」（官方 clippingmaskimage4.frag 的 alpha 公式
  // mix(albedoAlpha^4, albedoAlpha, mask)），混合是 MAX ⇒ 重叠件取最大覆盖。
  if (u_maskWrite > 0.5) {
    float al = t.a * u_color.a * v_alpha;
    float mtex = texture(u_maskTex, v_uv).r;
    float am = mix(al * al * al * al, al, mtex);
    fragColor = vec4(am, 0.0, 0.0, am);
    return;
  }
  vec3 mul = vec3(1.0);
  if (u_lightOn > 0.5) {
    vec3 n = normalize(v_wnormal);
    float ndl = max(dot(n, normalize(u_lightDir)), 0.0);
    // 只钳下界，**不钳上界**：作者素材里受光面就是过 1 的（棋盘/草地实测 1.2×），
    // 钳到 1 会正好把它压成「不亮的白」。非 HDR 目标写帧缓冲时由 GL 自然截断，
    // 与钳上界等价；HDR 场景则进 RGBA16F 交给 bloom/tonemap，与 WE 同一条路。
    mul = max(u_lightBase + u_lightAdd * ndl, 0.0);
  }
  fragColor = t * u_color * vec4(mul, v_alpha);
  // 被裁剪件：按**屏幕坐标**采样掩码缓冲（写入趟与本次绘制同 viewport、同 MVP，
  // 所以 gl_FragCoord.xy / u_viewport 就是该缓冲的 uv）。
  if (u_maskOn > 0.5) fragColor.a *= texture(u_maskTex, gl_FragCoord.xy / u_viewport).r;
  if (u_fogOn > 0.5) fragColor = applySceneFog(fragColor);
}`

// [we-scene patch 2026-10-12] 这里原本是「被收拢的零件盖住 → 同步压扁 / 剔除」启发式
// （shouldSyncCoveredParts / hasDeepPartCollapse / PART_SQUASH_* / meshSpan /
//  collapsedPartSquash，约 345 行）。它用「零件本帧包围盒高度比」猜哪些零件该跟着淡出，
// 判据随语料漂移 —— 这正是眨眼缺陷反复复发的根源（每换一批人物就要重调阈值）。
//
// 官方 WE 的机制是**每骨不透明度包络**：MDLA 的 blend_curves（mdla>=3 每条动画都带）
// 经 genericimage4.vert 的 g_BonesAlpha[] 乘进顶点 alpha，genericimage4.frag 再
// `color.a *= v_VertexAlpha;`。闭眼时作者把「眼球 / 虹膜 / 睫毛」零件绑的骨曲线压到 0，
// 零件自己就淡出了，不需要引擎猜。本引擎现已逐位实现该通道（顶点着色器 + 片元着色器 +
// mdl-skin.js 的 computeBoneAlphas），启发式整体删除。
//
// 依据：参考引擎 Wallpaper_Compiler_ModelCompiler.cpp:1300-1305（parts 按作者 z 序逐段
// 绘制）、:1329-1347（hasAlphaCurves → WE_CB_SKINNING_ALPHA）、PuppetRig.cpp:11-30 /
// :298-305（alpha 乘算），官方 assets/shaders/genericimage4.vert:92/170-173。

export function createMDLRenderer(gl) {
  // 按 GPU 上报的 uniform 预算编译；链接失败（驱动实际容量更小）时逐级减半重试。
  // 链接本身走 gl-util 的共享实现（B3 收敛）：原来这里有一份本地 compile + 内联链接，
  // 失败路径还会漏 shader（编译出的两个 shader 没有任何引用可删）。
  // 重试语义**必须原样保留** —— 它是骨预算的判据（verify-mdl-uniforms 覆盖）。
  let maxBones = boneBudget(gl)
  let prog = null
  const ATTRIBS = [
    [0, 'a_pos'],
    [1, 'a_uv'],
    [2, 'a_bone'],
    [3, 'a_weight'],
    [4, 'a_normal'],
  ]
  for (;;) {
    let p = null
    try {
      p = linkProgram(gl, mdlVertSrc(maxBones), MDL_FRAG, { attribs: ATTRIBS })
    } catch (e) {
      p = null
    }
    if (p) {
      prog = p
      break
    }
    if (maxBones <= MAX_BONES_FLOOR) {
      throw new Error('MDL 着色器链接失败（骨数已降到 ' + MAX_BONES_FLOOR + '）')
    }
    maxBones = Math.max(MAX_BONES_FLOOR, maxBones >> 1)
  }
  const MAX_BONES = maxBones

  const uni = {
    mvp: gl.getUniformLocation(prog, 'u_mvp'),
    tex: gl.getUniformLocation(prog, 'u_tex'),
    skin: gl.getUniformLocation(prog, 'u_skin'),
    boneCount: gl.getUniformLocation(prog, 'u_boneCount'),
    color: gl.getUniformLocation(prog, 'u_color'),
    keepZ: gl.getUniformLocation(prog, 'u_keepZ'),
    boneAlpha: gl.getUniformLocation(prog, 'u_boneAlpha'),
    alphaOn: gl.getUniformLocation(prog, 'u_alphaOn'),
    normalMat: gl.getUniformLocation(prog, 'u_normalMat'),
    lightDir: gl.getUniformLocation(prog, 'u_lightDir'),
    lightBase: gl.getUniformLocation(prog, 'u_lightBase'),
    lightAdd: gl.getUniformLocation(prog, 'u_lightAdd'),
    lightOn: gl.getUniformLocation(prog, 'u_lightOn'),
    model: gl.getUniformLocation(prog, 'u_model'),
    fogOn: gl.getUniformLocation(prog, 'u_fogOn'),
    fogAdditive: gl.getUniformLocation(prog, 'u_fogAdditive'),
    eye: gl.getUniformLocation(prog, 'u_eye'),
    fogDist: gl.getUniformLocation(prog, 'u_fogDist'),
    fogDistColor: gl.getUniformLocation(prog, 'u_fogDistColor'),
    fogHeight: gl.getUniformLocation(prog, 'u_fogHeight'),
    fogHeightColor: gl.getUniformLocation(prog, 'u_fogHeightColor'),
    // [we-scene patch 2026-10-12] 掩码通道（见 MDL_FRAG 头注与 draw 里的逐零件分支）
    maskTex: gl.getUniformLocation(prog, 'u_maskTex'),
    maskOn: gl.getUniformLocation(prog, 'u_maskOn'),
    maskWrite: gl.getUniformLocation(prog, 'u_maskWrite'),
    viewport: gl.getUniformLocation(prog, 'u_viewport'),
  }
  const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
  const ZERO3 = new Float32Array(3)
  const ZERO4 = new Float32Array(4)
  const identitySkin = new Float32Array(MAX_BONES * 16)
  for (let i = 0; i < MAX_BONES; i++) identitySkin.set(IDENTITY, i * 16)

  // [we-scene patch 2026-10-12] **掩码缓冲**（Puppet Warp Clipping Mask 的屏幕空间载体）。
  // 与当前 viewport 同尺寸：写入趟与读取趟用同一个 MVP 与同一个 viewport，于是
  // `gl_FragCoord.xy / u_viewport` 就是缓冲 uv，不需要任何额外的屏幕包围盒推演。
  // 只在真有掩码块的 puppet 上创建（24 个 puppet / 60 个块，见 /tmp/we/maskscan.json）。
  let maskTarget = null
  // 没有掩码的模型也要给 u_maskTex 绑一张完整纹理（采样器不能空绑）。**惰性创建**：
  // createMDLRenderer 会被 verify-mdl-depth 的**最小 GL mock** 直接调用并且真的调
  // `draw()`（`scripts/verify-mdl-depth.mjs:41 makeMockGL` 没有 createTexture），
  // 构造期碰 GL 对象会把那条源码级 verifier 打红。mock 下返回 null ⇒ 掩码通道停用。
  let whiteTex = null
  // ★**在 draw() 里新建纹理必须把「当前活动纹理单元」的绑定还回去**：`gl.bindTexture`
  // 绑的是**活动单元**，而这里创建资源时活动单元是 TEXTURE0（draw() 的默认态把它设回
  // 0）。若把新纹理留在 TEXTURE0，它就会被程序当作 `u_tex` 采样 —— 掩码缓冲那张纹理
  // 一旦同时是**当前 FBO 的颜色附件**，就构成纹理反馈环（feedback loop），于是掩码写入
  // 趟的每一次 `drawElements` 都只回报 `GL_INVALID_OPERATION (1282)` 且**一个片元都不写**：
  // 掩码缓冲全零 ⇒ 掩码通道静默失效（2026-10-12 用逐步 getError + readPixels 才挖到）。
  const withTextureUnit = (unit, fn) => {
    const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE)
    gl.activeTexture(gl.TEXTURE0 + unit)
    const prevBind = gl.getParameter(gl.TEXTURE_BINDING_2D)
    const out = fn()
    gl.bindTexture(gl.TEXTURE_2D, prevBind)
    if (prevActive !== gl.TEXTURE0 + unit) gl.activeTexture(prevActive)
    return out
  }
  function ensureWhiteTex() {
    if (whiteTex) return whiteTex
    if (typeof gl.createTexture !== 'function') return null
    withTextureUnit(1, () => {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      whiteTex = t
    })
    return whiteTex
  }
  function ensureMaskTarget(w, h) {
    if (maskTarget && maskTarget.w === w && maskTarget.h === h) return maskTarget
    if (maskTarget) {
      gl.deleteFramebuffer(maskTarget.fbo)
      gl.deleteTexture(maskTarget.tex)
    }
    // 同上：整段在 TEXTURE1 上做，结束时把 TEXTURE1 的原绑定还回去（TEXTURE0 根本不动）。
    const tex = withTextureUnit(1, () => {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return t
    })
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    maskTarget = { fbo, tex, w, h }
    return maskTarget
  }

  // 每个网格一套 VAO/VBO（顶点数据静态，蒙皮在 GPU 完成）。
  // [we-scene patch 2026-09-28] 键从 mdl 换成**子网格记录**：一个 MDL 可以有多个
  // 子网格（stage.mdl 15 个、TDRS 64 个），各自独立的顶点/索引缓冲。mdl 只有 1 个
  // 子网格时键仍是「伪网格对象」（见 draw 里 legacyMesh），与改动前逐位等价。
  const meshes = new WeakMap()
  // 可枚举的存活表：WeakMap 是**查询**用的（按键缓存），GC 到了也枚举不出来，
  // 里面的 VAO/VBO 就没人删。释放需要一份强引用清单（见下面的 dispose）。
  const liveMeshes = new Set()
  function ensureMesh(mesh) {
    let m = meshes.get(mesh)
    if (m) return m
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const n = mesh.vertexCount
    // 交错：pos(3) uv(2) [uv2(2)] bone(4) weight(4) [normal(3)] [tangent(4)]
    // 有法线的（真 3D 网格 / 无骨骼模型）多交错 3 个 float 供片元光照用；
    // 2D puppet 的 flag 里没有 NORMAL → 布局与改动前逐位一致。
    // [we-scene patch 2026-10-03] **切线**（F22）：官方 3D 材质 shader 的 NORMALMAP 分支要
    // `a_Tangent4`（xyz + handedness，fantasticcar `car.vert`），没有它整条材质路径 b 掉。
    // [we-scene patch 2026-10-03] **第二套 UV**（F34）：官方 `generic.vert` 在 LIGHTMAP 组合下
    // 声明 `attribute vec4 a_TexCoordVec4`（xy = 反照率 UV、zw = 光照图 UV）。vec4 属性要求
    // 四个分量**连续**，所以 uv2 紧跟 uv 之后（而不是像 normal/tangent 那样挂在尾部）——
    // 这样材质路径才能用一条 `vertexAttribPointer(loc, 4, …, 12)` 直接把它交给 shader。
    // 其余属性（bone/weight/normal/tangent）的偏移随之整体后移，改成按表算而不是写死。
    const hasN = !!mesh.normals
    const hasT = !!mesh.tangents
    const hasUv2 = !!mesh.uv2
    // 偏移表（单位 float）：uv2 紧跟 uv 之后，其余属性顺延；无 uv2 时与改动前逐位一致
    let cursor = 5 // pos(3) + uv(2)
    const uv2Off = hasUv2 ? cursor : -1
    if (hasUv2) cursor += 2
    const boneOff = cursor
    cursor += 4
    const weightOff = cursor
    cursor += 4
    const normalOff = hasN ? cursor : -1
    if (hasN) cursor += 3
    const tangentOff = hasT ? cursor : -1
    if (hasT) cursor += 4
    const F = cursor
    const data = new Float32Array(n * F)
    for (let i = 0; i < n; i++) {
      const o = i * F
      data[o] = mesh.positions[i * 3]
      data[o + 1] = mesh.positions[i * 3 + 1]
      data[o + 2] = mesh.positions[i * 3 + 2]
      data[o + 3] = mesh.uvs[i * 2]
      data[o + 4] = mesh.uvs[i * 2 + 1]
      if (hasUv2) {
        data[o + uv2Off] = mesh.uv2[i * 2]
        data[o + uv2Off + 1] = mesh.uv2[i * 2 + 1]
      }
      for (let k = 0; k < 4; k++) {
        data[o + boneOff + k] = mesh.boneIdx[i * 4 + k]
        data[o + weightOff + k] = mesh.weights[i * 4 + k]
      }
      if (hasN) {
        data[o + normalOff] = mesh.normals[i * 3]
        data[o + normalOff + 1] = mesh.normals[i * 3 + 1]
        data[o + normalOff + 2] = mesh.normals[i * 3 + 2]
      }
      if (hasT) {
        for (let k = 0; k < 4; k++) data[o + tangentOff + k] = mesh.tangents[i * 4 + k]
      }
    }
    const vbuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    const S = F * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 12)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, S, boneOff * 4)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, S, weightOff * 4)
    if (hasN) {
      gl.enableVertexAttribArray(4)
      gl.vertexAttribPointer(4, 3, gl.FLOAT, false, S, normalOff * 4)
    } else {
      gl.disableVertexAttribArray(4)
      gl.vertexAttrib3f(4, 0, 0, 1)
    }
    const ibuf = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
    gl.bindVertexArray(null)
    m = {
      vao,
      vbuf,
      ibuf,
      hasNormals: hasN,
      // [we-scene patch 2026-10-03] 供**材质 shader 路径**（F13）复用的几何信息：
      // 交错布局 pos(3f)@0 / uv(2f)@12 / bone(4f)@20 / weight(4f)@36 / normal(3f)@52
      // / tangent(4f)@64（后两段按数据存在与否），stride = floatStride*4。
      // 材质程序自己声明 attribute 名字与数量，这里暴露「顶点数 / 交错宽度 /
      // 各属性字节偏移 / 索引类型」，具体绑定由渲染侧按程序的位置做。
      vertexCount: n,
      floatStride: F,
      // 属性字节偏移（-1 = 该网格没有这条数据，声明了它的程序必须回落通用网格程序）
      normalOffset: normalOff >= 0 ? normalOff * 4 : -1,
      tangentOffset: tangentOff >= 0 ? tangentOff * 4 : -1,
      // uv2（光照图 UV）：材质路径的 `a_TexCoordVec4` 就是 [uv, uv2] 这一条连续 vec4
      uv2Offset: uv2Off >= 0 ? uv2Off * 4 : -1,
      hasTangents: hasT,
      hasUv2: hasUv2,
      indexCount: mesh.indexCount,
      indexU32: mesh.indices instanceof Uint32Array,
    }
    meshes.set(mesh, m)
    liveMeshes.add(m)
    return m
  }
  // 材质 shader 路径取几何信息（先建后取，语义与 ensureMesh 一致）
  const resolveMesh = (mesh) => (mesh ? ensureMesh(mesh) : null)
  /** [we-scene patch 2026-10-03] 材质 shader 路径用：返回 mdl 的子网格列表（单网格给伪网格） */
  const resolveMeshes = (mdl) => {
    const list = meshListOf(mdl)
    return list && list.length ? list : [legacyMeshOf(mdl)]
  }

  // 单网格模型（绝大多数 2D puppet）把顶层字段包成一条「伪子网格」，让 draw/upload
  // 只有一条代码路径；多网格模型直接走 mdl.meshes。
  // [we-scene patch 2026-10-03] **单网格模型的伪网格必须按 mdl 记忆化**：
  // ensureMesh（VBO/VAO 缓存）与材质路径的 VAO 缓存都以「网格对象」为键，
  // 每次新建对象 = **每帧新建一整套 VBO/VAO**。neon_sunset 的两个模型都是单网格，
  // 实测这条每帧泄漏把整帧拖成零像素（fps 仍 60、无报错、连 2D 层也不出图）。
  const legacyCache = new WeakMap()
  const legacyMeshOf = (mdl) => {
    let m = legacyCache.get(mdl)
    if (m) return m
    // meshes.length === 1 时 meshListOf 返回 null（走这条伪网格）—— 这时文档级数组
    // 与唯一那条网格记录是同一份几何，字段可能只写了其中一边。
    const singleSub = mdl.meshes && mdl.meshes.length === 1 ? mdl.meshes[0] : null
    m = {
      positions: mdl.positions,
      uvs: mdl.uvs,
      boneIdx: mdl.boneIdx,
      weights: mdl.weights,
      // [we-scene patch 2026-10-03] 法线/切线也要透传（F22）：单网格 3D 模型
      // （retro/ricepod… 的网格层）走这条伪网格，材质 shader 的 a_Normal/a_Tangent4
      // 只能从这里拿；缺字段时与改动前一致（两处都是 null → 布局不变）。
      // [we-scene patch 2026-10-09] **只有一个子网格时也认网格记录里的数组**：
      // 编辑器导入的单网格模型（`models/editor/*.mdl`）文档级 `normals` 是 null，
      // 法线只在 `meshes[0]` 上 —— 于是导入的单网格模型**在真机上从来没有法线**：
      // 逐网格 `u_lightOn` 恒为 0（手办的鼻子/嘴、卡通角色的腮与衣褶这类"只有形体、
      // 没有独立反照率"的特征完全不显形），材质路径的 a_Normal/a_Tangent4 也拿不到。
      // 判据见 verify-mdl-depth 的 F52 节（含变异注入）。
      normals: mdl.normals || singleSub?.normals || null,
      tangents: mdl.tangents || singleSub?.tangents || null,
      uv2: mdl.uv2 || singleSub?.uv2 || null,
      vertexCount: mdl.vertexCount,
      indices: mdl.indices,
      indexCount: mdl.indexCount,
      indexType: mdl.indexType,
      // [we-scene patch 2026-10-12] **零件表也要透传**：单网格模型走这条伪网格，而掩码
      // 通道（Puppet Warp Clipping Mask）必须逐零件绘制才能实现「a 件只在 b 件画到的
      // 地方可见」。mdl.parts 是 parseMDL 的部件表（锚扫），meshes[0].parts 来自
      // parseMeshes —— 两者都是**文件顺序**（实测 3629379075：id 12,10,11,9,1,…），
      // 与掩码块里 a/b 的「parts[] 下标」同一套编号。
      parts: mdl.parts || singleSub?.parts || null,
    }
    legacyCache.set(mdl, m)
    return m
  }
  const meshListOf = (mdl) => (mdl.meshes && mdl.meshes.length > 1 ? mdl.meshes : null)

  // [we-scene patch 2026-10-04] **子网格绘制顺序：显式不透明的先画**（F50）。
  //
  // `blendings[i]` 是宿主按第 i 个子网格的材质读出的 `passes[0].blending`（字符串或 null）。
  // 只有显式 `normal` 才算「声明了不透明」；`translucent`/`additive`/`alphatocoverage` 与
  // **未声明**都排到后面（未声明 = 未知，按可能透明保守处理）。同类内保持文件序。
  // 返回 null 表示「无需重排」（单网格、缺排序表、或两类都空/只有一类）——
  // 调用方这时走原下标，逐位等价。
  // 判据：`verify-mdl-depth` 的 F50 节（顺序 + 接线 + 未给表时不重排）。
  function meshDrawOrder(list, blendings) {
    if (!list || list.length < 2 || !blendings || !blendings.length) return null
    const isDeclaredOpaque = (i) => {
      const b = blendings[i]
      return typeof b === 'string' && b.toLowerCase() === 'normal'
    }
    const head = []
    const tail = []
    for (let i = 0; i < list.length; i++) (isDeclaredOpaque(i) ? head : tail).push(i)
    if (head.length === 0 || tail.length === 0) return null // 全同类：保持文件序
    const order = head.concat(tail)
    // 顺序与文件序一致时不返回（避免无谓的分支差异）
    for (let i = 0; i < order.length; i++) if (order[i] !== i) return order
    return null
  }

  return {
    gl,
    prog,
    maxBones: MAX_BONES,
    /** [we-scene patch 2026-10-03] 材质 shader 路径用：取某子网格的几何信息（含 VBO/IBO） */
    resolveMesh,
    /** [we-scene patch 2026-10-03] 材质 shader 路径用：mdl 的子网格列表（多网格或单网格伪网格） */
    resolveMeshes,
    /**
     * 释放本渲染器创建的 GL 对象：program + 每套网格的 VAO/VBO。
     *
     * 为什么必须显式释放：网格缓存是 WeakMap（按网格记录缓存），GC 到了也**无法枚举**，
     * 里面的 VAO/VBO 只能等上下文回收 —— 与 renderer 侧 gl-registry 的
     * 「自己回收 + 扩展兜底」原则不一致（docs/ENGINE-REVIEW-2026-10.md §3.1）。
     * 原先 mdl.js 里除「链接失败删 program」外没有任何 delete。
     * 调用方：装配层在场景卸载时（scene-mount 的 sceneCleanup）。
     */
    dispose() {
      for (const m of liveMeshes) {
        try {
          gl.deleteVertexArray(m.vao)
          gl.deleteBuffer(m.vbuf)
          gl.deleteBuffer(m.ibuf)
        } catch (e) {
          /* 上下文可能已丢失 */
        }
      }
      liveMeshes.clear()
      if (prog) {
        try {
          gl.deleteProgram(prog)
        } catch (e) {
          /* 同上 */
        }
        prog = null
      }
    },
    upload(mdl) {
      const list = meshListOf(mdl)
      if (list) {
        for (const mesh of list) if (mesh.vertexCount) ensureMesh(mesh)
      } else {
        ensureMesh(legacyMeshOf(mdl))
      }
    },
    // opts: { color:[r,g,b,a], time, animLayers, blending, overrideTex, keepZ, meshTextures, meshBlending, meshSkip }
    // overrideTex：puppet 层跑过效果链时采样源是链尾 FBO 的纹理，而不是原始贴图
    // （效果在贴图空间合成，见 renderer.js 中部那段长注释）。传裸 WebGLTexture。
    // keepZ：顶点 z 是否参与投影（透视场景的真 3D 网格 = true，2D puppet = 缺省 false）。
    // meshTextures：**逐子网格贴图**（宿主按每个子网格的材质 json 解析，见
    // scene-mount 的 model 分支）。缺省/缺项回落到 texture —— 单网格模型行为不变。
    draw(mvp, mdl, opts, texture) {
      gl.useProgram(prog)
      gl.uniformMatrix4fv(uni.mvp, false, mvp)
      gl.uniform1f(uni.keepZ, opts.keepZ ? 1 : 0)
      const col = opts.color || [1, 1, 1, 1]
      gl.uniform4f(uni.color, col[0], col[1], col[2], col[3])
      // 蒙皮与混合对**整个模型**只算一次（骨架只有一套），逐子网格只换 VAO/贴图/索引。
      const skin = computeSkinMatrices(mdl, opts.time || 0, opts.animLayers, opts.boneOverrides)
      const count = Math.min(mdl.bones.length, MAX_BONES)
      if (skin && count > 0) {
        gl.uniformMatrix4fv(uni.skin, false, skin.subarray(0, count * 16))
        gl.uniform1i(uni.boneCount, count)
      } else {
        gl.uniformMatrix4fv(uni.skin, false, identitySkin)
        gl.uniform1i(uni.boneCount, 0)
      }
      // [we-scene patch 2026-10-12] 每骨不透明度包络（官方眨眼机制，见顶点着色器头注）。
      // 只有包里真的带 blend_curves 且曲线降到过 1 以下的模型才开这条通道；关着时
      // 顶点 alpha 恒 1.0、片元 `vec4(mul, v_alpha)` 逐位等于改动前的 `vec4(mul, 1.0)`。
      // 与官方一致：官方也是 `puppet->hasAlphaCurves()` 为真才给材质开 SKINNING_ALPHA combo。
      const ba = count > 0 ? computeBoneAlphas(mdl, opts.time || 0, opts.animLayers) : null
      if (ba) {
        gl.uniform1fv(uni.boneAlpha, ba.subarray(0, count))
        gl.uniform1f(uni.alphaOn, 1)
      } else {
        gl.uniform1f(uni.alphaOn, 0)
      }
      // [we-scene patch 2026-10-12] 掩码通道的默认态：不裁剪、不写掩码、采样兜底白图。
      // 逐网格的掩码分支（见文件末的零件循环）会临时改这三项并复位。
      gl.uniform1f(uni.maskOn, 0)
      gl.uniform1f(uni.maskWrite, 0)
      const wt = ensureWhiteTex()
      if (wt) {
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, wt)
      }
      gl.uniform1i(uni.maskTex, 1)
      const vpNow = gl.getParameter(gl.VIEWPORT) || [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight]
      gl.uniform2f(uni.viewport, vpNow[2] || 1, vpNow[3] || 1)
      gl.activeTexture(gl.TEXTURE0)
      const applyBlend = () => {
        if (opts.blending === 'additive') {
          gl.enable(gl.BLEND)
          gl.blendEquation(gl.FUNC_ADD)
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE)
        } else if (opts.blending === 'normal') {
          gl.disable(gl.BLEND)
        } else {
          gl.enable(gl.BLEND)
          gl.blendEquation(gl.FUNC_ADD)
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        }
      }
      if (opts.blending === 'additive') {
        gl.enable(gl.BLEND)
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE)
      } else if (opts.blending === 'normal') {
        gl.disable(gl.BLEND)
      } else {
        gl.enable(gl.BLEND)
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.uniform1i(uni.tex, 0)
      // [we-scene patch 2026-09-28] 场景光照：宿主给 {dir:[x,y,z], base:[r,g,b], add:[r,g,b]}
      //（base = 场景 ambientcolor，add = 平行光 color×intensity×K）。只对**带法线的网格**生效，
      // 逐网格在下面的循环里开关 u_lightOn；关着时片元里 `mul ≡ 1`，与改动前逐位一致。
      const SL = opts.sceneLight
      gl.uniformMatrix3fv(uni.normalMat, false, (opts.normalMat && opts.normalMat.length === 9) ? opts.normalMat : IDENTITY3)
      if (SL) {
        gl.uniform3f(uni.lightDir, SL.dir[0], SL.dir[1], SL.dir[2])
        gl.uniform3f(uni.lightBase, SL.base[0], SL.base[1], SL.base[2])
        gl.uniform3f(uni.lightAdd, SL.add[0], SL.add[1], SL.add[2])
      } else {
        gl.uniform3f(uni.lightBase, 1, 1, 1)
        gl.uniform3f(uni.lightAdd, 0, 0, 0)
        gl.uniform3f(uni.lightDir, 0, 1, 0)
      }
      // [we-scene patch 2026-10-05] 场景雾：宿主给 { eye, dist:[4], distColor:[3], height:[4], heightColor:[3] }，
      // 只对真 3D（keepZ）且带模型矩阵时生效；某一项未开时其 Params.y 为 0，片元里跳过该项。
      const FOG = opts.keepZ && opts.fog && opts.model && opts.model.length === 16 ? opts.fog : null
      gl.uniformMatrix4fv(uni.model, false, FOG ? opts.model : IDENTITY)
      gl.uniform1f(uni.fogOn, FOG ? 1 : 0)
      if (FOG) {
        gl.uniform3fv(uni.eye, FOG.eye)
        gl.uniform4fv(uni.fogDist, FOG.dist || ZERO4)
        gl.uniform3fv(uni.fogDistColor, FOG.distColor || ZERO3)
        gl.uniform4fv(uni.fogHeight, FOG.height || ZERO4)
        gl.uniform3fv(uni.fogHeightColor, FOG.heightColor || ZERO3)
      }
      const identity = opts.overrideTex || (texture && texture.glTex ? texture.glTex : texture) || null
      // 多子网格：mdl.meshes 是 parseMeshes 的产物（1 个网格时与上面这份伪网格等价）。
      // 零件表（mdl.parts）仍由 parseMDL 产出，但绘制侧不再使用 —— 它现在只服务
      // 编辑器（puppet warp / mdl-edit）与 verify-mdl-write 的读回断言。
      const list = meshListOf(mdl)
      const legacyMesh = list ? null : legacyMeshOf(mdl)
      const n = list ? list.length : 1
      // [we-scene patch 2026-10-04] **子网格绘制顺序：显式不透明的先画**（F50）。
      //
      // 3477054430 的城模型：mesh0 = 树（贴图 65% 像素 alpha=0 的卡片网格，材质**没声明**
      // blending），mesh1 = 楼房（材质声明 `blending: normal`）。文件序把树排在前面，树的
      // 透明像素写进深度 ⇒ 随后画的楼房整片被 LEQUAL 拒掉 ⇒ 每棵树四周一个黑方块
      // （用户报「树图层黑色方块」）。官方引擎的规则是先不透明、后透明（透明网格必须能
      // 混合到它身后的背景上），所以这里按材质声明排序：`normal` = 不透明先画，
      // 其余（translucent/additive/alphatocoverage/**未声明**）后画；同类内保持文件序（稳定）。
      // 未声明按「可能透明」排后面是保守选择：排序只影响先后，遮挡仍由深度测试裁决（F49）。
      // 只在**真 3D（keepZ）**重排：2D 场景（含 2D 场景里的 model 层）没有深度测试，
      // 绘制顺序就是合成顺序（后画的盖先画的），重排会改观感。深度测试只在透视场景开
      // （见下一条），所以「透明网格排在身后几何之后」这条规则也只在那里成立。
      const order = opts.keepZ ? meshDrawOrder(list, opts.meshBlending) : null
      // [we-scene patch 2026-09-28] **真 3D 网格之间要开深度测试**。
      //
      // 为什么：一个 .mdl 的多个子网格是**同一个物体的不同部件**，它们相互遮挡靠的是
      // 深度，不是绘制顺序。关掉深度测试时后画的网格会整片盖住先画的：3281559867 的
      // 舞台 15 个网格里，场地地砖在前（mesh0/3/7…），四周草地/远景在后（mesh4/12），
      // 于是「棋盘地砖被草地整片涂绿」—— 作者 preview 里那块清清楚楚的棋盘完全看不见。
      // （实验：把绘制顺序反过来地砖立刻出现，证明是顺序遮挡而非贴图/UV 问题。）
      //
      // 只在透视场景（keepZ，即真 3D）开：2D puppet 的网格 z 是建模残留、本来就该
      // 按图层 z 序压平绘制（见 drawPuppetDirect 的 keepZ 注释），开深度测试会把它们
      // 按 z 互相裁剪。
      //
      // [we-scene patch 2026-10-04] **深度缓冲帧内共享，逐模型不再清**（F49）。
      //
      // 此前这里每画一个模型就 `clear(DEPTH_BUFFER_BIT)`：等于把先画的模型从深度缓冲里
      // 抹掉，深度测试无从比较 ⇒ **后画的模型无条件盖住先画的**。3477054430 的猫
      // （层序 0/1）被后画的城市（层序 5）整片涂掉，只剩探出楼顶轮廓的那圈耳机带可见
      // （用户报「没有显示 cat」）。同一根因在材质路径上已于 F40 修掉（fantasticcar
      // 地板盖住车身），这是另一条绘制路径（通用网格程序）。
      //
      // 帧首 renderScene 已统一 `clear(COLOR|DEPTH)`（HDR/MSAA 目标都带深度附件），
      // 模型之间就该按真实深度比较。宿主给的 FBO 没有深度附件时（效果链 FBO）深度
      // 测试退化为恒通过，与改动前一致。
      //
      // 天空盒是唯一例外：它的壳把相机包在里面，近侧壳比场内任何东西都近，写进深度
      // 会把后面所有模型拒掉。它本来就是背景（drawLayers 已把它排在最前），按
      // 「只测不写」画 —— 与 F40 对天空盒的处理同一条规则。
      const useDepth = !!opts.keepZ
      if (useDepth) {
        gl.enable(gl.DEPTH_TEST)
        gl.depthFunc(gl.LEQUAL)
        gl.depthMask(!opts.skybox)
      }
      for (let k = 0; k < n; k++) {
        // 绘制顺序由 meshDrawOrder 决定（F50）；单网格/未给排序表时 gi === k（逐位不变）。
        const gi = order ? order[k] : k
        // [we-scene patch 2026-10-12] **通道图烘焙子网格不上可见画布**：宿主按材质判定后
        // 在这里跳过（判据见 renderer/src/channel-bake.ts，引擎只认标记）。3441873795 的
        // Kirby：mesh1 = 两个 1:1 覆盖 226×175 通道图的四边形，停在模型右上角 ——
        // 画出来就是右上角那两个缩小、被竖直硬边切开的角色碎片（官方桌面端那里是干净的）。
        if (opts.meshSkip && opts.meshSkip[gi]) continue
        const mesh = list ? list[gi] : legacyMesh
        if (!mesh || !mesh.vertexCount || !mesh.indexCount) continue
        const m = ensureMesh(mesh)
        gl.bindVertexArray(m.vao)
        // 带法线且场景有光 → 走上光路径（片元里 N·L）；否则常量 1（逐位等价旧行为）
        gl.uniform1f(uni.lightOn, SL && m.hasNormals ? 1 : 0)
        // 官方只在 ADDITIVE 下让雾吃掉 alpha（ApplyFogAlpha）：加算网格靠 alpha 而非颜色淡出
        if (FOG) {
          const mb = opts.meshBlending && opts.meshBlending[gi]
          const b = String(typeof mb === 'string' ? mb : opts.blending || '').toLowerCase()
          gl.uniform1f(uni.fogAdditive, b === 'additive' ? 1 : 0)
        }
        // 每网格贴图：overrideTex（效果链输出）优先，其次该网格自己的材质贴图，
        // 最后回落整层贴图（单网格模型走的就是这一条）。索引必须用**原始** gi ——
        // meshTextures 是按子网格下标填的，用重排后的 k 会把贴图错配给另一个网格。
        const per = opts.meshTextures && opts.meshTextures[gi]
        const src = opts.overrideTex || (per && per.glTex ? per.glTex : per) || identity
        gl.bindTexture(gl.TEXTURE_2D, src)
        const idxType = mesh.indexType === 'u32' ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT
        // [we-scene patch 2026-10-12] 零件级「收拢压扁 / 剔除」已删除（见本文件顶部那段
        // 墓志注）：官方靠**每骨不透明度包络**让零件淡出，不靠引擎按包围盒猜。
        //
        // **掩码块（clipping mask）→ 逐零件绘制**：有掩码块的 puppet 不能再整网格一次
        // drawElements，因为 a 件（被裁剪件，作者绑的虹膜/高光）只在 b 件（掩码件，
        // 眼睑）画到的地方可见 —— 这正是「闭眼时虹膜消失」的官方做法。没有掩码块的
        // 模型仍走单次 drawElements（与改动前逐位一致）。
        const partsTable = mesh.parts && mesh.parts.length > 0 ? mesh.parts : null
        const mblocks = partsTable && mdl.maskBlocks && mdl.maskBlocks.length > 0 ? mdl.maskBlocks : null
        if (!mblocks) {
          gl.drawElements(gl.TRIANGLES, mesh.indexCount, idxType, 0)
          continue
        }
        const iw = mesh.indexType === 'u32' ? 4 : 2
        // 掩码写入趟：把 b 件画进与 viewport 同尺寸的掩码缓冲（MAX 混合累积覆盖率）。
        // 同一 (掩码材质 + b 表) 只在本次 draw 里建一次（3629379075 的 6 个块 → 2 张）。
        const built = new Map()
        const buildMask = (blk, bi) => {
          const vp = gl.getParameter(gl.VIEWPORT) || [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight]
          const w = Math.max(1, vp[2] | 0)
          const h = Math.max(1, vp[3] | 0)
          const tgt = ensureMaskTarget(w, h)
          const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING)
          const scissorOn = gl.isEnabled(gl.SCISSOR_TEST)
          if (scissorOn) gl.disable(gl.SCISSOR_TEST)
          // u_maskTex 在写入趟里是**掩码贴图**（官方 g_Texture1），在裁剪趟里换成
          // 屏幕空间缓冲 —— 同一个 uniform，两次绑定。
          // 掩码贴图与 meshTextures 同形（宿主存的是贴图包装对象，原始 GL 纹理在 `.glTex`，
          // 见上面 `per.glTex` 的同一约定）——漏拆包会直接抛
          // `bindTexture: parameter 2 is not of type WebGLTexture`。
          const mm0 = opts.maskTextures && opts.maskTextures[bi]
          const maskImg = (mm0 && mm0.glTex ? mm0.glTex : mm0) || ensureWhiteTex()
          gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo)
          gl.viewport(vp[0], vp[1], w, h)
          gl.clearColor(0, 0, 0, 0)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.enable(gl.BLEND)
          gl.blendEquation(gl.MAX)
          gl.blendFunc(gl.ONE, gl.ONE)
          gl.uniform1f(uni.maskWrite, 1)
          gl.activeTexture(gl.TEXTURE1)
          gl.bindTexture(gl.TEXTURE_2D, maskImg)
          for (const b of blk.partIdsB) {
            const bp = partsTable[b]
            if (!bp || !bp.size) continue
            gl.drawElements(gl.TRIANGLES, bp.size, idxType, bp.start * iw)
          }
          gl.uniform1f(uni.maskWrite, 0)
          gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
          gl.viewport(vp[0], vp[1], w, h)
          gl.blendEquation(gl.FUNC_ADD)
          applyBlend()
          if (scissorOn) gl.enable(gl.SCISSOR_TEST)
          return tgt.tex
        }
        const blkOf = (pi) => {
          for (let b = 0; b < mblocks.length; b++) if (mblocks[b].partIdsA.indexOf(pi) >= 0) return [mblocks[b], b]
          return null
        }
        const drawPart = (pi) => {
          const p = partsTable[pi]
          if (!p || !p.size) return
          const hit = blkOf(pi)
          if (hit) {
            const [blk, bi] = hit
            const key = blk.matPath + '|' + blk.partIdsB.join(',')
            let mt = built.get(key)
            if (!mt) {
              mt = buildMask(blk, bi)
              built.set(key, mt)
            }
            gl.activeTexture(gl.TEXTURE1)
            gl.bindTexture(gl.TEXTURE_2D, mt)
            gl.uniform1f(uni.maskOn, 1)
          } else {
            gl.uniform1f(uni.maskOn, 0)
          }
          gl.drawElements(gl.TRIANGLES, p.size, idxType, p.start * iw)
        }
        // 被掩码裁剪的零件要**单独一趟、画在未被裁剪的几何之后**：官方引擎为掩盖零件生成独立的
        // mask 子网格（`GenMaskSubmeshFromMdl`，见 `Wallpaper_Compiler_ModelCompiler.cpp:1313`），
        // 被裁剪件的绘制与基础网格分开，能盖住（而不是被盖住）眼睑/睫毛。按文件顺序画时，
        // 3629379075 的虹膜会被后面的睫毛件整条盖掉，官方 f54 却留着一条琥珀色残带 + 高光点。
        for (let pi = 0; pi < partsTable.length; pi++) if (!blkOf(pi)) drawPart(pi)
        for (let pi = 0; pi < partsTable.length; pi++) if (blkOf(pi)) drawPart(pi)
        gl.uniform1f(uni.maskOn, 0)
        gl.activeTexture(gl.TEXTURE0)
      }
      if (useDepth) {
        gl.depthMask(false)
        gl.disable(gl.DEPTH_TEST)
      }
      gl.bindVertexArray(null)
    },
  }
}

export { parseMDL, computeSkinMatrices, computeBoneAlphas, bindWorldOf, mat4MulOut, attachmentWorld, attachmentBind, attachmentEffectiveOffset, parentMeshToWorldDelta, applyAttachmentBindOrigins, followAttachments, skinnedMeshes }
