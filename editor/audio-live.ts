// 编辑器侧音频源：把「系统音频」与「试听音频」变成引擎吃得下的频谱快照。
//
// 引擎的音频反应（shader 的 g_AudioSpectrum16/32/64Left|Right uniform、粒子
// audioprocessingmode、文字脚本 engine.registerAudioBuffers）只认一份每帧快照，
// 来源由 MountOptions.audio / SceneInstance.setAudio() 的 AudioSource.snapshot() 决定。
// 编辑器预览是同页真引擎挂载（不走 iframe 遥控），所以挂载带 audio、或挂载后
// setAudio()，音频反应层就会在编辑器里真的动起来。
//
// 之前编辑器一个音频源都没有：内置模拟源恒定全零，音量又默认 0（引擎恒静音，
// bgm-analyser 的 readBands() 因 muted 直接返回 null），于是预览里频谱永远是零、
// 音条永远静止 —— 这两条源就是补这个缺口。
//
// 两条源都不依赖渲染器：一条听宿主 `/api/system/stream` 的 SSE（系统输出 loopback），
// 一条给试听的 HTMLAudioElement 挂 AnalyserNode。拿不到数据时一律喂全零快照
// （引擎注释：GL uniform 数组不设置会保留上一帧的值，静默必须显式喂零）。
//
// 系统那条 SSE 除了频谱还带宿主那份 media 快照（title/artist/album/hasArtwork）：
// 编辑器预览的封面（$mediaThumbnail）就走它 —— 那条 media 折成一个 MediaSource 交给
// 引擎，封面 URL 指向宿主的 /api/system/artwork（scene-mount 按 URL 变化 fetch + 上传）。
// 之前这里只读 `msg.audio.bands`，media 整块被丢掉，于是「音条会动、封面不出来」。

import { createMediaSource, type MediaSource } from "../renderer/src/api/editor";

/** 引擎要的形状：左右各 64 段，0..1 */
export type Bands = { left: Float32Array; right: Float32Array };

/** 编辑器侧音频源（快照恒非空：没数据就是全零；live() 说明当前是否真有信号） */
export type BandsSource = {
  snapshot(): Bands;
  live(): boolean;
};

export type AudioSourceStatus = "off" | "idle" | "live" | "preview";

const BANDS = 64;
/** 系统音频断流判据（与 renderer/src/live-system.ts 的 AUDIO_STALE_MS 一致） */
const STALE_MS = 1500;

export const silentBands = (): Bands => ({ left: new Float32Array(BANDS), right: new Float32Array(BANDS) });

/** media-bridge 的 64 段 0-255 对数频谱 → 引擎要的 0..1；左右同值（与 live-system 一致） */
export function bandsFromFrame(bands: readonly number[] | null | undefined): Bands | null {
  if (!Array.isArray(bands) || bands.length === 0) return null;
  const out = silentBands();
  const n = Math.min(BANDS, bands.length);
  for (let i = 0; i < n; i++) {
    const v = Number(bands[i]);
    const x = Number.isFinite(v) ? Math.max(0, Math.min(1, v / 255)) : 0;
    out.left[i] = x;
    out.right[i] = x;
  }
  return out;
}

/**
 * FFT 幅度谱（freq[i] = 0..255）→ 64 段对数分桶，桶内取峰。
 * 分桶公式与 renderer/src/bgm-analyser.ts 同源（usable = 0.72、lo = 2、平方刻度），
 * 这样编辑器里试听看到的频谱形状与壁纸里 BGM 驱动的形状一致。
 */
export function bandsFromFreq(freq: Uint8Array, out: Bands = silentBands()): Bands {
  const span = freq.length * 0.72;
  const lo = 2;
  for (let b = 0; b < BANDS; b++) {
    const f0 = lo + Math.floor(span * (b / BANDS) ** 2);
    const f1 = lo + Math.floor(span * ((b + 1) / BANDS) ** 2);
    const end = Math.min(freq.length, Math.max(f0 + 1, f1));
    let peak = 0;
    for (let i = f0; i < end; i++) if (freq[i] > peak) peak = freq[i];
    const x = peak / 255;
    out.left[b] = x;
    out.right[b] = x;
  }
  return out;
}

/** 把快照压成 16 段给面板电平条（每 4 段取最大，避免细线看不见） */
export function meterLevels(bands: Bands, bars = 16): number[] {
  const out: number[] = [];
  const step = BANDS / bars;
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    for (let i = Math.floor(b * step); i < Math.floor((b + 1) * step); i++) {
      peak = Math.max(peak, bands.left[i] ?? 0, bands.right[i] ?? 0);
    }
    out.push(peak);
  }
  return out;
}

/** 宿主 SSE 里那份 media 快照（host/system-live.ts 的 LiveMediaSnap 子集） */
export type RawSystemMedia = {
  hasMedia?: boolean;
  /** 1=播放 2=暂停（host/system-live.ts 的取值） */
  state?: number;
  title?: string;
  artist?: string;
  album?: string;
  /** 秒 */
  position?: number;
  duration?: number;
  hasArtwork?: boolean;
};

/** 媒体控制转发给宿主端点：编辑器自己没有播放器，控制面属于 media-bridge */
function postMediaControl(origin: string, action: string): void {
  try {
    void fetch(`${origin}/api/system/media-control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => {
      /* 端点不在（纯静态预览）就静默：控制面本来就允许无效 */
    });
  } catch {
    /* 同上 */
  }
}

export type SystemAudioSource = BandsSource & {
  /** 开听宿主 SSE（幂等；重复调用不叠加连接） */
  start(): void;
  stop(): void;
  status(): AudioSourceStatus;
  /**
   * 同一条 SSE 上的系统媒体源（Now Playing + 封面）。
   * 对象**恒为同一个**（挂载时带上、之后随 SSE 热更），可直接 setMedia()/MountOptions.media。
   */
  media(): MediaSource;
  dispose(): void;
};

/**
 * 系统音频：宿主 media-bridge（原生 loopback + FFT，64 段 0-255 对数）经
 * /api/system/stream 的 SSE 推下来。宿主没装 / 没权限时连不上，SSE 自动重连，
 * 这段期间快照全零、status() 为 "idle" —— 不抛错、不影响挂载。
 */
export function createSystemAudioSource(origin = ""): SystemAudioSource {
  let es: EventSource | null = null;
  let cur: Bands | null = null;
  let at = 0;
  // Now Playing 那条：库里 createMediaSource 会把配色/歌词行补全（手工拼快照会漏掉
  // 五个可链式颜色对象，脚本一调 subtract/multiply 就 TypeError 熔断）。
  const mediaSrc = createMediaSource(
    { hasMedia: false, state: 0, hasThumbnail: false },
    {
      skipNext: () => postMediaControl(origin, "skipNext"),
      skipPrevious: () => postMediaControl(origin, "skipPrevious"),
      play: () => postMediaControl(origin, "play"),
      pause: () => postMediaControl(origin, "pause"),
      playPause: () => postMediaControl(origin, "playPause"),
    },
  );
  /** 上一次的曲目键（含有无封面）：决定要不要换封面 URL */
  let mediaKey = "";
  const applyMedia = (m: RawSystemMedia | null | undefined) => {
    if (!m || m.hasMedia !== true) {
      if (mediaKey === "") return;
      mediaKey = "";
      mediaSrc.set({ hasMedia: false, state: 0, title: "", artist: "", album: "", position: 0, duration: 0, hasThumbnail: false, thumbnail: undefined });
      return;
    }
    const title = String(m.title ?? "");
    const artist = String(m.artist ?? "");
    const album = String(m.album ?? "");
    const hasArtwork = m.hasArtwork === true;
    // 曲目 / 有无封面没变就不重写 thumbnail：scene-mount 是按 URL 变化判重的，
    // 每 500ms 换个新 URL 会让场景反复 fetch + 重传 $mediaThumbnail。
    const key = `${title}|${artist}|${album}|${hasArtwork ? 1 : 0}`;
    const fresh = key !== mediaKey;
    mediaKey = key;
    mediaSrc.set({
      hasMedia: true,
      state: m.state === 2 ? 2 : 1,
      title,
      artist,
      album,
      position: Number(m.position) || 0,
      duration: Number(m.duration) || 0,
      hasThumbnail: hasArtwork,
      // 只在换曲/封面有无变化时改 URL：封面本体走 /api/system/artwork（二进制，不进 SSE）
      ...(fresh
        ? { thumbnail: hasArtwork ? `${origin}/api/system/artwork?k=${encodeURIComponent(`${title}|${artist}|${album}`)}` : undefined }
        : {}),
    });
  };
  const src: SystemAudioSource = {
    media: () => mediaSrc,
    start() {
      if (es || typeof EventSource === "undefined") return;
      es = new EventSource(`${origin}/api/system/stream`);
      es.onmessage = (ev: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(ev.data) as { audio?: { bands?: number[] }; media?: RawSystemMedia };
          const bands = bandsFromFrame(msg.audio?.bands);
          if (bands) {
            cur = bands;
            at = Date.now();
          }
          // 只认「带 media 字段」的报文：宿主频谱帧（{audio}）与 media 帧（{media,window,…}）
          // 是同一条 SSE 上的两种报文，频谱帧约 30Hz、media 帧约 2Hz —— 把频谱帧当成
          // 「没在播」会把刚收到的封面/歌名按 30Hz 洗掉（实测就是封面永远出不来）。
          if (msg.media !== undefined && msg.media !== null) applyMedia(msg.media);
        } catch {
          /* 单帧不规范就当没收到，等下一帧 */
        }
      };
    },
    stop() {
      es?.close();
      es = null;
      cur = null;
      at = 0;
    },
    dispose() {
      src.stop();
    },
    live() {
      return !!cur && Date.now() - at < STALE_MS;
    },
    status() {
      if (!es) return "off";
      return src.live() ? "live" : "idle";
    },
    snapshot() {
      return src.live() && cur ? cur : silentBands();
    },
  };
  return src;
}

export type ElementAudioSource = BandsSource & {
  status(): AudioSourceStatus;
  dispose(): void;
};

/**
 * 试听音频：给 `new Audio(url)` 的元素挂 AnalyserNode。
 * 接进 AudioContext 之后元素不再直接播到输出，所以 analyser 要再接回 destination，
 * 否则试听会变成哑巴。AudioContext 没跑起来（没用户手势）时**不接图**：宁可只有声音、
 * 没有频谱，也不要把试听掐无声。同一个元素只能建一次 source，所以每次试听新建元素。
 */
export function createElementAudioSource(au: HTMLAudioElement): ElementAudioSource {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let node: MediaElementAudioSourceNode | null = null;
  let freq: Uint8Array | null = null;
  const empty = silentBands();
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor) ctx = new Ctor();
    // 挂起也照样建图：resume() 是异步的，等它「跑起来」再建会白丢一次试听（getByteFrequencyData
    // 在挂起的上下文里本来就读全零，不需要额外判断）。
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
    if (ctx) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      node = ctx.createMediaElementSource(au);
      node.connect(analyser);
      // 采集完必须接回输出：少了这一跳，试听就只剩波形没有声音。
      analyser.connect(ctx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
    }
  } catch {
    // 建图中途失败时不能把试听掐哑：元素直放，频谱这条退回全零。
    try {
      node?.disconnect();
    } catch {
      /* 没接上 */
    }
    try {
      if (ctx && node) node.connect(ctx.destination);
    } catch {
      /* 接不回输出就认了，至少声音还在 */
    }
    analyser = null;
    freq = null;
  }
  const live = () => !!au && !au.paused && !au.ended && !au.muted && au.volume > 0;
  return {
    live,
    status() {
      if (!analyser) return "off";
      return live() ? "preview" : "idle";
    },
    snapshot() {
      if (!analyser || !freq || !live()) return empty;
      analyser.getByteFrequencyData(freq);
      return bandsFromFreq(freq, empty);
    },
    dispose() {
      try {
        node?.disconnect();
        analyser?.disconnect();
      } catch {
        /* 已经断开 */
      }
      analyser = null;
      node = null;
      freq = null;
      if (ctx) void ctx.close().catch(() => {});
      ctx = null;
    },
  };
}

export type AudioMeter = {
  /** 换源：null = 停表并把柱子清零 */
  setSource(src: BandsSource | null): void;
  /** 每帧回调（状态文案用），返回 false 表示不再需要 */
  onFrame(cb: (() => void) | null): void;
  dispose(): void;
};

/**
 * 面板电平条：16 根 `<i>`，只在有源时跑 rAF（省掉空闲时的每帧样式写入）。
 * 纯展示，不参与渲染。
 */
export function mountAudioMeter(el: HTMLElement, bars = 16): AudioMeter {
  el.textContent = "";
  const items: HTMLElement[] = [];
  for (let i = 0; i < bars; i++) {
    const bar = document.createElement("i");
    el.appendChild(bar);
    items.push(bar);
  }
  let src: BandsSource | null = null;
  let raf = 0;
  let frame: (() => void) | null = null;
  const paint = (levels: number[]) => {
    for (let i = 0; i < items.length; i++) items[i].style.setProperty("--lvl", String(Math.round((levels[i] ?? 0) * 100)));
  };
  const tick = () => {
    if (!src) return;
    paint(meterLevels(src.snapshot(), items.length));
    frame?.();
    raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  paint([]);
  return {
    setSource(next) {
      stop();
      src = next;
      if (!src) {
        paint([]);
        return;
      }
      raf = requestAnimationFrame(tick);
    },
    onFrame(cb) {
      frame = cb;
    },
    dispose() {
      stop();
      src = null;
      frame = null;
      el.textContent = "";
    },
  };
}
