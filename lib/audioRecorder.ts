// Robust microphone capture for one-shot + streaming transcription.
// Replaces the fragile webkitSpeechRecognition paths (no error surfacing,
// weak ar-SA support, silent death on permission/network failure). Captures
// raw PCM via Web Audio, encodes a 16 kHz mono WAV, and hands the base64 to
// Gemini for transcription.
//
// Two usage modes:
//   • one-shot  → start() … stop()         (survey field dictation)
//   • streaming → start() … flush()×N …    (conversational interview: VAD
//                 cuts the running stream into utterance segments via the
//                 onLevel callback; flush() returns one segment's WAV and
//                 keeps recording; discard() drops audio captured while the
//                 interviewer was talking, so its own voice is never echoed
//                 back into the transcript.)

export type RecorderError =
  | 'permission'   // user denied or no device
  | 'insecure'     // not a secure context (getUserMedia unavailable)
  | 'unsupported'  // browser lacks Web Audio / getUserMedia
  | 'empty'        // nothing captured
  | 'unknown';

export class MicRecordError extends Error {
  reason: RecorderError;
  constructor(reason: RecorderError, message: string) {
    super(message);
    this.reason = reason;
    this.name = 'MicRecordError';
  }
}

const SAMPLE_RATE = 16000;

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Captures mic audio. Surfaces a typed reason on any failure so the UI can tell
 * the user *why* the mic didn't work instead of dying silently.
 */
export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private onLevel?: (level: number) => void;
  private rate = SAMPLE_RATE;

  constructor(onLevel?: (level: number) => void) {
    this.onLevel = onLevel;
  }

  get active(): boolean { return !!this.processor; }

  async start(): Promise<void> {
    if (!window.isSecureContext) {
      throw new MicRecordError('insecure', 'Microphone needs HTTPS or localhost.');
    }
    if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || (window as any).webkitAudioContext)) {
      throw new MicRecordError('unsupported', 'Browser does not support audio capture.');
    }
    try {
      // Explicit echo cancellation so the open mic does not pick up the interviewer's
      // own TTS playback (matters now the mic stays open during spoken-MCQ questions).
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e: any) {
      const name = e?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new MicRecordError('permission', 'Microphone permission denied.');
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new MicRecordError('permission', 'No microphone found.');
      }
      throw new MicRecordError('unknown', e?.message || 'Could not open microphone.');
    }

    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    await this.ctx.resume();
    this.rate = this.ctx.sampleRate || SAMPLE_RATE;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];

    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));
      if (this.onLevel) {
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        this.onLevel(Math.min(1, Math.sqrt(sum / input.length) * 4));
      }
    };
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
  }

  /** Merge currently-buffered audio into a WAV without stopping capture.
   *  Returns null when nothing was buffered. Used for VAD segmentation. */
  flush(): { base64: string; mimeType: string } | null {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    if (total === 0) return null;
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) { merged.set(c, off); off += c.length; }
    this.chunks = [];
    const wav = encodeWav(merged, this.rate);
    return { base64: toBase64(wav), mimeType: 'audio/wav' };
  }

  /** Drop buffered audio without stopping capture (e.g. discard the
   *  interviewer's own TTS that leaked into the open mic). */
  discard(): void { this.chunks = []; }

  /** Stops capture and returns all recorded audio as a base64 WAV. */
  async stop(): Promise<{ base64: string; mimeType: string }> {
    const rate = this.rate;
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach(t => t.stop());
      if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close();
    } catch { /* best-effort teardown */ }

    this.ctx = null; this.stream = null; this.processor = null; this.source = null;

    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    if (total === 0) throw new MicRecordError('empty', 'No audio captured.');
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) { merged.set(c, off); off += c.length; }
    this.chunks = [];

    const wav = encodeWav(merged, rate);
    return { base64: toBase64(wav), mimeType: 'audio/wav' };
  }

  abort() {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach(t => t.stop());
      if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
    } catch { /* ignore */ }
    this.chunks = [];
    this.ctx = null; this.stream = null; this.processor = null; this.source = null;
  }
}
