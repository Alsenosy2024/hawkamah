import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import type { Language } from '../types';
import { sanitizeMermaid, guardMermaidLabels } from '../services/diagramService';

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
  fontFamily: 'inherit',
  flowchart: { curve: 'basis', htmlLabels: true },
});

let _rid = 0;

interface Props {
  mermaid: string;
  title?: string;
  language?: Language;
}

const MermaidView: React.FC<Props> = ({ mermaid: code, title, language }) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);
  const hostRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [err, setErr] = useState<string>('');
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setErr('');
    const id = `mmd_${_rid++}`;
    // Guard + sanitize raw stored code so unquoted long Arabic labels / stray
    // fences never crash the live render (root cause of "الرسم مش شغال").
    // guardMermaidLabels wraps (A)→("A") which breaks Mermaid edge-label parsing
    const src = guardMermaidLabels(sanitizeMermaid(code || ''))
      .replace(/\("([RACI])"\)/g, '($1)');
    if (!src) { setSvg(''); return; }
    mermaid.render(id, src)
      .then(({ svg }) => { if (!cancelled) setSvg(svg); })
      .catch((e) => { if (!cancelled) { setErr(e?.message || String(e)); setSvg(''); } });
    return () => { cancelled = true; };
  }, [code]);

  const downloadSvg = () => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    triggerDownload(URL.createObjectURL(blob), `${title || 'diagram'}.svg`);
  };

  const downloadPng = () => {
    if (!svg) return;
    const img = new Image();
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = (img.width || 1200) * scale;
      canvas.height = (img.height || 800) * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => { if (b) triggerDownload(URL.createObjectURL(b), `${title || 'diagram'}.png`); });
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50">
        <span className="font-bold text-sm text-slate-700 truncate">{title || t('مخطط', 'Diagram')}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setZoom(z => Math.max(0.4, z - 0.2))} className="w-7 h-7 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-sm">−</button>
          <span className="text-[11px] text-slate-500 w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(3, z + 0.2))} className="w-7 h-7 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-sm">+</button>
          <button onClick={downloadSvg} disabled={!svg} className="ml-1 px-2 h-7 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold disabled:opacity-40">SVG</button>
          <button onClick={downloadPng} disabled={!svg} className="px-2 h-7 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-bold disabled:opacity-40">PNG</button>
        </div>
      </div>
      <div className="overflow-auto max-h-[55vh] p-4 bg-[radial-gradient(circle,#e2e8f0_1px,transparent_1px)] [background-size:18px_18px]">
        {err ? (
          <div className="text-rose-600 text-xs">
            <div className="font-bold mb-1 flex items-center gap-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> {t('تعذّر رسم المخطط', 'Could not render diagram')}</div>
            <pre className="whitespace-pre-wrap bg-rose-50 border border-rose-200 rounded-lg p-2 ltr text-left" dir="ltr">{err}</pre>
          </div>
        ) : svg ? (
          <div ref={hostRef} style={{ transform: `scale(${zoom})`, transformOrigin: ar ? 'top right' : 'top left', transition: 'transform .15s' }}
               dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="text-slate-400 text-sm text-center py-10">{t('لا يوجد مخطط بعد', 'No diagram yet')}</div>
        )}
      </div>
    </div>
  );
};

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

export default MermaidView;
