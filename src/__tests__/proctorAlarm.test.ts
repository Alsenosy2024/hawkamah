import { describe, it, expect, vi, beforeEach } from 'vitest';

// A4 — the proctor spoken alarm shares ttsService's single audio channel with the
// interviewer narration (speak() begins with cancelSpeech()). So firing an alarm
// mid-question used to CUT OFF the question narration — the owner's "stupid,
// interrupting voice" complaint. The fix: the alarm must DEFER while narration is
// playing (and must not burn its throttle while deferring, so it re-fires the
// moment narration ends). We mock ttsService to assert the coordination.
const tts = vi.hoisted(() => ({
  speak: vi.fn((_text: string, _opts: { gender?: string; lang?: string; instant?: boolean; notify?: boolean }) => Promise.resolve()),
  isSpeaking: vi.fn(() => false),
}));
vi.mock('../../services/ttsService', () => tts);

import { speakProctorAlarm, resetProctorAlarm } from '../../services/proctorService';

beforeEach(() => {
  vi.clearAllMocks();
  // speakProctorAlarm early-returns when window is undefined (SSR guard).
  vi.stubGlobal('window', {});
  resetProctorAlarm();
  tts.isSpeaking.mockReturnValue(false);
});

describe('speakProctorAlarm — never interrupts question narration (A4)', () => {
  it('speaks the alarm in the male Puck voice when nothing is narrating', () => {
    speakProctorAlarm('ar', { severity: 'high', questionIndex: 2 });
    expect(tts.speak).toHaveBeenCalledTimes(1);
    const call = tts.speak.mock.calls[0];
    expect(call[1].gender).toBe('male');   // Puck path, not the browser's female default
    expect(call[1].notify).toBe(false);    // alarm must not drive the candidate question-voice notice (A4)
    expect(call[0]).toContain('السؤال 3'); // questionIndex (2) + 1
  });

  it('DEFERS — does not speak while the interviewer narration is playing', () => {
    tts.isSpeaking.mockReturnValue(true);
    speakProctorAlarm('ar', { severity: 'high' });
    expect(tts.speak).not.toHaveBeenCalled();   // cutting off narration is the bug being fixed
  });

  it('does not burn the throttle while deferring, so it re-fires once narration ends', () => {
    tts.isSpeaking.mockReturnValue(true);
    speakProctorAlarm('ar', { severity: 'high' });   // deferred (narration playing)
    expect(tts.speak).not.toHaveBeenCalled();

    tts.isSpeaking.mockReturnValue(false);           // narration ended
    speakProctorAlarm('ar', { severity: 'high' });   // < 12s later, but throttle was not consumed
    expect(tts.speak).toHaveBeenCalledTimes(1);
  });

  it('still gates on severity — low/none never alarm even when idle', () => {
    speakProctorAlarm('ar', { severity: 'low' });
    speakProctorAlarm('ar', { severity: 'none' });
    expect(tts.speak).not.toHaveBeenCalled();
  });
});
