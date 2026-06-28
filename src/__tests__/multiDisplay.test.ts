import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SEVERITY,
  SEVERITY_WEIGHT,
  eventAlert,
  parseProctorMessage,
  applyAlert,
  initProctorState,
} from '../../services/proctorCore';
import { detectExtendedDisplay, multiDisplayTransition } from '../../services/displayDetection';

// B2 — multi-monitor / extended-display detection. A new `multiple_displays`
// proctor signal (client-emitted, like tab_switch/fullscreen_exit) plus a pure
// detection helper that degrades gracefully where the Window Management API
// (screen.isExtended, Chrome 113+) is unavailable.

describe('multiple_displays signal (B2)', () => {
  it('defaults to high severity', () => {
    expect(DEFAULT_SEVERITY.multiple_displays).toBe('high');
    expect(eventAlert('multiple_displays', 'second screen connected').severity).toBe('high');
  });

  it('is a valid signal type that parseProctorMessage accepts', () => {
    const a = parseProctorMessage('{"type":"multiple_displays","severity":"high","message":"extended desktop"}');
    expect(a?.type).toBe('multiple_displays');
    expect(a?.severity).toBe('high');
  });

  it('deducts integrity like other high-severity signals', () => {
    const s = applyAlert(initProctorState(), eventAlert('multiple_displays', 'x'));
    expect(s.integrity).toBe(100 - SEVERITY_WEIGHT.high);   // 90
    expect(s.signalCounts.multiple_displays).toBe(1);
  });
});

describe('detectExtendedDisplay (B2)', () => {
  it('returns true on an extended desktop', () => {
    expect(detectExtendedDisplay({ isExtended: true })).toBe(true);
  });

  it('returns false on a single display', () => {
    expect(detectExtendedDisplay({ isExtended: false })).toBe(false);
  });

  it('returns null when the API is unsupported (no isExtended field)', () => {
    expect(detectExtendedDisplay({})).toBe(null);          // graceful degradation, never a false positive
  });

  it('returns null for a missing screen object', () => {
    expect(detectExtendedDisplay(null)).toBe(null);
    expect(detectExtendedDisplay(undefined)).toBe(null);
  });

  it('returns null when isExtended is not a boolean (defensive)', () => {
    expect(detectExtendedDisplay({ isExtended: 'yes' as unknown as boolean })).toBe(null);
  });
});

describe('multiDisplayTransition — debounce (B2)', () => {
  it('emits once when a second display first appears', () => {
    expect(multiDisplayTransition(false, true)).toEqual({ active: true, emit: true });
  });

  it('does NOT re-emit while the second display stays connected', () => {
    expect(multiDisplayTransition(true, true)).toEqual({ active: true, emit: false });
  });

  it('re-arms on disconnect, then re-emits on reconnect', () => {
    expect(multiDisplayTransition(true, false)).toEqual({ active: false, emit: false });
    expect(multiDisplayTransition(false, true)).toEqual({ active: true, emit: true });
  });

  it('unknown (null/unsupported) leaves state unchanged and never emits', () => {
    expect(multiDisplayTransition(true, null)).toEqual({ active: true, emit: false });
    expect(multiDisplayTransition(false, null)).toEqual({ active: false, emit: false });
  });
});
