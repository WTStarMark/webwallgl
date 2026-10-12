#!/usr/bin/env node
// scripts/verify-tex-constants.mjs
//
// 判据（W1 / task-21）：本仓 .tex 容器实现与本机第一方实测 + 文档
// `docs/re/we-native-tex-constants.md` 记录的常量一致。
//
//   node scripts/verify-tex-constants.mjs            # 纯合成字节，不扫全库
//   WE_TEX_SAMPLE=<某目录> node scripts/verify-tex-constants.mjs
//                                                    # 额外抽 ≤3 个真实 .tex 校验头不变量
//
// 设计原则：
//   1) **默认不碰素材库**（全库校验会吃内存，且本波明令禁跑其它判据）；
//   2) 每条判据都有**进程内正向对照**（故意造错必须报红），避免恒真判据；
//   3) 文档 ↔ 代码一致性检查**真的去读文档**，不是把常量抄一遍。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

import { parseTex, TEXTURE_FORMATS } from '../renderer/vendor/we-scene/pkg/texture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DOC = join(ROOT, 'docs/re/we-native-tex-constants.md');

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fails.push(msg);
    console.log('  ✗ ' + msg);
  }
};
const section = (t) => console.log('\n' + t);

// ---------------------------------------------------------------- 合成头
// 布局严格按文档 §1/§5（顺序取自 texture.js:60-100：容器魔数 → imageCount →
// 版本相关字段 → mipCount → [LUT 变体额外 u32] → mw/mh → compression/src_size → 载荷）
const MAGIC1 = 'TEXV0005\0';
const MAGIC2 = 'TEXI0001\0';
const wU32 = (b, o, v) => b.writeUInt32LE(v >>> 0, o);
const wI32 = (b, o, v) => b.writeInt32LE(v | 0, o);

function synthTex({
  format = 4, flags = 0, texW = 8, texH = 8, width = 8, height = 8, ignored = 0,
  container = 'TEXB0003', payload = Buffer.alloc(64), variant50 = false,
  mipExtra = false, freeImageFormat = -1, mipCount = 1,
} = {}) {
  const b = Buffer.alloc(160 + payload.length + 8);
  b.fill(0);
  b.write(MAGIC1, 0, 'latin1');
  b.write(MAGIC2, 9, 'latin1');
  wU32(b, 18, format);
  wU32(b, 22, flags);
  wU32(b, 26, texW);
  wU32(b, 30, texH);
  let o = 34;
  if (variant50) {
    wU32(b, 34, texW * texH); // 变体：容器定位前多写一个「像素数」
    o = 38;
  }
  wU32(b, o, width);
  wU32(b, o + 4, height);
  wU32(b, o + 8, ignored);
  let p = o + 12;
  b.write(container + '\0', p, 'latin1');
  p += 9;
  wU32(b, p, 1); // imageCount（紧跟容器魔数）
  p += 4;
  if (container === 'TEXB0004') {
    wU32(b, p, freeImageFormat);
    wU32(b, p + 4, 0); // hasMipExtension = 0 → containerVersion 3
    p += 8;
  } else if (container === 'TEXB0003') {
    wU32(b, p, freeImageFormat);
    p += 4;
  }
  wU32(b, p, mipCount);
  p += 4;
  wU32(b, p, width);
  wU32(b, p + 4, height);
  p += 8;
  if (mipExtra) {
    // 变体：多出的 u32 落在「本应是 compression」的槽位（texture.js:124-148）
    wU32(b, p, texW * texH);
    p += 4;
  }
  if (container !== 'TEXB0001') {
    wU32(b, p, 0); // compression = 0（原样）
    wI32(b, p + 4, payload.length);
    p += 8;
  }
  wI32(b, p, payload.length);
  p += 4;
  payload.copy(b, p);
  p += payload.length;
  return b.subarray(0, p);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngPayload = Buffer.concat([PNG_MAGIC, Buffer.from('synthetic-png-body')]);

// ---------------------------------------------------------------- §1 头布局
section('§1 头布局（[第一方] 440/440 实测的偏移表）');
{
  const tex = parseTex(synthTex({ format: 4, flags: 0x2, texW: 2048, texH: 1024, width: 2048, height: 1024 }));
  ok(tex.format === 4, `format 读自偏移 18：${tex.format}`);
  ok(tex.flags === 2, `flags 读自偏移 22：${tex.flags}`);
  ok(tex.textureWidth === 2048 && tex.textureHeight === 1024, `textureWidth/Height 读自 26/30：${tex.textureWidth}x${tex.textureHeight}`);
  ok(tex.width === 2048 && tex.height === 1024, `width/height 读自 34/38：${tex.width}x${tex.height}`);
  ok(tex.formatName === 'DXT5', `formatName 走 TEXTURE_FORMATS：${tex.formatName}`);
  // 偏移 16/17 属于 TEXI 魔数，不是自由字段：破坏它必须抛
  const broken = synthTex({});
  broken.write('X', 16, 'latin1');
  let threw = '';
  try { parseTex(broken); } catch (e) { threw = String(e && e.message); }
  ok(threw.includes('TEXI'), `偏移 16 属于魔数 'TEXI0001'，破坏后必须抛（实际：${String(threw).slice(0, 48)}…）`);
  // 反向对照：只改 format 槽必须被读到（证明上面不是恒真）
  const f9 = parseTex(synthTex({ format: 9, texW: 8, texH: 8 }));
  ok(f9.format === 9 && f9.formatName === 'R8', `format 槽可辨：9 → ${f9.formatName}`);
}

// ---------------------------------------------------------------- §2 format 表（文档 ↔ 代码）
section('§2 format 枚举：代码表 ↔ 文档 §2.2 表逐项一致');
const readDoc = () => (existsSync(DOC) ? readFileSync(DOC, 'utf8') : null);
function formatsInDoc(text) {
  const m = /TEXTURE_FORMATS\s*=\s*\{([^}]*)\}/.exec(text);
  if (!m) return null;
  const out = {};
  for (const pair of m[1].split(',')) {
    const kv = /^\s*(\d+)\s*:\s*'([^']+)'/.exec(pair);
    if (kv) out[Number(kv[1])] = kv[2];
  }
  return out;
}
function compareFormats(text) {
  const docFmt = formatsInDoc(text);
  const bad = [];
  if (!docFmt) return ['文档里找不到 TEXTURE_FORMATS 表'];
  for (const k of Object.keys(TEXTURE_FORMATS)) {
    if (docFmt[k] !== TEXTURE_FORMATS[k]) bad.push(`format ${k}: 文档 ${docFmt[k]} ≠ 代码 ${TEXTURE_FORMATS[k]}`);
  }
  for (const k of Object.keys(docFmt)) if (!(k in TEXTURE_FORMATS)) bad.push(`文档多出 format ${k}`);
  return bad;
}
{
  const doc = readDoc();
  ok(!!doc, '文档存在：docs/re/we-native-tex-constants.md');
  if (doc) {
    const bad = compareFormats(doc);
    ok(bad.length === 0, `文档 §2.2 表与代码 TEXTURE_FORMATS 一致（${Object.keys(TEXTURE_FORMATS).length} 项）${bad.length ? '：' + bad.join('; ') : ''}`);
    const mutated = doc.replace("4:'DXT5'", "4:'DXT3'");
    // 正向对照用独立合成文本，不依赖文档字面（文档被改时这条也必须仍然有效）
    const synthDoc = 'TEXTURE_FORMATS = {' + Object.entries(TEXTURE_FORMATS).map(([k, v]) => `${k}:'${v}'`).join(',') + '}';
    ok(compareFormats(synthDoc).length === 0, '正向对照：合成文档片段与代码一致时判 0 违规');
    ok(compareFormats(synthDoc.replace("4:'DXT5'", "4:'DXT3'")).length > 0, "正向对照：合成片段 4:'DXT3' 必须被判违规");
    ok(mutated !== doc && compareFormats(mutated).length > 0, "正向对照：真实文档 4:'DXT3' 必须被判违规");
    ok([0, 4, 8, 9].every((v) => v in TEXTURE_FORMATS), '第一方实测的 format 子集 {0,4,8,9} 都在代码表里');
  }
}

// ---------------------------------------------------------------- §3 flags 位域
section('§3 flags 位域：文档 §3 表 ↔ 第一方解码结果 ↔ 代码实际用位');
const BITS_DECODED = { 0x1: 'nointerpolation', 0x2: 'clampuvs', 0x4: 'sequence', 0x10: 'srgb', 0x20: 'video', 0x40: 'lut', 0x80000: 'alphachannelpriority' };
const BITS_USED_IN_REPO = [0x2, 0x20, 0x40];
function bitsInDoc(text) {
  const m = /## §3[\s\S]*?\n## §4/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[0].split('\n')) {
    const r = /^\|\s*`0x([0-9a-fA-F]+)`\s*\|\s*([^|]+?)\s*\|.*\|\s*([^|]*?)\s*\|\s*$/.exec(line);
    if (r) out[parseInt(r[1], 16)] = { name: r[2].replace(/`/g, ''), stance: r[3] };
  }
  return out;
}
/** 从本仓源码收集「实际参与判断的 flags 掩码」 */
function usedFlagMasks(src) {
  const masks = new Set();
  for (const m of src.matchAll(/flags\s*&\s*(0x[0-9a-fA-F]+|\d+)/g)) masks.add(Number(m[1]));
  for (const m of src.matchAll(/TEX_FLAG_[A-Z_]+\s*=\s*(0x[0-9a-fA-F]+|\d+)/g)) masks.add(Number(m[1]));
  return masks;
}
function undocumentedMasks(src, bits) {
  const bad = [];
  for (const mask of usedFlagMasks(src)) {
    for (let i = 0; i < 32; i++) {
      const bit = 1 << i;
      if ((mask & bit) === 0) continue;
      if (!(bit in bits)) bad.push('0x' + bit.toString(16));
    }
  }
  return [...new Set(bad)];
}
{
  const doc = readDoc();
  const docBits = doc ? bitsInDoc(doc) : null;
  ok(!!docBits, `文档 §3 位域表可解析（${docBits ? Object.keys(docBits).length : 0} 行）`);
  if (docBits) {
    const missing = Object.keys(BITS_DECODED).filter((b) => !(Number(b) in docBits));
    const extra = Object.keys(docBits).filter((b) => !(Number(b) in BITS_DECODED));
    ok(missing.length === 0 && extra.length === 0, `文档位集合 = 第一方解码出的 7 位（缺 ${missing.join(',') || '无'}；多 ${extra.join(',') || '无'}）`);
    const wrong = BITS_USED_IN_REPO.filter((b) => !/已使用/.test(docBits[b]?.stance || ''));
    const wronglyUsed = Object.keys(docBits).map(Number).filter((b) => !BITS_USED_IN_REPO.includes(b) && !/未使用/.test(docBits[b].stance));
    ok(wrong.length === 0, `代码已用的位在文档里标「已使用」：${BITS_USED_IN_REPO.map((b) => '0x' + b.toString(16)).join(',')}`);
    ok(wronglyUsed.length === 0, `代码未用的位在文档里标「未使用」${wronglyUsed.length ? '，异常：' + wronglyUsed.map((b) => '0x' + b.toString(16)).join(',') : ''}`);
  }
  // 真实源码扫描：任何新增的 flags 掩码必须在文档位表里
  const srcFiles = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const n of readdirSync(dir)) {
      if (n === 'node_modules' || n.startsWith('.git')) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, depth + 1);
      else if (['.js', '.mjs', '.ts'].includes(extname(n)) && !p.includes('verify-tex-constants')) srcFiles.push(p);
    }
  };
  walk(join(ROOT, 'renderer'), 0);
  walk(join(ROOT, 'scripts'), 0);
  const offenders = [];
  for (const f of srcFiles) {
    for (const bit of undocumentedMasks(readFileSync(f, 'utf8'), BITS_DECODED)) offenders.push(`${f.slice(ROOT.length + 1)} → ${bit}`);
  }
  ok(offenders.length === 0, `扫 ${srcFiles.length} 个本仓源码，flags 掩码全部是文档已记录的位${offenders.length ? '：' + offenders.slice(0, 5).join('; ') : ''}`);
  ok(undocumentedMasks('const on = (parsed.flags & 0x8) !== 0;', BITS_DECODED).length === 1, '正向对照：`flags & 0x8`（文档未记录）必须被判违规');
}

// ---------------------------------------------------------------- §5 容器与 LUT 变体
section('§5 容器版本 / LUT 变体（flags 0x40，容器落 50）');
{
  const v1 = parseTex(synthTex({ container: 'TEXB0001' }));
  const v2 = parseTex(synthTex({ container: 'TEXB0002' }));
  const v3 = parseTex(synthTex({ container: 'TEXB0003' }));
  const v4 = parseTex(synthTex({ container: 'TEXB0004', freeImageFormat: 13, payload: pngPayload }));
  ok(v1.containerVersion === 1 && v2.containerVersion === 2 && v3.containerVersion === 3 && v4.containerVersion === 3,
    `TEXB0001/2/3 → 版本 ${v1.containerVersion}/${v2.containerVersion}/${v3.containerVersion}；TEXB0004(hasMipExtension=0) → ${v4.containerVersion}`);
  ok(v4.freeImageFormat === 13 && v4.format === 4, `TEXB0004 读 freeImageFormat：${v4.freeImageFormat}`);

  const lut = synthTex({ flags: 0x42, format: 0, container: 'TEXB0004', freeImageFormat: 13, payload: pngPayload, variant50: true, mipExtra: true });
  const lt = parseTex(lut);
  ok(lt.width === 8 && lt.height === 8, `变体读法 A（containerOffset-12/-8）冻结：width/height = ${lt.width}x${lt.height}（文档 §5.2 方法 A）`);
  ok(lt.freeImageFormat === 13, `变体 sidecar-less PNG：freeImageFormat=${lt.freeImageFormat}`);
  const m0 = lt.images?.[0]?.[0];
  ok(!!m0 && m0.width === 8 && m0.height === 8, `变体 mip0 尺寸=${m0 && m0.width}x${m0 && m0.height}`);
  ok(!!m0 && Buffer.from(m0.data).slice(0, 8).equals(PNG_MAGIC), '变体载荷按 mipExtra=4 正确切出 PNG 字节');
  const notVariant = parseTex(synthTex({ flags: 0x42, format: 0, container: 'TEXB0004', freeImageFormat: 13, payload: pngPayload }));
  ok(notVariant.images[0][0].width === 8, `无变体布局 mip0 = ${notVariant.images[0][0].width}x${notVariant.images[0][0].height}（对照：不触发 mipExtra）`);
  ok(Buffer.from(notVariant.images[0][0].data).slice(0, 8).equals(PNG_MAGIC), '无变体布局载荷也对齐（对照）');
}

// ---------------------------------------------------------------- §6 闸门（limits）
section('§6 闸门：limits.js 上限与文档 §5.1 一致');
{
  const lim = await import('../renderer/vendor/we-scene/pkg/limits.js');
  const L = lim.TEX_LIMITS;
  ok(L.maxImages === 64 && L.maxMips === 32 && L.maxDim === 16384 && L.maxPixels === 1 << 27,
    `TEX_LIMITS = ${JSON.stringify(L)}`);
  const big = synthTex({});
  big.writeUInt32LE(33, 63); // 46 + 9(魔数) + 4(imageCount) + 4(fif) = mipCount
  let threw = '';
  try { parseTex(big); } catch (e) { threw = String(e && e.message); }
  ok(/mipCount/.test(threw), `mipCount 33 > maxMips 32 必须抛（实际：${String(threw).slice(0, 48) || '未抛'}）`);
  // 正向对照：合法 mipCount 必须不抛
  ok(parseTex(synthTex({ mipCount: 1 })).images.length === 1, '正向对照：mipCount 1 不抛');
}

// ---------------------------------------------------------------- §7 可选真实文件
section('§7 真实文件抽样（仅当 WE_TEX_SAMPLE 设置时）');
{
  const dir = process.env.WE_TEX_SAMPLE;
  if (!dir) {
    console.log('  · 未设置 WE_TEX_SAMPLE → 跳过（默认不触碰素材，避免全库扫描）');
  } else {
    const found = [];
    const dig = (d, depth) => {
      if (depth > 5 || found.length >= 3) return;
      for (const n of readdirSync(d)) {
        if (found.length >= 3) return;
        const p = join(d, n);
        if (statSync(p).isDirectory()) dig(p, depth + 1);
        else if (n.endsWith('.tex')) found.push(p);
      }
    };
    dig(dir, 0);
    ok(found.length > 0, `在 ${dir} 抽到 ${found.length} 个 .tex`);
    for (const f of found) {
      const buf = readFileSync(f);
      const u16 = (o) => buf.readUInt16LE(o);
      const u32 = (o) => buf.readUInt32LE(o);
      const bad = [];
      if (u16(16) !== 0x31) bad.push(`u16@16=${u16(16)}`);
      for (const o of [20, 28, 32, 36, 40]) if (u16(o) !== 0) bad.push(`u16@${o}=${u16(o)}`);
      if (![0, 4, 8, 9].includes(u32(18))) bad.push(`format=${u32(18)}`);
      if (!['TEXB0001\0', 'TEXB0002\0', 'TEXB0003\0', 'TEXB0004\0'].some((m) => buf.includes(Buffer.from(m, 'latin1')))) bad.push('找不到 TEXB 容器');
      ok(bad.length === 0, `${f.slice(dir.length + 1)}：头不变量成立${bad.length ? '（违规：' + bad.join(', ') + '）' : ''}`);

      // §5.3 TEXS 序列帧段不变量（文档 §5.3）：含 TEXS 块时必须满足
      //   (a) 要么整表采纳（frames.list.length === frameCount）、要么整表丢弃（无 frames），不许半截；
      //   (b) 图集几何栅格 cols×rows == frameCount（cols = mip0宽/|uDir|、rows = mip0高/|vDir|），
      //       第一方 61 张样本成立，故本仓若改动帧表逻辑会被这条判据拦下。
      const label = f.slice(dir.length + 1);
      const i3 = buf.indexOf(Buffer.from('TEXS0003', 'latin1'));
      const i2 = buf.indexOf(Buffer.from('TEXS0002', 'latin1'));
      const ti = i3 >= 0 ? i3 : i2;
      if (ti < 0) {
        console.log(`  · ${label}：无 TEXS 块 → 跳过帧表不变量`);
      } else {
        const isV3 = i3 >= 0;
        const fc = buf.readUInt32LE(ti + 9);
        const q0 = ti + 13 + (isV3 ? 8 : 0);
        const rem = buf.length - q0;
        const stride = fc > 0 && rem > 0 && rem % fc === 0 ? rem / fc : 0;
        let tex = null;
        try { tex = parseTex(buf); } catch { /* 解析失败由 §7 上半段暴露 */ }
        const got = tex && tex.frames ? tex.frames.list.length : 0;
        ok(got === fc || got === 0,
          `${label}：TEXS 帧表整取(${fc})或整弃(0)，实际 ${got}（frameCount=${fc}, ${isV3 ? 'TEXS0003' : 'TEXS0002'}）`);
        if (stride >= 32) {
          const fx = buf.readFloatLE(q0 + 16), fy = buf.readFloatLE(q0 + 20);
          const vx = buf.readFloatLE(q0 + 24), vy = buf.readFloatLE(q0 + 28);
          const uLen = Math.hypot(fx, fy), vLen = Math.hypot(vx, vy);
          const m0 = tex && tex.images && tex.images[0] && tex.images[0][0];
          if (m0 && uLen > 1e-30 && vLen > 1e-30) {
            const cols = m0.width / uLen, rows = m0.height / vLen;
            ok(Math.abs(cols * rows - fc) < 0.02,
              `${label}：几何栅格 ${cols.toFixed(3)}×${rows.toFixed(3)} == frameCount ${fc}（§5.3 修复前提）`);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 汇总
section('汇总');
console.log(`  通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('\n失败明细：');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ verify-tex-constants：.tex 常量判据全部通过');
