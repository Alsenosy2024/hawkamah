// proctorCore.ts — PURE module (no DOM, no WebSocket, fully unit-testable).
// Foundation for the live-proctoring feature: types, constants, and all core
// logic consumed by every other proctor slice.

// ─── Types ────────────────────────────────────────────────────────────────────

/** Severity levels for a proctor alert, ordered from benign → critical. */
export type ProctorSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Signal taxonomy — every detectable integrity event.
 * 'unknown' is intentionally absent from this union; unknown types are DROPPED.
 */
export type ProctorSignalType =
  | 'tab_switch'
  | 'window_blur'
  | 'copy_paste'
  | 'fullscreen_exit'
  | 'multiple_faces'
  | 'no_face'
  | 'phone_detected'
  | 'eye_gaze_off'
  | 'audio_noise'
  | 'rapid_answers'
  | 'idle_too_long'
  | 'ai_tool_visible'        // ChatGPT/Gemini/Claude/Copilot or any AI chat open on the shared screen
  | 'screen_other_content';  // any other app/tab/doc unrelated to the interview on the shared screen

/** All valid signal types as a runtime set for validation. */
const VALID_SIGNAL_TYPES = new Set<ProctorSignalType>([
  'tab_switch',
  'window_blur',
  'copy_paste',
  'fullscreen_exit',
  'multiple_faces',
  'no_face',
  'phone_detected',
  'eye_gaze_off',
  'audio_noise',
  'rapid_answers',
  'idle_too_long',
  'ai_tool_visible',
  'screen_other_content',
]);

/** All valid severity values as a runtime set for validation. */
const VALID_SEVERITIES = new Set<ProctorSeverity>([
  'none', 'low', 'medium', 'high', 'critical',
]);

/** A single integrity event emitted by any proctor signal source. */
export interface ProctorAlert {
  /** ISO-8601 timestamp when the alert was generated. */
  ts: string;
  /** Signal category. */
  type: ProctorSignalType;
  /** How serious this event is. */
  severity: ProctorSeverity;
  /** Human-readable explanation (for display / LLM system instruction). */
  message: string;
}

/** Mutable proctoring session state — pass through applyAlert (pure reducer). */
export interface ProctorState {
  /** Integrity score 0–100, floored at 0; starts at 100. */
  integrity: number;
  /** All alerts recorded so far in chronological order. */
  alerts: ProctorAlert[];
  /** Per-signal-type occurrence counters. */
  signalCounts: Partial<Record<ProctorSignalType, number>>;
  /** ISO-8601 timestamp of the most recently applied alert (or null if none). */
  lastAlertTs: string | null;
}

/**
 * End-of-session summary produced by summarizeProctor().
 * verdict: 'clear' ≥85 integrity, 'review' ≥70, 'fail' <70.
 */
export interface ProctorSummary {
  verdict: 'clear' | 'review' | 'fail';
  /** Final 0–100 integrity score. */
  integrity: number;
  /** Top signals by occurrence count, descending, max 5. */
  topSignals: Array<{ type: ProctorSignalType; count: number }>;
  /** Total number of alerts recorded. */
  totalAlerts: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How many integrity points each severity level subtracts per alert.
 * 'none' deducts 0 (informational only).
 */
export const SEVERITY_WEIGHT: Record<ProctorSeverity, number> = {
  none:     0,
  low:      2,
  medium:   5,
  high:     10,
  critical: 20,
};

/**
 * Default severity assigned to a signal type when the LLM omits or provides
 * an invalid severity field.
 */
export const DEFAULT_SEVERITY: Record<ProctorSignalType, ProctorSeverity> = {
  tab_switch:      'high',
  window_blur:     'medium',
  copy_paste:      'high',
  fullscreen_exit: 'medium',
  multiple_faces:  'critical',
  no_face:         'medium',
  phone_detected:  'high',
  eye_gaze_off:    'low',
  audio_noise:     'low',
  rapid_answers:   'medium',
  idle_too_long:   'low',
  ai_tool_visible:      'critical',  // an AI assistant open on screen = serious cheating
  screen_other_content: 'high',
};

// ─── Functions ────────────────────────────────────────────────────────────────

/**
 * Create a fresh ProctorState with integrity=100 and no alerts.
 */
export function initProctorState(): ProctorState {
  return {
    integrity: 100,
    alerts: [],
    signalCounts: {},
    lastAlertTs: null,
  };
}

/**
 * Build the system instruction injected into the proctoring LLM turn.
 * Summarises current integrity and recent violations so the model can
 * calibrate its response severity appropriately.
 */
export function buildProctorSystemInstruction(state: ProctorState): string {
  const recentAlerts = state.alerts.slice(-5);
  const recentLines = recentAlerts.length
    ? recentAlerts
        .map(a => `  • [${a.severity}] ${a.type}: ${a.message}`)
        .join('\n')
    : '  (none)';

  return [
    'You are a live exam-integrity monitor.',
    `Current integrity score: ${state.integrity}/100.`,
    `Total alerts so far: ${state.alerts.length}.`,
    '',
    'Recent violations (last 5):',
    recentLines,
    '',
    'You receive ONE composite image every few seconds: the candidate\'s shared',
    'SCREEN (large) with their CAMERA as an inset. Watch for exam cheating.',
    'Valid signal types: multiple_faces, no_face, phone_detected, eye_gaze_off,',
    'audio_noise, tab_switch, window_blur, copy_paste, fullscreen_exit,',
    'rapid_answers, idle_too_long, ai_tool_visible, screen_other_content.',
    '',
    'INSPECT THE SHARED SCREEN CLOSELY — read visible browser tab titles, window',
    'titles, URLs, and on-screen text. This is the #1 cheating channel:',
    '  • If you see an AI assistant or chatbot (ChatGPT, chat.openai.com, openai,',
    '    Gemini, Google AI, Claude, Anthropic, Copilot, Bard, Poe, DeepSeek, or any',
    '    "AI"/chat interface) → report TYPE ai_tool_visible (severity high or critical).',
    '  • If you see ANY other app, browser tab, search engine (Google), messaging app,',
    '    document, IDE, or notes unrelated to answering THIS interview → report',
    '    TYPE screen_other_content.',
    'Do not assume legitimacy — if text is readable on the screen, judge what it is.',
    '',
    'For EACH image, reply with ONE short spoken line in EXACTLY this shape:',
    '  SEVERITY <none|low|medium|high|critical> TYPE <signal_type>',
    'naming the single most serious signal you actually see (a second person, a phone,',
    'an AI tool/other app on the screen, eyes off-screen, the face absent, etc.).',
    'If everything looks legitimate, say: SEVERITY none TYPE none.',
    'Say nothing else — no explanations, no JSON, just that one line.',
  ].join('\n');
}

/**
 * Parse a raw LLM message string into a ProctorAlert, or null on failure.
 *
 * Handles three formats:
 *   1. A bare JSON object:  {"type":"tab_switch","severity":"high","message":"..."}
 *   2. A fenced block:      ```json\n{...}\n```
 *   3. JSON embedded in prose: "We noticed that {...} occurred."
 *
 * Validation rules:
 *   - severity must be a member of ProctorSeverity union (else use DEFAULT_SEVERITY).
 *   - type must be a member of ProctorSignalType union; unknown types → return null.
 *   - severity 'none' with no recognized signal type → return null.
 *   - Garbage / non-parseable input → return null.
 */
/**
 * Parse the native-audio proctor's spoken verdict transcript, e.g.
 *   "SEVERITY high TYPE multiple_faces"
 *   "SEVERITY medium TYPES phone_detected, eye_gaze_off"
 * Returns the alert for the FIRST recognized signal type, or null when the
 * verdict is "none", contains no known signal, or doesn't match the shape.
 * Tolerant of ASR drift (case, spaces-for-underscores).
 */
export function parseSpokenVerdict(raw: string): ProctorAlert | null {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/severity\s+(none|low|medium|high|critical)\b[\s\S]*?types?\s+([a-z0-9_,\s]+)/i);
  if (!m) return null;

  const severity = m[1].toLowerCase() as ProctorSeverity;
  if (severity === 'none') return null;

  const types = m[2]
    .split(/[,;]/)
    .map(t => t.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter(t => VALID_SIGNAL_TYPES.has(t as ProctorSignalType)) as ProctorSignalType[];
  if (types.length === 0) return null;

  return {
    ts: new Date().toISOString(),
    type: types[0],
    severity: VALID_SEVERITIES.has(severity) ? severity : DEFAULT_SEVERITY[types[0]],
    message: `proctor: ${types.join(', ')}`,
  };
}

export function parseProctorMessage(raw: string): ProctorAlert | null {
  if (!raw || typeof raw !== 'string') return null;

  const text = raw.trim();

  // Format A — spoken-verdict transcript from the native-audio Live model
  // (outputAudioTranscription), e.g. "SEVERITY high TYPE multiple_faces" or
  // "SEVERITY medium TYPES phone_detected, eye_gaze_off". Tried first because the
  // proctor model narrates rather than emitting JSON.
  const spoken = parseSpokenVerdict(text);
  if (spoken) return spoken;

  // Attempt to extract a JSON object from the text.
  // Strategy: try fenced block first, then bare/embedded JSON via brace-matching.
  let jsonStr: string | null = null;

  // 1. Fenced code block: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // 2. Try to find the first {...} span in the text (handles bare or embedded).
  if (!jsonStr) {
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      jsonStr = text.slice(start, end + 1);
    }
  }

  if (!jsonStr) return null;

  // Parse JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Validate and resolve 'type'.
  const rawType = obj['type'];
  if (typeof rawType !== 'string' || !VALID_SIGNAL_TYPES.has(rawType as ProctorSignalType)) {
    return null; // unknown signal type → drop
  }
  const signalType = rawType as ProctorSignalType;

  // Validate 'severity'; fall back to DEFAULT_SEVERITY if missing/invalid.
  const rawSeverity = obj['severity'];
  let severity: ProctorSeverity;
  if (typeof rawSeverity === 'string' && VALID_SEVERITIES.has(rawSeverity as ProctorSeverity)) {
    severity = rawSeverity as ProctorSeverity;
  } else {
    severity = DEFAULT_SEVERITY[signalType];
  }

  // Drop 'none' severity with no actionable signal.
  if (severity === 'none') return null;

  // Resolve 'message'.
  const message =
    typeof obj['message'] === 'string' && obj['message'].trim()
      ? obj['message'].trim()
      : `${signalType} detected`;

  return {
    ts: new Date().toISOString(),
    type: signalType,
    severity,
    message,
  };
}

/**
 * Create a ProctorAlert from a directly observed DOM/sensor event
 * (i.e., not from an LLM message but from a browser event handler).
 */
export function eventAlert(
  type: ProctorSignalType,
  message: string,
  severity?: ProctorSeverity,
): ProctorAlert {
  return {
    ts: new Date().toISOString(),
    type,
    severity: severity ?? DEFAULT_SEVERITY[type],
    message,
  };
}

/**
 * PURE reducer — apply a ProctorAlert to a ProctorState and return a NEW state.
 * Integrity is reduced by SEVERITY_WEIGHT[alert.severity] and floored at 0.
 * The original state object is never mutated.
 */
export function applyAlert(state: ProctorState, alert: ProctorAlert): ProctorState {
  const deduction = SEVERITY_WEIGHT[alert.severity];
  const newIntegrity = Math.max(0, state.integrity - deduction);

  const prevCount = state.signalCounts[alert.type] ?? 0;
  const newSignalCounts: Partial<Record<ProctorSignalType, number>> = {
    ...state.signalCounts,
    [alert.type]: prevCount + 1,
  };

  return {
    integrity: newIntegrity,
    alerts: [...state.alerts, alert],
    signalCounts: newSignalCounts,
    lastAlertTs: alert.ts,
  };
}

/**
 * Produce a ProctorSummary from the final session state.
 *
 * Verdict thresholds:
 *   integrity ≥ 85 → 'clear'
 *   integrity ≥ 70 → 'review'
 *   integrity <  70 → 'fail'
 *
 * topSignals: all signal types with at least 1 occurrence, sorted descending
 *   by count, truncated to the top 5.
 */
export function summarizeProctor(state: ProctorState): ProctorSummary {
  const { integrity, alerts, signalCounts } = state;

  const verdict: 'clear' | 'review' | 'fail' =
    integrity >= 85 ? 'clear' :
    integrity >= 70 ? 'review' :
    'fail';

  // Build sorted topSignals from signalCounts.
  const topSignals: Array<{ type: ProctorSignalType; count: number }> = (
    Object.entries(signalCounts) as Array<[ProctorSignalType, number]>
  )
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  return {
    verdict,
    integrity,
    topSignals,
    totalAlerts: alerts.length,
  };
}
