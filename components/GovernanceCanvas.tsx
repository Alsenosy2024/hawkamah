import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, type Connection, type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Language, GovFlowNode, GovFlowEdge, CompanyGovernanceModel } from '../types';
import { flowToMermaid } from '../services/diagramService';

interface Props {
  language?: Language;
  initialNodes: GovFlowNode[];
  initialEdges: GovFlowEdge[];
  onSave?: (nodes: GovFlowNode[], edges: GovFlowEdge[], mermaid: string) => void;
  saving?: boolean;
  // model-bound editing: when provided, selecting a bound node edits the REAL entity
  model?: CompanyGovernanceModel;
  onModelChange?: (model: CompanyGovernanceModel) => void;
}

let _nid = 0;

const toRf = (n: GovFlowNode): Node => ({ id: n.id, position: n.position, data: n.data, type: n.type, style: n.style });
const toRfE = (e: GovFlowEdge): Edge => ({ id: e.id, source: e.source, target: e.target, label: e.label, animated: e.animated, type: e.type });

const KIND_LABEL: Record<string, { ar: string; en: string }> = {
  unit: { ar: 'وحدة تنظيمية', en: 'Org unit' },
  role: { ar: 'دور', en: 'Role' },
  policy: { ar: 'سياسة', en: 'Policy' },
  procedure: { ar: 'إجراء', en: 'Procedure' },
};

const GovernanceCanvas: React.FC<Props> = ({ language, initialNodes, initialEdges, onSave, saving, model, onModelChange }) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initialNodes.map(toRf));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges.map(toRfE));
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => { setNodes(initialNodes.map(toRf)); setEdges(initialEdges.map(toRfE)); }, [initialNodes, initialEdges, setNodes, setEdges]);

  const onConnect = useCallback((c: Connection) => setEdges(eds => addEdge({ ...c, animated: true }, eds)), [setEdges]);

  const selectedNode = useMemo(() => nodes.find(n => n.id === selected), [nodes, selected]);
  const refKind = selectedNode?.data?.refKind as string | undefined;
  const refId = selectedNode?.data?.refId as string | undefined;

  const addNode = () => {
    const id = `m${Date.now().toString(36)}_${_nid++}`;
    setNodes(ns => [...ns, { id, position: { x: 120 + ns.length * 30, y: 120 + ns.length * 20 }, data: { label: t('عقدة جديدة', 'New node') } }]);
  };

  const renameSelected = () => {
    if (!selected) return;
    const cur = nodes.find(n => n.id === selected);
    const next = window.prompt(t('اسم العقدة', 'Node label'), String(cur?.data?.label || ''));
    if (next == null) return;
    setNodes(ns => ns.map(n => n.id === selected ? { ...n, data: { ...n.data, label: next } } : n));
  };

  const deleteSelected = () => {
    if (!selected) return;
    setNodes(ns => ns.filter(n => n.id !== selected));
    setEdges(es => es.filter(e => e.source !== selected && e.target !== selected));
    setSelected(null);
  };

  const save = () => {
    const fn: GovFlowNode[] = nodes.map(n => ({
      id: n.id, position: n.position,
      data: { label: String(n.data?.label || ''), refKind: n.data?.refKind as any, refId: n.data?.refId as any },
      type: n.type, style: n.style as any,
    }));
    const fe: GovFlowEdge[] = edges.map(e => ({ id: e.id, source: e.source, target: e.target, label: e.label ? String(e.label) : undefined, animated: e.animated, type: e.type }));
    onSave?.(fn, fe, flowToMermaid(fn, fe));
  };

  // ---- edit the REAL bound entity, then mirror label onto the node ----
  const patchModel = (mut: (m: CompanyGovernanceModel) => string | undefined) => {
    if (!model || !onModelChange) return;
    const next: CompanyGovernanceModel = JSON.parse(JSON.stringify(model));
    const newLabel = mut(next);
    onModelChange(next);
    if (newLabel != null) setNodes(ns => ns.map(n => n.id === selected ? { ...n, data: { ...n.data, label: newLabel } } : n));
  };

  const boundEntity = useMemo(() => {
    if (!model || !refKind || !refId) return null;
    if (refKind === 'unit') return model.orgUnits.find(u => u.id === refId) || null;
    if (refKind === 'role') return model.roles.find(r => r.id === refId) || null;
    if (refKind === 'policy') return model.policies.find(p => p.id === refId) || null;
    if (refKind === 'procedure') return (model.procedures || []).find(p => p.id === refId) || null;
    return null;
  }, [model, refKind, refId]);

  const Field = ({ label, value, onChange, area, rows }: { label: string; value: string; onChange: (v: string) => void; area?: boolean; rows?: number }) => (
    <label className="block mb-3">
      <span className="block text-[11px] font-bold text-slate-500 dark:text-slate-400 mb-1">{label}</span>
      {area
        ? <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows || 4}
            className="w-full text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2 py-1.5 leading-relaxed" />
        : <input value={value} onChange={e => onChange(e.target.value)}
            className="w-full text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2 py-1.5" />}
    </label>
  );

  const renderEditor = () => {
    if (!boundEntity) {
      return <div className="text-xs text-slate-400 dark:text-slate-500 p-3 leading-relaxed">
        {selectedNode
          ? t('عقدة حرة غير مرتبطة بعنصر حقيقي. استخدم "تسمية" لتغيير الاسم.', 'Free node, not bound to a real entity. Use "Rename".')
          : t('اختر عقدة لتحرير العنصر الحقيقي المرتبط بها (الوحدة/الدور/السياسة/الإجراء).', 'Select a node to edit its bound real entity.')}
      </div>;
    }
    const e: any = boundEntity;
    return (
      <div className="p-3">
        <div className="text-[11px] font-bold text-emerald-600 dark:text-emerald-300 mb-2">
          {t(KIND_LABEL[refKind!].ar, KIND_LABEL[refKind!].en)}
        </div>
        {refKind === 'unit' && <>
          <Field label={t('اسم الوحدة', 'Unit name')} value={e.name || ''} onChange={v => patchModel(m => { const x = m.orgUnits.find(u => u.id === refId); if (!x) return undefined; x.name = v; return v; })} />
          <Field label={t('التفويض / المهمة', 'Mandate')} area value={e.mandate || ''} onChange={v => patchModel(m => { const x = m.orgUnits.find(u => u.id === refId); if (!x) return undefined; x.mandate = v; return undefined; })} />
        </>}
        {refKind === 'role' && <>
          <Field label={t('المسمى', 'Title')} value={e.title || ''} onChange={v => patchModel(m => { const x = m.roles.find(r => r.id === refId); if (!x) return undefined; x.title = v; return v; })} />
          <Field label={t('الغرض', 'Purpose')} area value={e.purpose || ''} onChange={v => patchModel(m => { const x = m.roles.find(r => r.id === refId); if (!x) return undefined; x.purpose = v; return undefined; })} />
          <Field label={t('المسؤوليات (سطر لكل بند)', 'Responsibilities (one per line)')} area rows={5}
            value={(e.responsibilities || []).join('\n')}
            onChange={v => patchModel(m => { const x = m.roles.find(r => r.id === refId); if (!x) return undefined; x.responsibilities = v.split('\n').map(s => s.trim()).filter(Boolean); return undefined; })} />
        </>}
        {refKind === 'policy' && <>
          <Field label={t('عنوان السياسة', 'Policy title')} value={e.title || ''} onChange={v => patchModel(m => { const x = m.policies.find(p => p.id === refId); if (!x) return undefined; x.title = v; return v; })} />
          <Field label={t('المجال', 'Domain')} value={e.domain || ''} onChange={v => patchModel(m => { const x = m.policies.find(p => p.id === refId); if (!x) return undefined; x.domain = v; return undefined; })} />
          <Field label={t('نص السياسة (الحقيقة)', 'Policy body (reality)')} area rows={8} value={e.body || ''} onChange={v => patchModel(m => { const x = m.policies.find(p => p.id === refId); if (!x) return undefined; x.body = v; return undefined; })} />
        </>}
        {refKind === 'procedure' && <>
          <Field label={t('عنوان الإجراء', 'Procedure title')} value={e.title || ''} onChange={v => patchModel(m => { const x = m.procedures.find(p => p.id === refId); if (!x) return undefined; x.title = v; return v; })} />
          <Field label={t('الغرض', 'Purpose')} area value={e.purpose || ''} onChange={v => patchModel(m => { const x = m.procedures.find(p => p.id === refId); if (!x) return undefined; x.purpose = v; return undefined; })} />
          <Field label={t('نص الإجراء الكامل (الحقيقة — قابل للتعديل)', 'Full procedure body (editable reality)')} area rows={9}
            value={e.body || ''} onChange={v => patchModel(m => { const x = m.procedures.find(p => p.id === refId); if (!x) return undefined; x.body = v; return undefined; })} />
          <label className="block mb-1">
            <span className="block text-[11px] font-bold text-slate-500 dark:text-slate-400 mb-1">{t('الحالة', 'Status')}</span>
            <select value={e.status || 'draft'} onChange={ev => patchModel(m => { const x = m.procedures.find(p => p.id === refId); if (!x) return undefined; x.status = ev.target.value as any; return undefined; })}
              className="w-full text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-2 py-1.5">
              <option value="draft">{t('مسودة', 'Draft')}</option>
              <option value="in_review">{t('قيد المراجعة', 'In review')}</option>
              <option value="approved">{t('معتمد', 'Approved')}</option>
            </select>
          </label>
        </>}
        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 leading-relaxed">
          {t('التعديلات تُحفظ في نموذج الحوكمة عند الضغط على "حفظ".', 'Edits persist to the governance model on Save.')}
        </p>
      </div>
    );
  };

  const showPanel = !!model;

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden" dir="ltr">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800" dir={ar ? 'rtl' : 'ltr'}>
        <button onClick={addNode} className="px-3 h-8 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold">＋ {t('عقدة', 'Node')}</button>
        <button onClick={renameSelected} disabled={!selected} className="px-3 h-8 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-bold disabled:opacity-40">✏️ {t('تسمية', 'Rename')}</button>
        <button onClick={deleteSelected} disabled={!selected} className="px-3 h-8 rounded-lg bg-rose-100 dark:bg-rose-900/40 hover:bg-rose-200 text-rose-700 dark:text-rose-300 text-xs font-bold disabled:opacity-40">🗑 {t('حذف', 'Delete')}</button>
        <span className="text-[11px] text-slate-400 dark:text-slate-500 mx-1">{t('اسحب لتحريك · اربط من حافة العقدة', 'drag to move · connect from node edge')}</span>
        <button onClick={save} disabled={saving} className="ms-auto px-4 h-8 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold disabled:opacity-50">
          {saving ? t('جارٍ الحفظ…', 'Saving…') : `💾 ${t('حفظ', 'Save')}`}
        </button>
      </div>
      <div className="flex" style={{ height: '60vh' }}>
        <div className="flex-1 bg-slate-50 dark:bg-slate-900">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        {showPanel && (
          <div className="w-72 shrink-0 border-s border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-y-auto" dir={ar ? 'rtl' : 'ltr'}>
            <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300">
              {t('تحرير العنصر الحقيقي', 'Edit real entity')}
            </div>
            {renderEditor()}
          </div>
        )}
      </div>
    </div>
  );
};

export default GovernanceCanvas;
