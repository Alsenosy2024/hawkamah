// B2 — multi-monitor / extended-display detection.
// Uses the Window Management API: `screen.isExtended` (Chrome 113+) tells us the
// desktop spans more than one monitor WITHOUT any permission prompt. The richer
// `getScreenDetails()` (permissioned) can count screens but is best-effort only.
// Everything degrades gracefully: when the API is absent we return null (unknown)
// rather than guessing, so unsupported browsers never produce a false positive.

export interface ScreenLike {
  isExtended?: boolean;
}

/**
 * Pure detector — testable without a DOM.
 *   true  → extended/multi-monitor desktop
 *   false → single display
 *   null  → API unsupported / screen unavailable (treat as "unknown", not a violation)
 */
export function detectExtendedDisplay(screen?: ScreenLike | null): boolean | null {
  if (!screen || typeof screen.isExtended !== 'boolean') return null;
  return screen.isExtended;
}

/**
 * Debounce decision for a polling display monitor: emit a `multiple_displays`
 * alert only on the transition into an extended desktop (so we don't deduct
 * integrity on every poll), and re-arm when the second screen is disconnected so
 * a later reconnect is flagged again. `null` (unknown/unsupported) is inert.
 *   prevActive — whether we currently consider a second display "flagged"
 *   current    — latest detectExtendedDisplay result (true | false | null)
 */
export function multiDisplayTransition(
  prevActive: boolean,
  current: boolean | null,
): { active: boolean; emit: boolean } {
  if (current === true) return { active: true, emit: !prevActive };
  if (current === false) return { active: false, emit: false };
  return { active: prevActive, emit: false };   // null → no change, no emit
}

/** Live check against the real browser `screen` (null when no DOM / unsupported). */
export function isExtendedDisplayNow(): boolean | null {
  try {
    const s = (typeof globalThis !== 'undefined')
      ? ((globalThis as { screen?: ScreenLike }).screen ?? null)
      : null;
    return detectExtendedDisplay(s);
  } catch {
    return null;
  }
}

/**
 * Best-effort monitor count via getScreenDetails() (needs the window-management
 * permission). Returns null when unsupported or denied — never throws.
 */
export async function getDisplayCount(): Promise<number | null> {
  try {
    const w = globalThis as { getScreenDetails?: () => Promise<{ screens?: unknown[] }> };
    if (typeof w.getScreenDetails !== 'function') return null;
    const details = await w.getScreenDetails();
    return Array.isArray(details?.screens) ? details.screens.length : null;
  } catch {
    return null;
  }
}
