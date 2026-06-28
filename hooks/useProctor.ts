// B1 — Shared live-proctor lifecycle hook.
//
// The three candidate-facing exam surfaces (UnifiedAssessmentPortal,
// OnlineAssessmentPortal, VerbalAssessmentScreen) each wired the Gemini-Live
// proctor by hand with the SAME ~50 lines: identical refs, identical
// status/integrity/alert state, an identical `startProctor`/`stopProctor`, and
// an identical gesture-safe `getDisplayMedia` request. This hook owns exactly
// that shared core so the three portals stop duplicating it.
//
// Deliberately NOT owned here (these genuinely diverge per portal, and folding
// them in would CHANGE behavior — the one thing a refactor must not do):
//   • camera acquisition — Unified/Online call getUserMedia just for the proctor
//     (audio:false), while Verbal reuses its interview mic+camera stream.
//   • face-detection polling — three different strategies (FaceDetector 3s,
//     pixel-brightness camera-cover check, lazy detector).
//   • DOM-event anti-cheat — each portal funnels visibilitychange/blur/copy/
//     fullscreen into its OWN local violation counter (e.g. cancel-at-5), not
//     into the proctor engine (no portal calls handle.pushEvent today).
//   • the visible camera tile / status chip / alert banner JSX (different
//     positions and copy per surface).
//
// What the hook gives each portal: the refs to wire, the status/integrity/alert
// state to render, a gesture-safe `requestScreen()`, `startProctor()` /
// `stopProctor()` (capturing the ProctorSummary), `resetForAttempt()`, and
// `getSummary()`. Behavior is identical to the previous inline code.

import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { createLiveProctor, speakProctorAlarm, type LiveProctorHandle } from '../services/proctorService';
import { type ProctorSummary } from '../services/proctorCore';

export type ProctorStatus = 'off' | 'connecting' | 'live' | 'unavailable' | 'closed';
export interface ProctorAlertView { type: string; severity: string; question: number | null }

export interface UseProctorOptions {
  /** Spoken-alarm language for speakProctorAlarm (default 'ar'). */
  language?: 'ar' | 'en';
  /** Current zero-based question index, stamped onto alerts. */
  getQuestion?: () => number | null | undefined;
  /** Frame-pump period in ms (default 4000 — ~1 frame / 4s, cost-efficient). */
  intervalMs?: number;
  /** Auto-clear the transient alert banner after this many ms (default 6000). */
  alertClearMs?: number;
}

export interface UseProctorApi {
  // ── live state (render these) ──
  status: ProctorStatus;
  integrity: number;
  alert: ProctorAlertView | null;

  // ── refs the portal wires (visible screen-share preview lives in the portal) ──
  /** Screen-share MediaStream captured by requestScreen(); also fed to the engine. */
  screenStreamRef: MutableRefObject<MediaStream | null>;
  /** Integrity summary captured on stop — persist this with the attempt record. */
  summaryRef: MutableRefObject<ProctorSummary | null>;
  /** Guard so the engine starts at most once per attempt. */
  startedRef: MutableRefObject<boolean>;

  // ── lifecycle (identical to the previous inline code) ──
  /**
   * Request screen-share INSIDE a user gesture (getDisplayMedia requires one).
   * Resets the per-attempt guard + summary, flips status to 'connecting', and
   * stores the granted stream in screenStreamRef. Never throws (denied/unsupported
   * → continues camera-only). Returns the stream (or null).
   */
  requestScreen: () => Promise<MediaStream | null>;
  /**
   * Spin up the Gemini-Live proctor from the candidate camera + (optional) screen
   * streams. Hidden off-screen <video>s feed the engine. Guarded to start once
   * per attempt; graceful (camera-only if screen denied); never throws.
   */
  startProctor: (camStream: MediaStream | null, screenStream: MediaStream | null) => Promise<void>;
  /** Stop the engine, capture its summary, release the screen stream + hidden feeds. */
  stopProctor: () => void;
  /** Reset state for a fresh attempt (guard off, summary cleared, score reset). */
  resetForAttempt: () => void;
  /** The last captured integrity summary (same value as summaryRef.current). */
  getSummary: () => ProctorSummary | null;

  // escape hatches for portal-specific flows that set status directly
  setStatus: (s: ProctorStatus) => void;
  setIntegrity: (n: number) => void;
  setAlert: (a: ProctorAlertView | null) => void;
}

export function useProctor(opts: UseProctorOptions = {}): UseProctorApi {
  const { language = 'ar', getQuestion, intervalMs = 4000, alertClearMs = 6000 } = opts;

  const [status, setStatus]       = useState<ProctorStatus>('off');
  const [integrity, setIntegrity] = useState(100);
  const [alert, setAlert]         = useState<ProctorAlertView | null>(null);

  const proctorRef        = useRef<LiveProctorHandle | null>(null);
  const screenStreamRef   = useRef<MediaStream | null>(null);
  const proctorElsRef     = useRef<HTMLVideoElement[]>([]);   // hidden <video>s feeding the proctor
  const summaryRef        = useRef<ProctorSummary | null>(null);
  const startedRef        = useRef(false);                    // guard: start the proctor only once per attempt

  // Keep the latest options reachable from stable callbacks without re-creating them.
  const optsRef = useRef({ language, getQuestion, intervalMs, alertClearMs });
  optsRef.current = { language, getQuestion, intervalMs, alertClearMs };

  // ── Request SCREEN SHARE inside a user gesture (getDisplayMedia REQUIRES one) ──
  const requestScreen = useCallback(async (): Promise<MediaStream | null> => {
    startedRef.current = false;
    summaryRef.current = null;
    setStatus('connecting');
    try {
      const scr = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current = scr;
      return scr;
    } catch {
      // denied/cancelled/unsupported → continue with camera-only proctoring
      return null;
    }
  }, []);

  // ── Live AI proctor ──
  // Hidden off-screen <video>s feed the candidate's camera + shared screen to the
  // Gemini-Live engine, which streams back scored cheating signals. Graceful:
  // camera-only if screen denied; NEVER throws. Guarded so it only starts once.
  const startProctor = useCallback(async (camStream: MediaStream | null, screenStream: MediaStream | null) => {
    if (startedRef.current) return;
    startedRef.current = true;
    try {
      const mkHidden = (s: MediaStream) => {
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.srcObject = s;
        v.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
        document.body.appendChild(v);
        v.play().catch(() => { /* autoplay guard */ });
        proctorElsRef.current.push(v);
        return v;
      };
      const camEl = (camStream && camStream.getVideoTracks().length) ? mkHidden(camStream) : document.createElement('video');
      const scrEl = screenStream ? mkHidden(screenStream) : null;
      const handle = createLiveProctor({
        cameraEl: camEl,
        screenEl: scrEl,
        intervalMs: optsRef.current.intervalMs,
        getQuestion: () => optsRef.current.getQuestion?.() ?? null,
        onAlert: (a) => {
          setAlert({ type: a.type, severity: a.severity, question: a.questionIndex ?? null });
          window.setTimeout(() => setAlert(null), optsRef.current.alertClearMs);
          speakProctorAlarm(optsRef.current.language, { severity: a.severity, questionIndex: a.questionIndex });
        },
        onState: (s) => setIntegrity(s.integrity),
        onStatus: (st) => setStatus(st),
      });
      proctorRef.current = handle;
      await handle.start();
    } catch {
      setStatus('unavailable');
    }
  }, []);

  // Stop the proctor, capture its integrity summary, release the screen stream
  // and remove the hidden off-screen <video>s. Safe to call multiple times.
  const stopProctor = useCallback(() => {
    try { summaryRef.current = proctorRef.current?.stop() ?? summaryRef.current; } catch { /* noop */ }
    proctorRef.current = null;
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    proctorElsRef.current.forEach(v => { try { v.pause(); v.srcObject = null; v.remove(); } catch { /* noop */ } });
    proctorElsRef.current = [];
  }, []);

  const resetForAttempt = useCallback(() => {
    startedRef.current = false;
    summaryRef.current = null;
    setStatus('connecting');
    setIntegrity(100);
    setAlert(null);
  }, []);

  const getSummary = useCallback(() => summaryRef.current, []);

  return {
    status, integrity, alert,
    screenStreamRef, summaryRef, startedRef,
    requestScreen, startProctor, stopProctor, resetForAttempt, getSummary,
    setStatus, setIntegrity, setAlert,
  };
}
