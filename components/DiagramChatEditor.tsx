import React, { useEffect, useRef, useState } from 'react';
import MermaidView from './MermaidView';
import type { Language } from '../types';
import { editMermaidWithAI } from '../services/geminiService';
import { validateMermaidForRender } from '../services/diagramService';

// ===========================================================================
//  DiagramChatEditor — replaces the old drag-the-nodes canvas. The diagram is
//  shown exactly like the read-only view (MermaidView), and the user EDITS it by
//  chatting in natural language ("اجعل إدارة المشاريع تتبع الرئيس"). Images/PDFs
//  can be attached — build a diagram from a photo of an org chart, or feed a
//  policy list as a reference. Every AI edit is parse-validated before it shows,
//  there is an Undo, and a raw-code escape hatch for power users.
//
//  Source of truth = the Mermaid string. onSave persists the edited code.
// ===========================================================================

// `url` is the FileReader data: URL (data:<mime>;base64,<…>) — used both for the
// preview <img> and, with the prefix stripped, as the base64 sent to Gemini. Stored
// once (no separate base64 copy) and needs no revoke (data: URLs are GC'd).
interface Attachment { url: string; mimeType: string; name?: string; isImage: boolean }

interface Props {
  language?: Language;
  initialMermaid: string;
  title?: string;
  onSave?: (mermaid: string) => void;
  saving?: boolean;
}

const ACCEPT = 'image/*,application/pdf';

const fileToAttachment = (file: File): Promise<Attachment> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result || '');                 // data:<mime>;base64,<…>
      const mimeType = file.type || 'application/octet-stream';
      resolve({ url, mimeType, name: file.name, isImage: mimeType.startsWith('image/') });
    };
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });

// strip the `data:<mime>;base64,` prefix → raw base64 for Gemini inlineData.
const toBase64 = (dataUrl: string): string => dataUrl.slice(dataUrl.indexOf(',') + 1);

const IconAttach: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
);
const IconSend: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
);
const IconUndo: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6" /><path d="M3.51 13a9 9 0 1 0 2.13-9.36L3 7" /></svg>
);
const IconClose: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
);

const DiagramChatEditor: React.FC<Props> = ({ language, initialMermaid, title, onSave, saving }) => {
  const ar = language !== 'en';
  const t = (a: string, e: string) => (ar ? a : e);

  const [code, setCode] = useState(initialMermaid || '');
  const [history, setHistory] = useState<string[]>([]);
  const [instruction, setInstruction] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [draftCode, setDraftCode] = useState('');

  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Mirror current code into a ref so the re-seed effect reads the latest value
  // WITHOUT re-running on every keystroke.
  const codeRef = useRef(code);
  codeRef.current = code;
  const busyRef = useRef(false);   // synchronous double-send guard (busy state lags a tick)

  // Re-seed ONLY on a genuine external diagram switch — never on the echo of our
  // own save (the parent re-passes the value we just committed), which would wipe
  // the undo history after every edit.
  useEffect(() => {
    if ((initialMermaid || '') === codeRef.current) return;
    setCode(initialMermaid || '');
    setHistory([]);
    setError('');
    setShowCode(false);
  }, [initialMermaid]);

  // Abort any in-flight AI edit on unmount so it can't commit to a diagram the user
  // already navigated away from. (Attachments are data: URLs — nothing to free.)
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const commit = (next: string) => {
    setHistory(h => [...h, code]);
    setCode(next);
    onSave?.(next);
  };

  const pickFiles = () => fileRef.current?.click();

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fl = e.target.files;
    if (!fl || !fl.length) return;
    const picked: File[] = [];
    for (let i = 0; i < fl.length; i++) {
      const f = fl.item(i);
      if (f && (f.type.startsWith('image/') || f.type === 'application/pdf')) picked.push(f);
    }
    if (fileRef.current) fileRef.current.value = '';
    try {
      const next = await Promise.all(picked.map(fileToAttachment));
      setAttachments(a => [...a, ...next]);
    } catch { setError(t('تعذّرت قراءة الملف المرفق.', 'Could not read the attached file.')); }
  };

  const removeAttachment = (idx: number) => setAttachments(a => a.filter((_, i) => i !== idx));

  const send = async () => {
    if (busyRef.current) return;                          // synchronous guard — busy state lags a render
    const instr = instruction.trim();
    if (!instr && !attachments.length) return;
    busyRef.current = true;
    setBusy(true); setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const next = await editMermaidWithAI(code, instr, {
        attachments: attachments.map(a => ({ data: toBase64(a.url), mimeType: a.mimeType, name: a.name })),
        language,
        validate: validateMermaidForRender,
        signal: ctrl.signal,
      });
      commit(next);
      setInstruction('');
      setAttachments([]);
    } catch (e: any) {
      if (ctrl.signal.aborted) { /* user cancelled / unmounted */ }
      else if (String(e?.message || '').startsWith('INVALID_MERMAID')) {
        setError(t('تعذّر إنتاج مخطط صالح من هذا الطلب. جرّب صياغة أوضح أو خطوة أصغر.',
                   'Could not produce a valid diagram from that request. Try a clearer or smaller change.'));
      } else {
        setError(t('تعذّر تنفيذ التعديل — يُرجى المحاولة مرة أخرى.', 'The edit failed — please try again.'));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.abort();

  const undo = () => {
    setHistory(h => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      setCode(prev);
      onSave?.(prev);
      return h.slice(0, -1);
    });
  };

  const openCode = () => { setDraftCode(code); setShowCode(true); };
  const applyCode = () => {
    const next = draftCode.trim();
    if (next && next !== code) commit(next);
    setShowCode(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const suggestions = ar
    ? ['اجعل المخطط أوضح وأكثر تنظيمًا', 'أضف إدارة جديدة تتبع الرئيس التنفيذي', 'حوّل الاتجاه إلى أفقي']
    : ['Make it clearer and better organised', 'Add a new department under the CEO', 'Switch to a horizontal layout'];

  return (
    <div dir={ar ? 'rtl' : 'ltr'} className="space-y-3">
      {/* the diagram — same view as the read-only chart */}
      <MermaidView mermaid={code} title={title || t('الهيكل التنظيمي', 'Organisational structure')} language={language} />

      {/* raw-code escape hatch */}
      {showCode && (
        <div className="rounded-2xl border border-[var(--hw-border)] bg-white p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-600">{t('كود Mermaid', 'Mermaid code')}</span>
            <button onClick={() => setShowCode(false)} title={t('إغلاق', 'Close')} aria-label={t('إغلاق', 'Close')} className="text-slate-400 hover:text-slate-700"><IconClose /></button>
          </div>
          <textarea
            dir="ltr"
            value={draftCode}
            onChange={e => setDraftCode(e.target.value)}
            spellCheck={false}
            rows={Math.min(16, Math.max(6, draftCode.split('\n').length + 1))}
            className="w-full text-left font-mono text-xs leading-relaxed rounded-xl border border-[var(--hw-border)] bg-slate-50 p-3 text-slate-700 focus:outline-none focus:ring-2 focus:ring-[color:var(--hw-brand,#11a8bc)]"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowCode(false)} className="hw-btn hw-btn-subtle hw-btn-sm">{t('إلغاء', 'Cancel')}</button>
            <button onClick={applyCode} className="hw-btn hw-btn-primary hw-btn-sm">{t('تطبيق', 'Apply')}</button>
          </div>
        </div>
      )}

      {/* chat composer */}
      <div className="rounded-2xl border border-[var(--hw-border)] bg-white p-3 space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-slate-700">{t('عدّل المخطط بالكلام', 'Edit by chatting')}</span>
          {saving && <span className="text-[11px] text-slate-400">{t('· يُحفظ…', '· saving…')}</span>}
          {busy && (
            <button onClick={cancel} className="text-[11px] text-rose-600 hover:text-rose-700 font-semibold">{t('إيقاف', 'Stop')}</button>
          )}
          <div className="ms-auto flex items-center gap-1">
            <button
              onClick={undo}
              disabled={!history.length || busy}
              title={t('تراجع', 'Undo')}
              aria-label={t('تراجع', 'Undo')}
              className="w-8 h-8 grid place-items-center rounded-lg border border-[var(--hw-border)] text-slate-500 hover:text-slate-900 hover:bg-slate-50 disabled:opacity-40"
            >
              <IconUndo />
            </button>
            <button
              onClick={openCode}
              title={t('عرض/تعديل الكود', 'View/edit code')}
              aria-label={t('عرض/تعديل الكود', 'View/edit code')}
              className="h-8 px-2 grid place-items-center rounded-lg border border-[var(--hw-border)] text-[11px] font-bold text-slate-500 hover:text-slate-900 hover:bg-slate-50"
            >
              {'</>'}
            </button>
          </div>
        </div>

        {error && (
          <div role="alert" aria-live="assertive" className="px-3 py-2 rounded-xl border border-amber-200 bg-amber-50 text-[12px] text-amber-700">{error}</div>
        )}

        {/* attachment chips */}
        {!!attachments.length && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 ps-1 pe-2 py-1 rounded-lg bg-slate-100 border border-[var(--hw-border)] text-[11px] text-slate-600 max-w-[200px]">
                {a.isImage && a.url
                  ? <img src={a.url} alt="" className="w-6 h-6 rounded object-cover" />
                  : <span className="w-6 h-6 grid place-items-center rounded bg-rose-100 text-rose-600 font-bold text-[10px]">PDF</span>}
                <span className="truncate">{a.name || t('مرفق', 'file')}</span>
                <button onClick={() => removeAttachment(i)} className="text-slate-400 hover:text-rose-600 shrink-0" aria-label={t('إزالة', 'Remove')}><IconClose /></button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <button
            onClick={pickFiles}
            disabled={busy}
            title={t('إرفاق صورة أو ملف PDF', 'Attach an image or PDF')}
            aria-label={t('إرفاق', 'Attach')}
            className="shrink-0 w-10 h-10 grid place-items-center rounded-xl border border-[var(--hw-border)] text-slate-500 hover:text-slate-800 hover:bg-slate-50 disabled:opacity-40"
          >
            <IconAttach />
          </button>
          <input ref={fileRef} type="file" accept={ACCEPT} multiple onChange={onFiles} className="hidden" />
          <textarea
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
            rows={1}
            placeholder={t('اكتب التعديل المطلوب… (مثال: اجعل إدارة المشاريع تتبع الرئيس)', 'Describe the change… (e.g. make Projects report to the CEO)')}
            className="flex-1 resize-none max-h-32 rounded-xl border border-[var(--hw-border)] bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[color:var(--hw-brand,#11a8bc)]"
          />
          <button
            onClick={send}
            disabled={busy || (!instruction.trim() && !attachments.length)}
            title={t('تنفيذ', 'Send')}
            aria-label={t('تنفيذ', 'Send')}
            className="shrink-0 w-10 h-10 grid place-items-center rounded-xl bg-[color:var(--hw-brand,#11a8bc)] hover:bg-[color:var(--hw-brand-hover,#0b8090)] text-white disabled:opacity-40 transition-colors"
          >
            {busy
              ? <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
              : <IconSend />}
          </button>
        </div>

        {/* one-tap suggestions */}
        {!busy && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => setInstruction(s)}
                className="px-2.5 py-1 rounded-full bg-[var(--hw-brand-50,#eef8fa)] text-[color:var(--hw-brand-pressed,#0a6775)] text-[11px] font-semibold hover:bg-[var(--hw-brand-100,#def2f6)] transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DiagramChatEditor;
