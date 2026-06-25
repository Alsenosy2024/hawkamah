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
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">{label}</span>
      {area
        ? <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows || 4}
            className="hw-textarea text-sm leading-relaxed" />
        : <input value={value} onChange={e => onChange(e.target.value)}
            className="hw-input text-sm" />}
    </label>
  );

  const renderEditor = () => {
    if (!boundEntity) {
      return (
        <div className="p-4 flex flex-col items-start gap-2">
          <div className="text-xs text-slate-400 dark:text-slate-500 leading-relaxed">
            {selectedNode
              ? t('عقدة حرة غير مرتبطة بعنصر حقيقي. استخدم "تسمية" لتغيير الاسم.', 'Free node — not bound to a real entity. Use Rename to relabel.')
              : t('اختر عقدة لتحرير العنصر الحقيقي المرتبط بها.', 'Select a node to edit its bound real entity.')}
          </div>
        </div>
      );
    }
    const e: any = boundEntity;
    return (
      <div className="p-4">
        <div className="mb-3">
          <span className="hw-badge-brand text-[10px] uppercase tracking-widest">
            {t(KIND_LABEL[refKind!].ar, KIND_LABEL[refKind!].en)}
          </span>
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
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">{t('الحالة', 'Status')}</span>
            <select value={e.status || 'draft'} onChange={ev => patchModel(m => { const x = m.procedures.find(p => p.id === refId); if (!x) return undefined; x.status = ev.target.value as any; return undefined; })}
              className="hw-input text-sm">
              <option value="draft">{t('مسودة', 'Draft')}</option>
              <option value="in_review">{t('قيد المراجعة', 'In review')}</option>
              <option value="approved">{t('معتمد', 'Approved')}</option>
            </select>
          </label>
        </>}
        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-3 leading-relaxed border-t border-slate-100 dark:border-slate-700 pt-3">
          {t('التعديلات تُحفظ في نموذج الحوكمة عند الضغط على "حفظ".', 'Edits persist to the governance model on Save.')}
        </p>
      </div>
    );
  };

  const showPanel = !!model;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900" dir="ltr">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900" dir={ar ? 'rtl' : 'ltr'}>
        {/* Node action group */}
        <div className="flex items-center gap-1">
          <button
            onClick={addNode}
            className="hw-btn hw-btn-primary hw-btn-sm"
          >
            + {t('عقدة', 'Node')}
          </button>
          <button
            onClick={renameSelected}
            disabled={!selected}
            className="hw-btn hw-btn-ghost hw-btn-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('تسمية', 'Rename')}
          </button>
          <button
            onClick={deleteSelected}
            disabled={!selected}
            className="hw-btn hw-btn-danger hw-btn-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('حذف', 'Delete')}
          </button>
        </div>

        {/* Separator */}
        <span className="hidden sm:block w-px h-5 bg-slate-200 dark:bg-slate-700 mx-2 shrink-0" aria-hidden="true" />

        {/* Hint */}
        <span className="hidden sm:block text-[11px] text-slate-400 dark:text-slate-500 leading-none">
          {t('اسحب لتحريك · اربط من حافة العقدة', 'drag to move · connect from node edge')}
        </span>

        {/* Save — ms-auto pushes to end */}
        <button
          onClick={save}
          disabled={saving}
          className="hw-btn hw-btn-primary hw-btn-sm ms-auto disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ', 'Save')}
        </button>
      </div>

      {/* ── Canvas + Inspector ── */}
      <div className="flex" style={{ height: '60vh' }}>
        {/* Canvas */}
        <div className="flex-1 bg-[#F7FAFB] dark:bg-slate-900">
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

        {/* Properties inspector panel */}
        {showPanel && (
          <div
            className="w-72 shrink-0 border-s border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-y-auto flex flex-col"
            dir={ar ? 'rtl' : 'ltr'}
          >
            <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-700 flex items-center gap-2 shrink-0">
              <span className="text-xs font-bold text-slate-700 dark:text-slate-200 leading-none">
                {t('محرر الخصائص', 'Properties')}
              </span>
              {selected && (
                <span className="ms-auto text-[10px] text-slate-400 dark:text-slate-500 font-mono leading-none truncate max-w-[6rem]">
                  #{selected}
                </span>
              )}
            </div>
            {renderEditor()}
          </div>
        )}
      </div>
    </div>
  );
};

export default GovernanceCanvas;
