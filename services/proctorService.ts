// proctorService.ts — DOM + Gemini Live WebSocket proctoring service.
// Imports pure logic from ./proctorCore (no DOM, no WebSocket).
// Pattern mirrors ttsService.ts: GoogleGenAI v1alpha, ai.live.connect.
// Auth: fetchProctorToken() (Firebase callable 'proctorToken') → process.env.API_KEY.
// compositeFrame draws screen (full) + camera (PiP inset) with burned labels →
//   base64 JPEG q0.5 on a 1024-wide canvas, no data: prefix.
// Frame pump: every opts.intervalMs (default 2500) via sendRealtimeInput.
// Incoming text: parseProctorMessage → applyAlert → onAlert/onState callbacks.
// DOM events: pushEvent uses eventAlert.
// stop(): returns summarizeProctor(state). Graceful: never throws out of start().

import { GoogleGenAI, Modality } from '@google/genai';
import { MODELS } from '../constants/models';
import { speak as ttsSpeak } from './ttsService';
import {
  initProctorState,
  buildProctorSystemInstruction,
  parseProctorMessage,
  applyAlert,
  eventAlert,
  summarizeProctor,
  type ProctorAlert,
  type ProctorState,
  type ProctorSummary,
  type ProctorSignalType,
} from './proctorCore';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LiveProctorOptions {
  /** Video element showing the candidate's camera feed. */
  cameraEl: HTMLVideoElement;
  /** Video element (or null) showing the screen capture feed. */
  screenEl: HTMLVideoElement | null;
  /** Fires every time a new ProctorAlert is created. */
  onAlert: (alert: ProctorAlert) => void;
  /** Fires after every state update with the latest ProctorState. */
  onState: (state: ProctorState) => void;
  /** Reports connection lifecycle: 'connecting' | 'live' | 'unavailable' | 'closed'. */
  onStatus: (status: 'connecting' | 'live' | 'unavailable' | 'closed') => void;
  /** Frame pump interval in ms (default 2500). */
  intervalMs?: number;
  /** Returns the candidate's current question index, so each alert records WHERE it happened. */
  getQuestion?: () => number | null | undefined;
}

export interface LiveProctorHandle {
  /**
   * Start the Gemini Live session and frame pump.
   * Resolves immediately; never rejects — errors call onStatus('unavailable').
   */
  start(): Promise<void>;
  /**
   * Push a DOM/sensor alert directly (e.g. tab_switch, fullscreen_exit).
   * Works even when the WebSocket is unavailable.
   */
  pushEvent(type: ProctorSignalType, message: string): void;
  /**
   * Stop the session, cancel the frame pump, close the WebSocket.
   * Returns the end-of-session ProctorSummary.
   */
  stop(): ProctorSummary;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Higher than a basic thumbnail so the model can READ small on-screen text (browser
// tab titles, a visible ChatGPT/AI tool) — that legibility is what makes screen-content
// cheating detection work. At ~1 frame/4s the extra bytes are a modest cost.
const COMPOSITE_WIDTH  = 1600;
const PIP_RATIO        = 0.24;   // camera PiP width as fraction of canvas width
const PIP_MARGIN       = 10;     // px gap from bottom-right corner
const JPEG_QUALITY     = 0.72;
const LABEL_FONT       = 'bold 14px sans-serif';
const LABEL_BG         = 'rgba(0,0,0,0.55)';
const LABEL_FG         = '#ffffff';
const LABEL_PAD        = 4;

// Ephemeral proctor token cache (analogous to _liveToken in ttsService).
let _proctorToken: { name: string; expMs: number } | null = null;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function fetchProctorToken(): Promise<string | null> {
  const now = Date.now();
  if (_proctorToken && _proctorToken.expMs - now > 60_000) return _proctorToken.name;
  try {
    const [{ getApp }, { getFunctions, httpsCallable }] = await Promise.all([
      import('firebase/app'),
      import('firebase/functions'),
    ]);
    const fns = getFunctions(getApp(), 'us-central1');
    const call = httpsCallable<unknown, { token: string; expireTime?: string }>(fns, 'proctorToken');
    const res = await call({});
    const name = res?.data?.token;
    if (!name) { console.warn('[proctor] proctorToken: no token in response'); return null; }
    const expMs = res.data.expireTime ? Date.parse(res.data.expireTime) : now + 25 * 60_000;
    _proctorToken = { name, expMs };
    console.info('[proctor] proctorToken minted ✓');
    return name;
  } catch (e: any) {
    console.warn('[proctor] proctorToken fetch failed:', e?.code || e?.message || e);
    return null;
  }
}

function apiKey(): string {
  // Reference the Vite magic token directly (same pattern as ttsService).
  return process.env.API_KEY || '';
}

async function resolveApiKey(): Promise<string | null> {
  const token = await fetchProctorToken();
  if (token) return token;
  const key = apiKey();
  return key || null;
}

// ─── compositeFrame ──────────────────────────────────────────────────────────

/**
 * Draw screen video (full) + camera video (PiP inset, bottom-right) onto a
 * 1024-wide offscreen canvas with burned "SCREEN"/"CAMERA" labels.
 * Returns a base64 JPEG (quality 0.5) — NO "data:image/jpeg;base64," prefix.
 * Returns null if neither source has renderable content.
 */
function compositeFrame(
  cameraEl: HTMLVideoElement,
  screenEl: HTMLVideoElement | null,
): string | null {
  const canvas = document.createElement('canvas');

  // Determine background source: prefer screen, fall back to camera.
  const bgEl = (screenEl && screenEl.readyState >= 2 && screenEl.videoWidth > 0)
    ? screenEl
    : (cameraEl.readyState >= 2 && cameraEl.videoWidth > 0 ? cameraEl : null);

  if (!bgEl) return null;

  const bgAspect = bgEl.videoHeight > 0 ? bgEl.videoWidth / bgEl.videoHeight : 16 / 9;
  canvas.width  = COMPOSITE_WIDTH;
  canvas.height = Math.round(COMPOSITE_WIDTH / bgAspect);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Draw background (screen or camera if no screen).
  ctx.drawImage(bgEl, 0, 0, canvas.width, canvas.height);
  drawLabel(ctx, bgEl === screenEl ? 'SCREEN' : 'CAMERA', 8, 8);

  // Draw PiP camera inset (only when screen is the background).
  if (bgEl === screenEl && cameraEl.readyState >= 2 && cameraEl.videoWidth > 0) {
    const pipW = Math.round(COMPOSITE_WIDTH * PIP_RATIO);
    const camAspect = cameraEl.videoHeight > 0
      ? cameraEl.videoWidth / cameraEl.videoHeight
      : 4 / 3;
    const pipH = Math.round(pipW / camAspect);
    const pipX = canvas.width  - pipW - PIP_MARGIN;
    const pipY = canvas.height - pipH - PIP_MARGIN;

    // White border.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(pipX - 2, pipY - 2, pipW + 4, pipH + 4);
    ctx.drawImage(cameraEl, pipX, pipY, pipW, pipH);
    drawLabel(ctx, 'CAMERA', pipX + 4, pipY + 4);
  }

  // Export JPEG without the data: prefix.
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  // dataUrl is "data:image/jpeg;base64,<b64>" — strip prefix.
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  return dataUrl.slice(comma + 1);
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
): void {
  ctx.font = LABEL_FONT;
  const metrics = ctx.measureText(text);
  const w = metrics.width + LABEL_PAD * 2;
  const h = 18;
  ctx.fillStyle = LABEL_BG;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = LABEL_FG;
  ctx.fillText(text, x + LABEL_PAD, y + h - LABEL_PAD - 1);
}

// ─── createLiveProctor ────────────────────────────────────────────────────────

/**
 * Create a LiveProctorHandle that manages a Gemini Live WebSocket session
 * and a periodic frame pump for live exam-integrity monitoring.
 */
export function createLiveProctor(opts: LiveProctorOptions): LiveProctorHandle {
  const intervalMs = opts.intervalMs ?? 2500;

  // Mutable session state — all mutations are local (not exported).
  let state: ProctorState = initProctorState();
  let session: any = null;        // Gemini Live session
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let transcriptBuf = '';         // accumulates the model's spoken-verdict transcript per turn

  // ── Internal helpers ────────────────────────────────────────────────────────

  function applyAndBroadcast(alert: ProctorAlert): void {
    // Stamp the question the candidate was on when this was detected.
    if (alert.questionIndex == null) {
      const q = opts.getQuestion?.();
      if (typeof q === 'number') alert.questionIndex = q;
    }
    state = applyAlert(state, alert);
    try { opts.onAlert(alert); }    catch { /* never let callback throw */ }
    try { opts.onState(state); }    catch { /* never let callback throw */ }
  }

  function startPump(): void {
    if (pumpTimer !== null) return;
    pumpTimer = setInterval(() => {
      if (stopped || !session) return;
      try {
        const b64 = compositeFrame(opts.cameraEl, opts.screenEl);
        if (!b64) return;
        // Drive ONE analysis turn per frame. (sendRealtimeInput relies on audio
        // VAD to mark turn boundaries; with vision-only input the model never
        // emits a turn — so we send an explicit turnComplete to force a verdict.)
        session.sendClientContent({
          turns: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: b64 } }] }],
          turnComplete: true,
        });
      } catch (e: any) {
        console.warn('[proctor] frame send failed:', e?.message || e);
      }
    }, intervalMs);
  }

  function stopPump(): void {
    if (pumpTimer !== null) {
      clearInterval(pumpTimer);
      pumpTimer = null;
    }
  }

  // ── Public handle ────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (stopped) return;
    try {
      opts.onStatus('connecting');

      const key = await resolveApiKey();
      if (!key) {
        console.warn('[proctor] no API key — WebSocket unavailable');
        opts.onStatus('unavailable');
        return;
      }

      const ai = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: 'v1alpha' } });

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };

        ai.live.connect({
          model: MODELS.PROCTOR,
          config: {
            // The available Live models are native-AUDIO only (no TEXT output).
            // We get the model's verdict as TEXT via outputAudioTranscription —
            // it "narrates" each frame's analysis and we read the transcript.
            responseModalities: [Modality.AUDIO],
            outputAudioTranscription: {},
            systemInstruction: buildProctorSystemInstruction(state),
          },
          callbacks: {
            onopen: () => {
              if (stopped) { try { session?.close(); } catch { /* noop */ } finish(); return; }
              opts.onStatus('live');
              startPump();
              finish();
            },
            onmessage: (m: any) => {
              // Native-audio model: the verdict text arrives as the transcript of
              // the model's spoken output (serverContent.outputTranscription.text),
              // streamed in fragments. Accumulate per turn, parse on turnComplete.
              try {
                const frag: string | undefined = m?.serverContent?.outputTranscription?.text;
                if (frag) transcriptBuf += frag;
                if (m?.serverContent?.turnComplete) {
                  const alert = parseProctorMessage(transcriptBuf);
                  transcriptBuf = '';
                  if (alert) applyAndBroadcast(alert);
                }
              } catch (e: any) {
                console.warn('[proctor] onmessage parse error:', e?.message || e);
              }
            },
            onerror: (e: any) => {
              console.warn('[proctor] WebSocket error:', e?.message || e);
              stopPump();
              if (!stopped) opts.onStatus('unavailable');
              finish();
            },
            onclose: (ev: any) => {
              stopPump();
              session = null;
              if (!stopped) opts.onStatus('closed');
              finish();
            },
          },
        }).then((s: any) => {
          session = s;
        }).catch((e: any) => {
          console.warn('[proctor] live.connect failed:', e?.message || e);
          stopPump();
          opts.onStatus('unavailable');
          finish();
        });
      });
    } catch (e: any) {
      // Never throw out of start() — report unavailable and continue.
      console.warn('[proctor] start() error (swallowed):', e?.message || e);
      opts.onStatus('unavailable');
    }
  }

  function pushEvent(type: ProctorSignalType, message: string): void {
    const alert = eventAlert(type, message);
    applyAndBroadcast(alert);
  }

  function stop(): ProctorSummary {
    stopped = true;
    stopPump();
    try { if (session) { session.close(); session = null; } } catch { /* noop */ }
    opts.onStatus('closed');
    return summarizeProctor(state);
  }

  return { start, pushEvent, stop };
}

// ─── Spoken alarm ───────────────────────────────────────────────────────────────
// Speak a short out-loud warning when a suspicious action is detected. Throttled so
// the recurring per-frame alerts (one every ~4s while a violation persists) don't
// spam the candidate, and gated to medium+ severity. Uses the browser's
// SpeechSynthesis (independent of the neural interviewer TTS), never throws.
let _lastAlarmMs = 0;
const ALARM_MIN_GAP_MS = 12_000;   // at most one spoken alarm per 12s

export function speakProctorAlarm(
  language: 'ar' | 'en',
  opts?: { severity?: string; questionIndex?: number | null },
): void {
  try {
    if (typeof window === 'undefined') return;
    const sev = opts?.severity;
    if (sev === 'low' || sev === 'none') return;            // only alarm on medium/high/critical
    const now = Date.now();
    if (now - _lastAlarmMs < ALARM_MIN_GAP_MS) return;      // throttle
    _lastAlarmMs = now;

    const qn = opts?.questionIndex != null ? opts.questionIndex + 1 : null;
    const text = language === 'ar'
      ? `تنبيه. تم رصد سلوك مخالف${qn ? ` في السؤال ${qn}` : ''}. يُرجى التوقف والتركيز في المقابلة.`
      : `Warning. Suspicious activity detected${qn ? ` on question ${qn}` : ''}. Please stop and focus on the interview.`;

    // Speak the alarm in the SAME male Gemini voice (Puck) as the interviewer, via
    // the neural TTS chain — never the browser's default Arabic voice, which is
    // female on most platforms. instant:false so we wait for the male neural voice
    // instead of momentarily emitting a female Web Speech fallback.
    void ttsSpeak(text, {
      gender: 'male',
      lang: language === 'ar' ? 'ar-SA' : 'en-US',
      instant: false,
    }).catch(() => { /* never throw out of an alarm */ });
  } catch { /* never throw out of an alarm */ }
}

/** Reset the alarm throttle (call at the start of a fresh attempt). */
export function resetProctorAlarm(): void { _lastAlarmMs = 0; }
