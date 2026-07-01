// Client-facing document sharing + comments (PRD V14 + V20).
//
// V14 — a generated/edited canvas document is snapshotted into a tokenized,
// URL-addressable share (`/?doc=<token>`) so a client can open it in a read-only
// canvas (brand fonts + diagrams baked in) and leave comments.
// V20 — the share can be gated by an access code, so a "visual reviewer" unlocks
// it WITHOUT a Firebase login (reuses the existing access-code/token pattern — no
// new auth) and can record a structured visual-review check.
//
// Storage (NO firestore.rules change for share + read) ----------------------
//  - The share token lives in the world-readable `survey_tokens` collection
//    (public read / admin write) with type:'shared_doc', carrying a self-contained
//    HTML snapshot — exactly the reviewer-link pattern (reviewerTokenService).
//
// Comments (NEEDS a firestore.rules addition — see the PR description) --------
//  - A non-admin client/reviewer cannot write to gov_documents (admin-gated) or to
//    survey_tokens (admin write), so comments go to a NEW create-only, size-capped
//    `doc_comments` collection mirroring `assessments`. Until that rule is live the
//    write fails with permission-denied and the UI shows a clear, non-blocking
//    "comments not enabled yet" state (postDocComment throws COMMENTS_NOT_ENABLED).

import { db } from '../firebase';
import { collection, doc, setDoc, getDoc, getDocs, query, where } from 'firebase/firestore';
import type { SharedDocToken, DocComment, VisualReviewCheck, GovCommentAnchor } from '../types';

const C_TOKENS = 'survey_tokens';
const C_COMMENTS = 'doc_comments';

// A token id doubles as the ?doc= URL value (16 hex chars, like the other tokens).
export function genShareToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

// SHA-256 hex — same scheme as paperAssessmentService.hashPassword. The access
// code is never stored in clear; a reviewer's entry is hashed and compared.
export async function hashAccessCode(code: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Firestore caps a single document at ~1 MiB. Guard the snapshot so an oversized
// document fails loudly (the owner can still use the admin /?r= review link)
// rather than silently producing a broken share.
export const MAX_SNAPSHOT_BYTES = 900_000;
export function snapshotByteLength(html: string): number {
  return typeof Blob !== 'undefined'
    ? new Blob([html || '']).size
    : new TextEncoder().encode(html || '').length;
}
export function snapshotTooLarge(html: string): boolean {
  return snapshotByteLength(html) > MAX_SNAPSHOT_BYTES;
}

export function shareUrl(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/?doc=${token}`;
}

// Mint a `/?doc=` share. Writing to survey_tokens requires an admin (the owner) —
// the existing rule, no change. Returns the token + ready-to-send URL.
export async function createSharedDoc(params: {
  tenantId: string;
  docId: string;
  docTitle: string;
  html: string;
  allowComments?: boolean;
  accessCode?: string;
  createdByEmail?: string;
}): Promise<{ token: string; url: string }> {
  const html = params.html || '';
  if (!html.trim()) throw new Error('EMPTY_SNAPSHOT');
  if (snapshotTooLarge(html)) throw new Error('SNAPSHOT_TOO_LARGE');
  const id = genShareToken();
  const code = (params.accessCode || '').trim();
  const tok: SharedDocToken = {
    id,
    type: 'shared_doc',
    tenantId: params.tenantId,
    docId: params.docId,
    docTitle: params.docTitle || 'وثيقة',
    html,
    allowComments: params.allowComments !== false,
    createdAt: new Date().toISOString(),
    ...(code ? { accessCodeHash: await hashAccessCode(code) } : {}),
    ...(params.createdByEmail ? { createdByEmail: params.createdByEmail } : {}),
  };
  await setDoc(doc(db, C_TOKENS, id), tok);
  return { token: id, url: shareUrl(id) };
}

export async function getSharedDoc(tokenId: string): Promise<SharedDocToken | null> {
  const snap = await getDoc(doc(db, C_TOKENS, tokenId));
  if (!snap.exists()) return null;
  const data = snap.data() as { type?: string };
  if (data?.type !== 'shared_doc') return null;   // a survey/reviewer token, not a shared doc
  return data as SharedDocToken;
}

export async function verifyAccessCode(tok: SharedDocToken, code: string): Promise<boolean> {
  if (!tok.accessCodeHash) return true;            // no gate
  return (await hashAccessCode(code)) === tok.accessCodeHash;
}

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

// Build the create-only payload for a client comment / visual-review check. PURE
// (no I/O) and bounded so the size-capped `doc_comments` rule always accepts it.
export function buildDocComment(input: {
  tokenId: string;
  docId: string;
  tenantId: string;
  author: string;
  text: string;
  check?: VisualReviewCheck;
  anchor?: GovCommentAnchor;   // V31: present when the comment was left inline on a selection
}): DocComment {
  return {
    id: uid('dcm'),
    tokenId: input.tokenId,
    docId: input.docId,
    tenantId: input.tenantId,
    kind: input.check ? 'review_check' : 'comment',
    author: (input.author || 'client').slice(0, 120),
    text: (input.text || '').slice(0, 4000),
    at: new Date().toISOString(),
    ...(input.check ? { check: input.check } : {}),
    ...(input.anchor ? { anchor: boundAnchor(input.anchor) } : {}),
  };
}

// Bound an inline anchor so the size-capped `doc_comments` rule always accepts it
// (the quote/context are short spans, but a pathological selection shouldn't blow
// the document limit). Drops empty context fields to keep the payload lean.
function boundAnchor(a: GovCommentAnchor): GovCommentAnchor {
  return {
    quote: (a.quote || '').slice(0, 2000),
    ...(a.prefix ? { prefix: a.prefix.slice(0, 200) } : {}),
    ...(a.suffix ? { suffix: a.suffix.slice(0, 200) } : {}),
    ...(a.sectionId ? { sectionId: a.sectionId.slice(0, 200) } : {}),
  };
}

// Post a comment / review check (create-only). Throws COMMENTS_NOT_ENABLED when
// the `doc_comments` rule isn't deployed yet (permission-denied) so the UI can
// show a clear, non-blocking state.
export async function postDocComment(input: {
  tokenId: string;
  docId: string;
  tenantId: string;
  author: string;
  text: string;
  check?: VisualReviewCheck;
  anchor?: GovCommentAnchor;   // V31: inline select-text comment anchor
}): Promise<DocComment> {
  const payload = buildDocComment(input);
  try {
    await setDoc(doc(db, C_COMMENTS, payload.id), payload);
    return payload;
  } catch (e: unknown) {
    const code = String((e as { code?: string })?.code || (e as Error)?.message || e);
    if (code.includes('permission-denied') || code.includes('PERMISSION_DENIED')) {
      throw new Error('COMMENTS_NOT_ENABLED');
    }
    throw e;
  }
}

// Owner-side (admin) read of all client comments/checks for one document.
export async function loadDocComments(docId: string): Promise<DocComment[]> {
  const q = query(collection(db, C_COMMENTS), where('docId', '==', docId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data() as DocComment)
    .sort((a, b) => (a.at || '').localeCompare(b.at || ''));
}

// Owner-side (admin) read of every client comment/check for a tenant, grouped by
// source document id — ONE query for the whole library. Throws are the caller's
// to swallow: before the `doc_comments` rule is deployed this is permission-denied,
// and the library simply shows no client feedback (its in-doc comments still work).
export async function loadTenantDocComments(tenantId: string): Promise<Record<string, DocComment[]>> {
  const q = query(collection(db, C_COMMENTS), where('tenantId', '==', tenantId));
  const snap = await getDocs(q);
  const byDoc: Record<string, DocComment[]> = {};
  for (const d of snap.docs) {
    const c = d.data() as DocComment;
    (byDoc[c.docId] = byDoc[c.docId] || []).push(c);
  }
  for (const k of Object.keys(byDoc)) byDoc[k].sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  return byDoc;
}
