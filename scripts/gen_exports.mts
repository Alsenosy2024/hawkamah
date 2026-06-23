// Offline export-shape QA: builds a rich Arabic governance manual from the dev
// seed model and emits real DOCX + PPTX + standalone PDF-HTML to /tmp, so the
// owner-mandated "review the outputs and their shape" can be done by rendering
// the actual exporter code (no browser, no Firestore).
import { writeFileSync } from 'fs';
import { Packer } from 'docx';

// ---- minimal browser shims so download paths don't crash in node ----
let captured: Blob | null = null;
(globalThis as any).URL = (globalThis as any).URL || {};
(globalThis as any).URL.createObjectURL = (b: Blob) => { captured = b; return 'blob:captured'; };
(globalThis as any).URL.revokeObjectURL = () => {};
(globalThis as any).document = {
  createElement: () => ({ href: '', download: '', style: {}, click() {}, setAttribute() {}, remove() {} }),
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {}, removeEventListener() {},
};
(globalThis as any).window = (globalThis as any).window || globalThis;
(globalThis as any).window.addEventListener = () => {};
(globalThis as any).window.removeEventListener = () => {};

const { makeSeedModel } = await import('../services/devSeed');
const { exportGovernanceManual, buildStandalonePdfHtml } = await import('../services/exportService');
const { buildPptx } = await import('../services/pptxExport');
import type { GeneratedArtifact } from '../types';

const COMPANY = 'شركة تال الإعمارية للمقاولات';
const model = makeSeedModel('seed-tenant', COMPANY);

const md = (s: string) => s.trim();
const artifact: GeneratedArtifact = {
  title: 'دليل الحوكمة المؤسسية',
  goal: 'إطار حوكمة متكامل لشركة مقاولات وبنية تحتية',
  language: 'ar' as any,
  createdAt: new Date(),
  complete: true,
  executiveSummary: md(`
يقدّم هذا الدليل إطار الحوكمة المؤسسية لشركة **تال الإعمارية للمقاولات**، ويهدف إلى ترسيخ الشفافية والمساءلة وضبط تضارب المصالح عبر هيكل تنظيمي واضح ومصفوفة صلاحيات محكمة. يغطّي الدليل الوحدات التنظيمية الخمس الرئيسية، والأدوار الوظيفية، والسياسات والإجراءات التشغيلية، ومؤشرات الأداء، مع مواءمة كاملة لأفضل الممارسات في قطاع الإنشاءات.

> الدرجة الإجمالية لنضج الحوكمة بلغت **58%** عند خط الأساس، مع خارطة طريق للارتقاء إلى مستوى «مُعرّف» خلال 12 شهراً.
`),
  sections: [
    { id: 's1', title: 'الإطار العام للحوكمة', status: 'done', content: md(`
## الغرض والنطاق
يحدّد هذا الباب المبادئ الحاكمة لاتخاذ القرار وتوزيع المسؤوليات. ينطبق على جميع الوحدات التنظيمية والمشاريع.

## المبادئ الأساسية
- **الشفافية**: الإفصاح عن القرارات الجوهرية وآليات اعتمادها.
- **المساءلة**: ربط كل صلاحية بدور وظيفي محدد.
- **فصل الصلاحيات**: منع ازدواج الاعتماد في القرارات المالية.

## الوحدات التنظيمية
| الوحدة | الولاية | الهدف |
|--------|---------|-------|
| مجلس الإدارة | الإشراف الاستراتيجي وإقرار السياسات | حوكمة الشركة |
| الرئيس التنفيذي | القيادة التنفيذية | تنفيذ الاستراتيجية |
| إدارة المشاريع | تخطيط وتنفيذ المشاريع | تسليم في الوقت والتكلفة |
| الإدارة المالية | الرقابة المالية والمشتريات | الانضباط المالي |
| الموارد البشرية | استقطاب وتطوير الكوادر | كفاءة رأس المال البشري |
`) },
    { id: 's2', title: 'السياسات والإجراءات', status: 'done', content: md(`
## سياسة المشتريات والمناقصات
تنظّم عمليات الشراء والترسية بشفافية لكل مشتريات الشركة فوق 10,000 ريال، عبر منافسة عادلة وتعدد عروض وفصل صلاحيات.

### إجراء ترسية المناقصة
1. استلام العروض في الموعد المحدد.
2. فتح المظاريف بحضور اللجنة.
3. التقييم الفني ثم المالي.
4. رفع التوصية للاعتماد.
5. إصدار أمر العمل للمقاول الفائز.

## سياسة السلامة في مواقع البناء
تلتزم الشركة بحماية العاملين عبر معدات الوقاية الشخصية، وتقييم المخاطر اليومي، وبلاغات الحوادث الفورية. هذه السياسة قيد المراجعة وتحتاج إجراءً تشغيلياً يفعّلها.
`) },
    { id: 's3', title: 'مؤشرات الأداء والمخاطر', status: 'done', content: md(`
## مؤشرات الأداء الرئيسية
| المؤشر | الهدف | التكرار |
|--------|-------|---------|
| نسبة تسليم المشاريع في موعدها | ≥ 90% | ربع سنوي |
| انحراف التكلفة | ≤ 5% | شهري |
| معدل الحوادث في المواقع | ≤ 1.0 | شهري |

## الفجوات الحوكمية المرصودة
- **إدارة المخاطر** (خطورة عالية): لا يوجد سجل مخاطر مؤسسي موحّد. التوصية: إنشاء سجل مركزي ومراجعته شهرياً.
- **مصفوفة الصلاحيات** (خطورة متوسطة): حدود التفويض المالي غير موثّقة لبعض المستويات الوسطى.
`) },
  ],
  diagrams: [],
};

const o = { companyName: COMPANY };  // DOCX_FONT defaults to embedded Almarai
const extras = {
  maturity: {
    overall: 58, label: 'مُدار نحو مُعرّف',
    domains: [
      { domain: 'الهيكل التنظيمي', score: 60, label: 'مُحدّد' },
      { domain: 'السياسات', score: 50, label: 'مُحدّد' },
      { domain: 'الإجراءات', score: 100, label: 'مُحسّن' },
      { domain: 'الصلاحيات', score: 100, label: 'مُحسّن' },
      { domain: 'إدارة المخاطر', score: 40, label: 'مبدئي' },
    ],
  } as any,
  approvedBy: 'د. أحمد السنوسي',
  effectiveDate: '2026-06-19',
};

// ---- DOCX ----
await exportGovernanceManual(model, artifact, o, extras);
if (!captured) throw new Error('DOCX blob not captured');
const docxBuf = Buffer.from(await (captured as Blob).arrayBuffer());
writeFileSync('/tmp/hk_manual.docx', docxBuf);
console.log('WROTE /tmp/hk_manual.docx', docxBuf.length, 'bytes');

// ---- PPTX ----
const pptx = buildPptx(
  `# ${artifact.title}\n${artifact.executiveSummary}\n\n` + artifact.sections.map(s => `# ${s.title}\n${s.content}`).join('\n\n'),
  artifact.title, '19 يونيو 2026',
);
const pbuf = await pptx.write({ outputType: 'nodebuffer' }) as Buffer;
writeFileSync('/tmp/hk_manual.pptx', pbuf);
console.log('WROTE /tmp/hk_manual.pptx', pbuf.length, 'bytes');

// ---- PDF HTML (standalone, fonts via file://) ----
const fontBase = 'file://' + process.cwd() + '/public/fonts/';
const html = buildStandalonePdfHtml(artifact, o, fontBase);
writeFileSync('/tmp/hk_manual.html', html, 'utf8');
console.log('WROTE /tmp/hk_manual.html', html.length, 'chars');
console.log('DONE');
