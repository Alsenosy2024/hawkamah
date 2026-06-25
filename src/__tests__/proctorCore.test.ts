import { describe, it, expect } from 'vitest';
import {
  initProctorState,
  SEVERITY_WEIGHT,
  DEFAULT_SEVERITY,
  parseProctorMessage,
  parseSpokenVerdict,
  applyAlert,
  eventAlert,
  summarizeProctor,
  type ProctorAlert,
  type ProctorState,
} from '../../services/proctorCore';

// ─── per-question breakdown (which question each alert happened on) ────────────

describe('summarizeProctor byQuestion', () => {
  const alert = (type: any, q?: number): ProctorAlert => ({
    ts: new Date().toISOString(), type, severity: 'medium', message: type,
    ...(q !== undefined ? { questionIndex: q } : {}),
  });

  it('groups alerts by questionIndex, ascending, with counts + unique types', () => {
    let s = initProctorState();
    s = applyAlert(s, alert('tab_switch', 2));
    s = applyAlert(s, alert('ai_tool_visible', 0));
    s = applyAlert(s, alert('tab_switch', 2));      // same question, same type → count 2, types unique
    s = applyAlert(s, alert('phone_detected', 2));  // same question, new type
    const sum = summarizeProctor(s);
    expect(sum.byQuestion.map(b => b.question)).toEqual([0, 2]);  // ascending
    const q2 = sum.byQuestion.find(b => b.question === 2)!;
    expect(q2.count).toBe(3);
    expect(q2.types.sort()).toEqual(['phone_detected', 'tab_switch']);
  });

  it('omits alerts that carry no questionIndex from byQuestion', () => {
    let s = initProctorState();
    s = applyAlert(s, alert('no_face'));            // no question → excluded
    s = applyAlert(s, alert('eye_gaze_off', 4));    // included
    const sum = summarizeProctor(s);
    expect(sum.byQuestion).toEqual([{ question: 4, count: 1, types: ['eye_gaze_off'] }]);
    expect(sum.totalAlerts).toBe(2);                 // both still count toward totals
  });

  it('byQuestion is empty when no alert has a questionIndex', () => {
    let s = initProctorState();
    s = applyAlert(s, alert('window_blur'));
    expect(summarizeProctor(s).byQuestion).toEqual([]);
  });
});

// ─── parseSpokenVerdict (native-audio transcript format) ──────────────────────

describe('parseSpokenVerdict / spoken-format parseProctorMessage', () => {
  it('parses "SEVERITY high TYPE multiple_faces"', () => {
    const a = parseSpokenVerdict('SEVERITY high TYPE multiple_faces');
    expect(a).not.toBeNull();
    expect(a!.severity).toBe('high');
    expect(a!.type).toBe('multiple_faces');
  });

  it('parses plural "TYPES a, b" and keeps the first valid signal', () => {
    const a = parseSpokenVerdict('SEVERITY medium TYPES phone_detected, eye_gaze_off');
    expect(a!.type).toBe('phone_detected');
    expect(a!.severity).toBe('medium');
  });

  it('is case-insensitive and tolerates spaces-for-underscores (ASR drift)', () => {
    const a = parseSpokenVerdict('severity High type multiple faces');
    expect(a!.type).toBe('multiple_faces');
    expect(a!.severity).toBe('high');
  });

  it('returns null for "SEVERITY none TYPE none"', () => {
    expect(parseSpokenVerdict('SEVERITY none TYPE none')).toBeNull();
  });

  it('returns null when no signal type is recognized', () => {
    expect(parseSpokenVerdict('SEVERITY high TYPE nonsense_signal')).toBeNull();
  });

  it('returns null on non-matching prose', () => {
    expect(parseSpokenVerdict('the candidate looks fine to me')).toBeNull();
  });

  it('parseProctorMessage routes spoken verdicts through the spoken parser', () => {
    const a = parseProctorMessage('SEVERITY critical TYPE phone_detected');
    expect(a!.type).toBe('phone_detected');
    expect(a!.severity).toBe('critical');
  });

  it('detects an AI tool on the shared screen (ai_tool_visible)', () => {
    const a = parseSpokenVerdict('SEVERITY critical TYPE ai_tool_visible');
    expect(a).not.toBeNull();
    expect(a!.type).toBe('ai_tool_visible');
    expect(a!.severity).toBe('critical');
  });

  it('detects other content on the shared screen (screen_other_content)', () => {
    const a = parseSpokenVerdict('SEVERITY high TYPE screen_other_content');
    expect(a!.type).toBe('screen_other_content');
  });

  it('ai_tool_visible defaults to critical severity via eventAlert', () => {
    expect(DEFAULT_SEVERITY.ai_tool_visible).toBe('critical');
    expect(eventAlert('ai_tool_visible', 'ChatGPT on screen').severity).toBe('critical');
    expect(eventAlert('screen_other_content', 'other app').severity).toBe('high');
  });
});

// ─── initProctorState ─────────────────────────────────────────────────────────

describe('initProctorState', () => {
  it('starts with integrity 100', () => {
    const state = initProctorState();
    expect(state.integrity).toBe(100);
  });

  it('starts with an empty alerts array', () => {
    const state = initProctorState();
    expect(state.alerts).toEqual([]);
  });

  it('starts with empty signalCounts', () => {
    const state = initProctorState();
    expect(state.signalCounts).toEqual({});
  });

  it('starts with lastAlertTs null', () => {
    const state = initProctorState();
    expect(state.lastAlertTs).toBeNull();
  });
});

// ─── SEVERITY_WEIGHT ──────────────────────────────────────────────────────────

describe('SEVERITY_WEIGHT', () => {
  it('none has weight 0', () => {
    expect(SEVERITY_WEIGHT['none']).toBe(0);
  });

  it('low has weight 2', () => {
    expect(SEVERITY_WEIGHT['low']).toBe(2);
  });

  it('medium has weight 5', () => {
    expect(SEVERITY_WEIGHT['medium']).toBe(5);
  });

  it('high has weight 10', () => {
    expect(SEVERITY_WEIGHT['high']).toBe(10);
  });

  it('critical has weight 20', () => {
    expect(SEVERITY_WEIGHT['critical']).toBe(20);
  });
});

// ─── parseProctorMessage ──────────────────────────────────────────────────────

describe('parseProctorMessage', () => {
  it('parses a clean bare JSON object', () => {
    const raw = '{"type":"tab_switch","severity":"high","message":"User switched tabs"}';
    const result = parseProctorMessage(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('tab_switch');
    expect(result!.severity).toBe('high');
    expect(result!.message).toBe('User switched tabs');
  });

  it('parses a fenced json code block', () => {
    const raw = '```json\n{"type":"window_blur","severity":"medium","message":"Window lost focus"}\n```';
    const result = parseProctorMessage(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('window_blur');
    expect(result!.severity).toBe('medium');
  });

  it('parses JSON embedded in surrounding prose', () => {
    const raw = 'We noticed that {"type":"copy_paste","severity":"high","message":"Copy-paste detected"} occurred during the exam.';
    const result = parseProctorMessage(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('copy_paste');
    expect(result!.severity).toBe('high');
  });

  it('returns null when severity is "none" (informational only → dropped)', () => {
    const raw = '{"type":"eye_gaze_off","severity":"none","message":"Glanced away briefly"}';
    const result = parseProctorMessage(raw);
    expect(result).toBeNull();
  });

  it('returns null when signal type is unknown', () => {
    const raw = '{"type":"unknown_signal","severity":"high","message":"Something happened"}';
    const result = parseProctorMessage(raw);
    expect(result).toBeNull();
  });

  it('returns null on garbage / non-JSON input', () => {
    const result = parseProctorMessage('this is just some random text with no JSON');
    expect(result).toBeNull();
  });

  it('returns null on empty string', () => {
    const result = parseProctorMessage('');
    expect(result).toBeNull();
  });

  it('uses DEFAULT_SEVERITY when severity field is missing', () => {
    const raw = '{"type":"phone_detected","message":"A phone was spotted"}';
    const result = parseProctorMessage(raw);
    expect(result).not.toBeNull();
    // phone_detected defaults to 'high'
    expect(result!.severity).toBe(DEFAULT_SEVERITY['phone_detected']);
    expect(result!.severity).toBe('high');
  });

  it('uses DEFAULT_SEVERITY when severity field is invalid', () => {
    const raw = '{"type":"audio_noise","severity":"extreme","message":"Loud noise detected"}';
    const result = parseProctorMessage(raw);
    expect(result).not.toBeNull();
    // audio_noise defaults to 'low'
    expect(result!.severity).toBe(DEFAULT_SEVERITY['audio_noise']);
    expect(result!.severity).toBe('low');
  });

  it('result has a valid ISO-8601 ts field', () => {
    const raw = '{"type":"fullscreen_exit","severity":"medium","message":"Exited fullscreen"}';
    const result = parseProctorMessage(raw);
    expect(result).not.toBeNull();
    expect(() => new Date(result!.ts)).not.toThrow();
    expect(new Date(result!.ts).toISOString()).toBe(result!.ts);
  });
});

// ─── applyAlert ───────────────────────────────────────────────────────────────

describe('applyAlert', () => {
  it('deducts integrity by the correct amount for a high-severity alert', () => {
    const state = initProctorState();
    const alert: ProctorAlert = {
      ts: new Date().toISOString(),
      type: 'tab_switch',
      severity: 'high',
      message: 'Tab switch detected',
    };
    const next = applyAlert(state, alert);
    // high = weight 10, so 100 - 10 = 90
    expect(next.integrity).toBe(90);
  });

  it('deducts integrity by the correct amount for a medium-severity alert', () => {
    const state = initProctorState();
    const alert: ProctorAlert = {
      ts: new Date().toISOString(),
      type: 'window_blur',
      severity: 'medium',
      message: 'Window blurred',
    };
    const next = applyAlert(state, alert);
    // medium = weight 5, so 100 - 5 = 95
    expect(next.integrity).toBe(95);
  });

  it('floors integrity at 0 after many high-severity alerts', () => {
    let state = initProctorState();
    // 11 high alerts × 10 points = 110 deducted, floor at 0
    for (let i = 0; i < 11; i++) {
      const alert: ProctorAlert = {
        ts: new Date().toISOString(),
        type: 'tab_switch',
        severity: 'high',
        message: 'Tab switch',
      };
      state = applyAlert(state, alert);
    }
    expect(state.integrity).toBe(0);
  });

  it('increments signalCounts for the alert type', () => {
    const state = initProctorState();
    const alert: ProctorAlert = {
      ts: new Date().toISOString(),
      type: 'copy_paste',
      severity: 'high',
      message: 'Paste detected',
    };
    const next = applyAlert(state, alert);
    expect(next.signalCounts['copy_paste']).toBe(1);
  });

  it('accumulates signalCounts across multiple alerts of the same type', () => {
    let state = initProctorState();
    for (let i = 0; i < 3; i++) {
      const alert: ProctorAlert = {
        ts: new Date().toISOString(),
        type: 'eye_gaze_off',
        severity: 'low',
        message: 'Gaze off screen',
      };
      state = applyAlert(state, alert);
    }
    expect(state.signalCounts['eye_gaze_off']).toBe(3);
  });

  it('appends the alert to the alerts array', () => {
    const state = initProctorState();
    const alert: ProctorAlert = {
      ts: new Date().toISOString(),
      type: 'no_face',
      severity: 'medium',
      message: 'No face in frame',
    };
    const next = applyAlert(state, alert);
    expect(next.alerts).toHaveLength(1);
    expect(next.alerts[0]).toBe(alert);
  });

  it('does not mutate the original state', () => {
    const state = initProctorState();
    const alert: ProctorAlert = {
      ts: new Date().toISOString(),
      type: 'multiple_faces',
      severity: 'critical',
      message: 'Multiple faces detected',
    };
    applyAlert(state, alert);
    expect(state.integrity).toBe(100);
    expect(state.alerts).toHaveLength(0);
  });

  it('updates lastAlertTs to the alert timestamp', () => {
    const state = initProctorState();
    const ts = new Date().toISOString();
    const alert: ProctorAlert = {
      ts,
      type: 'rapid_answers',
      severity: 'medium',
      message: 'Answers too fast',
    };
    const next = applyAlert(state, alert);
    expect(next.lastAlertTs).toBe(ts);
  });
});

// ─── eventAlert ───────────────────────────────────────────────────────────────

describe('eventAlert', () => {
  it('uses DEFAULT_SEVERITY when no severity argument is provided', () => {
    const alert = eventAlert('tab_switch', 'User switched tabs');
    // tab_switch defaults to 'high'
    expect(alert.severity).toBe(DEFAULT_SEVERITY['tab_switch']);
    expect(alert.severity).toBe('high');
  });

  it('uses DEFAULT_SEVERITY for eye_gaze_off (low)', () => {
    const alert = eventAlert('eye_gaze_off', 'Eyes wandered');
    expect(alert.severity).toBe('low');
  });

  it('uses DEFAULT_SEVERITY for multiple_faces (critical)', () => {
    const alert = eventAlert('multiple_faces', 'Another person visible');
    expect(alert.severity).toBe('critical');
  });

  it('respects an explicitly passed severity', () => {
    const alert = eventAlert('audio_noise', 'Loud background', 'medium');
    expect(alert.severity).toBe('medium');
  });

  it('populates type and message correctly', () => {
    const alert = eventAlert('idle_too_long', 'No activity detected');
    expect(alert.type).toBe('idle_too_long');
    expect(alert.message).toBe('No activity detected');
  });
});

// ─── summarizeProctor ─────────────────────────────────────────────────────────

describe('summarizeProctor', () => {
  it('returns verdict "clear" when integrity is 90 (≥85)', () => {
    const state: ProctorState = {
      integrity: 90,
      alerts: [],
      signalCounts: {},
      lastAlertTs: null,
    };
    const summary = summarizeProctor(state);
    expect(summary.verdict).toBe('clear');
  });

  it('returns verdict "clear" when integrity is exactly 85', () => {
    const state: ProctorState = {
      integrity: 85,
      alerts: [],
      signalCounts: {},
      lastAlertTs: null,
    };
    const summary = summarizeProctor(state);
    expect(summary.verdict).toBe('clear');
  });

  it('returns verdict "review" when integrity is 75 (≥70, <85)', () => {
    const state: ProctorState = {
      integrity: 75,
      alerts: [],
      signalCounts: {},
      lastAlertTs: null,
    };
    const summary = summarizeProctor(state);
    expect(summary.verdict).toBe('review');
  });

  it('returns verdict "review" when integrity is exactly 70', () => {
    const state: ProctorState = {
      integrity: 70,
      alerts: [],
      signalCounts: {},
      lastAlertTs: null,
    };
    const summary = summarizeProctor(state);
    expect(summary.verdict).toBe('review');
  });

  it('returns verdict "fail" when integrity is 50 (<70)', () => {
    const state: ProctorState = {
      integrity: 50,
      alerts: [],
      signalCounts: {},
      lastAlertTs: null,
    };
    const summary = summarizeProctor(state);
    expect(summary.verdict).toBe('fail');
  });

  it('returns verdict "fail" when integrity is 69 (just below review threshold)', () => {
    const state: ProctorState = {
      integrity: 69,
      alerts: [],
      signalCounts: {},
      lastAlertTs: null,
    };
    const summary = summarizeProctor(state);
    expect(summary.verdict).toBe('fail');
  });

  it('topSignals are ordered descending by count', () => {
    const state: ProctorState = {
      integrity: 80,
      alerts: [],
      signalCounts: {
        tab_switch: 3,
        copy_paste: 7,
        audio_noise: 1,
      },
      lastAlertTs: null,
    };
    const summary = summarizeProctor(state);
    expect(summary.topSignals[0].type).toBe('copy_paste');
    expect(summary.topSignals[0].count).toBe(7);
    expect(summary.topSignals[1].type).toBe('tab_switch');
    expect(summary.topSignals[1].count).toBe(3);
    expect(summary.topSignals[2].type).toBe('audio_noise');
    expect(summary.topSignals[2].count).toBe(1);
  });

  it('topSignals is capped at 5 entries', () => {
    const state: ProctorState = {
      integrity: 0,
      alerts: [],
      signalCounts: {
        tab_switch:      10,
        copy_paste:       9,
        audio_noise:      8,
        no_face:          7,
        phone_detected:   6,
        eye_gaze_off:     5,
        window_blur:      4,
      },
      lastAlertTs: null,
    };
    const summary = summarizeProctor(state);
    expect(summary.topSignals).toHaveLength(5);
    // First should be the highest count
    expect(summary.topSignals[0].count).toBe(10);
  });

  it('totalAlerts reflects the number of alerts in state', () => {
    let state = initProctorState();
    const alert: ProctorAlert = {
      ts: new Date().toISOString(),
      type: 'tab_switch',
      severity: 'high',
      message: 'Tab switch',
    };
    state = applyAlert(state, alert);
    state = applyAlert(state, alert);
    state = applyAlert(state, alert);
    const summary = summarizeProctor(state);
    expect(summary.totalAlerts).toBe(3);
  });

  it('integrity in summary matches state integrity', () => {
    let state = initProctorState();
    const alert: ProctorAlert = {
      ts: new Date().toISOString(),
      type: 'multiple_faces',
      severity: 'critical',
      message: 'Multiple faces',
    };
    state = applyAlert(state, alert);
    const summary = summarizeProctor(state);
    // 100 - 20 = 80
    expect(summary.integrity).toBe(80);
    expect(summary.integrity).toBe(state.integrity);
  });

  it('topSignals is empty when there are no alerts', () => {
    const state = initProctorState();
    const summary = summarizeProctor(state);
    expect(summary.topSignals).toEqual([]);
  });
});
