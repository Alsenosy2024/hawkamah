import { describe, it, expect } from 'vitest';
import {
  detectMermaidType,
  sanitizeMermaid,
  prepareMermaidForRender,
  guardMermaidLabels,
  convertRadarChart,
} from '../../services/diagramService';

// ===========================================================================
//  Regression suite for the "gantt / flowchart fall back to raw code" bug.
//
//  Root cause: sanitizeMermaid + guardMermaidLabels applied FLOWCHART-specific
//  quote-wrapping ( (..)→("..") , [..]→["..."] , {..}→{".."} ) to EVERY diagram
//  type. For gantt/sequence/pie/class/er/state those brackets are real syntax,
//  so the rewrite produced un-parseable code and MermaidView degraded to source.
//
//  The fix gates those transforms by detected diagram type and makes the guard
//  line-aware (subgraph/style/etc. left alone). These tests pin that contract at
//  the string level (vitest runs in node — no DOM — so mermaid.parse can't run,
//  but the corruption is fully observable in the transformed string).
// ===========================================================================

// ---- real samples reconstructed from the reported screenshots --------------
const GANTT = `gantt
    title الجدول الزمني لمخرجات التحقق (يوماً)
    dateFormat X
    axisFormat %d

    section المرحلة الأولى
    اعتماد مصفوفة الصلاحيات DoA      :active, a1, 0, 15
    تفعيل مبكر للـ PMO               :active, a2, 10, 25
    التعاقد مع الاستشاري فئة أول      :active, a3, 15, 30

    section المرحلة الثالثة
    دعم معايير الاستدامة (LEED)       :after b3, c3, 70, 90`;

const FLOWCHART = `graph TD
    subgraph الوضع الراهن (الخصم والشمس)
        A1[عروض أسعار مرجعية دون بناء سعر مباشرة] --> B1[مفاوضات مباشرة]
        B1 --> C1{طلب خفض السعر عشوائيا}
        C1 -->|تقوم تحقيق وفر مالي| D1[استجابة المقاول]
    end
    style A1 fill:#ffcccc,stroke:#333,stroke-width:1px`;

const PIE = `pie title توزيع المخاطر
    "مالية" : 40
    "تشغيلية" : 35
    "قانونية (تعاقدية)" : 25`;

const SEQUENCE = `sequenceDiagram
    participant A as الإدارة
    participant B as المقاول
    A->>B: طلب عرض سعر (عاجل)
    Note over A,B: مراجعة فنية ومالية`;

describe('detectMermaidType', () => {
  it('identifies every common diagram head', () => {
    expect(detectMermaidType(GANTT)).toBe('gantt');
    expect(detectMermaidType(FLOWCHART)).toBe('flowchart');     // graph → flowchart
    expect(detectMermaidType('flowchart LR\n A-->B')).toBe('flowchart');
    expect(detectMermaidType(PIE)).toBe('pie');
    expect(detectMermaidType(SEQUENCE)).toBe('sequencediagram');
    expect(detectMermaidType('stateDiagram-v2\n [*] --> A')).toBe('statediagram');
    expect(detectMermaidType('classDiagram\n class A')).toBe('classdiagram');
    expect(detectMermaidType('erDiagram\n A ||--o{ B : has')).toBe('erdiagram');
    expect(detectMermaidType('journey\n title T')).toBe('journey');
    expect(detectMermaidType('mindmap\n root')).toBe('mindmap');
    expect(detectMermaidType('timeline\n title T')).toBe('timeline');
  });

  it('sees through %%{init}%% directives and YAML front-matter', () => {
    expect(detectMermaidType('%%{init: {"theme":"base"}}%%\nflowchart TD\n A-->B')).toBe('flowchart');
    expect(detectMermaidType('---\ntitle: خطة\n---\ngantt\n section s')).toBe('gantt');
    expect(detectMermaidType('%% a comment\ngantt\n section s')).toBe('gantt');
  });

  it('returns empty for non-diagram content', () => {
    expect(detectMermaidType('const x = graph();')).toBe('');
    expect(detectMermaidType('')).toBe('');
    expect(detectMermaidType('just some text')).toBe('');
  });
});

describe('prepareMermaidForRender — non-flowchart types are never quote-guarded', () => {
  it('gantt: title parens and task rows survive intact (no quote-wrapping)', () => {
    const out = prepareMermaidForRender(GANTT);
    // the guard must NOT run on gantt → equals the plain sanitized source
    expect(out).toBe(sanitizeMermaid(GANTT));
    // parenthesised constructs survive verbatim (LEED is tashkeel-free, so it is a
    // stable witness that title/label parens are NOT quote-wrapped)
    expect(out).toContain('(LEED)');
    expect(out).toContain(':active, a1, 0, 15');
    // the corruption signature — a quote right after an opening paren — is absent
    expect(out).not.toContain('("');
  });

  it('pie: parenthesised slice labels are left alone', () => {
    const out = prepareMermaidForRender(PIE);
    expect(out).toBe(sanitizeMermaid(PIE));
    expect(out).toContain('"قانونية (تعاقدية)" : 25');
    expect(out).not.toContain('("');
  });

  it('sequence: message parens are not wrapped', () => {
    const out = prepareMermaidForRender(SEQUENCE);
    expect(out).toBe(sanitizeMermaid(SEQUENCE));
    expect(out).toContain('طلب عرض سعر (عاجل)');
    expect(out).not.toContain('("عاجل")');
  });
});

describe('prepareMermaidForRender — flowcharts still get label guarding', () => {
  it('wraps node labels but never the subgraph/style lines', () => {
    const out = prepareMermaidForRender(FLOWCHART);
    const lines = out.split('\n');
    // structural lines pass through untouched
    expect(lines.some(l => l.trim() === 'subgraph الوضع الراهن (الخصم والشمس)')).toBe(true);
    expect(lines.some(l => l.includes('style A1 fill:#ffcccc'))).toBe(true);
    // the subgraph title was NOT turned into a quoted label
    expect(out).not.toContain('("الخصم والشمس")');
    // a normal node label IS quoted by the guard
    expect(out).toMatch(/A1\["/);
  });

  it('keeps parentheses inside a quoted flowchart node label (GovF17)', () => {
    const out = prepareMermaidForRender('flowchart TD\n  n1[اللجنة (التنفيذية)]');
    expect(out).toContain('n1["');
    expect(out).toContain('(التنفيذية)');         // inner parens preserved within the quotes
  });

  it('preserves decorated shapes (cylinder) instead of flattening them to rectangles', () => {
    const out = prepareMermaidForRender('flowchart TD\n  db[(قاعدة البيانات)]');
    expect(out).toContain('[(');                   // cylinder delimiters intact
    expect(out).toContain(')]');
    expect(out).not.toContain('["(');              // NOT collapsed to a quoted rectangle
  });
});

describe('guardMermaidLabels — line awareness', () => {
  it('never rewrites structural/directive lines', () => {
    const src = 'flowchart TD\n  subgraph منطقة (أ)\n    X[نص]\n  end\n  style X fill:#eee';
    const out = guardMermaidLabels(src);
    expect(out).toContain('subgraph منطقة (أ)');   // untouched
    expect(out).toContain('style X fill:#eee');    // untouched
    expect(out).toMatch(/X\["/);                   // node label guarded
  });
});

describe('sanitizeMermaid — universally-safe cleaning on every type', () => {
  it('strips leaked [مصدر N] citation markers without harming gantt syntax', () => {
    const out = sanitizeMermaid('gantt\n  section s\n  مهمة [مصدر 3]   :active, a1, 0, 5');
    expect(out).not.toContain('مصدر 3');
    expect(out).toContain(':active, a1, 0, 5');
    expect(detectMermaidType(out)).toBe('gantt');
  });

  it('strips code fences regardless of type', () => {
    expect(sanitizeMermaid('```mermaid\npie title T\n "a" : 1\n```')).toContain('pie title T');
  });

  it('collapses literal \\n line-break artifacts inside labels', () => {
    const out = sanitizeMermaid('flowchart TD\n  Owner["المالك (أبو عبد الله)\\nمصدر 7"]\n  Owner --> Owner');
    expect(out).not.toMatch(/\\n/);                 // no literal backslash-n left
    expect(out).toContain('مصدر 7');                // text preserved
  });
});

// The model invents a `radar-chart` dialect Mermaid has no type for (→ "No
// diagram type detected" → raw-code fallback). It must become valid `radar-beta`.
describe('convertRadarChart — invalid radar-chart → valid radar-beta', () => {
  const SRC = `radar-chart
    title نضج الحوكمة (شركة كلمة)
    axes
        "الحوكمة" : 1.5
        "PMO" : 2.0
        "المخاطر" : 3.5`;

  it('rewrites the header to radar-beta and detects it as radar', () => {
    const out = sanitizeMermaid(SRC);
    expect(out.startsWith('radar-beta')).toBe(true);
    expect(out).not.toContain('radar-chart');
    expect(detectMermaidType(out)).toBe('radar');
  });

  it('maps each "label : value" row to an axis + a single curve of values', () => {
    const out = convertRadarChart(SRC);
    expect(out).toMatch(/axis a0\["الحوكمة"\], a1\["PMO"\], a2\["المخاطر"\]/);
    expect(out).toMatch(/curve c0\[".*"\]\{1\.5, 2, 3\.5\}/);
    expect(out).toMatch(/title "نضج الحوكمة \(شركة كلمة\)"/);
    expect(out).toMatch(/max 5/);                   // ceil(max(values))=4 → floored to a sane 5
  });

  it('leaves a chart with no extractable axis rows untouched (no mangling)', () => {
    const weird = 'radar-chart\n  title only a title';
    expect(convertRadarChart(weird)).toBe(weird);
  });
});
