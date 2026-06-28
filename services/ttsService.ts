// Robust voice for the verbal interview.
// Primary: Gemini LIVE native-audio (conversational, human) → WAV → <Audio>.
// Then:    Gemini 3.1 dedicated TTS (neural read-aloud) if Live fails.
// Last:    browser Web Speech API (only if all Gemini paths fail).
// Every call is cancellable; speak() resolves when playback ends (or on cancel).
//
// SPEED: neural TTS generation can take many seconds (cold preview models).
// Two mechanisms keep the interview snappy:
//   1) per-attempt TIMEOUT → a slow/hanging model falls through to the next
//      model (and finally Web Speech) fast instead of freezing the interview.
//   2) PREFETCH cache → the screen warms the NEXT question's audio while the
//      candidate answers the current one, so the next prompt plays instantly.

import { GoogleGenAI, Modality } from '@google/genai';
import { MODELS } from '../constants/models';

// Voice chain for the interview, best → safest:
//   1) LIVE native-audio (gemini-3.1-flash-live-preview) — a genuine
//      conversational engine; sounds HUMAN, not a flat read-aloud. Primary.
//   2) 3.1-flash-tts (dedicated TTS) — high-quality neural read-aloud, fallback.
//   3) browser Web Speech — last resort so the interview never goes silent.
// No 2.5 model anywhere (owner mandate).
const LIVE_MODEL = MODELS.LIVE;                       // 3.1-flash-live-preview
const TTS_MODELS = [MODELS.TTS, MODELS.TTS_FALLBACK]; // 3.1-flash-tts (+retry)
// Gemini prebuilt voices. Puck = the fast, lively, conversational Arabic voice
// (owner mandate 2026-06-16: "بوكا" — best Arabic voice, NOT the slow/flat ones).
// Female keeps Kore. Both run on the fast 3.1-flash-tts model.
export type TtsGender = 'male' | 'female';
const VOICE: Record<TtsGender, string> = { male: 'Puck', female: 'Kore' };

// Diagnostics / UI: the configured neural voice name (male = Puck per owner
// mandate 2026-06-16). Lets callers verify or label which voice the candidate
// hears — locks the Puck mandate in tests and backs a future voice badge. (A4)
export function configuredVoice(gender: TtsGender): string { return VOICE[gender]; }

// Per-attempt generation budget. Past this we abandon the model and try the
// next one (or Web Speech) so the interview never stalls on a cold model.
// MEASURED 2026-06-14: real neural TTS for a full greeting+scenario prompt takes
// 18-22s on the 3.1 preview model (cold start can exceed that). The old 14s budget
// timed out EVERY real question → null → silent interviewer. Give it real headroom.
const GEN_TIMEOUT_MS = 38000;
// The Live websocket can open + stream a short prompt in ~6-10s; give it ample
// room (token fetch + ws + generation on a slow network) before falling through
// to dedicated TTS — we want the human native-audio voice, not the read-aloud.
const LIVE_TIMEOUT_MS = 24000;

// Style direction prepended to every prompt. Gemini TTS treats a leading
// natural-language instruction as DELIVERY guidance (not spoken text), turning
// the default flat read-aloud into a warm, human interviewer tone. This is the
// single biggest perceived-quality lever short of the Live native-audio API.
const STYLE_AR = 'بنبرة دافئة ودّية وطبيعية، زي محاور بشري محترف وهادئ، بإيقاع مريح وواضح: ';
const STYLE_EN = 'In a warm, friendly, natural voice — like a calm professional human interviewer, at an easy clear pace: ';
const styled = (text: string): string =>
  (/[؀-ۿ]/.test(text) ? STYLE_AR : STYLE_EN) + text;

let _audio: HTMLAudioElement | null = null;     // currently-playing element
let _objectUrl: string | null = null;
let _genId = 0;                                  // bumps on every cancel to abandon stale playback
let _speakingGen = -1;                            // _genId of an in-flight speak() — keeps isSpeaking() true during neural GENERATION (before _audio is set), so the proctor alarm defers instead of cancel-killing a still-generating question (A4)

// ---- Autoplay unlock --------------------------------------------------------
// The neural blob is generated 5-8s AFTER the join gesture; by then a fresh
// `new Audio().play()` is treated as programmatic (no transient activation) and
// blocked on Safari + some Chrome configs → the interview goes silent.
// Fix: prime ONE reusable <audio> element DURING the user gesture (play a tiny
// silent clip then pause). That element keeps its activation, so later
// programmatic .play() on it is allowed. We also resume an AudioContext for
// browsers that gate on it. Call unlockAudio() from any click handler.
let _player: HTMLAudioElement | null = null;
let _unlockCtx: AudioContext | null = null;
// 0.05s of silence as a WAV data URL — enough to bless the element.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

export function unlockAudio(): void {
  try {
    if (!_player) {
      _player = new Audio();
      _player.preload = 'auto';
      _player.setAttribute('playsinline', 'true');
    }
    _player.src = SILENT_WAV;
    _player.muted = true;
    const p = _player.play();
    if (p && typeof p.then === 'function') {
      p.then(() => { try { _player!.pause(); _player!.currentTime = 0; _player!.muted = false; } catch { /* noop */ } })
       .catch(() => { /* gesture too weak — still try real playback later */ });
    }
  } catch { /* noop */ }
  try {
    const Ctx = (typeof window !== 'undefined')
      ? ((window as any).AudioContext || (window as any).webkitAudioContext)
      : undefined;
    if (Ctx) {
      if (!_unlockCtx) _unlockCtx = new Ctx();
      if (_unlockCtx.state === 'suspended') void _unlockCtx.resume().catch(() => { /* noop */ });
    }
  } catch { /* noop */ }
}

// ---- Prefetch cache: text → ready WAV blob ----------------------------------
// Lets the UI warm the next prompt's audio ahead of time. Bounded + keyed by
// (model-chain, gender, text) so a voice/text change never serves stale audio.
const _blobCache = new Map<string, Blob>();
const _inflight = new Map<string, Promise<Blob | null>>();
const MAX_CACHE = 16;
const cacheKey = (text: string, gender: TtsGender) => `${gender}::${text}`;

function rememberBlob(key: string, blob: Blob): void {
  _blobCache.set(key, blob);
  while (_blobCache.size > MAX_CACHE) {
    const oldest = _blobCache.keys().next().value;
    if (oldest === undefined) break;
    _blobCache.delete(oldest);
  }
}

export function cancelSpeech(): void {
  _genId++;
  try { _audio?.pause(); } catch { /* noop */ }
  _audio = null;
  if (_objectUrl) { try { URL.revokeObjectURL(_objectUrl); } catch { /* noop */ } _objectUrl = null; }
  try { if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel(); } catch { /* noop */ }
}

// True while audio is actively playing — the neural <audio> element OR the browser
// Web Speech engine. The proctor alarm consults this so it never speaks over (and
// cancelSpeech-kills) in-progress question narration. (A4)
export function isSpeaking(): boolean {
  if (_speakingGen === _genId) return true;   // a narration is generating or playing for the current generation
  if (_audio && !_audio.paused && !_audio.ended) return true;
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis.speaking) return true;
  } catch { /* noop */ }
  return false;
}

// Voice-status notifications for the UI. 'neural' = the natural Puck voice played;
// 'fallback' = the neural chain was unavailable and we resorted to the robotic
// browser voice. The exam portal subscribes to SHOW a visible "voice unavailable"
// notice instead of silently swapping the jarring fallback voice in (A4). One
// global listener — only one candidate-facing narration surface is live at a time.
export type VoiceStatus = 'neural' | 'fallback';
let _voiceFallbackHandler: ((s: VoiceStatus) => void) | null = null;
export function setVoiceFallbackHandler(fn: ((s: VoiceStatus) => void) | null): void {
  _voiceFallbackHandler = fn;
}
function notifyVoice(s: VoiceStatus): void {
  try { _voiceFallbackHandler?.(s); } catch { /* a listener must never break playback */ }
}

// ---- PCM(base64) → WAV(blob) ------------------------------------------------
// Gemini returns signed 16-bit little-endian PCM mono. Sample rate is carried in
// the inlineData mimeType (e.g. "audio/L16;rate=24000"); default 24 kHz.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Wrap raw PCM bytes in a WAV container.
function pcmBytesToWav(pcm: Uint8Array, sampleRate: number): Blob {
  const len = pcm.length;
  const buf = new ArrayBuffer(44 + len);
  const dv = new DataView(buf);
  const wr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + len, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);  // PCM
  dv.setUint16(22, 1, true);                                              // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);                                 // byte rate
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);                  // block align, bits
  wr(36, 'data'); dv.setUint32(40, len, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

function pcmToWav(b64: string, sampleRate: number): Blob {
  return pcmBytesToWav(b64ToBytes(b64), sampleRate);
}

// Concatenate many base64 PCM chunks (Live streams audio in pieces) → one WAV.
function pcmChunksToWav(chunks: string[], sampleRate: number): Blob {
  const parts = chunks.map(b64ToBytes);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { merged.set(p, off); off += p.length; }
  return pcmBytesToWav(merged, sampleRate);
}

function rateFromMime(mime?: string): number {
  const m = mime?.match(/rate=(\d+)/);
  return m ? parseInt(m[1], 10) : 24000;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tts-timeout')), ms);
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

function apiKey(): string {
  // Vite `define` replaces the LITERAL token `process.env.API_KEY` with the key
  // string at build time. A `typeof process !== 'undefined'` guard breaks this:
  // the guard is NOT the magic token, so it survives to runtime where `process`
  // is undefined in the browser → the whole expression short-circuits to '' and
  // the embedded key is unreachable. That silently emptied the TTS key in prod,
  // so dedicated TTS returned null and the voice fell back to robotic Web Speech.
  // Reference the magic token DIRECTLY (same as geminiService) — no guard.
  return process.env.API_KEY || '';
}

// Generate a WAV blob for `text` with one model (no playback). null = no audio.
// Wrapped in a hard timeout so a cold/slow preview model can't stall the chain.
async function genBlobOnce(text: string, gender: TtsGender, model: string): Promise<Blob | null> {
  const key = apiKey();
  if (!key) return null;
  const ai = new GoogleGenAI({ apiKey: key });
  const res: any = await withTimeout(ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: styled(text) }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE[gender] } } },
    },
  }), GEN_TIMEOUT_MS);
  const part = res?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data);
  const data: string | undefined = part?.inlineData?.data;
  if (!data) return null;
  return pcmToWav(data, rateFromMime(part.inlineData.mimeType));
}

// Generate a WAV via the LIVE native-audio model (gemini-3.1-flash-live-preview).
// Opens a websocket, sends the prompt as one turn, accumulates the streamed
// audio chunks until turnComplete, then returns one WAV. This is a genuine
// conversational engine → far more human/natural than read-aloud TTS.
// Once the Live websocket is rejected (e.g. the API key is HTTP-referrer
// restricted — websockets carry no Referer, so Google blocks them with close
// code 1008), there's no point retrying it for every prompt: flip this flag and
// skip straight to dedicated TTS. Lets us ship Live-ready code that activates
// automatically the day the key path supports it (ephemeral token / proxy),
// without paying a failed-handshake latency on every question meanwhile.
let _liveBlocked = false;

// Ephemeral-token cache. Live can't use the referrer-restricted prod key over a
// websocket (close 1008). A Firebase Function mints a short ephemeral token with
// the unrestricted server key; the client opens the ws with token.name (no
// referer needed). Cached across utterances until ~expiry, then re-minted.
let _liveToken: { name: string; expMs: number } | null = null;

async function fetchLiveToken(): Promise<string | null> {
  const now = Date.now();
  if (_liveToken && _liveToken.expMs - now > 60_000) return _liveToken.name;
  try {
    const [{ getApp }, { getFunctions, httpsCallable }] = await Promise.all([
      import('firebase/app'),
      import('firebase/functions'),
    ]);
    // Gated server-side by Origin allowlist (no app login exists in prod).
    const fns = getFunctions(getApp(), 'us-central1');
    const call = httpsCallable<unknown, { token: string; expireTime?: string }>(fns, 'liveToken');
    const res = await call({});
    const name = res?.data?.token;
    if (!name) { console.warn('[voice] liveToken: no token in response'); return null; }
    const expMs = res.data.expireTime ? Date.parse(res.data.expireTime) : now + 25 * 60_000;
    _liveToken = { name, expMs };
    console.info('[voice] liveToken minted ✓');
    return name;
  } catch (e: any) {
    console.warn('[voice] liveToken fetch failed:', e?.code || e?.message || e);
    return null;
  }
}

async function genLiveBlob(text: string, gender: TtsGender): Promise<Blob | null> {
  if (_liveBlocked) return null;
  const token = await fetchLiveToken();
  if (!token) return null;
  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
  const chunks: string[] = [];
  let rate = 24000;

  return withTimeout(new Promise<Blob | null>((resolve, reject) => {
    let settled = false;
    const finish = (b: Blob | null) => { if (settled) return; settled = true; resolve(b); };
    ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE[gender] } } },
      },
      callbacks: {
        onopen: () => { /* connected */ },
        onmessage: (m: any) => {
          const parts = m?.serverContent?.modelTurn?.parts || [];
          for (const p of parts) {
            const d = p?.inlineData?.data;
            if (d) { chunks.push(d); rate = rateFromMime(p.inlineData.mimeType) || rate; }
          }
          if (m?.serverContent?.turnComplete) {
            finish(chunks.length ? pcmChunksToWav(chunks, rate) : null);
          }
        },
        onerror: (e: any) => { if (!settled) reject(e instanceof Error ? e : new Error('live-error')); },
        onclose: (e: any) => {
          const reason = String(e?.reason || '');
          // Token expired/exhausted/invalid → drop cache, re-mint next call.
          if (/token|expire|unauth|invalid/i.test(reason)) _liveToken = null;
          // Hard referer/permission block → disable Live for the session.
          else if (/referer|blocked|denied|permission/i.test(reason)) _liveBlocked = true;
          finish(chunks.length ? pcmChunksToWav(chunks, rate) : null);
        },
      },
    }).then((session: any) => {
      try {
        session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: styled(text) }] }],
          turnComplete: true,
        });
      } catch (e) { if (!settled) reject(e instanceof Error ? e : new Error('live-send')); }
      // Close shortly after turnComplete resolves; guard via settled flag.
      const closeWhenDone = setInterval(() => {
        if (settled) { clearInterval(closeWhenDone); try { session.close(); } catch { /* noop */ } }
      }, 200);
    }).catch((e: any) => { if (!settled) reject(e instanceof Error ? e : new Error('live-connect')); });
  }), LIVE_TIMEOUT_MS);
}

// Voice chain, reliable → enhancement: dedicated TTS (3.1, proven on the prod
// referrer key) → Live native-audio → null. Dedicated TTS goes FIRST because the
// Live preview is flaky/slow — putting it first meant a hung Live ws stalled the
// voice for up to LIVE_TIMEOUT_MS before falling through, which the user heard as
// a freeze then a robotic Web Speech voice. TTS-first guarantees the neural Orus
// voice plays immediately; Live is only tried if TTS itself yields nothing.
// First path that yields audio wins; Web Speech is the caller's final fallback.
async function genBlobChain(text: string, gender: TtsGender): Promise<Blob | null> {
  for (const model of TTS_MODELS) {
    try {
      const blob = await genBlobOnce(text, gender, model);
      if (blob) { console.info('[voice] path = dedicated TTS', model); return blob; }
    } catch (e: any) { console.warn('[voice] TTS', model, 'failed:', e?.message || e); }
  }
  try {
    const live = await genLiveBlob(text, gender);
    if (live) { console.info('[voice] path = LIVE native-audio ✓'); return live; }
  } catch (e: any) { console.warn('[voice] LIVE failed:', e?.message || e); }
  console.warn('[voice] path = Web Speech fallback (no Gemini audio)');
  return null;
}

// Browser diagnostic: run the real voice chain and report which path wins.
// Call window.__voiceTest() from the console / preview_eval to verify Live.
if (typeof window !== 'undefined') {
  (window as any).__voiceTest = async (text = 'مرحبًا، أهلاً بك في المقابلة.') => {
    const t0 = Date.now();
    try {
      const live = await genLiveBlob(text, 'male');
      const ms = Date.now() - t0;
      if (live) return { path: 'LIVE', ms, bytes: live.size };
      return { path: 'LIVE_NULL_fellback', ms };
    } catch (e: any) {
      return { path: 'LIVE_ERROR', err: e?.message || String(e) };
    }
  };
}

// Get a blob from cache, an in-flight request, or a fresh generation. Caches
// the result so a later speak()/prefetch() of the same text is instant.
function obtainBlob(text: string, gender: TtsGender): Promise<Blob | null> {
  const key = cacheKey(text, gender);
  const cached = _blobCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = _inflight.get(key);
  if (pending) return pending;
  const job = genBlobChain(text, gender)
    .then(blob => { if (blob) rememberBlob(key, blob); return blob; })
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, job);
  return job;
}

/**
 * Warm the audio for `text` ahead of time (no playback). Call while the
 * candidate answers the current question to make the NEXT prompt instant.
 * Fully best-effort: failures are swallowed and just mean no warm cache.
 */
export function prefetch(text: string, opts: { gender?: TtsGender } = {}): void {
  const clean = (text || '').trim();
  if (!clean || !apiKey()) return;
  void obtainBlob(clean, opts.gender || 'male').catch(() => { /* best-effort */ });
}

function playBlob(blob: Blob, myGen: number): Promise<void> {
  if (myGen !== _genId) return Promise.resolve();  // cancelled while generating
  const url = URL.createObjectURL(blob);
  _objectUrl = url;
  // Reuse the gesture-primed element when available — its activation lets the
  // delayed programmatic play() through. Fall back to a fresh element if unlock
  // never ran (e.g. autoplay-permissive context).
  const audio = _player || new Audio();
  audio.src = url;
  audio.muted = false;
  audio.currentTime = 0;
  _audio = audio;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return; settled = true;
      if (_objectUrl === url) { try { URL.revokeObjectURL(url); } catch { /* noop */ } _objectUrl = null; }
      if (_audio === audio) _audio = null;
      audio.onended = null; audio.onerror = null;
      ok ? resolve() : reject(new Error('playback-failed'));
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(true);  // decode/network error — treat as done, don't block chain
    const p = audio.play();
    if (p && typeof p.then === 'function') {
      // play() rejection = autoplay blocked → reject so caller falls to Web Speech.
      p.catch(() => finish(false));
    }
  });
}

// Browser voice names that are male (or female, to exclude). The default Arabic
// Web Speech voice is female on most platforms, so when we want the male voice we
// must actively prefer a known-male voice and avoid the known-female ones.
const MALE_VOICE_HINTS = /\b(male|man|hamed|naayf|tarik|fahad|majed|hamza|david|daniel|george|james|fred|alex|mark|guy|rishi|ryan|will)\b/i;
const FEMALE_VOICE_HINTS = /\b(female|woman|hoda|salma|laila|zariyah|amira|naayf?a|zira|samantha|susan|karen|tessa|fiona|moira|serena|google عربي|عربية)\b/i;

function pickVoice(voices: SpeechSynthesisVoice[], lang: string, gender: TtsGender): SpeechSynthesisVoice | undefined {
  const inLang = voices.filter(v => v.lang?.toLowerCase().startsWith(lang.slice(0, 2)));
  if (inLang.length === 0) return undefined;
  if (gender === 'male') {
    return (
      inLang.find(v => MALE_VOICE_HINTS.test(v.name)) ||           // explicit male
      inLang.find(v => !FEMALE_VOICE_HINTS.test(v.name)) ||        // anything not clearly female
      inLang[0]                                                     // last resort
    );
  }
  return inLang.find(v => FEMALE_VOICE_HINTS.test(v.name)) || inLang[0];
}

function webSpeechSpeak(text: string, lang: string, myGen: number, gender: TtsGender = 'male'): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) { resolve(); return; }
    const synth = window.speechSynthesis;
    const voices = synth.getVoices();
    const pref = pickVoice(voices, lang, gender);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    if (pref) u.voice = pref;
    u.rate = lang.startsWith('ar') ? 0.92 : 0.98;
    let settled = false;
    const done = () => { if (settled) return; settled = true; resolve(); };
    u.onend = done; u.onerror = done;
    // Chrome bug: speak() right after cancel() can be dropped — small delay.
    try { synth.cancel(); } catch { /* noop */ }
    window.setTimeout(() => {
      if (myGen !== _genId) { done(); return; }
      window.setTimeout(done, Math.min(45000, 2500 + text.length * 90));  // safety timeout
      synth.speak(u);
    }, 60);
  });
}

// INSTANT mode grace: with `instant`, we never make the interviewer wait the full
// neural-gen budget (18-22s, worst-case chain ~100s) before any sound. We race the
// (possibly warm/in-flight) neural blob against a short grace; whichever is first
// wins. If neural isn't ready in time, Web Speech speaks IMMEDIATELY so the robot
// talks at once — and the neural blob keeps generating in the background and lands
// in the cache, so a replay of the same prompt plays in the real neural voice.
// Owner mandate (2026-06-16): the interviewer must speak instantly, never freeze.
const INSTANT_GRACE_MS = 2600;

/**
 * Speak `text` and resolve when audio finishes (or is cancelled).
 * Serves warm cache instantly; otherwise generates (Gemini chain) with a hard
 * per-model timeout, then falls back to Web Speech so the interview never stalls.
 * `instant`: cap time-to-first-sound at INSTANT_GRACE_MS — play warm/quick neural
 * if it arrives, else speak via Web Speech right away (no long wait, ever).
 */
export async function speak(text: string, opts: { gender?: TtsGender; lang?: string; instant?: boolean; notify?: boolean } = {}): Promise<void> {
  const clean = (text || '').trim();
  if (!clean) return;
  cancelSpeech();
  const myGen = _genId;
  _speakingGen = myGen;            // mark in-progress NOW (covers the generate-before-playback window) so the proctor alarm defers (A4)
  const gender = opts.gender || 'male';
  const lang = opts.lang || 'ar-SA';
  // notify (default on) drives the candidate "voice unavailable" notice. The
  // proctor alarm passes notify:false so its OWN fallback never mislabels the
  // candidate's question-voice status (A4).
  const notify = opts.notify !== false;
  try {
    if (opts.instant) {
      // Race the neural blob (warm cache / in-flight gen) against a short grace.
      // obtainBlob caches its result, so even if the grace wins now, the neural
      // audio is ready for a later replay.
      const blob = await Promise.race<Blob | null>([
        obtainBlob(clean, gender).catch(() => null),
        new Promise<null>(resolve => setTimeout(() => resolve(null), INSTANT_GRACE_MS)),
      ]);
      if (myGen !== _genId) return;
      if (blob) {
        try { await playBlob(blob, myGen); return; }
        catch { /* autoplay blocked → fall through to Web Speech */ }
        if (myGen !== _genId) return;
      }
      // Neural not ready within grace → speak now via the browser voice.
      await webSpeechSpeak(clean, lang, myGen, gender);
      return;
    }

    let blob: Blob | null = null;
    try { blob = await obtainBlob(clean, gender); } catch { blob = null; }
    if (myGen !== _genId) return;          // cancelled while generating
    if (blob) {
      // notify('neural') only AFTER playback actually starts — if play() rejects
      // (autoplay blocked) we fall through to 'fallback' below, so emitting
      // 'neural' first would flicker the notice clear→show. The per-question
      // notice reset (portal, keyed on qIndex) handles staleness across questions.
      try { await playBlob(blob, myGen); if (notify) notifyVoice('neural'); return; }
      catch { /* autoplay blocked → fall through to Web Speech */ }
      if (myGen !== _genId) return;
    }

    // Gemini chain produced nothing (no key / quota / timeout) OR playback was
    // blocked → robotic browser voice. Tell the UI so it can label this as a
    // degraded last-resort voice instead of silently swapping it in (A4).
    if (notify) notifyVoice('fallback');
    await webSpeechSpeak(clean, lang, myGen, gender);
  } finally {
    if (_speakingGen === myGen) _speakingGen = -1;   // clear only if a newer speak() hasn't taken over
  }
}

export const ttsSupported = true;  // always — Gemini path needs no browser voices
