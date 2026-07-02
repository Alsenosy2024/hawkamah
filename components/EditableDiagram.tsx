import React, { useEffect, useRef, useState } from 'react';
import type { Language } from '../types';
import MermaidView from './MermaidView';
import SwimlaneView from './SwimlaneView';
import DiagramChatEditor from './DiagramChatEditor';
import DiagramChatShell, { type DiagramAttachment as Attachment, toBase64 } from './DiagramChatShell';
import { editSwimlaneWithAI, type SwimlaneSpec } from '../services/swimlaneService';

// ===========================================================================
//  EditableDiagram — THE single diagram module for the app (P8). Renders a
//  Mermaid diagram or a swimlane spec exactly like the read-only views
//  (MermaidView / SwimlaneView) and, when a matching onSave prop is supplied,
//  shows a «تحرير بالكلام» pencil that switches to natural-language chat
//  editing — Mermaid via the existing DiagramChatEditor, swimlanes via
//  editSwimlaneWithAI below. Drop it in anywhere a diagram is shown; omit both
//  onSave props for a plain read-only view (identical to using MermaidView/
//  SwimlaneView directly).
//
//  Exactly one of `mermaid` / `swimlane` is expected — which one is present
//  decides the branch at runtime (no TS discriminated-union narrowing is
//  relied on; this repo's tsconfig is non-strict, where that narrowing is
//  unreliable).
// ===========================================================================

interface Props {
  language?: Language;
  title?: string;
  mermaid?: string;
  swimlane?: SwimlaneSpec;
  onSaveMermaid?: (code: string) => void;
  onSaveSwimlane?: (spec: SwimlaneSpec) => void;
  saving?: boolean;
}

const IconPencil: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 inline-block me-1"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
);
const IconEye: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 inline-block me-1"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
);

// ---------------------------------------------------------------------------
//  Swimlane chat editor — the swimlane counterpart of DiagramChatEditor, built
//  on the SAME shared composer (DiagramChatShell) and the same shape of state
//  machine (spec + undo history + busy/error), driving editSwimlaneWithAI
//  instead of editMermaidWithAI. Kept local to this module (not a separate
//  exported component) since it has no standalone consumer outside
//  EditableDiagram.
// ---------------------------------------------------------------------------
interface SwimlaneChatEditorProps {
  language?: Language;
  initialSpec: SwimlaneSpec;
  title?: string;
  onSave: (spec: SwimlaneSpec) => void;
  saving?: boolean;
}

const specKey = (s: SwimlaneSpec): string => { try { return JSON.stringify(s); } catch { return ''; } };

const SwimlaneChatEditor: React.FC<SwimlaneChatEditorProps> = ({ language, initialSpec, title, onSave, saving }) => {
  const ar = language !== 'en';
  const t = (a: string, e: string) => (ar ? a : e);

  const [spec, setSpec] = useState<SwimlaneSpec>(initialSpec);
  const [history, setHistory] = useState<SwimlaneSpec[]>([]);
  const [instruction, setInstruction] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;
  const busyRef = useRef(false);

  // Re-seed ONLY on a genuine external spec switch — compared by VALUE (like
  // DiagramChatEditor compares Mermaid strings), never on the echo of our own
  // save (the parent re-passes the same spec object we just committed), which
  // would otherwise wipe the undo history after every edit.
  useEffect(() => {
    if (specKey(initialSpec) === specKey(specRef.current)) return;
    setSpec(initialSpec);
    setHistory([]);
    setError('');
  }, [initialSpec]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const commit = (next: SwimlaneSpec) => {
    setHistory(h => [...h, spec]);
    setSpec(next);
    onSave(next);
  };

  const send = async () => {
    if (busyRef.current) return;
    const instr = instruction.trim();
    if (!instr && !attachments.length) return;
    busyRef.current = true;
    setBusy(true); setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const next = await editSwimlaneWithAI(spec, instr, {
        attachments: attachments.map(a => ({ data: toBase64(a.url), mimeType: a.mimeType, name: a.name })),
        language: ar ? 'ar' : 'en',
        signal: ctrl.signal,
      });
      commit(next);
      setInstruction('');
      setAttachments([]);
    } catch (e: any) {
      if (ctrl.signal.aborted) { /* user cancelled / unmounted */ }
      else if (String(e?.message || '').startsWith('INVALID_SWIMLANE')) {
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
      setSpec(prev);
      onSave(prev);
      return h.slice(0, -1);
    });
  };

  const suggestions = ar
    ? ['أضف مسار موافقة جديد', 'وضّح خطوة القرار أكثر', 'أضف مسار رفض/إرجاع من هذه الخطوة']
    : ['Add a new approval lane', 'Clarify the decision step', 'Add a reject/return path from this step'];

  return (
    <div dir={ar ? 'rtl' : 'ltr'} className="space-y-3">
      <SwimlaneView spec={spec} title={title || spec.title} language={language} />
      <DiagramChatShell
        language={language}
        instruction={instruction} onInstructionChange={setInstruction}
        attachments={attachments} onAttachmentsChange={setAttachments}
        busy={busy} saving={saving} error={error}
        canUndo={!!history.length} onUndo={undo} onSend={send} onCancel={cancel}
        suggestions={suggestions}
        placeholder={t('اكتب التعديل المطلوب… (مثال: أضف موافقة المدير المالي قبل الاعتماد النهائي)', 'Describe the change… (e.g. add finance manager approval before final sign-off)')}
        onAttachError={() => setError(t('تعذّرت قراءة الملف المرفق.', 'Could not read the attached file.'))}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
//  EditableDiagram — the exported unified module.
// ---------------------------------------------------------------------------
const EditableDiagram: React.FC<Props> = ({ language, title, mermaid, swimlane, onSaveMermaid, onSaveSwimlane, saving }) => {
  const ar = language !== 'en';
  const t = (a: string, e: string) => (ar ? a : e);
  const [editing, setEditing] = useState(false);

  const isSwimlane = !!swimlane;
  const editable = isSwimlane ? !!onSaveSwimlane : !!onSaveMermaid;

  const toggleBtn = editable ? (
    <div className="flex justify-end">
      <button
        onClick={() => setEditing(v => !v)}
        title={editing ? t('عرض المخطط فقط', 'View only') : t('تحرير بالكلام', 'Edit by chatting')}
        className="hw-btn hw-btn-xs hw-btn-ghost font-bold"
      >
        {editing ? <><IconEye />{t('عرض', 'View')}</> : <><IconPencil />{t('تحرير بالكلام', 'Edit by chatting')}</>}
      </button>
    </div>
  ) : null;

  if (isSwimlane && swimlane) {
    if (editing && onSaveSwimlane) {
      return (
        <div className="space-y-2">
          {toggleBtn}
          <SwimlaneChatEditor language={language} initialSpec={swimlane} title={title} onSave={onSaveSwimlane} saving={saving} />
        </div>
      );
    }
    return (
      <div className="space-y-2">
        {toggleBtn}
        <SwimlaneView spec={swimlane} title={title} language={language} />
      </div>
    );
  }

  // Mermaid branch (default — also covers an empty/undefined mermaid string).
  if (editing && onSaveMermaid) {
    return (
      <div className="space-y-2">
        {toggleBtn}
        <DiagramChatEditor language={language} initialMermaid={mermaid || ''} title={title} onSave={onSaveMermaid} saving={saving} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {toggleBtn}
      <MermaidView mermaid={mermaid || ''} title={title} language={language} />
    </div>
  );
};

export default EditableDiagram;
