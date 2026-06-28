import { describe, it, expect, beforeEach } from 'vitest';
import { isSpeaking, configuredVoice, setVoiceFallbackHandler } from '../../services/ttsService';

// A4 — locks the voice contract the candidate hears, plus the seams the portal uses
// to (a) keep the proctor alarm from interrupting narration (isSpeaking) and (b)
// surface a visible notice when the neural Puck voice falls back to the robotic
// browser voice (setVoiceFallbackHandler), instead of swapping it in silently.
describe('ttsService voice config (A4)', () => {
  beforeEach(() => setVoiceFallbackHandler(null));

  it('uses the owner-mandated Puck voice for male narration', () => {
    expect(configuredVoice('male')).toBe('Puck');   // never the flat/robotic default
  });

  it('keeps Kore for the female voice', () => {
    expect(configuredVoice('female')).toBe('Kore');
  });

  it('reports not speaking when nothing is playing', () => {
    expect(isSpeaking()).toBe(false);
  });

  it('accepts and clears a voice-fallback listener without throwing', () => {
    expect(() => setVoiceFallbackHandler(() => { /* noop */ })).not.toThrow();
    expect(() => setVoiceFallbackHandler(null)).not.toThrow();
  });
});
