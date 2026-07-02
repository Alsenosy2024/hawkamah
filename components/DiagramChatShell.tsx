import React, { useRef } from 'react';
import type { Language } from '../types';

// ===========================================================================
//  DiagramChatShell — the reusable "edit by chatting" composer shared by every
//  diagram chat editor (Mermaid's DiagramChatEditor, and the swimlane chat
//  editor inside EditableDiagram — see P8). Owns ONLY presentation + the
//  attachment file-reading helpers; the actual AI call, validation, undo
//  history and error copy stay with each caller, which passes controlled
//  instruction/attachments state plus busy/error/undo/send callbacks. Keeping
//  this shell "dumb" means DiagramChatEditor's external behavior — and its
//  existing consumers (DocumentCanvas, GovernanceCenter) — is unchanged by
//  this extraction; its own Props interface never moved.
// ===========================================================================

// `url` is the FileReader data: URL (data:<mime>;base64,<…>) — used both for the
// preview <img> and, with the prefix stripped, as the base64 sent to Gemini. Stored
// once (no separate base64 copy) and needs no revoke (data: URLs are GC'd).
export interface DiagramAttachment { url: string; mimeType: string; name?: string; isImage: boolean }

const ACCEPT = 'image/*,application/pdf';

export const fileToAttachment = (file: File): Promise<DiagramAttachment> =>
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
export const toBase64 = (dataUrl: string): string => dataUrl.slice(dataUrl.indexOf(',') + 1);

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

interface Props {
  language?: Language;
  instruction: string;
  onInstructionChange: (v: string) => void;
  attachments: DiagramAttachment[];
  onAttachmentsChange: (a: DiagramAttachment[]) => void;
  busy: boolean;
  saving?: boolean;
  error?: string;
  canUndo: boolean;
  onUndo: () => void;
  onSend: () => void;
  onCancel: () => void;
  suggestions: string[];
  placeholder?: string;
  headerExtra?: React.ReactNode;   // e.g. Mermaid's raw-code "</>" toggle
  onAttachError?: () => void;      // a picked file failed to read
}

const DiagramChatShell: React.FC<Props> = ({
  language, instruction, onInstructionChange, attachments, onAttachmentsChange,
  busy, saving, error, canUndo, onUndo, onSend, onCancel, suggestions, placeholder, headerExtra, onAttachError,
}) => {
  const ar = language !== 'en';
  const t = (a: string, e: string) => (ar ? a : e);
  const fileRef = useRef<HTMLInputElement>(null);

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
      onAttachmentsChange([...attachments, ...next]);
    } catch { onAttachError?.(); }
  };

  const removeAttachment = (idx: number) => onAttachmentsChange(attachments.filter((_, i) => i !== idx));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  };

  return (
    <div className="rounded-2xl border border-[var(--hw-border)] bg-white p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-slate-700">{t('عدّل المخطط بالكلام', 'Edit by chatting')}</span>
        {saving && <span className="text-[11px] text-slate-400">{t('· يُحفظ…', '· saving…')}</span>}
        {busy && (
          <button onClick={onCancel} className="text-[11px] text-rose-600 hover:text-rose-700 font-semibold">{t('إيقاف', 'Stop')}</button>
        )}
        <div className="ms-auto flex items-center gap-1">
          <button
            onClick={onUndo}
            disabled={!canUndo || busy}
            title={t('تراجع', 'Undo')}
            aria-label={t('تراجع', 'Undo')}
            className="w-8 h-8 grid place-items-center rounded-lg border border-[var(--hw-border)] text-slate-500 hover:text-slate-900 hover:bg-slate-50 disabled:opacity-40"
          >
            <IconUndo />
          </button>
          {headerExtra}
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
          onChange={e => onInstructionChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          rows={1}
          placeholder={placeholder || t('اكتب التعديل المطلوب…', 'Describe the change…')}
          className="flex-1 resize-none max-h-32 rounded-xl border border-[var(--hw-border)] bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[color:var(--hw-brand,#11a8bc)]"
        />
        <button
          onClick={onSend}
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
              onClick={() => onInstructionChange(s)}
              className="px-2.5 py-1 rounded-full bg-[var(--hw-brand-50,#eef8fa)] text-[color:var(--hw-brand-pressed,#0a6775)] text-[11px] font-semibold hover:bg-[var(--hw-brand-100,#def2f6)] transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default DiagramChatShell;
