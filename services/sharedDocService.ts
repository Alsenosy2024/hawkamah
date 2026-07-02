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
//    (public read / admin write) with type:'shared_doc', exactly the reviewer-
//    link pattern (reviewerTokenService).
//
// D1 SECURITY FIX — code-gated shares must not be world-readable ------------
//  - `survey_tokens` is `allow read: if true`. The OLD scheme wrote the full
//    plaintext HTML snapshot into that world-readable doc alongside an unsalted
//    SHA-256 `accessCodeHash` — so anyone who obtained/guessed a doc id could
//    read the entire document WITHOUT the code, and the unsalted hash invited
//    offline brute-force of short codes. Changing the rule is out of scope
//    (surveys need `survey_tokens` to stay world-readable), so the fix is
//    client-side crypto: when an access code is set, the html is AES-GCM
//    encrypted with a key derived from the code via PBKDF2 (random salt, random
//    IV) BEFORE it is written. No plaintext html and no accessCodeHash are ever
//    stored for a new code-gated share — the successful decrypt IS the
//    verification; a wrong code fails GCM authentication. Open (no-code) shares
//    are unaffected: they're public by design, so the snapshot stays plaintext.
//  - BACKWARD COMPAT: shares already minted in the old {html, accessCodeHash}
//    shape must keep working. `verifyAccessCode` + a plain read of `tok.html`
//    still serve them; only the write path (`createSharedDoc`) changed. Those
//    legacy shares remain readable-by-id until the owner re-shares the
//    document (this cannot be fixed retroactively from the client — the
//    plaintext is already sitting in Firestore).
//
// Comments (NEEDS a firestore.rules addition — see the PR description) --------
//  - A non-admin client/reviewer cannot write to gov_documents (admin-gated) or to
//    survey_tokens (admin write), so comments go to a NEW create-only, size-capped
//    `doc_comments` collection mirroring `assessments`. Until that rule is live the
//    write fails with permission-denied and the UI shows a clear, non-blocking
//    "comments not enabled yet" state (postDocComment throws COMMENTS_NOT_ENABLED).

import { db } from '../firebase';
import { collection, doc, setDoc, getDoc, getDocs, query, where } from 'firebase/firestore';
import type { SharedDocToken, DocComment, VisualReviewCheck, GovCommentAnchor, GovComment } from '../types';

const C_TOKENS = 'survey_tokens';
const C_COMMENTS = 'doc_comments';

// A token id doubles as the ?doc= URL value (16 hex chars, like the other tokens).
export function genShareToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

// SHA-256 hex — same scheme as paperAssessmentService.hashPassword. LEGACY ONLY:
// kept so pre-D1 shares (plaintext html + accessCodeHash) still verify; no new
// share is ever minted with an accessCodeHash (see createSharedDoc).
export async function hashAccessCode(code: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Firestore caps a single document at ~1 MiB. Guard the snapshot so an oversized
// document fails loudly (the owner can still use the admin /?r= review link)
// rather than silently producing a broken share. Checked against whatever is
// ACTUALLY written (plaintext html for an open share, base64 ciphertext for a
// code-gated one — encryption + base64 inflate the payload ~33%).
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

// ---------------------------------------------------------------------------
// D1 — AES-GCM(PBKDF2) encryption for code-gated shares. PURE (no I/O) so it's
// unit-testable without touching Firestore.
// ---------------------------------------------------------------------------

// >=150k iterations per the threat model (offline brute-force resistance for a
// short access code) — WebCrypto's PBKDF2, no external crypto library needed.
export const PBKDF2_ITERATIONS = 150_000;

// btoa/atob operate on a "binary string" (one char per byte); chunk the
// conversion so a large snapshot doesn't blow the call-stack via a spread arg.
function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveAesKey(code: string, salt: Uint8Array, iterations: number, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

// Encrypt a snapshot for a code-gated share: random 16-byte salt, random
// 12-byte IV, AES-GCM-256. Returns the fields to spread onto the token — no
// plaintext and no code hash included.
export async function encryptSharedDocHtml(
  html: string,
  code: string,
): Promise<Pick<SharedDocToken, 'enc' | 'htmlEnc' | 'salt' | 'iv' | 'kdfIterations'>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(code, salt, PBKDF2_ITERATIONS, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(html));
  return {
    enc: true,
    htmlEnc: bytesToB64(new Uint8Array(ciphertext)),
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    kdfIterations: PBKDF2_ITERATIONS,
  };
}

// Decrypt a code-gated share. Throws 'WRONG_CODE' when AES-GCM authentication
// fails (the wrong code derives a different key, so the tag never verifies) —
// that failure IS the verification; there's no separate hash to check first.
export async function decryptSharedDocHtml(tok: SharedDocToken, code: string): Promise<string> {
  if (!tok.enc || !tok.htmlEnc || !tok.salt || !tok.iv) throw new Error('NOT_ENCRYPTED');
  const salt = b64ToBytes(tok.salt);
  const iv = b64ToBytes(tok.iv);
  const key = await deriveAesKey(code, salt, tok.kdfIterations || PBKDF2_ITERATIONS, 'decrypt');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, b64ToBytes(tok.htmlEnc) as BufferSource);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('WRONG_CODE');
  }
}

// Mint a `/?doc=` share. Writing to survey_tokens requires an admin (the owner) —
// the existing rule, no change. When an access code is set the snapshot is
// AES-GCM encrypted (D1) before it's written; otherwise the share is open by
// design and the snapshot stays plaintext. Returns the token + ready-to-send URL.
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
  const id = genShareToken();
  const code = (params.accessCode || '').trim();
  let payload: Pick<SharedDocToken, 'html'> | Pick<SharedDocToken, 'enc' | 'htmlEnc' | 'salt' | 'iv' | 'kdfIterations'>;
  let storedBytes: string;
  if (code) {
    const enc = await encryptSharedDocHtml(html, code);
    payload = enc;
    storedBytes = enc.htmlEnc;
  } else {
    payload = { html };
    storedBytes = html;
  }
  // Size-check whatever actually gets written (ciphertext+base64 for a
  // code-gated share runs ~33% larger than the source html).
  if (snapshotTooLarge(storedBytes)) throw new Error('SNAPSHOT_TOO_LARGE');
  const tok: SharedDocToken = {
    id,
    type: 'shared_doc',
    tenantId: params.tenantId,
    docId: params.docId,
    docTitle: params.docTitle || 'وثيقة',
    allowComments: params.allowComments !== false,
    createdAt: new Date().toISOString(),
    ...payload,
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

// True when the token needs a code prompt before it can be read at all (either
// scheme — new AES-GCM or legacy hash-gated).
export function sharedDocIsGated(tok: SharedDocToken): boolean {
  return !!tok.enc || !!tok.accessCodeHash;
}

// LEGACY-ONLY verification for pre-D1 {html, accessCodeHash} shares. New
// encrypted shares are verified by decryptSharedDocHtml instead (a successful
// decrypt IS the verification), so this returns true immediately for them —
// callers should check `tok.enc` and use decryptSharedDocHtml first.
export async function verifyAccessCode(tok: SharedDocToken, code: string): Promise<boolean> {
  if (!tok.accessCodeHash) return true;            // no legacy gate (open share OR new enc share)
  return (await hashAccessCode(code)) === tok.accessCodeHash;
}

// Unified reader for the /?doc= flow: resolves the plaintext html for BOTH the
// new encrypted scheme (decrypts) and the legacy plaintext+hash scheme (verifies
// the hash then returns the stored html), plus the open/ungated case. Throws
// 'WRONG_CODE' for a bad code under either scheme.
export async function unlockSharedDocHtml(tok: SharedDocToken, code: string): Promise<string> {
  if (tok.enc) return decryptSharedDocHtml(tok, code);
  if (tok.accessCodeHash) {
    if (!(await verifyAccessCode(tok, code))) throw new Error('WRONG_CODE');
    return tok.html || '';
  }
  return tok.html || '';   // open share, no gate
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

// D1 — a client comment left on the /?doc= share (doc_comments) is a DIFFERENT
// shape than the owner's own in-canvas review comments (GovDocumentRecord.comments)
// and, before this fix, never fed the canvas / button gates / AI-apply / the "new
// comments" badge — a document with ONLY client feedback showed no comment UI at
// all, and «إصدار جديد» silently ignored it. Map a client DocComment onto the
// SAME GovComment shape so ONE list can drive all of those call sites.
export function clientCommentToGovComment(c: DocComment): GovComment {
  const fallbackText = c.kind === 'review_check'
    ? (c.check?.verdict === 'fail' ? 'مراجعة بصرية: مرفوض' : 'مراجعة بصرية: مقبول')
    : '';
  return {
    id: c.id,
    at: c.at,
    author: c.author || 'عميل',
    text: c.text || fallbackText,
    ...(c.anchor ? { anchor: c.anchor } : {}),
    status: 'open',
  };
}

// PURE (no I/O). Merges a document's own GovComment[] with its client-submitted
// DocComment[] (loaded separately from `doc_comments`, keyed by docId) into ONE
// list. Deduped by id so a client comment already PROMOTED onto the record (see
// newDocVersion in GovernanceCenter, which persists the merged+status-flipped list
// back onto `comments` after an AI-apply run) isn't appended a second time as a
// fresh 'open' duplicate — the persisted (possibly 'implemented') copy always wins.
export function mergeClientComments(
  comments: GovComment[] | undefined,
  clientComments: DocComment[] | undefined,
): GovComment[] {
  const own = comments || [];
  if (!clientComments?.length) return own;
  const seen = new Set(own.map(c => c.id));
  const promoted = clientComments.filter(c => !seen.has(c.id)).map(clientCommentToGovComment);
  return promoted.length ? [...own, ...promoted] : own;
}
