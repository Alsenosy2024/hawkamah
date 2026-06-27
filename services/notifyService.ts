// Notify service — fires a confirmation email after an employee completes the
// assessment. Delegates the actual SMTP/Gmail send to an owner-controlled EC2
// endpoint (the browser must never hold mail credentials).
//
// W5: the call is best-effort — a failure here must NEVER break the thank-you
// screen, so callers fire-and-forget and we swallow all errors.

import type { Language } from '../types';

// Endpoint base is overridable via Vite env so staging/prod can differ without a
// code change. Defaults to the Caddy-fronted EC2 host used across the platform.
const NOTIFY_BASE =
  (import.meta as any).env?.VITE_NOTIFY_BASE_URL || 'https://98.83.240.139:8443';

export interface SurveyCompleteNotice {
  to: string;
  employeeName: string;
  companyName: string;
  language: Language;
}

// HWK-D4: compose a `mailto:` invite for a document reviewer. Pure string — it
// opens the owner's own mail client with the review link pre-filled (no server
// send, no mail credentials in the browser). `to` is optional; when omitted the
// owner fills the recipient in their mail client.
export function composeReviewerInviteMailto(p: {
  reviewerUrl: string;
  docTitle: string;
  language: Language;
  to?: string;
}): string {
  const ar = p.language === 'ar';
  const subject = ar ? `طلب مراجعة: ${p.docTitle}` : `Review request: ${p.docTitle}`;
  const body = ar
    ? `مرحباً،\n\nأرجو مراجعة هذا المستند وإضافة ملاحظاتك عبر الرابط التالي (يتطلّب تسجيل الدخول):\n${p.reviewerUrl}\n\nشكراً.`
    : `Hello,\n\nPlease review this document and add your comments via the link below (sign-in required):\n${p.reviewerUrl}\n\nThank you.`;
  // The address belongs in the mailto path literally (RFC 6068); only the
  // query params are percent-encoded.
  return `mailto:${p.to || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Best-effort confirmation email. Returns true on a 2xx, false otherwise — never
 * throws. Has a short timeout so a slow endpoint can't stall the UI.
 */
export async function notifySurveyComplete(n: SurveyCompleteNotice): Promise<boolean> {
  if (!n.to || !n.to.includes('@')) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${NOTIFY_BASE}/notify/survey-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(n),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    // Network error / timeout / CORS — degrade silently. The response is already
    // persisted; the email is a courtesy, not a requirement.
    return false;
  }
}
