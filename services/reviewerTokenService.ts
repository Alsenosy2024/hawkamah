// Reviewer-link sharing for governance documents (HWK-D3).
//
// A document owner mints a tokenized `/?r=` link; a signed-in reviewer opens it,
// reads the document, and posts comments that land back on the owner's
// gov_document. The token is stored in the EXISTING world-readable
// `survey_tokens` collection (admin write / public read) with `type:'reviewer'`,
// so NO new collection — and therefore no firestore.rules change — is required.
//
// The document itself is read/updated through the normal gov_documents path,
// which is admin-gated: the reviewer must be a signed-in member of the admin
// allow-list (the app's existing auth model). A truly anonymous external
// reviewer would need a dedicated firestore.rules rule + a backend proxy and is
// a documented follow-up.
import { db } from '../firebase';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import type { ReviewerToken } from '../types';

const C_TOKENS = 'survey_tokens';

function genToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export async function createReviewerToken(
  tenantId: string,
  docId: string,
  docTitle: string,
  createdByEmail?: string,
): Promise<{ token: string; url: string }> {
  const id = genToken();
  const tok: ReviewerToken = {
    id,
    type: 'reviewer',
    tenantId,
    docId,
    docTitle,
    createdAt: new Date().toISOString(),
    ...(createdByEmail ? { createdByEmail } : {}),
  };
  await setDoc(doc(db, C_TOKENS, id), tok);
  return { token: id, url: `${window.location.origin}/?r=${id}` };
}

export async function getReviewerToken(tokenId: string): Promise<ReviewerToken | null> {
  const snap = await getDoc(doc(db, C_TOKENS, tokenId));
  if (!snap.exists()) return null;
  const data = snap.data() as { type?: string };
  if (data?.type !== 'reviewer') return null;   // a survey token, not a reviewer link
  return data as ReviewerToken;
}
