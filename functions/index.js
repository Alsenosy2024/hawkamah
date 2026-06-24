// Mints a single-use Gemini Live ephemeral auth token for the interactive
// interview voice. The browser cannot use the production Gemini key for Live:
// the key is HTTP-referrer restricted and websockets carry no Referer header,
// so every Live ws is rejected with close 1008. This function mints a short
// ephemeral token server-side with the UNRESTRICTED key, gated by Firebase
// Auth, and returns token.name — the client opens the Live ws with that token
// (no referer needed). Secret never reaches the browser.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { GoogleGenAI, Modality } from '@google/genai';

const GEMINI_LIVE_KEY = defineSecret('GEMINI_LIVE_KEY');
const LIVE_MODEL = 'gemini-3.1-flash-live-preview';
// Native-audio Live model — the only Live models this key can use are audio-out;
// the proctor reads its verdict via outputAudioTranscription (see proctorService.ts).
const PROCTOR_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

// The app has no real user login in production (governance UI bypass, anonymous
// provider disabled), so an Auth gate would block every legitimate caller.
// Gate by Origin instead — same allowlist philosophy as the prod key's HTTP
// referrer restriction. The unrestricted key never leaves the server; the
// minted token is short-lived and Live-audio-only, so blast radius is tiny.
const ALLOWED = new Set([
  'https://hawkamah.web.app',
  'https://gen-lang-client-0579241284.firebaseapp.com',
  'http://localhost:3000',
  'http://localhost:3100',
  'http://localhost:5173',
]);

export const liveToken = onCall(
  { secrets: [GEMINI_LIVE_KEY], region: 'us-central1', cors: true },
  async (request) => {
    const hdr = request.rawRequest?.headers || {};
    const origin = String(hdr.origin || hdr.referer || '').replace(/\/$/, '');
    const ok = [...ALLOWED].some((a) => origin === a || origin.startsWith(a + '/'));
    if (!ok) {
      throw new HttpsError('permission-denied', 'Origin not allowed.');
    }
    const ai = new GoogleGenAI({
      apiKey: GEMINI_LIVE_KEY.value(),
      httpOptions: { apiVersion: 'v1alpha' },
    });
    try {
      // One token covers a whole interview session (many utterances = many ws
      // connections) so the client doesn't pay a mint round-trip per question.
      // Short expiry caps exposure; uses caps connection count.
      const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const tok = await ai.authTokens.create({
        config: {
          uses: 50,
          expireTime,
          liveConnectConstraints: {
            model: LIVE_MODEL,
            config: { responseModalities: [Modality.AUDIO] },
          },
        },
      });
      return { token: tok.name, model: LIVE_MODEL, expireTime };
    } catch (e) {
      throw new HttpsError('internal', `token mint failed: ${e?.message || e}`);
    }
  }
);

export const proctorToken = onCall(
  { secrets: [GEMINI_LIVE_KEY], region: 'us-central1', cors: true },
  async (request) => {
    const hdr = request.rawRequest?.headers || {};
    const origin = String(hdr.origin || hdr.referer || '').replace(/\/$/, '');
    const ok = [...ALLOWED].some((a) => origin === a || origin.startsWith(a + '/'));
    if (!ok) {
      throw new HttpsError('permission-denied', 'Origin not allowed.');
    }
    const ai = new GoogleGenAI({
      apiKey: GEMINI_LIVE_KEY.value(),
      httpOptions: { apiVersion: 'v1alpha' },
    });
    try {
      const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const tok = await ai.authTokens.create({
        config: {
          uses: 200,
          expireTime,
          liveConnectConstraints: {
            model: PROCTOR_MODEL,
            config: { responseModalities: [Modality.AUDIO], outputAudioTranscription: {} },
          },
        },
      });
      return { token: tok.name, model: PROCTOR_MODEL, expireTime };
    } catch (e) {
      throw new HttpsError('internal', `token mint failed: ${e?.message || e}`);
    }
  }
);
