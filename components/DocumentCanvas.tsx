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
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Language, GovComment, GovCommentAnchor } from '../types';
import BackButton from './BackButton';
import { mermaidToSvg, makeSvgResponsive, diagramFallbackHtml } from '../services/diagramService';
import {
  buildCanvasHtml, extractDocSpec, markdownToDocSpec, canvasHtmlToMarkdown,
  type DocSpec, type DocBlock, type MdToSpecOptions,
} from '../services/canvasDocument';
import { exportMessageDocx, exportMessageXlsx } from '../services/exportService';
import { exportMessagePptx } from '../services/pptxExport';
import { rewriteSelection, type SmartEditAction } from '../services/governanceChat';
import { anchorFromSelection, highlightComments, scrollToComment, type AnchoredComment } from '../services/commentAnchor';
import DiagramChatEditor from './DiagramChatEditor';

// A Mermaid diagram queued for PROGRESSIVE rendering (PRD V2/V3): the document
// text shows within a beat, then each diagram fills into its placeholder.
export interface PendingDiagram { id: string; code: string; }

// Placeholder figure shown until a diagram finishes rendering — keeps the page
// layout stable and tells the reader a diagram is on the way (never a blank gap).
// D1 — the placeholder stamps its own Mermaid source (data-mermaid-code) at
// CREATION time, not only after a successful render: any snapshot serialized
// WHILE this is still on screen (an export/save/share that races the injection)
// still carries the source, so canvasHtmlToMarkdown's figureToMd can recover the
// diagram for Word/PPTX/Excel, and a reopened/reshared snapshot can be healed
// (re-queued for render) instead of showing a permanently stuck placeholder.
function pendingPlaceholder(id: string, label: string, code: string): string {
  const stamped = encodeURIComponent(code);
  return `<div class="dgm-host" id="${id}" data-dgm-pending="1" data-mermaid-code="${stamped}" style="width:100%;min-height:88px;`
    + `display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12.5px">${label}…</div>`;
}

// D1 — pure gating check (no DOM, unit-testable): does this document HTML/DOM
// snapshot currently carry an unresolved diagram placeholder? Export/save/share
// must wait until this is false, or a placeholder — never the diagram itself —
// can get baked into a PDF/DOCX/share snapshot while Mermaid is still injecting.
export function hasPendingDiagrams(html: string): boolean {
  return /\bdata-dgm-pending\s*=\s*"1"/i.test(html || '');
}

// ── prepare: markdown/spec → canvas HTML, Mermaid swapped for placeholders ──
// We DON'T block first paint on Mermaid (it's the slow part and a single bad/
// huge diagram used to hang the whole canvas → "nothing shows / ~15 min"). The
// document renders immediately with placeholder figures; the diagrams are then
// rendered and injected progressively after the iframe loads.
export function prepareCanvasDoc(markdown: string, opts: MdToSpecOptions): { html: string; pending: PendingDiagram[] } {
  const spec: DocSpec = extractDocSpec(markdown, opts) || markdownToDocSpec(markdown, opts);
  const pending: PendingDiagram[] = [];
  const label = opts.lang === 'en' ? 'Rendering diagram' : 'جارٍ رسم المخطط';
  placeholderMermaid(spec.blocks, pending, label);
  return { html: buildCanvasHtml(spec), pending };
}

function placeholderMermaid(blocks: DocBlock[], pending: PendingDiagram[], label: string): void {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'mermaid') {
      const id = `dgm-${pending.length}`;
      pending.push({ id, code: b.code });
      blocks[i] = { type: 'figure', svg: pendingPlaceholder(id, label, b.code), alt: 'diagram' };
    } else if (b.type === 'columns') {
      // recurse into column children, writing the swapped block back into place
      if (b.left) { const k = [b.left]; placeholderMermaid(k, pending, label); b.left = k[0]; }
      if (b.right) { const k = [b.right]; placeholderMermaid(k, pending, label); b.right = k[0]; }
    }
  }
}

// D3 — the in-place "edit this diagram" affordance rendered INSIDE each resolved
// diagram host. It's plain injected markup (not React — the host document is a
// srcDoc iframe), a hover-revealed button; the click is caught by ONE delegated
// listener in handleIframeLoad (elements inside the iframe don't bubble to the
// parent document, so the listener lives on the iframe's own `doc`). Stripped
// again in liveHtml() before any export/save/share serialize (see there).
function diagramEditAffordanceHtml(lang: 'ar' | 'en'): string {
  const label = lang === 'en' ? 'Edit diagram' : 'تعديل المخطط';
  return `<button type="button" class="dgm-edit-btn" data-dgm-edit="1" contenteditable="false" `
    + `title="${label}" aria-label="${label}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>`;
}

// (Re)attach the affordance to every already-resolved diagram host that doesn't
// have one yet. Covers three cases with one idempotent scan: a fresh diagram that
// just finished rendering, the D1 healing pass, and a REOPENED saved/shared
// snapshot (the affordance never rides into a persisted snapshot — see
// liveHtml() — so it must be re-added on load).
function attachDiagramAffordances(doc: Document, lang: 'ar' | 'en'): void {
  doc.querySelectorAll<HTMLElement>('.dgm-host[data-mermaid-code]:not([data-dgm-pending])').forEach(host => {
    if (!host.querySelector(':scope > .dgm-edit-btn')) {
      host.insertAdjacentHTML('beforeend', diagramEditAffordanceHtml(lang));
    }
  });
}

// D3 — pure string transform (no DOM, unit-testable): remove the in-place "edit
// diagram" affordance from a serialized document. liveHtml() runs this before
// every export/save/share so the editing chrome never rides into a PDF, a
// DOCX/PPTX/XLSX (via canvasHtmlToMarkdown), or a persisted/shared HTML snapshot.
export function stripDiagramEditAffordance(html: string): string {
  return (html || '').replace(/<button\b[^>]*\bdata-dgm-edit="1"[^>]*>[\s\S]*?<\/button\s*>/gi, '');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('diagram render timeout')), ms);
    p.then(v => { clearTimeout(id); resolve(v); }, e => { clearTimeout(id); reject(e); });
  });
}

// Render each queued diagram to full-width SVG and inject it into its placeholder
// inside the (same-origin) canvas iframe. Sequential so the heavy Mermaid renders
// yield to the event loop between diagrams (the tab stays responsive on large
// docs). A diagram that fails to compile or times out shows a labelled fallback
// with its source (PRD V3) — never an empty gap. `alive()` aborts the run when
// the document is rebuilt or closed.
async function renderPendingDiagrams(
  doc: Document, pending: PendingDiagram[], lang: 'ar' | 'en', alive: () => boolean,
): Promise<void> {
  for (const p of pending) {
    if (!alive()) return;
    if (!doc.getElementById(p.id)) continue;
    let inner: string;
    try {
      inner = makeSvgResponsive(await withTimeout(mermaidToSvg(p.code), 9000));
    } catch {
      inner = diagramFallbackHtml(p.code, lang);
    }
    if (!alive()) return;
    const target = doc.getElementById(p.id);
    if (!target) continue;
    target.innerHTML = inner;
    target.removeAttribute('data-dgm-pending');
    // FE-3/D1: re-stamp the source (already present since creation — see
    // pendingPlaceholder — but kept idempotent here too) so canvasHtmlToMarkdown
    // can re-emit a ```mermaid block for the Word/PPTX/Excel exporters.
    try { target.setAttribute('data-mermaid-code', encodeURIComponent(p.code)); } catch { /* noop */ }
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
const IcWarn = () => <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;
const IcRetry = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>;
// ── smart-edit toolbar icons (V11) ──
const IcShorten = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M4 12h10M4 17h7" /></svg>;
const IcLengthen = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 10h16M4 14h16M4 18h12" /></svg>;
const IcRewrite = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
const IcTrash = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>;
// ── share popover icons (V14) ──
const IcShare = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98" /></svg>;
const IcCopy = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
// ── inline comments icons (V21) ──
const IcComment = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
const IcCheckDone = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>;

// Highlight CSS injected into the canvas iframe for the anchored comment spans.
const COMMENT_HL_CSS =
  'mark.cmt-hl{background:#fde68a;color:inherit;border-radius:2px;padding:0 1px;box-shadow:inset 0 -2px 0 rgba(245,158,11,.45)}'
  + 'mark.cmt-hl-done{background:#bbf7d0;box-shadow:inset 0 -2px 0 rgba(22,163,74,.45)}'
  + 'mark.cmt-flash{animation:dccmtflash 1.1s ease}'
  + '@keyframes dccmtflash{0%{filter:brightness(1.12)}40%{filter:brightness(1.4)}100%{filter:brightness(1)}}';

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
  readOnly?: boolean;                   // V14 client share view — view + export, no editing
  onClose?: () => void;                 // optional: hidden when absent (e.g. standalone share page)
  onSave?: (html: string) => void;      // persist the edited HTML
  onAskAi?: (selectedText: string) => void;
  // V14/V20 — mint a /?doc= share from the LIVE canvas HTML. When provided, a
  // "Share" button opens a popover (optional access code + view-only) and the
  // host persists the snapshot, returning the ready-to-send URL.
  onShare?: (html: string, opts: { accessCode?: string; allowComments: boolean }) => Promise<{ url: string }>;
  // V21 — anchored review comments left by the client (via the /?doc= client
  // share). When supplied, the canvas highlights them in the iframe body and shows
  // a comments panel; `onApplyComments` AI-applies the open comments into a new
  // version.
  comments?: GovComment[];
  onApplyComments?: () => void | Promise<void>;
  commentsOpenByDefault?: boolean;
  // V31 — inline "select text → add a comment" on BOTH surfaces (the owner canvas
  // and the read-only client share). When provided, selecting text in the document
  // shows an «أضف تعليقاً» control; submitting hands the anchored text back so the
  // host persists it (owner → gov_document comment · client → doc_comments). Works
  // in readOnly (client) mode too, independently of the owner's smart-edit toolbar.
  onAddComment?: (input: { anchor: GovCommentAnchor; text: string }) => void | Promise<void>;
  // V31 — highlight-only anchors (e.g. the client's own inline comments) painted in
  // the iframe body without opening the owner comments panel. Merged with `comments`
  // in the highlight pass; scroll to one via the imperative `scrollToComment` handle.
  highlightAnchors?: AnchoredComment[];
}

// V31 — imperative handle so a host that renders its own comment list OUTSIDE the
// canvas (the client share drawer) can scroll the iframe to a highlighted span.
export interface DocumentCanvasHandle {
  scrollToComment: (id: string) => void;
}

const DocumentCanvas = React.forwardRef<DocumentCanvasHandle, DocumentCanvasProps>(function DocumentCanvas({
  markdown, initialHtml, title, subtitle, date, brand, language,
  rootClass = 'fixed inset-0 z-[60]', readOnly = false, onClose, onSave, onAskAi, onShare,
  comments = [], onApplyComments, commentsOpenByDefault = false,
  onAddComment, highlightAnchors,
}, ref) {
  const ar = (language || 'ar') === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [docHtml, setDocHtml] = useState<string | null>(initialHtml || null);
  const [loading, setLoading] = useState(!initialHtml);
  const [error, setError] = useState(false);                           // render failed → explicit retry (never an endless spinner)
  const [reloadKey, setReloadKey] = useState(0);                       // bump to rebuild on "Retry"
  const pendingRef = useRef<PendingDiagram[]>([]);                     // diagrams to inject after the iframe loads
  const renderRunRef = useRef(0);                                      // cancels an in-flight diagram render pass
  const [coverOpen, setCoverOpen] = useState(false);
  const [askSel, setAskSel] = useState<{ text: string; top: number; left: number } | null>(null);
  const [smartBusy, setSmartBusy] = useState<SmartEditAction | ''>('');   // V11: which AI rewrite is running
  const [saved, setSaved] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);                     // export-format menu
  const [exporting, setExporting] = useState<'docx' | 'pptx' | 'xlsx' | ''>('');
  // V14 share popover (only when onShare is provided)
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareCode, setShareCode] = useState('');
  const [shareAllowComments, setShareAllowComments] = useState(true);
  const [shareUrl, setShareUrl] = useState('');
  const [shareErr, setShareErr] = useState('');
  const [shareCopied, setShareCopied] = useState(false);
  // V21 inline-comments panel + AI-apply.
  const [panelOpen, setPanelOpen] = useState(commentsOpenByDefault);
  const [applyBusy, setApplyBusy] = useState(false);
  // Read the latest comments from inside the (deps-stable) iframe-load callback.
  const commentsRef = useRef<GovComment[]>(comments);
  commentsRef.current = comments;
  const openCount = comments.filter(c => c.status !== 'implemented').length;
  const doneCount = comments.length - openCount;
  // V31 inline "select → comment": the floating «أضف تعليقاً» button anchored to the
  // client's selection, the composer popover, and its draft/state. onAddComment +
  // highlightAnchors are read via refs from the deps-stable iframe-load listeners.
  const [commentBtn, setCommentBtn] = useState<{ top: number; left: number } | null>(null);
  const [commentComposer, setCommentComposer] = useState<{ anchor: GovCommentAnchor; top: number; left: number } | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentErr, setCommentErr] = useState('');
  const onAddCommentRef = useRef(onAddComment);
  onAddCommentRef.current = onAddComment;
  const highlightAnchorsRef = useRef<AnchoredComment[] | undefined>(highlightAnchors);
  highlightAnchorsRef.current = highlightAnchors;
  const composerOpenRef = useRef(false);
  composerOpenRef.current = !!commentComposer;
  // D1 — a brief bilingual notice shown ONLY when export/save/share actually had
  // to wait on an in-flight diagram render (waitForDiagrams below); near-instant
  // waits never flash it.
  const [diagramsWaitNotice, setDiagramsWaitNotice] = useState(false);
  // D3 — in-place diagram regenerate / natural-language edit. The hover/click
  // affordance itself lives INSIDE the iframe (diagramEditAffordanceHtml, native
  // CSS :hover — no cross-frame hover tracking needed); a single delegated click
  // listener in handleIframeLoad reads the clicked diagram's id + stamped source
  // and opens this PARENT overlay panel to edit it.
  const [dgmEditor, setDgmEditor] = useState<{ id: string; code: string } | null>(null);
  const [dgmRegenBusy, setDgmRegenBusy] = useState(false);
  const [dgmSaving, setDgmSaving] = useState(false);

  const docTitle = useMemo(
    () => (title || (markdown.match(/^#{1,2}\s+(.+)$/m)?.[1] || t('وثيقة', 'Document'))).slice(0, 80).trim(),
    [title, markdown, ar],
  );

  // Build the canvas HTML (markdown/spec → paginated doc). Mermaid is NOT pre-
  // rendered here — diagrams inject progressively after load (see handleIframeLoad)
  // so the document shows within a beat and a heavy diagram can't blank the canvas.
  useEffect(() => {
    if (initialHtml) { setDocHtml(initialHtml); setLoading(false); setError(false); pendingRef.current = []; return; }
    let alive = true;
    setLoading(true); setError(false); setDocHtml(null);
    // Watchdog: never allow an indefinite blank/spinner (PRD V2). If preparing the
    // document hasn't settled, surface an explicit error + Retry instead.
    const watchdog = window.setTimeout(() => { if (alive) { setError(true); setLoading(false); } }, 15000);
    // Defer one microtask so a huge synchronous parse doesn't block the spinner paint.
    Promise.resolve().then(() => {
      if (!alive) return;
      try {
        const { html, pending } = prepareCanvasDoc(markdown, {
          title, subtitle: subtitle || t('وثيقة حوكمة', 'Governance document'),
          lang: ar ? 'ar' : 'en', date, brand,
        });
        if (!alive) return;
        pendingRef.current = pending;
        setDocHtml(html);
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        console.warn('[canvas] failed to prepare document', e);
        setError(true);
        setLoading(false);
      } finally {
        window.clearTimeout(watchdog);
      }
    });
    return () => { alive = false; window.clearTimeout(watchdog); renderRunRef.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, initialHtml, reloadKey]);

  // V21 — highlight the client's anchored review comments inside the iframe body
  // (the iframe is a non-React srcDoc, so it's safe to mutate directly). Reads the
  // latest comments via the ref so it stays correct from the deps-stable load
  // callback below; a separate effect re-runs it when the comments prop changes.
  const applyCommentHighlights = useCallback((doc: Document | null | undefined) => {
    if (!doc?.body) return;
    if (!doc.getElementById('dc-comment-hl')) {
      const st = doc.createElement('style');
      st.id = 'dc-comment-hl';
      st.textContent = COMMENT_HL_CSS;
      (doc.head || doc.documentElement).appendChild(st);
    }
    // Merge the owner's anchored review comments with any highlight-only anchors
    // (the client's own inline comments), then repaint in one idempotent pass.
    const anchored: AnchoredComment[] = [
      ...(commentsRef.current || []).filter(c => c.anchor),
      ...(highlightAnchorsRef.current || []),
    ];
    try { highlightComments(doc.body, anchored); } catch { /* noop */ }
  }, []);

  // D3 — open the parent overlay panel for a clicked diagram, reading its CURRENT
  // stamped Mermaid source straight off the host (always present since D1 stamps
  // it at placeholder creation and every render pass keeps it in sync).
  const openDiagramEditor = useCallback((id: string) => {
    const doc = iframeRef.current?.contentDocument;
    const host = doc?.getElementById(id);
    if (!host) return;
    let code = '';
    try { code = decodeURIComponent(host.getAttribute('data-mermaid-code') || ''); } catch { /* noop */ }
    if (!code) return;
    setDgmEditor({ id, code });
  }, []);

  // Enable in-place editing once the iframe document is ready.
  const handleIframeLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    // V14 read-only share view: neutralize the contenteditable the document is
    // built with (cover/body/sections), keep designMode off, and skip the editing
    // listeners below — the client can view + export, never edit.
    if (readOnly) {
      try { doc.designMode = 'off'; } catch { /* noop */ }
      doc.querySelectorAll('[contenteditable]').forEach(el => el.setAttribute('contenteditable', 'false'));
    } else {
      try { doc.designMode = 'on'; doc.execCommand('styleWithCSS', false, 'true'); } catch { /* noop */ }
    }

    // PRD V15: make embedded diagrams fill the page width (ratio preserved) in
    // BOTH the live canvas and the printed PDF — exportPdf serializes this same
    // DOM, so the injected rule rides along. Overrides the figure's default
    // inline-block sizing that left diagrams small + left-shifted.
    if (!doc.getElementById('dc-diagram-fullwidth')) {
      const st = doc.createElement('style');
      st.id = 'dc-diagram-fullwidth';
      st.textContent =
        '.fig .svgwrap{display:block!important;width:100%!important;max-width:100%!important;overflow:auto;}'
        + '.fig .svgwrap svg{display:block!important;width:100%!important;height:auto!important;max-width:100%!important;max-height:620px;margin-inline:auto;}'
        + '.fig .svgwrap .dgm-host,.fig .svgwrap .dgm-fallback{width:100%;}'
        + '@media print{.fig .svgwrap{overflow:visible}.fig .svgwrap svg,.fig svg{width:100%!important;height:auto!important;max-width:100%!important;max-height:250mm!important;}}'
        // D3 — hover-revealed "edit diagram" affordance (native CSS :hover, no JS
        // needed to show/hide it); never printed/exported (belt-and-suspenders —
        // liveHtml() also strips the markup before any serialize).
        + '.dgm-host{position:relative}'
        + '.dgm-edit-btn{position:absolute;top:8px;inset-inline-end:8px;width:28px;height:28px;padding:0;border:none;'
        + 'border-radius:8px;background:rgba(17,168,188,.94);color:#fff;display:flex;align-items:center;justify-content:center;'
        + 'opacity:0;transform:translateY(-2px);transition:opacity .15s,transform .15s;cursor:pointer;z-index:4;}'
        + '.dgm-host:hover .dgm-edit-btn,.dgm-edit-btn:focus-visible{opacity:1;transform:translateY(0)}'
        + '@media print{.dgm-edit-btn{display:none!important}}';
      (doc.head || doc.documentElement).appendChild(st);
    }

    // PRD V2/V3: render the queued diagrams progressively into their placeholders.
    // D1 — heal a stuck/reopened snapshot: when this load has no FRESH pending
    // queue (the initialHtml/reopen path never builds one — pendingRef stays []),
    // but the DOM still carries [data-dgm-pending] hosts that stamped their source
    // at creation, rescan and queue them too. Otherwise a placeholder saved mid-
    // render (an export/save/share that raced the injection) would stay stuck
    // forever — this is what actually resolves it on the next open.
    let pending = pendingRef.current;
    if (!pending.length) {
      const orphans: PendingDiagram[] = [];
      doc.querySelectorAll<HTMLElement>('[data-dgm-pending="1"][data-mermaid-code]').forEach((el: HTMLElement) => {
        let code = '';
        try { code = decodeURIComponent(el.getAttribute('data-mermaid-code') || ''); } catch { /* noop */ }
        if (el.id && code) orphans.push({ id: el.id, code });
      });
      if (orphans.length) pending = orphans;
    }
    const lang = ar ? 'ar' : 'en';
    if (pending.length) {
      const run = ++renderRunRef.current;
      const alive = () => run === renderRunRef.current && !!iframeRef.current;
      void renderPendingDiagrams(doc, pending, lang, alive).then(() => {
        // D3 — attach the edit affordance to every diagram this pass just resolved.
        if (alive() && !readOnly) attachDiagramAffordances(doc, lang);
      });
    }
    // D3 — attach the affordance to diagrams that are ALREADY resolved at load
    // time (a reopened saved/shared snapshot never carries the affordance markup
    // itself — see liveHtml() — so it must be re-added here on every load).
    if (!readOnly) attachDiagramAffordances(doc, lang);
    // V21: paint the anchored review-comment highlights (both modes).
    applyCommentHighlights(doc);

    // V31 — client (read-only) inline comments: the owner's smart-edit toolbar is
    // skipped in readOnly, so wire a dedicated selection→«أضف تعليقاً» button here.
    // (In the editable owner canvas the same action lives on the smart-edit bar.)
    if (readOnly && onAddCommentRef.current) {
      const updateCommentBtn = () => {
        if (composerOpenRef.current) return;                 // don't fight an open composer
        const win = doc.defaultView;
        const s = win?.getSelection?.();
        const text = s?.toString().trim() || '';
        const frame = iframeRef.current;
        if (!s || s.isCollapsed || !text || !frame) { setCommentBtn(null); return; }
        try {
          const r = s.getRangeAt(0).getBoundingClientRect();
          if (!r.width && !r.height) { setCommentBtn(null); return; }
          const f = frame.getBoundingClientRect();
          const left = Math.max(8, Math.min(f.left + r.left, window.innerWidth - 176));
          setCommentBtn({ top: f.top + r.bottom + 6, left });
        } catch { setCommentBtn(null); }
      };
      doc.addEventListener('mouseup', updateCommentBtn);
      doc.addEventListener('keyup', updateCommentBtn);
      doc.addEventListener('scroll', () => setCommentBtn(null), true);
    }

    if (readOnly) return;   // share view: no restyle / selection editing

    // D3 — one delegated listener catches every diagram's edit affordance (present
    // and future — a click on any [data-dgm-edit] button, however many render
    // passes injected it). Elements inside the iframe don't bubble to the PARENT
    // document, so this must live on the iframe's own `doc`, not on window/document.
    doc.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement)?.closest?.('[data-dgm-edit="1"]') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      const host = btn.closest('.dgm-host') as HTMLElement | null;
      if (host?.id) openDiagramEditor(host.id);
    });

    // Clicking the cover opens the restyle modal (instead of editing its text).
    const cover = doc.querySelector('.cover') as HTMLElement | null;
    if (cover) {
      cover.setAttribute('contenteditable', 'false');
      cover.style.cursor = 'pointer';
      cover.addEventListener('click', () => setCoverOpen(true));
    }
    // PRD V11: track the live selection so the floating smart-edit toolbar can
    // anchor to it. Runs regardless of onAskAi (the AI rewrites are independent;
    // the "Ask copilot" button inside the bar only appears when onAskAi is set).
    const updateAsk = () => {
      const win = doc.defaultView;
      const s = win?.getSelection();
      const text = s?.toString().trim() || '';
      const frame = iframeRef.current;
      if (!s || s.isCollapsed || !text || !frame) { setAskSel(null); return; }
      try {
        const r = s.getRangeAt(0).getBoundingClientRect();
        const f = frame.getBoundingClientRect();
        // Clamp X so the bar (≈380px) never runs off-screen on a narrow/docked canvas.
        const left = Math.max(8, Math.min(f.left + r.left, window.innerWidth - 388));
        setAskSel({ text, top: f.top + r.bottom + 6, left });
      } catch { setAskSel(null); }
    };
    doc.addEventListener('mouseup', updateAsk);
    doc.addEventListener('keyup', updateAsk);
    doc.addEventListener('scroll', () => setAskSel(null), true);
  }, [onAskAi, ar, readOnly, applyCommentHighlights, openDiagramEditor]);

  // Re-highlight when the comments (or client highlight-only anchors) change (e.g.
  // after an AI apply, or a new inline comment) without a full iframe reload.
  useEffect(() => {
    applyCommentHighlights(iframeRef.current?.contentDocument);
  }, [comments, highlightAnchors, applyCommentHighlights]);

  // AI-apply the open comments → a new version (host owns the version/history).
  const runApplyComments = useCallback(async () => {
    if (!onApplyComments || applyBusy) return;
    setApplyBusy(true);
    try { await onApplyComments(); } finally { setApplyBusy(false); }
  }, [onApplyComments, applyBusy]);

  // Scroll to (and flash) a comment's highlight inside the iframe.
  const focusComment = useCallback((id: string) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    const el = scrollToComment(doc.body, id);
    if (el) { el.classList.add('cmt-flash'); window.setTimeout(() => el.classList.remove('cmt-flash'), 1200); }
  }, []);

  // Expose an imperative scroll so a host with its own comment list outside the
  // canvas (the client share drawer) can jump the iframe to a highlighted span.
  useImperativeHandle(ref, () => ({ scrollToComment: (id: string) => focusComment(id) }), [focusComment]);

  // ── V31 inline "select → comment" ─────────────────────────────────────────
  // Capture an anchor from the LIVE iframe selection and open the composer. Runs
  // on mousedown (client button) / click (owner smart-edit bar) — both keep the
  // selection alive (preventDefault, resp. the bar's own onMouseDown guard).
  const openCommentComposer = useCallback((e?: React.MouseEvent) => {
    e?.preventDefault?.();
    const doc = iframeRef.current?.contentDocument;
    const body = doc?.body;
    if (!body) return;
    const sel = doc?.defaultView?.getSelection?.();
    let sectionId: string | undefined;
    const node = sel?.anchorNode || null;
    if (node) {
      const el = (node.nodeType === 1 ? node : node.parentElement) as Element | null;
      sectionId = el?.closest?.('[data-section-id]')?.getAttribute('data-section-id') || undefined;
    }
    const anchor = anchorFromSelection(body, sectionId);
    if (!anchor) { setCommentBtn(null); return; }
    const src = commentBtn || askSel;
    const top = src?.top ?? 96;
    const left = Math.max(8, Math.min(src?.left ?? 16, window.innerWidth - 316));
    setCommentComposer({ anchor, top, left });
    setCommentBtn(null);
    setAskSel(null);
    setCommentErr('');
    setCommentDraft('');
  }, [commentBtn, askSel]);

  const cancelCommentComposer = useCallback(() => { setCommentComposer(null); setCommentDraft(''); setCommentErr(''); }, []);

  const submitInlineComment = useCallback(async () => {
    const text = commentDraft.trim();
    if (!text || !commentComposer || commentBusy) return;
    setCommentBusy(true); setCommentErr('');
    try {
      await onAddCommentRef.current?.({ anchor: commentComposer.anchor, text });
      setCommentComposer(null);
      setCommentDraft('');
    } catch {
      setCommentErr(t('تعذّر إرسال التعليق. حاول مرة أخرى.', 'Could not send the comment. Please try again.'));
    } finally {
      setCommentBusy(false);
    }
  }, [commentDraft, commentComposer, commentBusy, ar]);

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
    // D3 — the in-place "edit diagram" affordance (button + its stylesheet) is a
    // live-canvas-only overlay, injected straight into the DOM for reliable native
    // :hover + same-document click handling. Strip it here so it never rides into
    // an export/save/share snapshot — every one of those paths serializes through
    // this function. attachDiagramAffordances() re-adds it on the next load.
    html = stripDiagramEditAffordance(html);
    // Reinforce color printing + strip the screen card chrome. Pagination is owned
    // by the document's own @media print rules (per-section pages, atomic blocks
    // never split) so the PDF matches the canvas — do NOT override break-* here.
    const fix = '<style id="pdf-export-fix">*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}'
      + '@media print{html,body{background:#fff!important}.page{box-shadow:none!important;margin:0!important;border-radius:0!important;background:#fff!important}}</style>';
    if (!html.includes('pdf-export-fix')) html = html.replace('</head>', `${fix}</head>`);
    return html;
  }, [docHtml]);

  // D1 — wait until no diagram placeholder is left unresolved in the live iframe
  // (every diagram either rendered or fell back to its labelled source —
  // renderPendingDiagrams always clears [data-dgm-pending] either way), so a
  // still-injecting diagram can never get baked into a PDF/DOCX/share snapshot.
  // Bounded (12s) so a stuck/aborted render pass can never hang export forever;
  // shows a brief bilingual notice ONLY if the wait is actually noticeable.
  const waitForDiagrams = useCallback(async (): Promise<void> => {
    const readNow = () => hasPendingDiagrams(iframeRef.current?.contentDocument?.documentElement?.outerHTML || '');
    if (!readNow()) return;
    const noticeTimer = window.setTimeout(() => setDiagramsWaitNotice(true), 150);
    try {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && readNow()) {
        await new Promise(resolve => window.setTimeout(resolve, 120));
      }
    } finally {
      window.clearTimeout(noticeTimer);
      setDiagramsWaitNotice(false);
    }
  }, []);

  // Export PDF: print the live document HTML in a dedicated hidden iframe. The
  // browser's own print engine shapes Arabic correctly and renders the woff2
  // brand font + colored backgrounds (print-color-adjust:exact) — a real,
  // selectable, vector PDF via "Save as PDF".
  const exportPdf = useCallback(async () => {
    await waitForDiagrams();   // D1 — never print a still-pending placeholder box
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
  }, [liveHtml, waitForDiagrams]);

  // WYSIWYG export (PRD V12): Word / PowerPoint / Excel are built from the LIVE
  // edited canvas — we serialize its HTML back to Markdown and feed the shared
  // exporters, so every format matches what the user sees (PDF prints the HTML
  // directly above). The DOCX font stays Almarai for reliable Word Arabic shaping;
  // the canvas + PDF carry the Thmanyah brand font (V13).
  const doExport = useCallback(async (kind: 'pdf' | 'docx' | 'pptx' | 'xlsx') => {
    setMenuOpen(false);
    if (kind === 'pdf') { await exportPdf(); return; }
    setExporting(kind);
    try {
      await waitForDiagrams();   // D1 — never export a still-pending placeholder box
      const md = canvasHtmlToMarkdown(liveHtml());
      const company = (brand || '').split(/[·|]/)[0].trim() || undefined;
      if (kind === 'docx') await exportMessageDocx(md, docTitle, { language, companyName: company });
      else if (kind === 'pptx') await exportMessagePptx(md, docTitle, { companyName: company });
      else exportMessageXlsx(md, docTitle);
    } catch (e) {
      console.warn('[canvas export] failed', e);
    } finally {
      setExporting('');
    }
  }, [liveHtml, exportPdf, waitForDiagrams, brand, docTitle, language]);

  // ── V11: floating smart-edit toolbar — act on the live selection IN PLACE ──
  // The edits land in the same designMode document the canvas exports, and we
  // persist them through the existing save path so they survive reload + flow
  // into every export (ties to V12/V14). D1 — waits for any in-flight diagram
  // render first, so an auto-save mid-edit can never bake in a pending placeholder.
  const persist = useCallback(async () => {
    const save = onSave;
    if (!save) return;
    await waitForDiagrams();
    save(liveHtml());
  }, [onSave, liveHtml, waitForDiagrams]);

  // D3 — shared by "إعادة توليد" (regenerate, same code) and the NL editor's save
  // (new code): re-render the diagram's SVG through the SAME repair pipeline every
  // Mermaid render goes through (mermaidToSvg → prepareMermaidForRender), swap it
  // into its host in place, re-stamp the source, re-add the edit affordance, and
  // persist via the existing save path.
  const applyDiagramCode = useCallback(async (id: string, code: string): Promise<void> => {
    const doc = iframeRef.current?.contentDocument;
    const host = doc?.getElementById(id);
    if (!doc || !host) return;
    let inner: string;
    try {
      inner = makeSvgResponsive(await withTimeout(mermaidToSvg(code), 9000));
    } catch {
      inner = diagramFallbackHtml(code, ar ? 'ar' : 'en');
    }
    host.innerHTML = inner;
    host.removeAttribute('data-dgm-pending');
    try { host.setAttribute('data-mermaid-code', encodeURIComponent(code)); } catch { /* noop */ }
    attachDiagramAffordances(doc, ar ? 'ar' : 'en');
    await persist();
  }, [ar, persist]);

  // «إعادة توليد» — re-attempt the CURRENT diagram's render (recovers a transient
  // failure/timeout, or simply refreshes it) without changing its source.
  const regenerateDiagram = useCallback(async () => {
    if (!dgmEditor || dgmRegenBusy) return;
    setDgmRegenBusy(true);
    try { await applyDiagramCode(dgmEditor.id, dgmEditor.code); }
    finally { setDgmRegenBusy(false); }
  }, [dgmEditor, dgmRegenBusy, applyDiagramCode]);

  // DiagramChatEditor's onSave — a natural-language edit ("ضيف رئيس تنفيذي فوق")
  // produced a NEW, already-validated Mermaid string; render + swap it in place.
  const handleDiagramEditorSave = useCallback(async (nextCode: string) => {
    if (!dgmEditor) return;
    setDgmSaving(true);
    try {
      await applyDiagramCode(dgmEditor.id, nextCode);
      setDgmEditor(prev => (prev && prev.id === dgmEditor.id ? { ...prev, code: nextCode } : prev));
    } finally {
      setDgmSaving(false);
    }
  }, [dgmEditor, applyDiagramCode]);

  // Replace the selected range with plain text, preferring execCommand so the
  // change joins designMode's own undo stack; falls back to a manual DOM swap.
  const replaceSelection = useCallback((doc: Document, win: Window, range: Range, text: string) => {
    try {
      const sel = win.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      win.focus();
      if (!doc.execCommand('insertText', false, text)) {
        range.deleteContents(); range.insertNode(doc.createTextNode(text));
      }
    } catch {
      try { range.deleteContents(); range.insertNode(doc.createTextNode(text)); } catch { /* noop */ }
    }
  }, []);

  const runSmartEdit = useCallback(async (action: SmartEditAction) => {
    const win = iframeRef.current?.contentWindow;
    const doc = iframeRef.current?.contentDocument;
    const sel = win?.getSelection?.();
    if (!win || !doc || !sel || sel.rangeCount === 0 || sel.isCollapsed || smartBusy) return;
    const text = sel.toString().trim();
    if (!text) return;
    const range = sel.getRangeAt(0).cloneRange();   // captured now (mousedown kept the selection)
    setSmartBusy(action);
    try {
      const out = await rewriteSelection({ text, action, language });
      if (out && out.trim()) { replaceSelection(doc, win, range, out.trim()); persist(); }
    } catch (e) {
      console.warn('[smart-edit] rewrite failed', e);   // leave the selection untouched on failure
    } finally {
      setSmartBusy('');
      setAskSel(null);
    }
  }, [language, smartBusy, persist, replaceSelection]);

  const deleteSelection = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    const doc = iframeRef.current?.contentDocument;
    const sel = win?.getSelection?.();
    if (!win || !doc || !sel || sel.isCollapsed) return;
    win.focus();
    try { doc.execCommand('delete'); } catch { /* noop */ }
    persist();
    setAskSel(null);
  }, [persist]);

  // Relative font sizing on the selection ("shrink/enlarge font"): tag the
  // selection with a throwaway fontSize, then convert the wrapped runs to an
  // explicit px that steps from their current computed size — true increments.
  const stepFont = useCallback((dir: 1 | -1) => {
    const win = iframeRef.current?.contentWindow;
    const doc = iframeRef.current?.contentDocument;
    const sel = win?.getSelection?.();
    if (!win || !doc || !sel || sel.isCollapsed) return;
    win.focus();
    try {
      // Force the presentational <font size="7"> marker (the canvas runs with
      // styleWithCSS on, which would otherwise emit a CSS span we can't target),
      // then convert each wrapped run to an explicit px stepped from its size.
      doc.execCommand('styleWithCSS', false, 'false');
      doc.execCommand('fontSize', false, '7');
      doc.execCommand('styleWithCSS', false, 'true');
      doc.querySelectorAll('font[size="7"]').forEach(el => {
        const f = el as HTMLElement;
        f.removeAttribute('size');
        const cur = parseFloat(win.getComputedStyle(f).fontSize) || 16;
        const next = Math.max(9, Math.min(48, Math.round(cur + dir * 2)));
        f.style.fontSize = `${next}px`;
      });
    } catch { /* noop */ }
    persist();
  }, [persist]);

  const handleSave = useCallback(async () => {
    const save = onSave;
    if (!save) return;
    await waitForDiagrams();   // D1 — never save a still-pending placeholder box
    save(liveHtml());
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }, [onSave, liveHtml, waitForDiagrams]);

  // V14 — mint a /?doc= share from the LIVE canvas HTML (the host persists the
  // snapshot and returns the URL). Surfaces SNAPSHOT_TOO_LARGE / failures inline.
  const runShare = useCallback(async () => {
    if (!onShare || shareBusy) return;
    setShareBusy(true); setShareErr(''); setShareUrl(''); setShareCopied(false);
    try {
      await waitForDiagrams();   // D1 — never share a still-pending placeholder box
      const { url } = await onShare(liveHtml(), {
        accessCode: shareCode.trim() || undefined,
        allowComments: shareAllowComments,
      });
      setShareUrl(url);
      try { await navigator.clipboard.writeText(url); setShareCopied(true); } catch { /* clipboard blocked — link still shown */ }
    } catch (e: unknown) {
      const code = String((e as Error)?.message || e);
      setShareErr(
        code.includes('SNAPSHOT_TOO_LARGE')
          ? t('المستند كبير جدًا للمشاركة المباشرة. صدّره كـ PDF بدلاً من ذلك.', 'Document is too large to share directly — export it as PDF instead.')
          : t('تعذّر إنشاء رابط المشاركة.', 'Could not create the share link.'),
      );
    } finally {
      setShareBusy(false);
    }
  }, [onShare, shareBusy, liveHtml, waitForDiagrams, shareCode, shareAllowComments, ar]);

  // Esc closes the canvas (when a close handler exists and no modal is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !coverOpen && !shareOpen && !dgmEditor) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, coverOpen, shareOpen, dgmEditor]);

  const tbtn = 'flex items-center justify-center w-8 h-8 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-[var(--hw-brand-50,#eef8fa)] hover:text-[var(--hw-brand,#11a8bc)] transition-colors shrink-0';
  const md = (e: React.MouseEvent, cmd: string, val?: string) => { e.preventDefault(); exec(cmd, val); };

  return (
    <div className={`dc-overlay ${rootClass} flex flex-col bg-white dark:bg-slate-900`} dir={ar ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-[var(--hw-border)] shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* V23 — a clear, labelled way back out of the full-screen canvas (the corner
              ✕ stays as the conventional overlay-close; this is the consistent رجوع). */}
          {onClose && (
            <BackButton onClick={onClose} ar={ar} titleLabel={t('إغلاق', 'Close')} />
          )}
          <span className="dc-spark text-[var(--hw-brand,#11a8bc)]"><IcSpark /></span>
          <div className="flex flex-col min-w-0">
            <span className="text-[14.5px] font-bold text-slate-900 dark:text-slate-100 truncate">{docTitle}</span>
            <span className="text-[11px] text-slate-400 leading-none">{readOnly ? t('مستند مُشارَك · للعرض والتصدير', 'Shared document · View & export') : t('مستند قابل للتحرير · الكانفس', 'Editable document · Canvas')}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {(comments.length > 0 || onApplyComments) && (
            <button type="button" onClick={() => setPanelOpen(o => !o)} aria-pressed={panelOpen}
              className={`hw-btn hw-btn-sm !rounded-full ${panelOpen ? 'hw-btn-primary' : 'hw-btn-subtle'}`}>
              <IcComment />{t('التعليقات', 'Comments')}{comments.length ? ` (${comments.length})` : ''}
            </button>
          )}
          {onSave && (
            <button type="button" onClick={handleSave} className="hw-btn hw-btn-subtle hw-btn-sm !rounded-full">
              {saved ? <span className="text-emerald-600">✓</span> : <IcSave />}{saved ? t('حُفظ', 'Saved') : t('حفظ', 'Save')}
            </button>
          )}
          {onShare && (
            <div className="relative">
              <button type="button" onClick={() => { setShareOpen(o => !o); setShareErr(''); }}
                aria-haspopup="dialog" aria-expanded={shareOpen} className="hw-btn hw-btn-subtle hw-btn-sm !rounded-full">
                <IcShare />{t('مشاركة', 'Share')}
              </button>
              {shareOpen && (
                <>
                  <div className="fixed inset-0 z-[10000]" onClick={() => setShareOpen(false)} aria-hidden="true" />
                  <div role="dialog" dir={ar ? 'rtl' : 'ltr'}
                    className="absolute z-[10001] mt-1.5 end-0 w-[300px] rounded-xl border border-[var(--hw-border)] bg-white dark:bg-slate-800 p-3.5 shadow-2xl dc-pop">
                    <div className="text-[13px] font-bold text-slate-800 dark:text-slate-100 mb-0.5">{t('مشاركة رابط للعميل', 'Share a client link')}</div>
                    <p className="text-[11px] text-slate-500 leading-relaxed mb-2.5">{t('رابط يفتح المستند للعرض والتعليق دون تسجيل دخول.', 'A link that opens the document for viewing and comments — no sign-in.')}</p>
                    <label className="flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300 mb-2 cursor-pointer">
                      <input type="checkbox" checked={shareAllowComments} onChange={e => setShareAllowComments(e.target.checked)} className="accent-[var(--hw-brand,#11a8bc)]" />
                      {t('السماح بالتعليقات', 'Allow comments')}
                    </label>
                    <input type="text" value={shareCode} onChange={e => setShareCode(e.target.value)}
                      placeholder={t('رمز دخول للمراجع (اختياري)', 'Reviewer access code (optional)')}
                      className="w-full text-[12px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 mb-2.5" />
                    <button type="button" onClick={runShare} disabled={shareBusy}
                      className="hw-btn hw-btn-primary hw-btn-sm !rounded-full w-full justify-center">
                      {shareBusy ? <IcSpin /> : <IcShare />}{t('إنشاء الرابط', 'Create link')}
                    </button>
                    {shareErr && <p className="text-[11px] text-rose-600 mt-2">{shareErr}</p>}
                    {shareUrl && (
                      <div className="mt-2.5">
                        <div className="flex items-center gap-1.5">
                          <input readOnly value={shareUrl} onFocus={e => e.currentTarget.select()}
                            className="flex-1 min-w-0 text-[11px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2 py-1.5 text-slate-600 dark:text-slate-300" />
                          <button type="button" title={t('نسخ', 'Copy')}
                            onClick={async () => { try { await navigator.clipboard.writeText(shareUrl); setShareCopied(true); } catch { /* noop */ } }}
                            className="gc-icon-btn shrink-0"><IcCopy /></button>
                        </div>
                        <p className="text-[11px] text-emerald-600 mt-1.5">{shareCopied ? t('نُسخ الرابط ✅', 'Link copied ✅') : t('الرابط جاهز.', 'Link ready.')}</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="relative">
            <button type="button" onClick={() => setMenuOpen(o => !o)} disabled={loading || !!exporting}
              aria-haspopup="menu" aria-expanded={menuOpen} className="hw-btn hw-btn-primary hw-btn-sm !rounded-full">
              {exporting ? <IcSpin /> : <IcDownload />}{t('تصدير', 'Export')}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" className={menuOpen ? 'rotate-180 transition-transform' : 'transition-transform'}><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-[10000]" onClick={() => setMenuOpen(false)} aria-hidden="true" />
                <div role="menu" dir={ar ? 'rtl' : 'ltr'}
                  className="absolute z-[10001] mt-1.5 end-0 min-w-[200px] rounded-xl border border-[var(--hw-border)] bg-white dark:bg-slate-800 p-1.5 shadow-2xl dc-pop">
                  {([
                    ['pdf', t('PDF — مطابق للكانفس', 'PDF — matches canvas')],
                    ['docx', t('Word (.docx)', 'Word (.docx)')],
                    ['pptx', t('PowerPoint (.pptx)', 'PowerPoint (.pptx)')],
                    ['xlsx', t('Excel (.xlsx)', 'Excel (.xlsx)')],
                  ] as const).map(([k, label]) => (
                    <button key={k} type="button" role="menuitem" onClick={() => doExport(k)}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-[var(--hw-brand-50,#eef8fa)] hover:text-[var(--hw-brand,#11a8bc)] transition-colors text-start">
                      {exporting === k ? <IcSpin /> : <IcDownload />}{label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {onClose && (
            <button type="button" onClick={onClose} title={t('إغلاق', 'Close')} aria-label={t('إغلاق', 'Close')} className="gc-icon-btn">
              <IcClose />
            </button>
          )}
        </div>
      </div>

      {/* Formatting toolbar (drives the iframe via execCommand) — hidden in the
          read-only client share view. */}
      {!readOnly && (
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
      )}

      {/* The document — isolated iframe, edits in place, IS what we export.
          State machine (PRD V2): loading → spinner; failure → explicit error +
          Retry; otherwise the iframe. NEVER an indefinite blank/spinner. */}
      <div className="flex-1 overflow-hidden bg-[#eceef1] dark:bg-[#0a121a]">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2.5 text-slate-500 dark:text-slate-400 text-sm">
            <span className="dc-spark text-[var(--hw-brand,#11a8bc)]"><IcSpin /></span>
            {t('جارٍ تجهيز المستند…', 'Preparing the document…')}
          </div>
        ) : (error || docHtml === null) ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-slate-500 dark:text-slate-400">
            <span className="text-amber-500"><IcWarn /></span>
            <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
              {t('تعذّر فتح المستند', 'Could not open the document')}
            </p>
            <button type="button" onClick={() => setReloadKey(k => k + 1)}
              className="hw-btn hw-btn-primary hw-btn-sm !rounded-full">
              <IcRetry /> {t('إعادة المحاولة', 'Retry')}
            </button>
          </div>
        ) : (
          <iframe ref={iframeRef} title={docTitle} srcDoc={docHtml} onLoad={handleIframeLoad}
            className="h-full w-full border-0 bg-white" />
        )}
      </div>

      {/* PRD V11 — floating smart-edit toolbar over a text selection. One-click AI
          actions (shorten / lengthen / improve / rewrite) edit the selection in
          place; font-size + delete are direct DOM edits; "Ask" hands the passage
          to the copilot. onMouseDown is prevented so the selection survives the
          click. */}
      {askSel && (
        <div role="toolbar" aria-label={t('تحرير ذكي', 'Smart edit')}
          onMouseDown={e => e.preventDefault()}
          style={{ top: askSel.top, left: askSel.left }}
          className="dc-smartbar fixed z-[10001] flex items-center gap-0.5 rounded-xl border border-[var(--hw-border)] bg-white dark:bg-slate-800 p-1 shadow-2xl dc-pop">
          {([
            ['shorten', <IcShorten />, t('اختصار', 'Shorten')],
            ['lengthen', <IcLengthen />, t('إطالة', 'Lengthen')],
            ['improve', <IcSpark />, t('تحسين', 'Improve')],
            ['rewrite', <IcRewrite />, t('صياغة', 'Rewrite')],
          ] as const).map(([act, icon, label]) => (
            <button key={act} type="button" disabled={!!smartBusy}
              onClick={() => runSmartEdit(act as SmartEditAction)} title={label}
              className="flex items-center gap-1 h-7 px-2 rounded-lg text-[12px] font-medium text-slate-600 dark:text-slate-300 hover:bg-[var(--hw-brand-50,#eef8fa)] hover:text-[var(--hw-brand,#11a8bc)] disabled:opacity-50 transition-colors">
              {smartBusy === act ? <IcSpin /> : icon}{label}
            </button>
          ))}
          <span className="w-px h-5 bg-[var(--hw-border)] mx-0.5" />
          <button type="button" disabled={!!smartBusy} onClick={() => stepFont(-1)} title={t('تصغير الخط', 'Smaller font')}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-[12px] font-bold text-slate-600 dark:text-slate-300 hover:bg-[var(--hw-brand-50,#eef8fa)] hover:text-[var(--hw-brand,#11a8bc)] disabled:opacity-50 transition-colors">A−</button>
          <button type="button" disabled={!!smartBusy} onClick={() => stepFont(1)} title={t('تكبير الخط', 'Larger font')}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-[15px] font-bold text-slate-600 dark:text-slate-300 hover:bg-[var(--hw-brand-50,#eef8fa)] hover:text-[var(--hw-brand,#11a8bc)] disabled:opacity-50 transition-colors">A+</button>
          <span className="w-px h-5 bg-[var(--hw-border)] mx-0.5" />
          <button type="button" disabled={!!smartBusy} onClick={deleteSelection} title={t('حذف', 'Delete')}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15 disabled:opacity-50 transition-colors"><IcTrash /></button>
          {/* V31 — anchor a review comment to the selection (owner side). */}
          {onAddComment && (
            <>
              <span className="w-px h-5 bg-[var(--hw-border)] mx-0.5" />
              <button type="button" disabled={!!smartBusy} onClick={() => openCommentComposer()} title={t('علّق على التحديد', 'Comment on selection')}
                className="flex items-center gap-1 h-7 px-2 rounded-lg text-[12px] font-semibold text-[var(--hw-brand,#11a8bc)] hover:bg-[var(--hw-brand-50,#eef8fa)] disabled:opacity-50 transition-colors">
                <IcComment />{t('علّق', 'Comment')}
              </button>
            </>
          )}
          {onAskAi && (
            <>
              <span className="w-px h-5 bg-[var(--hw-border)] mx-0.5" />
              <button type="button" disabled={!!smartBusy}
                onClick={() => { onAskAi(askSel.text); setAskSel(null); }} title={t('اسأل الكوبايلوت', 'Ask copilot')}
                className="flex items-center gap-1 h-7 px-2 rounded-lg text-[12px] font-semibold text-[var(--hw-brand,#11a8bc)] hover:bg-[var(--hw-brand-50,#eef8fa)] disabled:opacity-50 transition-colors">
                <IcSpark />{t('اسأل', 'Ask')}
              </button>
            </>
          )}
        </div>
      )}

      {/* V31 — client (read-only) floating «أضف تعليقاً» over the live selection.
          The owner uses the smart-edit bar's Comment button instead. */}
      {readOnly && commentBtn && onAddComment && (
        <button type="button" onMouseDown={openCommentComposer}
          style={{ top: commentBtn.top, left: commentBtn.left }}
          className="fixed z-[10000] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--hw-brand,#11a8bc)] text-white text-[12px] font-bold shadow-lg hover:opacity-90">
          <IcComment />{t('أضف تعليقاً', 'Add comment')}
        </button>
      )}

      {/* V31 — inline comment composer popover (both surfaces). Bound to the anchor
          captured from the selection; submit hands it to onAddComment. */}
      {commentComposer && (
        <>
          <div className="fixed inset-0 z-[10000]" onClick={cancelCommentComposer} aria-hidden="true" />
          <div dir={ar ? 'rtl' : 'ltr'} role="dialog"
            style={{ top: commentComposer.top, left: Math.max(8, Math.min(commentComposer.left, window.innerWidth - 316)) }}
            className="fixed z-[10001] w-[300px] rounded-xl border border-[var(--hw-border)] bg-white dark:bg-slate-800 p-3 shadow-2xl dc-pop">
            <div className="text-[11px] text-slate-500 dark:text-slate-400 border-s-2 border-amber-300 dark:border-amber-700 ps-2 mb-2 line-clamp-3">«{commentComposer.anchor.quote}»</div>
            <textarea value={commentDraft} onChange={e => setCommentDraft(e.target.value)} rows={3} autoFocus
              placeholder={t('اكتب تعليقك…', 'Write your comment…')}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitInlineComment(); }}
              className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 resize-y" />
            {commentErr && <p className="text-[11px] text-rose-600 mt-1">{commentErr}</p>}
            <div className="flex items-center justify-end gap-2 mt-2">
              <button type="button" onClick={cancelCommentComposer}
                className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">{t('إلغاء', 'Cancel')}</button>
              <button type="button" onClick={submitInlineComment} disabled={!commentDraft.trim() || commentBusy}
                className="hw-btn hw-btn-primary hw-btn-sm !rounded-lg disabled:opacity-50">
                {commentBusy ? t('جارٍ الإرسال…', 'Sending…') : t('تعليق', 'Comment')}
              </button>
            </div>
          </div>
        </>
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

      {/* D3 — in-place diagram editor: regenerate the current render, or edit the
          diagram in natural language via the SAME chat editor the org-chart Build
          stage uses. Owner canvas only — never reachable in the read-only share view. */}
      {!readOnly && dgmEditor && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4 dc-fade" onClick={() => setDgmEditor(null)}>
          <div className="w-[620px] max-w-full max-h-[88vh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-800 p-5 shadow-2xl dc-pop" onClick={e => e.stopPropagation()} dir={ar ? 'rtl' : 'ltr'}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">{t('تحرير المخطط', 'Edit diagram')}</h3>
              <button type="button" onClick={() => setDgmEditor(null)} title={t('إغلاق', 'Close')} aria-label={t('إغلاق', 'Close')} className="gc-icon-btn"><IcClose /></button>
            </div>
            <button type="button" onClick={regenerateDiagram} disabled={dgmRegenBusy || dgmSaving}
              title={t('أعِد رسم المخطط الحالي من جديد', 'Re-render the current diagram from scratch')}
              className="hw-btn hw-btn-subtle hw-btn-sm !rounded-full mb-3 disabled:opacity-50">
              {dgmRegenBusy ? <IcSpin /> : <IcRetry />}{t('إعادة توليد', 'Regenerate')}
            </button>
            <DiagramChatEditor
              language={language}
              initialMermaid={dgmEditor.code}
              title={t('المخطط', 'Diagram')}
              onSave={handleDiagramEditorSave}
              saving={dgmSaving}
            />
            <p className="mt-3 text-[11px] text-slate-400">{t('يُطبَّق كل تعديل على المستند فوراً ويُحفظ.', 'Every edit applies to the document immediately and is saved.')}</p>
          </div>
        </div>
      )}

      {/* D1 — brief notice while export/save/share waits on an in-flight diagram
          render (never shown for a near-instant wait — see waitForDiagrams). */}
      {diagramsWaitNotice && (
        <div className="fixed bottom-6 inset-x-0 z-[10002] flex justify-center pointer-events-none" dir={ar ? 'rtl' : 'ltr'}>
          <div className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900/90 text-white text-[12.5px] font-semibold shadow-2xl dc-pop">
            <IcSpin />{t('بانتظار اكتمال المخططات…', 'Waiting for diagrams…')}
          </div>
        </div>
      )}

      {/* V21 — review-comments panel: client's anchored comments (highlighted in
          the iframe) and the AI-apply action. */}
      {panelOpen && (
        <div dir={ar ? 'rtl' : 'ltr'} className="absolute inset-y-0 end-0 z-[57] w-[330px] max-w-[88vw] bg-white dark:bg-slate-900 border-s border-[var(--hw-border)] shadow-2xl flex flex-col">
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--hw-border)]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[var(--hw-brand,#11a8bc)]"><IcComment /></span>
              <span className="text-[13.5px] font-bold text-slate-800 dark:text-slate-100">{t('تعليقات المراجعة', 'Review comments')}</span>
            </div>
            <button type="button" onClick={() => setPanelOpen(false)} title={t('إغلاق', 'Close')} aria-label={t('إغلاق', 'Close')} className="gc-icon-btn"><IcClose /></button>
          </div>

          <div className="px-4 py-2 flex items-center gap-2 text-[11px] border-b border-[var(--hw-border)]">
            <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-bold">{t('مفتوحة', 'Open')} {openCount}</span>
            <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 font-bold">{t('مطبّقة', 'Implemented')} {doneCount}</span>
          </div>

          {onApplyComments && (
            <div className="px-4 py-3 space-y-2 border-b border-[var(--hw-border)]">
              <button type="button" onClick={runApplyComments} disabled={applyBusy || openCount === 0}
                title={t('طبّق التعليقات المفتوحة بالذكاء الاصطناعي → إصدار جديد', 'AI-apply the open comments → a new version')}
                className="hw-btn hw-btn-primary hw-btn-sm !rounded-full w-full justify-center disabled:opacity-50">
                {applyBusy ? <IcSpin /> : <IcSpark />}{t('مراجعة وتطبيق التعليقات (AI)', 'Review & apply comments (AI)')}
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {comments.length === 0 && (
              <p className="text-[12px] text-slate-400 px-1">{t('لا توجد تعليقات بعد. شارك المستند مع العميل لجمع الملاحظات.', 'No comments yet. Share the document with the client to collect feedback.')}</p>
            )}
            {comments.map(c => (
              <button key={c.id} type="button" onClick={() => c.anchor && focusComment(c.id)}
                className={`block w-full text-start rounded-lg border p-2.5 transition-colors ${c.anchor ? 'cursor-pointer hover:border-[var(--hw-brand,#11a8bc)]' : 'cursor-default'} ${c.status === 'implemented' ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-900/10' : 'border-slate-200 dark:border-slate-700'}`}>
                {c.anchor?.quote && <div className="text-[11px] text-slate-500 dark:text-slate-400 border-s-2 border-amber-300 dark:border-amber-700 ps-2 mb-1 line-clamp-2">«{c.anchor.quote}»</div>}
                <div className="text-[12px] text-slate-700 dark:text-slate-200">{c.text}</div>
                <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 flex-wrap">
                  {c.status === 'implemented'
                    ? <span className="inline-flex items-center gap-0.5 text-emerald-600 font-bold"><IcCheckDone />{t('طُبّق', 'Implemented')}{c.appliedInVersion ? ` · v${c.appliedInVersion}` : ''}</span>
                    : <span className="text-amber-600 font-bold">{t('مفتوح', 'Open')}</span>}
                  <span>· {c.author} · {new Date(c.at).toLocaleDateString()}</span>
                </div>
                {c.changeSummary && <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1">{c.changeSummary}</div>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default DocumentCanvas;
