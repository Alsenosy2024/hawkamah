// Public reviewer page — accessed via ?r=TOKEN (HWK-D3 · V21 inline comments).
//
// A document owner shares a /?r= link. The reviewer opens it, signs in, reads
// the live governance document read-only, and leaves Google-Docs-style inline
// comments: they HIGHLIGHT a sentence → an «أضف تعليقاً» popover appears → they
// type a note → it is written straight back onto the owner's gov_document with a
// TextQuoteSelector anchor (so the owner's canvas can re-locate + highlight it,
// and the AI can apply it into a new version). Reading/commenting on
// gov_documents is admin-gated by firestore.rules, so the reviewer must sign in
// with an account on the admin allow-list; a non-allow-list account sees a clear
// "no access" message rather than a blank screen. (A fully anonymous external
// reviewer needs a dedicated firestore.rules rule + backend proxy — a documented
// follow-up.)
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { auth } from '../firebase';
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { getReviewerToken } from '../services/reviewerTokenService';
import { getGovDocument, saveGovDocument } from '../services/governanceService';
import { anchorFromSelection, highlightComments, scrollToComment } from '../services/commentAnchor';
import Markdown from './Markdown';
import type { ReviewerToken, GovDocumentRecord, GovComment, GovCommentAnchor } from '../types';

interface Props { token: string; }

type Phase = 'loading' | 'invalid' | 'need_auth' | 'loading_doc' | 'no_access' | 'ready';

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

// The read-only document body, isolated in a memoized subtree keyed only on the
// CONTENT (sections/executiveSummary) — NOT on the comments. So when a comment is
// added the body does NOT re-render, and the imperative highlight pass below can
// safely wrap text in <mark> without React reconciling the wrappers away.
const ReviewDocBody = React.memo(function ReviewDocBody(
  { bodyRef, ar, executiveSummary, sections }:
  { bodyRef: React.RefObject<HTMLDivElement>; ar: boolean; executiveSummary?: string; sections: GovDocumentRecord['sections'] },
) {
  const t = (a: string, e: string) => (ar ? a : e);
  return (
    <div ref={bodyRef} className="review-doc space-y-5 select-text">
      {executiveSummary && (
        <Markdown text={executiveSummary} rtl={ar} className="p-3 bg-teal-50 dark:bg-teal-900/20 rounded-lg text-sm leading-relaxed" />
      )}
      {sections.map(s => (
        <section key={s.id} data-section-id={s.id}>
          <h2 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-1">{s.title}</h2>
          <Markdown text={s.content} rtl={ar} className="text-sm leading-relaxed text-slate-700 dark:text-slate-300" />
        </section>
      ))}
      {sections.length === 0 && !executiveSummary && (
        <p className="text-sm text-slate-400">{t('لا يوجد محتوى لعرضه.', 'No content to display.')}</p>
      )}
    </div>
  );
});

// Highlight CSS for the <mark> spans we inject (open = amber, implemented = green).
const HIGHLIGHT_CSS = `
.review-doc mark.cmt-hl{background:#fde68a;color:inherit;border-radius:2px;padding:0 1px;box-shadow:inset 0 -2px 0 rgba(245,158,11,.4);cursor:pointer}
.review-doc mark.cmt-hl-done{background:#bbf7d0;box-shadow:inset 0 -2px 0 rgba(22,163,74,.4)}
.dark .review-doc mark.cmt-hl{background:#a16207;color:#fff}
.dark .review-doc mark.cmt-hl-done{background:#166534;color:#fff}
.review-doc mark.cmt-flash{animation:cmtflash 1.1s ease}
@keyframes cmtflash{0%{filter:brightness(1.15)}40%{filter:brightness(1.45)}100%{filter:brightness(1)}}
`;

const PublicReviewScreen: React.FC<Props> = ({ token }) => {
  const [tok, setTok] = useState<ReviewerToken | null>(null);
  const [docRec, setDocRec] = useState<GovDocumentRecord | null>(null);
  const [user, setUser] = useState<{ email: string | null } | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [phase, setPhase] = useState<Phase>('loading');
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState('');
  // V21 inline-comment UI state.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [addBtn, setAddBtn] = useState<{ top: number; left: number } | null>(null);   // floating «أضف تعليقاً»
  const [composer, setComposer] = useState<{ anchor: GovCommentAnchor; top: number; left: number } | null>(null);

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

  // ── inline highlight-and-comment ──────────────────────────────────────────
  // Re-apply the comment highlights after every render of the document. Safe to
  // mutate the DOM here because ReviewDocBody is memoized on the content only, so
  // React won't reconcile while comments change.
  useLayoutEffect(() => {
    if (phase !== 'ready') return;
    const root = bodyRef.current;
    if (!root) return;
    highlightComments(root, (docRec?.comments || []).filter(c => c.anchor));
  }, [docRec, phase]);

  // Show the floating "add comment" button whenever the reviewer has an active
  // text selection inside the document (and isn't already composing).
  useEffect(() => {
    if (phase !== 'ready') return;
    const onSelect = () => {
      if (composer) return;
      const root = bodyRef.current;
      const sel = root?.ownerDocument?.defaultView?.getSelection?.();
      const text = sel?.toString().trim() || '';
      if (!root || !sel || sel.isCollapsed || !text || !sel.anchorNode || !root.contains(sel.anchorNode)) { setAddBtn(null); return; }
      try {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (!r.width && !r.height) { setAddBtn(null); return; }
        setAddBtn({ top: r.bottom + 8, left: Math.max(8, Math.min(r.left, window.innerWidth - 168)) });
      } catch { setAddBtn(null); }
    };
    document.addEventListener('mouseup', onSelect);
    document.addEventListener('keyup', onSelect);
    return () => { document.removeEventListener('mouseup', onSelect); document.removeEventListener('keyup', onSelect); };
  }, [phase, composer]);

  // Capture the anchor from the live selection and open the composer. Runs on
  // mousedown (preventDefault) so the selection survives the click.
  const openComposer = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const root = bodyRef.current;
    if (!root) return;
    const sel = root.ownerDocument?.defaultView?.getSelection?.();
    let sectionId: string | undefined;
    const node = sel?.anchorNode || null;
    if (node) {
      const el = (node.nodeType === 1 ? node : node.parentElement) as Element | null;
      sectionId = el?.closest('[data-section-id]')?.getAttribute('data-section-id') || undefined;
    }
    const anchor = anchorFromSelection(root, sectionId);
    if (!anchor) { setAddBtn(null); return; }
    setComposer({ anchor, top: addBtn?.top ?? 96, left: addBtn?.left ?? 16 });
    setAddBtn(null);
    setCommentText('');
  }, [addBtn]);

  const cancelComposer = () => { setComposer(null); setCommentText(''); };

  const submitComment = async () => {
    const text = commentText.trim();
    if (!text || !docRec || !composer) return;
    setSubmitting(true);
    const author = user?.email || 'reviewer';
    const comment: GovComment = { id: uid('cmt'), at: new Date().toISOString(), author, text, anchor: composer.anchor, status: 'open' };
    const updated: GovDocumentRecord = { ...docRec, comments: [...(docRec.comments || []), comment] };
    try {
      await saveGovDocument(updated);
      setDocRec(updated);          // optimistic — reflects + highlights immediately
      setComposer(null);
      setCommentText('');
      setNote(t('أُرسل تعليقك إلى المالك ✅', 'Your comment was sent to the owner ✅'));
    } catch {
      setNote(t('تعذّر إرسال التعليق — قد لا تملك صلاحية المراجعة لهذا المستند.', 'Could not send the comment — you may not have review access to this document.'));
    } finally {
      setSubmitting(false);
    }
  };

  // Scroll to (and briefly flash) a comment's highlight when its list item is clicked.
  const focusComment = (id: string) => {
    const root = bodyRef.current;
    if (!root) return;
    const el = scrollToComment(root, id);
    if (el) { el.classList.add('cmt-flash'); window.setTimeout(() => el.classList.remove('cmt-flash'), 1200); }
  };

  const Shell: React.FC<{ children: React.ReactNode; wide?: boolean }> = ({ children, wide }) => (
    <div dir={ar ? 'rtl' : 'ltr'} className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center py-8 px-4">
      <style>{HIGHLIGHT_CSS}</style>
      <div className={`w-full ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>{children}</div>
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
  const comments = d.comments || [];
  return (
    <Shell wide>
      <div className="flex flex-col lg:flex-row gap-4 items-start">
        {/* Document */}
        <div className="flex-1 min-w-0 w-full bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 md:p-8 space-y-5">
          <header className="border-b border-slate-100 dark:border-slate-800 pb-4">
            <div className="text-[11px] uppercase tracking-wide font-bold text-teal-600">{t('مراجعة مستند', 'Document review')}</div>
            <h1 className="text-xl font-black text-slate-800 dark:text-slate-100 mt-1">{d.title}</h1>
            <div className="text-xs text-slate-400 mt-1">{t('الإصدار', 'Version')} {d.version} · {d.status}</div>
            <p className="text-[12px] text-teal-700 dark:text-teal-400 mt-2 flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
              {t('ظلّل أي جملة لإضافة تعليق عليها.', 'Highlight any sentence to comment on it.')}
            </p>
          </header>

          <ReviewDocBody bodyRef={bodyRef} ar={ar} executiveSummary={d.executiveSummary} sections={d.sections} />

          {note && <p className="text-xs text-teal-700 dark:text-teal-400">{note}</p>}
          {user?.email && <p className="text-[11px] text-slate-400">{t('تراجع باسم', 'Reviewing as')} {user.email}</p>}
        </div>

        {/* Comments margin list */}
        <aside className="w-full lg:w-72 shrink-0 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 lg:sticky lg:top-4">
          <h2 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-2 flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-teal-600"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            {t('التعليقات', 'Comments')}{comments.length ? ` (${comments.length})` : ''}
          </h2>
          {comments.length === 0 && (
            <p className="text-[12px] text-slate-400">{t('لا توجد تعليقات بعد. ظلّل جملة في المستند لبدء تعليق.', 'No comments yet. Highlight a sentence in the document to start one.')}</p>
          )}
          <div className="space-y-2">
            {comments.map(c => (
              <button key={c.id} type="button" onClick={() => c.anchor && focusComment(c.id)}
                className={`block w-full text-start rounded-lg border p-2.5 transition-colors ${c.anchor ? 'cursor-pointer hover:border-teal-300 dark:hover:border-teal-700' : 'cursor-default'} ${c.status === 'implemented' ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-900/10' : 'border-slate-200 dark:border-slate-700'}`}>
                {c.anchor?.quote && (
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 border-s-2 border-amber-300 dark:border-amber-700 ps-2 mb-1 line-clamp-2">«{c.anchor.quote}»</div>
                )}
                <div className="text-[12px] text-slate-700 dark:text-slate-200">{c.text}</div>
                <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 flex-wrap">
                  {c.status === 'implemented'
                    ? <span className="text-emerald-600 font-bold">{t('طُبّق', 'Implemented')}{c.appliedInVersion ? ` · v${c.appliedInVersion}` : ''}</span>
                    : <span className="text-amber-600 font-bold">{t('مفتوح', 'Open')}</span>}
                  <span>· {c.author} · {new Date(c.at).toLocaleDateString()}</span>
                </div>
                {c.changeSummary && <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1">{c.changeSummary}</div>}
              </button>
            ))}
          </div>
        </aside>
      </div>

      {/* Floating "add comment" button anchored to the active selection. */}
      {addBtn && (
        <button type="button" onMouseDown={openComposer}
          style={{ top: addBtn.top, left: addBtn.left }}
          className="fixed z-[10000] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-teal-600 text-white text-[12px] font-bold shadow-lg hover:bg-teal-700">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="12" y1="8" x2="12" y2="14"/><line x1="9" y1="11" x2="15" y2="11"/></svg>
          {t('أضف تعليقاً', 'Add comment')}
        </button>
      )}

      {/* Composer popover — textarea bound to the captured anchor. */}
      {composer && (
        <>
          <div className="fixed inset-0 z-[10000]" onClick={cancelComposer} aria-hidden="true" />
          <div dir={ar ? 'rtl' : 'ltr'} role="dialog"
            style={{ top: composer.top, left: Math.max(8, Math.min(composer.left, window.innerWidth - 308)) }}
            className="fixed z-[10001] w-[300px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 shadow-2xl">
            <div className="text-[11px] text-slate-500 dark:text-slate-400 border-s-2 border-amber-300 dark:border-amber-700 ps-2 mb-2 line-clamp-3">«{composer.anchor.quote}»</div>
            <textarea value={commentText} onChange={e => setCommentText(e.target.value)} rows={3} autoFocus
              placeholder={t('اكتب تعليقك…', 'Write your comment…')}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitComment(); }}
              className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 resize-y" />
            <div className="flex items-center justify-end gap-2 mt-2">
              <button onClick={cancelComposer} className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">{t('إلغاء', 'Cancel')}</button>
              <button onClick={submitComment} disabled={!commentText.trim() || submitting}
                className="px-4 py-1.5 rounded-lg bg-teal-600 text-white font-bold text-[12px] hover:bg-teal-700 disabled:opacity-50">
                {submitting ? t('جارٍ الإرسال…', 'Sending…') : t('تعليق', 'Comment')}
              </button>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
};

export default PublicReviewScreen;
