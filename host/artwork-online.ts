/**
 * 在线封面源（宿主侧）——补上「播放器不给封面」的曲子。
 *
 * 背景（本机实测）：macOS 的 Now Playing 里，播放器可以只写标题/歌手而不给 ArtworkData
 * （汽水音乐即如此；Chromium 系播放器塞的 `mediaSession.metadata.artwork` 也不会变成
 * MediaRemote 的封面）。这种曲子在 media-bridge 侧一律报「播放器未提供」，
 * 于是从系统媒体会话出发的任何方案都拿不到封面 —— 只能按「歌名 + 歌手」去公开曲库补一张。
 *
 * 三个数据源都不需要 key：iTunes Search（TW / US 店铺）→ Deezer → 网易云。命中后由调用方
 * 缓存，并与播放器封面共用同一条出口（GET /api/system/artwork），编辑器与壁纸都吃得着。
 *
 * 实测细节（决定了查询怎么写）：
 *   - iTunes 的 `country=CN` 店铺对华语曲目返回 `resultCount: 0`；`country=TW` 才能查到
 *     （「晴天 / 周杰倫」），不传 country 的默认店铺则混进翻唱版。所以**多个店铺都查**，
 *     候选汇总后按「歌名+歌手」打分取最高，而不是谁先返回就用谁。
 *   - 同一首歌在简/繁/罗马字之间歌手名会变（周杰伦 / 周杰倫 / Jay Chou），所以歌手只加分、
 *     歌名才是准入条件 —— 名字对不上照样能命中，不会因为转写差异整首丢掉。
 *   - 华语独立音乐（蒸汽波/短视频翻唱那类）iTunes 与 Deezer 常常零命中，网易云的
 *     `api/cloudsearch/pc`（POST）能查到，且 `al.picUrl` 直接就是专辑封面 ⇒ 也接进来。
 *     QQ 音乐的搜索接口本机实测返回 500（需要额外签名/票据），不接。
 *
 * 三条硬约束：
 *   1. 绝不伪造：两个源都失败就返回 null，保留「无封面」语义（前端会回落到默认外观）；
 *   2. 绝不看歌名就认：命中要求歌名匹配（相等 2 分 / 互为子串 1 分），歌手命中再加 0.5，
 *      低于 1 分直接丢弃 —— 宁可没封面，也不给用户贴一张别的歌的图；
 *   3. 只缓存真正的图片字节（魔数校验 JPEG/PNG/WebP + 体积下限），避免把错误页当封面。
 *
 * 关闭方式：环境变量 `WE_ONLINE_ARTWORK=0`（`off` / `false` / `no` 同义）。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ArtworkQuery = {
  /** 歌名（必需，空则直接放弃查询） */
  title: string;
  artist?: string;
  album?: string;
};

export type OnlineArtwork = {
  data: Buffer;
  mime: string;
  /** 命中来源；cache = 磁盘缓存命中 */
  provider: "itunes" | "deezer" | "netease" | "cache";
  /** 命中的曲目（"歌名 — 歌手"，便于日志核对是不是同一首） */
  matched: string;
  /** 命中的图片地址（诊断用） */
  url: string;
};

type ResponseLike = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; method?: string; body?: string },
) => Promise<ResponseLike>;

export type LookupOptions = {
  /** 注入 fetch（测试用；缺省 globalThis.fetch） */
  fetchImpl?: FetchLike;
  /** 单个请求超时（毫秒）；在线查询不该拖住 SSE/HTTP 的响应 */
  timeoutMs?: number;
};

const UA = "WebWallGL/1.0 (+https://github.com/oneincase/webwallgl)";
const DEFAULT_TIMEOUT_MS = 5_000;
/** iTunes 店铺查询顺序：华语曲库在 TW 命中率最高，US 补欧美；CN 店铺实测对华语返回空 */
export const ITUNES_STOREFRONTS = ["TW", "US"] as const;
/** 候选打分命中后最多下载几张图（串行，失败轮到下一张） */
const MAX_IMAGE_ATTEMPTS = 2;
const MIN_IMAGE_BYTES = 1_024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 磁盘缓存有效期：封面基本不随时间变，30 天足够避免反复联网 */
export const ONLINE_ARTWORK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 缓存首次写失败只提示一次（避免每首歌刷屏，也避免「没缓存」被误判成「没查询」） */
let cacheWriteWarned = false;

/** 在线封面总开关（默认开；WE_ONLINE_ARTWORK=0/off/false/no 关闭） */
export function onlineArtworkEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.WE_ONLINE_ARTWORK ?? "")
    .trim()
    .toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

/**
 * 匹配用归一化：去括号注记（"(R&B氛围版)" / "[Live]" / "【官方版】"）、去标点空白、小写。
 * 只用于比对与缓存键，不用于展示。
 */
export function normalizeText(s: string): string {
  return String(s ?? "")
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

/** 0..2.5：歌名相等 2 / 互为子串 1 / 不匹配 0；歌手命中再 +0.5 */
export function matchScore(qTitle: string, qArtist: string, cTitle: string, cArtist: string): number {
  const t = normalizeText(qTitle);
  const ct = normalizeText(cTitle);
  if (!t || !ct) return 0;
  const hit = t === ct ? 2 : ct.includes(t) || t.includes(ct) ? 1 : 0;
  if (hit === 0) return 0;
  const a = normalizeText(qArtist);
  const ca = normalizeText(cArtist);
  const artistHit = a && ca && (a === ca || ca.includes(a) || a.includes(ca));
  return hit + (artistHit ? 0.5 : 0);
}

export type ArtworkCandidate = { title: string; artist: string; url: string };

/** 取分数最高的候选；低于 1 分（歌名都没对上）视为没找到 */
export function pickBest(q: ArtworkQuery, candidates: ArtworkCandidate[]): (ArtworkCandidate & { score: number }) | null {
  let best: (ArtworkCandidate & { score: number }) | null = null;
  for (const c of candidates) {
    const score = matchScore(q.title, q.artist ?? "", c.title, c.artist);
    if (!best || score > best.score) best = { ...c, score };
  }
  return best && best.score >= 1 ? best : null;
}

/** 只认真正是图片的字节（JPEG / PNG / WebP），否则拿不到 mime */
export function sniffImageMime(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function itunesCandidates(payload: unknown): ArtworkCandidate[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: ArtworkCandidate[] = [];
  for (const r of results) {
    const o = (r ?? {}) as Record<string, unknown>;
    const raw = typeof o.artworkUrl100 === "string" ? o.artworkUrl100 : "";
    if (!raw) continue;
    // iTunes 给的是 100x100 缩略图；同址换尺寸即可拿到大图
    out.push({
      title: String(o.trackName ?? ""),
      artist: String(o.artistName ?? ""),
      url: raw.replace(/\/\d+x\d+bb\./, "/600x600bb."),
    });
  }
  return out;
}

function deezerCandidates(payload: unknown): ArtworkCandidate[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ArtworkCandidate[] = [];
  for (const r of data) {
    const o = (r ?? {}) as Record<string, unknown>;
    const album = (o.album ?? {}) as Record<string, unknown>;
    const artist = (o.artist ?? {}) as Record<string, unknown>;
    const url = String(album.cover_xl ?? album.cover_big ?? "");
    if (!url) continue;
    out.push({ title: String(o.title ?? ""), artist: String(artist.name ?? ""), url });
  }
  return out;
}

/** 网易云搜索结果里的封面地址：换 https 并要 600×600（原图可能是 120×120 缩略） */
export function upgradeNeteaseCover(url: string): string {
  const u = String(url ?? "").trim();
  if (!u) return "";
  const https = u.startsWith("http://") ? `https://${u.slice("http://".length)}` : u;
  return https.includes("?") ? https : `${https}?param=600y600`;
}

function neteaseCandidates(payload: unknown): ArtworkCandidate[] {
  const songs = (payload as { result?: { songs?: unknown } } | null)?.result?.songs;
  if (!Array.isArray(songs)) return [];
  const out: ArtworkCandidate[] = [];
  for (const r of songs) {
    const o = (r ?? {}) as Record<string, unknown>;
    const al = (o.al ?? {}) as Record<string, unknown>;
    const ar = Array.isArray(o.ar) ? o.ar : [];
    const url = upgradeNeteaseCover(String(al.picUrl ?? ""));
    if (!url) continue;
    out.push({
      title: String(o.name ?? ""),
      artist: ar.map((a) => String((a as Record<string, unknown>)?.name ?? "")).filter(Boolean).join(" / "),
      url,
    });
  }
  return out;
}

async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(
  f: FetchLike,
  url: string,
  timeoutMs: number,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<unknown | null> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await f(url, {
        signal,
        method: init.method,
        body: init.body,
        headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers ?? {}) },
      });
      if (!res.ok) return null;
      return await res.json();
    });
  } catch {
    return null;
  }
}

async function downloadImage(f: FetchLike, url: string, timeoutMs: number): Promise<{ data: Buffer; mime: string } | null> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await f(url, { signal, headers: { "User-Agent": UA, Accept: "image/*" } });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_IMAGE_BYTES || buf.length > MAX_IMAGE_BYTES) return null;
      const mime =
        sniffImageMime(buf) ?? String(res.headers?.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      if (!mime.startsWith("image/")) return null;
      return { data: buf, mime };
    });
  } catch {
    return null;
  }
}

/**
 * 按歌名 + 歌手去公开曲库找一张封面；找不到返回 null（调用方保持「无封面」）。
 * 数据源：iTunes 多个店铺（TW / US，CN 店铺实测查不到华语曲目）+ Deezer；
 * 候选汇总打分后依次尝试下载（最多 2 张，避免串行下载把首屏拖太久）。
 */
export async function lookupOnlineArtwork(q: ArtworkQuery, opts: LookupOptions = {}): Promise<OnlineArtwork | null> {
  const title = String(q.title ?? "").trim();
  if (!title) return null;
  const artist = String(q.artist ?? "").trim();
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!f) return null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const term = [artist, title].filter(Boolean).join(" ");

  const sources: {
    name: "itunes" | "deezer" | "netease";
    url: string;
    parse: (p: unknown) => ArtworkCandidate[];
    init?: { method?: string; body?: string; headers?: Record<string, string> };
  }[] = [
    ...ITUNES_STOREFRONTS.map((country) => ({
      name: "itunes" as const,
      url: `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=8&country=${country}`,
      parse: itunesCandidates,
    })),
    {
      name: "deezer" as const,
      url: `https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=8`,
      parse: deezerCandidates,
    },
    {
      // 华语（尤其独立音乐）覆盖率最好的一家：iTunes 店铺查不到的歌，它常有
      name: "netease" as const,
      url: "https://music.163.com/api/cloudsearch/pc",
      parse: neteaseCandidates,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://music.163.com/" },
        body: `s=${encodeURIComponent(term)}&type=1&limit=8&offset=0`,
      },
    },
  ];

  const ranked: (ArtworkCandidate & { score: number; name: "itunes" | "deezer" | "netease" })[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    const raw = await fetchJson(f, s.url, timeoutMs, s.init);
    for (const c of s.parse(raw)) {
      const score = matchScore(title, artist, c.title, c.artist);
      if (score < 1 || seen.has(c.url)) continue; // 歌名对不上的一律不进候选
      seen.add(c.url);
      ranked.push({ ...c, score, name: s.name });
    }
  }
  ranked.sort((a, b) => b.score - a.score);

  for (const c of ranked.slice(0, MAX_IMAGE_ATTEMPTS)) {
    const img = await downloadImage(f, c.url, timeoutMs);
    if (img) return { data: img.data, mime: img.mime, provider: c.name, matched: `${c.title} — ${c.artist}`, url: c.url };
  }
  return null;
}

export function onlineArtworkCacheDir(env: Record<string, string | undefined> = process.env): string {
  const custom = String(env.WE_ARTWORK_CACHE_DIR ?? "").trim();
  if (custom) return custom;
  const home = homedir();
  return process.platform === "darwin"
    ? join(home, "Library", "Caches", "io.github.oneincase.wallpaperem", "online-artwork")
    : join(home, ".cache", "webwallgl", "online-artwork");
}

/** 缓存键：归一化后的 歌名|歌手|专辑（同一首歌换播放器也命中同一张） */
export function onlineArtworkCacheKey(q: ArtworkQuery): string {
  return [normalizeText(q.title), normalizeText(q.artist ?? ""), normalizeText(q.album ?? "")].join("|");
}

export function onlineArtworkCacheFile(key: string, env: Record<string, string | undefined> = process.env): string {
  return join(onlineArtworkCacheDir(env), `${createHash("sha1").update(key).digest("hex")}.json`);
}

/** 读磁盘缓存；过期 / 损坏 / 非图片一律当未命中（宁可重查，也不给前端坏字节） */
export async function readOnlineArtworkCache(
  key: string,
  opts: { env?: Record<string, string | undefined>; maxAgeMs?: number; now?: number } = {},
): Promise<OnlineArtwork | null> {
  if (!key) return null;
  try {
    const raw = JSON.parse(await readFile(onlineArtworkCacheFile(key, opts.env), "utf8")) as Record<string, unknown>;
    const savedAt = Number(raw.savedAt ?? 0);
    if (!savedAt || (opts.now ?? Date.now()) - savedAt > (opts.maxAgeMs ?? ONLINE_ARTWORK_TTL_MS)) return null;
    const data = Buffer.from(String(raw.data ?? ""), "base64");
    const mime = String(raw.mime ?? "");
    if (data.length < MIN_IMAGE_BYTES || !mime.startsWith("image/")) return null;
    if (!sniffImageMime(data)) return null;
    return { data, mime, provider: "cache", matched: String(raw.matched ?? ""), url: String(raw.url ?? "") };
  } catch {
    return null;
  }
}

/** 写磁盘缓存；失败不影响本次封面（最多下次再联网查一遍） */
export async function writeOnlineArtworkCache(
  key: string,
  art: OnlineArtwork,
  opts: { env?: Record<string, string | undefined>; now?: number } = {},
): Promise<void> {
  if (!key || !art || !art.data?.length) return;
  try {
    const file = onlineArtworkCacheFile(key, opts.env);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        mime: art.mime,
        data: art.data.toString("base64"),
        matched: art.matched,
        url: art.url,
        provider: art.provider,
        savedAt: opts.now ?? Date.now(),
      }),
    );
  } catch (err) {
    // 缓存写不进不影响本次封面，但**要说一次**：否则「线上没缓存」会被误判成「查询逻辑没跑」
    if (!cacheWriteWarned) {
      cacheWriteWarned = true;
      console.warn(`[host] 在线封面缓存写入失败（本次封面不受影响）：${(err as Error)?.message ?? err}`);
    }
  }
}
