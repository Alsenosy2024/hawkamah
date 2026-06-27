// Public reviewer page — accessed via ?r=TOKEN (HWK-D3).
//
// A document owner shares a /?r= link. The reviewer opens it, signs in, reads
// the live governance document read-only, and posts comments that are written
// straight back onto the owner's gov_document (so they appear in the owner's
// Library). Reading/commenting on gov_documents is admin-gated by
// firestore.rules, so the reviewer must sign in with an account on the admin
// allow-list; a non-allow-list account sees a clear "no access" message rather
// than a blank screen. (A fully anonymous external reviewer needs a dedicated
// firestore.rules rule + backend proxy — a documented follow-up.)
import React, { useState, useEffect } from 'react';
import { auth } from '../firebase';
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { getReviewerToken } from '../services/reviewerTokenService';
import { getGovDocument, saveGovDocument } from '../services/governanceService';
import Markdown from './Markdown';
import type { ReviewerToken, GovDocumentRecord } from '../types';

interface Props { token: string; }

type Phase = 'loading' | 'invalid' | 'need_auth' | 'loading_doc' | 'no_access' | 'ready';

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

const PublicReviewScreen: React.FC<Props> = ({ token }) => {
  const [tok, setTok] = useState<ReviewerToken | null>(null);
  const [docRec, setDocRec] = useState<GovDocumentRecord | null>(null);
  const [user, setUser] = useState<{ email: string | null } | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [phase, setPhase] = useState<Phase>('loading');
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState('');

  const ar = true;                                   // Arabic-first; docs carry no language
  const t = (a: string, e: string) => (ar ? a : e);

  // Resolve the token first (public read — no auth needed).
  useEffect(() => {
    let alive = true;
    getReviewerToken(token)
      .then(r => { if (alive) { if (!r) setPhase('invalid'); else setTok(r); } })
      .catch(() => { if (alive) setPhase('invalid'); });
    return () => { alive = false; };
  }, [token]);

  // Track auth state.
  useEffect(() => onAuthStateChanged(auth, u => { setUser(u as any); setAuthReady(true); }), []);

  // Once we have a valid token and know the auth state, gate on sign-in then load the doc.
  useEffect(() => {
    if (!tok || !authReady) return;
    if (!user) { setPhase('need_auth'); return; }
    let alive = true;
    setPhase('loading_doc');
    getGovDocument(tok.docId)
      .then(d => { if (!alive) return; if (!d) setPhase('no_access'); else { setDocRec(d); setPhase('ready'); } })
      .catch(() => { if (alive) setPhase('no_access'); });   // permission-denied for a non-admin reviewer
    return () => { alive = false; };
  }, [tok, user, authReady]);

  const signIn = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch { setNote(t('تعذّر تسجيل الدخول. حاول مرة أخرى.', 'Sign-in failed. Please try again.')); }
  };

  const submitComment = async () => {
    const text = commentText.trim();
    if (!text || !docRec) return;
    setSubmitting(true);
    const author = user?.email || 'reviewer';
    const updated: GovDocumentRecord = {
      ...docRec,
      comments: [...(docRec.comments || []), { id: uid('cmt'), at: new Date().toISOString(), author, text }],
    };
    try {
      await saveGovDocument(updated);
      setDocRec(updated);          // optimistic — reflects immediately
      setCommentText('');
      setNote(t('أُرسل تعليقك إلى المالك ✅', 'Your comment was sent to the owner ✅'));
    } catch {
      setNote(t('تعذّر إرسال التعليق — قد لا تملك صلاحية المراجعة لهذا المستند.', 'Could not send the comment — you may not have review access to this document.'));
    } finally {
      setSubmitting(false);
    }
  };

  const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div dir={ar ? 'rtl' : 'ltr'} className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center py-8 px-4">
      <div className="w-full max-w-3xl">{children}</div>
    </div>
  );

  if (phase === 'loading' || phase === 'loading_doc') {
    return <Shell><div className="text-center text-slate-500 py-20">{t('جارٍ التحميل…', 'Loading…')}</div></Shell>;
  }

  if (phase === 'invalid') {
    return <Shell><div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 text-center">
      <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('رابط المراجعة غير صالح', 'Invalid review link')}</p>
      <p className="text-sm text-slate-500 mt-2">{t('هذا الرابط غير صحيح أو أُلغي.', 'This link is invalid or has been revoked.')}</p>
    </div></Shell>;
  }

  if (phase === 'need_auth') {
    return <Shell><div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 text-center space-y-4">
      <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('مراجعة مستند', 'Document review')}</p>
      {tok && <p className="text-sm text-slate-600 dark:text-slate-300">«{tok.docTitle}»</p>}
      <p className="text-sm text-slate-500">{t('سجّل الدخول لعرض المستند وإضافة ملاحظاتك.', 'Sign in to view the document and add your comments.')}</p>
      <button onClick={signIn} className="px-5 py-2.5 rounded-xl bg-teal-600 text-white font-bold text-sm hover:bg-teal-700">{t('تسجيل الدخول عبر Google', 'Sign in with Google')}</button>
      {note && <p className="text-xs text-rose-600">{note}</p>}
    </div></Shell>;
  }

  if (phase === 'no_access') {
    return <Shell><div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 text-center space-y-3">
      <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('لا تملك صلاحية مراجعة هذا المستند', 'You do not have access to review this document')}</p>
      <p className="text-sm text-slate-500">{t('اطلب من مالك المستند منح بريدك صلاحية المراجعة.', 'Ask the document owner to grant your email review access.')}</p>
      {user?.email && <p className="text-xs text-slate-400">{user.email}</p>}
    </div></Shell>;
  }

  // ready
  const d = docRec!;
  return (
    <Shell>
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 md:p-8 space-y-5">
        <header className="border-b border-slate-100 dark:border-slate-800 pb-4">
          <div className="text-[11px] uppercase tracking-wide font-bold text-teal-600">{t('مراجعة مستند', 'Document review')}</div>
          <h1 className="text-xl font-black text-slate-800 dark:text-slate-100 mt-1">{d.title}</h1>
          <div className="text-xs text-slate-400 mt-1">{t('الإصدار', 'Version')} {d.version} · {d.status}</div>
        </header>

        {d.executiveSummary && (
          <Markdown text={d.executiveSummary} rtl={ar} className="p-3 bg-teal-50 dark:bg-teal-900/20 rounded-lg text-sm leading-relaxed" />
        )}
        {d.sections.map(s => (
          <section key={s.id}>
            <h2 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-1">{s.title}</h2>
            <Markdown text={s.content} rtl={ar} className="text-sm leading-relaxed text-slate-700 dark:text-slate-300" />
          </section>
        ))}

        <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
          <h2 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-2">{t('الملاحظات', 'Comments')}{d.comments?.length ? ` (${d.comments.length})` : ''}</h2>
          {(d.comments || []).map(c => (
            <div key={c.id} className="text-[12px] text-slate-600 dark:text-slate-300 border-s-2 border-slate-200 dark:border-slate-700 ps-2 mb-1.5">
              {c.text} <span className="text-slate-400">· {c.author} · {new Date(c.at).toLocaleDateString()}</span>
            </div>
          ))}
          <div className="mt-3 flex items-start gap-2">
            <textarea value={commentText} onChange={e => setCommentText(e.target.value)} rows={3} placeholder={t('اكتب ملاحظتك للمراجعة…', 'Write your review comment…')} className="flex-1 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2 resize-y" />
            <button onClick={submitComment} disabled={!commentText.trim() || submitting} className="px-4 py-2 rounded-xl bg-teal-600 text-white font-bold text-sm hover:bg-teal-700 disabled:opacity-50 shrink-0">{submitting ? t('جارٍ الإرسال…', 'Sending…') : t('إرسال', 'Send')}</button>
          </div>
          {note && <p className="text-xs text-teal-700 dark:text-teal-400 mt-2">{note}</p>}
          {user?.email && <p className="text-[11px] text-slate-400 mt-2">{t('تراجع باسم', 'Reviewing as')} {user.email}</p>}
        </div>
      </div>
    </Shell>
  );
};

export default PublicReviewScreen;
