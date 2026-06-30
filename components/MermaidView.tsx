import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import type { Language } from '../types';
import { prepareMermaidForRender, ensureMermaidFont, makeSvgResponsive } from '../services/diagramService';
import { MERMAID_THEME_VARIABLES, MERMAID_THEME_CSS, MERMAID_FONT } from '../services/mermaidTheme';

// Brand-themed Mermaid (refined teal) so EVERY diagram type — flowchart,
// sequence, class, state, ER, gantt, pie, journey, git… — matches the Ailigent
// palette instead of Mermaid's default purple/lavender.
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'loose',
  suppressErrorRendering: true,
  fontFamily: MERMAID_FONT,
  flowchart: { curve: 'basis', htmlLabels: true, useMaxWidth: true },
  sequence: { useMaxWidth: true, wrap: true },
  gantt: { useMaxWidth: true },
  themeVariables: MERMAID_THEME_VARIABLES,
  themeCSS: MERMAID_THEME_CSS,
} as any);

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
    // Type-aware clean+guard of raw stored code: flowcharts get long-Arabic-label
    // quoting; gantt/sequence/pie/class/state/etc. keep their real syntax so they
    // render instead of degrading to raw source (root cause of "الرسم مش شغال").
    const src = prepareMermaidForRender(code || '');
    if (!src) { setSvg(''); return; }
    // Load the brand font BEFORE rendering — mermaid measures text synchronously,
    // so an unloaded font sizes node boxes wrong and Arabic overflows.
    ensureMermaidFont()
      .then(() => mermaid.render(id, src))
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
          // Graceful degradation: instead of a scary red error, show the raw
          // mermaid source so the diagram content is never lost.
          <div>
            <div className="text-[11px] text-slate-400 mb-2">
              {t('تعذّر رسم المخطط — هذا هو الكود', 'Could not render the diagram — showing the source')}
            </div>
            <pre
              dir="ltr"
              className="text-left overflow-x-auto rounded-xl p-3 text-xs leading-relaxed font-mono text-slate-700 bg-slate-50"
              style={{ border: '1px solid var(--hw-border)' }}
            >
              {code}
            </pre>
          </div>
        ) : svg ? (
          // PRD V15: render full-width (ratio preserved); zoom multiplies on top.
          <div ref={hostRef} style={{ width: '100%', transform: `scale(${zoom})`, transformOrigin: ar ? 'top right' : 'top left', transition: 'transform .15s' }}
               dangerouslySetInnerHTML={{ __html: makeSvgResponsive(svg) }} />
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
