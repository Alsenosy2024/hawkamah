// ===========================================================================
//  DocumentCanvas — the in-app Ailigent "document canvas".
//
//  Renders an AI-generated document as a polished, paginated HTML document
//  (cover → table of contents → numbered section pages, KPI cards, inline-SVG
//  charts, premium tables — built by services/canvasDocument.ts) inside a
//  same-origin <iframe srcDoc> with `designMode` editing. The full design is
//  preserved (no schema round-trip), every word stays editable, the cover and
//  pages can be restyled, and one click prints the SAME HTML to a real PDF —
//  the browser shapes Arabic correctly (unlike html2canvas rasterizers).
//
//  Adapted from the Ailigent/document-canvas in-app editor, re-themed to this
//  app's design system (hw-btn, Thmanyah, teal) and inline t(ar,en) i18n.
// ===========================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Language } from '../types';
import { mermaidToSvg } from '../services/diagramService';
import {
  buildCanvasHtml, extractDocSpec, markdownToDocSpec,
  type DocSpec, type DocBlock, type MdToSpecOptions,
} from '../services/canvasDocument';

// ── prepare: markdown/spec → canvas HTML, with Mermaid pre-rendered to SVG ──
// Diagrams are rendered to brand-themed INLINE SVG (htmlLabels on) so Arabic
// shapes correctly AND prints sharp — a rasterized PNG would need htmlLabels off,
// which breaks Arabic glyph shaping.
async function prepareCanvasDoc(markdown: string, opts: MdToSpecOptions): Promise<string> {
  const spec: DocSpec = extractDocSpec(markdown, opts) || markdownToDocSpec(markdown, opts);
  await replaceMermaid(spec.blocks);
  return buildCanvasHtml(spec);
}

async function replaceMermaid(blocks: DocBlock[]): Promise<void> {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'mermaid') {
      try {
        const svg = await mermaidToSvg(b.code);
        blocks[i] = { type: 'figure', svg, alt: 'diagram' };
      } catch {
        blocks[i] = { type: 'code', code: b.code, lang: 'mermaid' };
      }
    } else if (b.type === 'columns') {
      const kids = [b.left, b.right].filter(Boolean) as DocBlock[];
      await replaceMermaid(kids);
    }
  }
}

// ── compact inline icons (match the app's hand-rolled icon convention) ─────────
const IcBold = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z" /></svg>;
const IcItalic = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M19 4h-9M14 20H5M15 4 9 20" /></svg>;
const IcUnderline = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 4v6a6 6 0 0 0 12 0V4M4 21h16" /></svg>;
const IcStrike = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16" /></svg>;
const IcAlignR = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 6H3M21 12H9M21 18H6" /></svg>;
const IcAlignC = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 6H3M18 12H6M19 18H5" /></svg>;
const IcAlignL = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M3 12h12M3 18h15" /></svg>;
const IcUl = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>;
const IcOl = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4l2-2v-1H4" /></svg>;
const IcClear = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V5h13M9 5l-2 14M14 14l6 6M20 14l-6 6" /></svg>;
const IcPalette = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1-.3-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-4.4-4.5-8-10-8z" /></svg>;
const IcDownload = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>;
const IcSave = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" /></svg>;
const IcClose = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>;
const IcSpark = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c.8 5.5 4.5 9.2 10 10-5.5.8-9.2 4.5-10 10-.8-5.5-4.5-9.2-10-10 5.5-.8 9.2-4.5 10-10z" /></svg>;
const IcSpin = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>;

// ── restyle presets (Ailigent-led) ─────────────────────────────────────────
const COVER_GRADIENTS: { name: string; css: string }[] = [
  { name: 'teal', css: 'radial-gradient(125% 140% at 100% 0%,#2bc4d6 0%,#11a8bc 44%,#0b6f86 100%)' },
  { name: 'blue', css: 'radial-gradient(120% 140% at 100% 0%,#3b82c4 0%,#1e6fa8 55%,#16456e 100%)' },
  { name: 'deep', css: 'radial-gradient(120% 140% at 100% 0%,#0fb6c9 0%,#0b8090 55%,#08515c 100%)' },
  { name: 'emerald', css: 'radial-gradient(120% 140% at 100% 0%,#1f9d70 0%,#0f766e 55%,#0c4a45 100%)' },
  { name: 'slate', css: 'radial-gradient(120% 140% at 100% 0%,#475569 0%,#1e293b 55%,#0f172a 100%)' },
  { name: 'plum', css: 'radial-gradient(120% 140% at 100% 0%,#7c5cd6 0%,#5b3aa6 55%,#3a2470 100%)' },
];
const TEXT_COLORS = ['#10242b', '#11a8bc', '#1e6fa8', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#ffffff'];
const HILITE_COLORS = ['#cdeef3', '#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', 'transparent'];
const PAGE_COLORS = ['#ffffff', '#f7fbfc', '#f8fafc', '#fbfdff', '#f6fbf7', '#fffdf6'];
const PAGE_PATTERNS: { key: string; label: string; labelEn: string; css: string }[] = [
  { key: 'plain', label: 'سادة', labelEn: 'Plain', css: '#ffffff' },
  { key: 'lines', label: 'مسطّر', labelEn: 'Lined', css: 'repeating-linear-gradient(0deg,#eef3f5 0 1px,#ffffff 1px 30px)' },
  { key: 'diagonal', label: 'مخطّط', labelEn: 'Diagonal', css: 'repeating-linear-gradient(135deg,#eef3f5 0 1px,#ffffff 1px 14px)' },
  { key: 'dots', label: 'منقّط', labelEn: 'Dots', css: 'radial-gradient(#dde9ec 1.2px,#ffffff 1.3px) 0 0/18px 18px' },
  { key: 'grid', label: 'شبكة', labelEn: 'Grid', css: 'linear-gradient(#eef3f5 1px,transparent 1px) 0 0/24px 24px,linear-gradient(90deg,#eef3f5 1px,transparent 1px) 0 0/24px 24px,#ffffff' },
];
const COVER_PATTERNS: { key: string; label: string; labelEn: string; css: string }[] = [
  { key: 'none', label: 'بدون', labelEn: 'None', css: '' },
  { key: 'diagonal', label: 'مخطّط', labelEn: 'Diagonal', css: 'repeating-linear-gradient(135deg,#fff 0 1px,transparent 1px 16px)' },
  { key: 'lines', label: 'مسطّر', labelEn: 'Lined', css: 'repeating-linear-gradient(0deg,#fff 0 1px,transparent 1px 30px)' },
  { key: 'dots', label: 'منقّط', labelEn: 'Dots', css: 'radial-gradient(#fff 1.1px,transparent 1.3px) 0 0/18px 18px' },
  { key: 'grid', label: 'شبكة', labelEn: 'Grid', css: 'linear-gradient(#fff 1px,transparent 1px) 0 0/24px 24px,linear-gradient(90deg,#fff 1px,transparent 1px) 0 0/24px 24px' },
];

export interface DocumentCanvasProps {
  markdown: string;
  initialHtml?: string;                 // previously-edited HTML (reopen shows edits)
  title?: string;
  subtitle?: string;
  date?: string;
  brand?: string;
  language?: Language;
  rootClass?: string;                   // host-controlled geometry (default full-screen)
  onClose: () => void;
  onSave?: (html: string) => void;      // persist the edited HTML
  onAskAi?: (selectedText: string) => void;
}

const DocumentCanvas: React.FC<DocumentCanvasProps> = ({
  markdown, initialHtml, title, subtitle, date, brand, language,
  rootClass = 'fixed inset-0 z-[60]', onClose, onSave, onAskAi,
}) => {
  const ar = (language || 'ar') === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [docHtml, setDocHtml] = useState<string | null>(initialHtml || null);
  const [loading, setLoading] = useState(!initialHtml);
  const [coverOpen, setCoverOpen] = useState(false);
  const [askSel, setAskSel] = useState<{ text: string; top: number; left: number } | null>(null);
  const [saved, setSaved] = useState(false);

  const docTitle = useMemo(
    () => (title || (markdown.match(/^#{1,2}\s+(.+)$/m)?.[1] || t('وثيقة', 'Document'))).slice(0, 80).trim(),
    [title, markdown, ar],
  );

  // Build the canvas HTML once (markdown/spec → paginated doc, mermaid → images).
  useEffect(() => {
    if (initialHtml) { setDocHtml(initialHtml); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    prepareCanvasDoc(markdown, {
      title, subtitle: subtitle || t('وثيقة حوكمة', 'Governance document'),
      lang: ar ? 'ar' : 'en', date, brand,
    })
      .then(html => { if (alive) { setDocHtml(html); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, initialHtml]);

  // Enable in-place editing once the iframe document is ready.
  const handleIframeLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    try { doc.designMode = 'on'; doc.execCommand('styleWithCSS', false, 'true'); } catch { /* noop */ }
    // Clicking the cover opens the restyle modal (instead of editing its text).
    const cover = doc.querySelector('.cover') as HTMLElement | null;
    if (cover) {
      cover.setAttribute('contenteditable', 'false');
      cover.style.cursor = 'pointer';
      cover.addEventListener('click', () => setCoverOpen(true));
    }
    if (onAskAi) {
      const updateAsk = () => {
        const win = doc.defaultView;
        const s = win?.getSelection();
        const text = s?.toString().trim() || '';
        const frame = iframeRef.current;
        if (!s || s.isCollapsed || !text || !frame) { setAskSel(null); return; }
        try {
          const r = s.getRangeAt(0).getBoundingClientRect();
          const f = frame.getBoundingClientRect();
          setAskSel({ text, top: f.top + r.bottom + 6, left: f.left + r.left });
        } catch { setAskSel(null); }
      };
      doc.addEventListener('mouseup', updateAsk);
      doc.addEventListener('keyup', updateAsk);
      doc.addEventListener('scroll', () => setAskSel(null), true);
    }
  }, [onAskAi]);

  const exec = useCallback((cmd: string, val?: string) => {
    const win = iframeRef.current?.contentWindow;
    const doc = iframeRef.current?.contentDocument;
    if (!doc || !win) return;
    win.focus();
    try { doc.execCommand(cmd, false, val); } catch { /* noop */ }
  }, []);

  // ── restyle: cover / pages ──
  const setCoverBg = useCallback((bg: string) => {
    const cover = iframeRef.current?.contentDocument?.querySelector('.cover') as HTMLElement | null;
    if (!cover) return;
    cover.style.background = bg; cover.style.backgroundSize = 'cover'; cover.style.backgroundPosition = 'center';
  }, []);
  const setPageBg = useCallback((bg: string) => {
    iframeRef.current?.contentDocument?.querySelectorAll<HTMLElement>('.page:not(.cover)').forEach(el => { el.style.background = bg; });
  }, []);
  const setCoverPattern = useCallback((cssVal: string) => {
    const layer = iframeRef.current?.contentDocument?.querySelector('.cover .pattern') as HTMLElement | null;
    if (!layer) return;
    layer.style.background = cssVal || 'none'; layer.style.opacity = cssVal ? '0.16' : '0';
  }, []);
  const onCoverImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCoverBg(`linear-gradient(rgba(8,20,24,.42),rgba(8,20,24,.58)),url(${String(reader.result)}) center/cover no-repeat`);
    reader.readAsDataURL(file);
  }, [setCoverBg]);

  // The live document HTML (edits included) + a print-fix stylesheet.
  const liveHtml = useCallback((): string => {
    const doc = iframeRef.current?.contentDocument;
    let html = doc?.documentElement?.outerHTML || docHtml || '';
    if (!/^\s*<!doctype/i.test(html)) html = `<!DOCTYPE html>${html}`;
    // Reinforce color printing + strip the screen card chrome. Pagination is owned
    // by the document's own @media print rules (per-section pages, atomic blocks
    // never split) so the PDF matches the canvas — do NOT override break-* here.
    const fix = '<style id="pdf-export-fix">*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}'
      + '@media print{html,body{background:#fff!important}.page{box-shadow:none!important;margin:0!important;border-radius:0!important;background:#fff!important}}</style>';
    if (!html.includes('pdf-export-fix')) html = html.replace('</head>', `${fix}</head>`);
    return html;
  }, [docHtml]);

  // Export PDF: print the live document HTML in a dedicated hidden iframe. The
  // browser's own print engine shapes Arabic correctly and renders the woff2
  // brand font + colored backgrounds (print-color-adjust:exact) — a real,
  // selectable, vector PDF via "Save as PDF".
  const exportPdf = useCallback(() => {
    const html = liveHtml();
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(frame);
    let done = false;
    const cleanup = () => { if (!done) { done = true; setTimeout(() => frame.remove(), 800); } };
    const go = () => {
      const w = frame.contentWindow;
      if (!w) { cleanup(); return; }
      try { w.onafterprint = cleanup; } catch { /* noop */ }
      try { w.focus(); w.print(); } catch { /* noop */ }
      setTimeout(cleanup, 60000); // safety net (print dialog left open)
    };
    const d = frame.contentDocument;
    if (!d) { frame.remove(); return; }
    d.open(); d.write(html); d.close();
    const fonts = (d as any).fonts;
    const fire = () => { setTimeout(go, 80); };
    if (fonts?.ready?.then) fonts.ready.then(fire).catch(fire);
    else if (d.readyState === 'complete') fire();
    else frame.onload = fire;
  }, [liveHtml]);

  const handleSave = useCallback(() => {
    onSave?.(liveHtml());
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }, [onSave, liveHtml]);

  // Esc closes the canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !coverOpen) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, coverOpen]);

  const tbtn = 'flex items-center justify-center w-8 h-8 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-[var(--hw-brand-50,#eef8fa)] hover:text-[var(--hw-brand,#11a8bc)] transition-colors shrink-0';
  const md = (e: React.MouseEvent, cmd: string, val?: string) => { e.preventDefault(); exec(cmd, val); };

  return (
    <div className={`dc-overlay ${rootClass} flex flex-col bg-white dark:bg-slate-900`} dir={ar ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-[var(--hw-border)] shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="dc-spark text-[var(--hw-brand,#11a8bc)]"><IcSpark /></span>
          <div className="flex flex-col min-w-0">
            <span className="text-[14.5px] font-bold text-slate-900 dark:text-slate-100 truncate">{docTitle}</span>
            <span className="text-[11px] text-slate-400 leading-none">{t('مستند قابل للتحرير · الكانفس', 'Editable document · Canvas')}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onSave && (
            <button type="button" onClick={handleSave} className="hw-btn hw-btn-subtle hw-btn-sm !rounded-full">
              {saved ? <span className="text-emerald-600">✓</span> : <IcSave />}{saved ? t('حُفظ', 'Saved') : t('حفظ', 'Save')}
            </button>
          )}
          <button type="button" onClick={exportPdf} disabled={loading} className="hw-btn hw-btn-primary hw-btn-sm !rounded-full">
            <IcDownload />{t('تصدير PDF', 'Export PDF')}
          </button>
          <button type="button" onClick={onClose} title={t('إغلاق', 'Close')} aria-label={t('إغلاق', 'Close')} className="gc-icon-btn">
            <IcClose />
          </button>
        </div>
      </div>

      {/* Formatting toolbar (drives the iframe via execCommand) */}
      <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-[var(--hw-border)] bg-white dark:bg-slate-900 overflow-x-auto flex-nowrap">
        <span className="text-[11px] text-slate-400 me-2 shrink-0 whitespace-nowrap">{t('حدّد أي نص وعدّله ✏️', 'Select any text to edit ✏️')}</span>
        <span className="w-px h-5 bg-[var(--hw-border)] mx-1 shrink-0" />
        <button type="button" onMouseDown={e => md(e, 'bold')} className={tbtn} title={t('عريض', 'Bold')}><IcBold /></button>
        <button type="button" onMouseDown={e => md(e, 'italic')} className={tbtn} title={t('مائل', 'Italic')}><IcItalic /></button>
        <button type="button" onMouseDown={e => md(e, 'underline')} className={tbtn} title={t('تسطير', 'Underline')}><IcUnderline /></button>
        <button type="button" onMouseDown={e => md(e, 'strikeThrough')} className={tbtn} title={t('يتوسطه خط', 'Strikethrough')}><IcStrike /></button>
        <span className="w-px h-5 bg-[var(--hw-border)] mx-1 shrink-0" />
        <div className="flex items-center gap-0.5 shrink-0" title={t('لون النص', 'Text color')}>
          {TEXT_COLORS.map(c => (
            <button key={c} type="button" onMouseDown={e => md(e, 'foreColor', c)}
              className="w-4 h-4 rounded-full border border-slate-300 shrink-0 hover:scale-110 transition" style={{ background: c }} />
          ))}
        </div>
        <span className="w-px h-5 bg-[var(--hw-border)] mx-1 shrink-0" />
        <div className="flex items-center gap-0.5 shrink-0" title={t('تظليل', 'Highlight')}>
          {HILITE_COLORS.map(c => (
            <button key={c} type="button" onMouseDown={e => md(e, 'hiliteColor', c)}
              className="w-4 h-4 rounded border border-slate-300 shrink-0 hover:scale-110 transition"
              style={{ background: c === 'transparent' ? 'repeating-linear-gradient(45deg,#fff,#fff 3px,#eee 3px,#eee 6px)' : c }} />
          ))}
        </div>
        <span className="w-px h-5 bg-[var(--hw-border)] mx-1 shrink-0" />
        <select onChange={e => exec('fontSize', e.target.value)} defaultValue="3"
          className="h-8 border border-[var(--hw-border)] rounded-lg px-2 text-xs bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 shrink-0">
          <option value="2">{t('صغير', 'Small')}</option>
          <option value="3">{t('عادي', 'Normal')}</option>
          <option value="5">{t('كبير', 'Large')}</option>
          <option value="6">{t('كبير جدًا', 'X-Large')}</option>
        </select>
        <span className="w-px h-5 bg-[var(--hw-border)] mx-1 shrink-0" />
        <button type="button" onMouseDown={e => md(e, 'justifyRight')} className={tbtn} title={t('محاذاة يمين', 'Align right')}><IcAlignR /></button>
        <button type="button" onMouseDown={e => md(e, 'justifyCenter')} className={tbtn} title={t('توسيط', 'Center')}><IcAlignC /></button>
        <button type="button" onMouseDown={e => md(e, 'justifyLeft')} className={tbtn} title={t('محاذاة يسار', 'Align left')}><IcAlignL /></button>
        <span className="w-px h-5 bg-[var(--hw-border)] mx-1 shrink-0" />
        <button type="button" onMouseDown={e => md(e, 'insertUnorderedList')} className={tbtn} title={t('قائمة نقطية', 'Bullet list')}><IcUl /></button>
        <button type="button" onMouseDown={e => md(e, 'insertOrderedList')} className={tbtn} title={t('قائمة مرقّمة', 'Numbered list')}><IcOl /></button>
        <button type="button" onMouseDown={e => md(e, 'removeFormat')} className={tbtn} title={t('مسح التنسيق', 'Clear formatting')}><IcClear /></button>
        <span className="w-px h-5 bg-[var(--hw-border)] mx-1 shrink-0" />
        <button type="button" onMouseDown={e => { e.preventDefault(); setCoverOpen(true); }}
          className="flex items-center gap-1 px-2.5 h-8 rounded-lg text-xs font-medium border border-[var(--hw-border)] text-slate-600 dark:text-slate-300 hover:text-[var(--hw-brand,#11a8bc)] hover:border-[var(--hw-brand,#11a8bc)]/40 transition-colors shrink-0"
          title={t('المظهر', 'Appearance')}>
          <IcPalette /> {t('المظهر', 'Appearance')}
        </button>
      </div>

      {/* The document — isolated iframe, edits in place, IS what we export */}
      <div className="flex-1 overflow-hidden bg-[#eceef1] dark:bg-[#0a121a]">
        {loading || docHtml === null ? (
          <div className="flex h-full items-center justify-center gap-2.5 text-slate-500 dark:text-slate-400 text-sm">
            <span className="dc-spark text-[var(--hw-brand,#11a8bc)]"><IcSpin /></span>
            {t('جارٍ تجهيز المستند…', 'Preparing the document…')}
          </div>
        ) : (
          <iframe ref={iframeRef} title={docTitle} srcDoc={docHtml} onLoad={handleIframeLoad}
            className="h-full w-full border-0 bg-white" />
        )}
      </div>

      {/* Floating "Ask AI" over a text selection */}
      {askSel && onAskAi && (
        <button type="button" onMouseDown={e => e.preventDefault()}
          onClick={() => { onAskAi(askSel.text); setAskSel(null); }}
          style={{ top: askSel.top, left: askSel.left }}
          className="fixed z-[10001] flex items-center gap-1.5 rounded-lg bg-[var(--hw-brand,#11a8bc)] px-3 py-1.5 text-xs font-semibold text-white shadow-lg transition hover:brightness-105">
          <IcSpark /> {t('اسأل الكوبايلوت', 'Ask copilot')}
        </button>
      )}

      {/* Appearance modal — cover gradient/color/image/pattern + page bg */}
      {coverOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4 dc-fade" onClick={() => setCoverOpen(false)}>
          <div className="w-[440px] max-w-full rounded-2xl bg-white dark:bg-slate-800 p-5 shadow-2xl dc-pop" onClick={e => e.stopPropagation()} dir={ar ? 'rtl' : 'ltr'}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">{t('المظهر', 'Appearance')}</h3>
              <button type="button" onClick={() => setCoverOpen(false)} className="gc-icon-btn"><IcClose /></button>
            </div>

            <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-400">{t('خلفية الغلاف', 'Cover background')}</div>
            <div className="mb-4 flex flex-wrap gap-2">
              {COVER_GRADIENTS.map(g => (
                <button key={g.name} type="button" onClick={() => setCoverBg(g.css)} title={g.name}
                  className="h-9 w-9 rounded-lg border-2 border-white shadow-sm transition hover:scale-110 dark:border-slate-700" style={{ background: g.css }} />
              ))}
              <label className="relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-slate-300 dark:border-slate-600" title={t('لون مخصّص', 'Custom color')}>
                <input type="color" defaultValue="#11a8bc" onChange={e => setCoverBg(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
                <IcPalette />
              </label>
              <label className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-xs text-slate-600 hover:text-[var(--hw-brand,#11a8bc)] dark:border-slate-600 dark:text-slate-300" title={t('رفع صورة', 'Upload image')}>
                {t('صورة', 'Image')}
                <input type="file" accept="image/*" onChange={onCoverImage} className="hidden" />
              </label>
            </div>

            <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-400">{t('نقش الغلاف', 'Cover pattern')}</div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {COVER_PATTERNS.map(p => (
                <button key={p.key} type="button" onClick={() => setCoverPattern(p.css)}
                  className="h-8 rounded-lg border border-slate-300 px-2.5 text-xs text-slate-600 transition hover:border-[var(--hw-brand,#11a8bc)] hover:text-[var(--hw-brand,#11a8bc)] dark:border-slate-600 dark:text-slate-300">
                  {t(p.label, p.labelEn)}
                </button>
              ))}
            </div>

            <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-400">{t('خلفية الصفحات', 'Pages background')}</div>
            <div className="flex flex-wrap items-center gap-2">
              {PAGE_COLORS.map(c => (
                <button key={c} type="button" onClick={() => setPageBg(c)} title={c}
                  className="h-8 w-8 rounded-lg border border-slate-300 shadow-sm transition hover:scale-110 dark:border-slate-600" style={{ background: c }} />
              ))}
              <span className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-600" />
              {PAGE_PATTERNS.map(p => (
                <button key={p.key} type="button" onClick={() => setPageBg(p.css)}
                  className="h-8 rounded-lg border border-slate-300 px-2.5 text-xs text-slate-600 transition hover:border-[var(--hw-brand,#11a8bc)] hover:text-[var(--hw-brand,#11a8bc)] dark:border-slate-600 dark:text-slate-300">
                  {t(p.label, p.labelEn)}
                </button>
              ))}
            </div>

            <p className="mt-4 text-[11px] text-slate-400">{t('يُطبَّق التغيير فوراً. أغلِق لمتابعة التحرير.', 'Changes apply immediately. Close to keep editing.')}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default DocumentCanvas;
