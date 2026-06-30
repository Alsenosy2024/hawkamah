// Client-facing shared document — accessed via ?doc=TOKEN (PRD V14 + V20).
//
// A document owner shares a /?doc= link carrying a self-contained HTML snapshot
// of the (edited) canvas. The client opens it WITHOUT any sign-in, views it in a
// read-only canvas (brand fonts + diagrams baked in, full export), and may leave
// comments. An optional access code gates a "visual reviewer" (V20), who can also
// record a structured visual-review check. The token is read from the world-
// readable `survey_tokens` collection (no rules change). Comments are written to
// the create-only `doc_comments` collection — until that rule is deployed the post
// fails gracefully with a clear "comments not enabled yet" message.
import React, { useEffect, useState } from 'react';
import DocumentCanvas from './DocumentCanvas';
import {
  getSharedDoc, verifyAccessCode, postDocComment,
} from '../services/sharedDocService';
import type { SharedDocToken, DocComment, VisualReviewCheck } from '../types';

interface Props { token: string; }

type Phase = 'loading' | 'invalid' | 'locked' | 'ready';

const SharedDocScreen: React.FC<Props> = ({ token }) => {
  const [tok, setTok] = useState<SharedDocToken | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  // comments / review drawer
  const [drawer, setDrawer] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [author, setAuthor] = useState('');
  const [text, setText] = useState('');
  const [check, setCheck] = useState<VisualReviewCheck>({ diagrams: true, fonts: true, layout: true, content: true, verdict: 'pass' });
  const [posting, setPosting] = useState(false);
  const [note, setNote] = useState('');
  const [mine, setMine] = useState<DocComment[]>([]);

  const ar = true;                                   // Arabic-first; the snapshot carries its own dir
  const t = (a: string, e: string) => (ar ? a : e);

  useEffect(() => {
    let alive = true;
    getSharedDoc(token)
      .then(r => {
        if (!alive) return;
        if (!r) { setPhase('invalid'); return; }
        setTok(r);
        setPhase(r.accessCodeHash ? 'locked' : 'ready');
      })
      .catch(() => { if (alive) setPhase('invalid'); });
    return () => { alive = false; };
  }, [token]);

  const unlock = async () => {
    if (!tok) return;
    setUnlocking(true); setCodeErr('');
    try {
      if (await verifyAccessCode(tok, code.trim())) setPhase('ready');
      else setCodeErr(t('رمز الدخول غير صحيح.', 'Incorrect access code.'));
    } catch {
      setCodeErr(t('تعذّر التحقق. حاول مرة أخرى.', 'Verification failed. Try again.'));
    } finally {
      setUnlocking(false);
    }
  };

  const submit = async (withCheck: boolean) => {
    if (!tok) return;
    const body = text.trim();
    if (!withCheck && !body) return;
    setPosting(true); setNote('');
    try {
      const saved = await postDocComment({
        tokenId: tok.id, docId: tok.docId, tenantId: tok.tenantId,
        author: author.trim() || t('عميل', 'Client'),
        text: body,
        ...(withCheck ? { check } : {}),
      });
      setMine(m => [...m, saved]);
      setText('');
      setNote(withCheck
        ? t('سُجِّلت المراجعة البصرية وأُرسلت للمالك ✅', 'Visual review recorded and sent to the owner ✅')
        : t('أُرسل تعليقك إلى المالك ✅', 'Your comment was sent to the owner ✅'));
    } catch (e: unknown) {
      setNote(String((e as Error)?.message) === 'COMMENTS_NOT_ENABLED'
        ? t('التعليقات غير مُفعَّلة بعد لهذا المستند. تواصل مع مالك المستند.', 'Comments are not enabled yet for this document. Please contact the document owner.')
        : t('تعذّر إرسال التعليق. حاول مرة أخرى.', 'Could not send the comment. Please try again.'));
    } finally {
      setPosting(false);
    }
  };

  if (phase === 'loading') {
    return <div dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-500">{t('جارٍ التحميل…', 'Loading…')}</div>;
  }

  if (phase === 'invalid') {
    return (
      <div dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 text-center max-w-md">
          <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{t('رابط المستند غير صالح', 'Invalid document link')}</p>
          <p className="text-sm text-slate-500 mt-2">{t('هذا الرابط غير صحيح أو أُلغي.', 'This link is invalid or has been revoked.')}</p>
        </div>
      </div>
    );
  }

  if (phase === 'locked' && tok) {
    return (
      <div dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 text-center max-w-md space-y-4">
          <div className="text-[11px] uppercase tracking-wide font-bold text-teal-600">{t('مراجعة بصرية', 'Visual review')}</div>
          <p className="text-lg font-bold text-slate-800 dark:text-slate-100">«{tok.docTitle}»</p>
          <p className="text-sm text-slate-500">{t('أدخل رمز الدخول لفتح المستند للمراجعة.', 'Enter the access code to open the document for review.')}</p>
          <input type="password" value={code} onChange={e => setCode(e.target.value)} autoFocus
            onKeyDown={e => { if (e.key === 'Enter') unlock(); }}
            placeholder={t('رمز الدخول', 'Access code')}
            className="w-full text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2.5 text-center" />
          <button onClick={unlock} disabled={!code.trim() || unlocking}
            className="w-full px-5 py-2.5 rounded-xl bg-teal-600 text-white font-bold text-sm hover:bg-teal-700 disabled:opacity-50">
            {unlocking ? t('جارٍ الفتح…', 'Unlocking…') : t('فتح المستند', 'Open document')}
          </button>
          {codeErr && <p className="text-xs text-rose-600">{codeErr}</p>}
        </div>
      </div>
    );
  }

  // ready
  const d = tok!;
  return (
    <div dir="rtl" className="fixed inset-0 bg-white dark:bg-slate-900">
      {/* The read-only canvas fills the screen (its own header carries title + export). */}
      <DocumentCanvas
        markdown=""
        initialHtml={d.html}
        title={d.docTitle}
        language="ar"
        readOnly
      />

      {/* Floating comments toggle (only when the owner allowed comments). */}
      {d.allowComments && (
        <button onClick={() => setDrawer(o => !o)}
          className="fixed bottom-5 end-5 z-[70] flex items-center gap-2 px-4 py-2.5 rounded-full bg-teal-600 text-white font-bold text-sm shadow-2xl hover:bg-teal-700">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          {t('التعليقات والمراجعة', 'Comments & review')}
        </button>
      )}

      {/* Comments / visual-review drawer. */}
      {d.allowComments && drawer && (
        <>
          <div className="fixed inset-0 z-[75] bg-black/30" onClick={() => setDrawer(false)} aria-hidden="true" />
          <aside dir="rtl" className="fixed top-0 bottom-0 end-0 z-[80] w-[min(92vw,400px)] bg-white dark:bg-slate-900 border-s border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col">
            <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
              <span className="text-sm font-black text-slate-800 dark:text-slate-100">{t('التعليقات والمراجعة', 'Comments & review')}</span>
              <button onClick={() => setDrawer(false)} aria-label={t('إغلاق', 'Close')} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {/* Mode toggle: free comment vs structured visual-review check (V20). */}
              <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-xl p-1">
                <button onClick={() => setReviewMode(false)} className={`flex-1 py-1.5 rounded-lg text-xs font-bold ${!reviewMode ? 'bg-white dark:bg-slate-700 text-teal-700 dark:text-teal-300 shadow' : 'text-slate-500'}`}>{t('تعليق', 'Comment')}</button>
                <button onClick={() => setReviewMode(true)} className={`flex-1 py-1.5 rounded-lg text-xs font-bold ${reviewMode ? 'bg-white dark:bg-slate-700 text-teal-700 dark:text-teal-300 shadow' : 'text-slate-500'}`}>{t('مراجعة بصرية', 'Visual review')}</button>
              </div>

              <input type="text" value={author} onChange={e => setAuthor(e.target.value)} placeholder={t('اسمك (اختياري)', 'Your name (optional)')}
                className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2" />

              {reviewMode && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-2">
                  {([
                    ['diagrams', t('المخططات تظهر بشكل صحيح', 'Diagrams render correctly')],
                    ['fonts', t('خط الهوية يظهر', 'Brand font renders')],
                    ['layout', t('التنسيق والاتجاه سليمان', 'Layout & direction correct')],
                    ['content', t('المحتوى دقيق', 'Content is accurate')],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-200 cursor-pointer">
                      <input type="checkbox" checked={check[key]} onChange={e => setCheck(c => ({ ...c, [key]: e.target.checked }))} className="accent-teal-600" />
                      {label}
                    </label>
                  ))}
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-[12px] text-slate-500">{t('الحكم:', 'Verdict:')}</span>
                    <button onClick={() => setCheck(c => ({ ...c, verdict: 'pass' }))} className={`px-3 py-1 rounded-full text-xs font-bold ${check.verdict === 'pass' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{t('مقبول', 'Pass')}</button>
                    <button onClick={() => setCheck(c => ({ ...c, verdict: 'fail' }))} className={`px-3 py-1 rounded-full text-xs font-bold ${check.verdict === 'fail' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500'}`}>{t('مرفوض', 'Fail')}</button>
                  </div>
                </div>
              )}

              <textarea value={text} onChange={e => setText(e.target.value)} rows={3}
                placeholder={reviewMode ? t('ملاحظات المراجعة (اختياري)…', 'Review notes (optional)…') : t('اكتب تعليقك…', 'Write your comment…')}
                className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 resize-y" />

              <button onClick={() => submit(reviewMode)} disabled={posting || (!reviewMode && !text.trim())}
                className="w-full px-4 py-2.5 rounded-xl bg-teal-600 text-white font-bold text-sm hover:bg-teal-700 disabled:opacity-50">
                {posting ? t('جارٍ الإرسال…', 'Sending…') : reviewMode ? t('تسجيل المراجعة', 'Record review') : t('إرسال التعليق', 'Send comment')}
              </button>
              {note && <p className="text-xs text-teal-700 dark:text-teal-400">{note}</p>}

              {mine.length > 0 && (
                <div className="border-t border-slate-100 dark:border-slate-800 pt-3 space-y-2">
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">{t('مساهماتك', 'Your submissions')}</p>
                  {mine.map(c => (
                    <div key={c.id} className="text-[12px] text-slate-600 dark:text-slate-300 border-s-2 border-teal-200 dark:border-teal-800 ps-2">
                      {c.kind === 'review_check' && c.check && (
                        <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-full me-1 ${c.check.verdict === 'pass' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                          {c.check.verdict === 'pass' ? t('مراجعة: مقبول', 'Review: pass') : t('مراجعة: مرفوض', 'Review: fail')}
                        </span>
                      )}
                      {c.text || (c.kind === 'review_check' ? t('(بدون ملاحظات)', '(no notes)') : '')}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
};

export default SharedDocScreen;
