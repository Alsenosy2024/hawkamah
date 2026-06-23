import { writeFileSync, readFileSync } from 'fs';
import { buildPptx } from '../services/pptxExport';
import type { ArtifactDiagram } from '../types';
const png = 'data:image/png;base64,' + readFileSync('/tmp/test_diagram.png').toString('base64');
const diagrams: ArtifactDiagram[] = [
  { title: 'الهيكل التنظيمي المقترح', png, width: 1200, height: 700 },
  { title: 'مخطط سير عملية المشتريات', png, width: 1200, height: 700 },
];
const md = `# دليل الحوكمة المؤسسية\nملخص تنفيذي قصير لاختبار شريحة المخططات.\n\n# المخططات`;
const pptx = buildPptx(md, 'دليل الحوكمة المؤسسية', '19 يونيو 2026', diagrams);
const buf = await pptx.write({ outputType: 'nodebuffer' }) as Buffer;
writeFileSync('/tmp/hk_diag.pptx', buf);
console.log('WROTE /tmp/hk_diag.pptx', buf.length);
