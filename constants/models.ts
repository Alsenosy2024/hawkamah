// Single source of truth for every Gemini model name used across the app.
// Centralized so a model upgrade is a one-line change, not a scattered find-replace.
// NOTE: `gemini-3.5-flash` is the current latest Flash — do NOT rename it.
export const MODELS = {
  TEXT: 'gemini-3.5-flash',               // all text generation / reasoning / extraction
  // Voice for the interactive interview. 3.1-flash-tts is the NEWEST/highest
  // dedicated Gemini TTS available (ListModels 2026-06-13: no 3.5-tts exists —
  // 3.5 ships only as live-translate; native-audio is 2.5 only). NO 2.5 model is
  // used anywhere in the voice path — owner mandate. Verified working on the
  // production (referrer-restricted) key.
  TTS: 'gemini-3.1-flash-tts-preview',    // primary neural TTS — highest available
  // Fallback retries the SAME highest model (covers a transient/cold-start miss)
  // — deliberately NOT a 2.5 model, so the voice never degrades to an old engine.
  TTS_FALLBACK: 'gemini-3.1-flash-tts-preview', // same highest model, retry
  LIVE: 'gemini-3.1-flash-live-preview',  // realtime live model (legacy live interview)
  EMBED: 'gemini-embedding-001',          // primary embedding model
  EMBED_FALLBACK: 'gemini-embedding-2',   // embedding fallback
} as const;

export type ModelKey = keyof typeof MODELS;
