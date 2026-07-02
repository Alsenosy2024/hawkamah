import React, { useEffect, useRef, useState } from 'react';
import MermaidView from './MermaidView';
import type { Language } from '../types';
import { editMermaidWithAI } from '../services/geminiService';
import { validateMermaidForRender } from '../services/diagramService';
import DiagramChatShell, { type DiagramAttachment as Attachment, toBase64 } from './DiagramChatShell';

// ===========================================================================
//  DiagramChatEditor — replaces the old drag-the-nodes canvas. The diagram is
//  shown exactly like the read-only view (MermaidView), and the user EDITS it by
//  chatting in natural language ("اجعل إدارة المشاريع تتبع الرئيس"). Images/PDFs
//  can be attached — build a diagram from a photo of an org chart, or feed a
//  policy list as a reference. Every AI edit is parse-validated before it shows,
//  there is an Undo, and a raw-code escape hatch for power users.
//
//  Source of truth = the Mermaid string. onSave persists the edited code.
//
//  P8: the composer (instruction input, attachments, busy/error, undo, send) is
//  the shared DiagramChatShell — also used by the swimlane chat editor inside
//  EditableDiagram — so this component keeps only Mermaid-specific state (the
//  code, its history, the raw-code escape hatch). Its own Props/behavior below
//  are unchanged by that extraction.
// ===========================================================================

interface Props {
  language?: Language;
  initialMermaid: string;
  title?: string;
  onSave?: (mermaid: string) => void;
  saving?: boolean;
}

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
      <DiagramChatShell
        language={language}
        instruction={instruction} onInstructionChange={setInstruction}
        attachments={attachments} onAttachmentsChange={setAttachments}
        busy={busy} saving={saving} error={error}
        canUndo={!!history.length} onUndo={undo} onSend={send} onCancel={cancel}
        suggestions={suggestions}
        placeholder={t('اكتب التعديل المطلوب… (مثال: اجعل إدارة المشاريع تتبع الرئيس)', 'Describe the change… (e.g. make Projects report to the CEO)')}
        onAttachError={() => setError(t('تعذّرت قراءة الملف المرفق.', 'Could not read the attached file.'))}
        headerExtra={
          <button
            onClick={openCode}
            title={t('عرض/تعديل الكود', 'View/edit code')}
            aria-label={t('عرض/تعديل الكود', 'View/edit code')}
            className="h-8 px-2 grid place-items-center rounded-lg border border-[var(--hw-border)] text-[11px] font-bold text-slate-500 hover:text-slate-900 hover:bg-slate-50"
          >
            {'</>'}
          </button>
        }
      />
    </div>
  );
};

export default DiagramChatEditor;
