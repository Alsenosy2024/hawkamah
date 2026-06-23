// Offline structural test for the pptxgenjs-based branded PPTX exporter.
// Builds a deck from rich Markdown, writes it to /tmp, and reports size.
import { buildPptx } from '../services/pptxExport';
import { writeFileSync } from 'fs';

const md = `# استراتيجية الحوكمة المؤسسية
مقدمة عن الإطار العام للحوكمة في الشركة.

## الأهداف
- تعزيز الشفافية والمساءلة
- ضبط تضارب المصالح
- مواءمة مع معايير **OECD** و *COSO*

## الأدوار والمسؤوليات
| الدور | المسؤولية |
|------|-----------|
| مجلس الإدارة | الإشراف الاستراتيجي |
| لجنة التدقيق | الرقابة المالية |

## مؤشرات الأداء
1. نسبة الالتزام باللوائح
2. زمن إغلاق الفجوات
3. عدد حالات تضارب المصالح المُدارة

---

## الخاتمة
خارطة طريق للتطبيق خلال 12 شهراً.`;

const pptx = buildPptx(md, 'استراتيجية الحوكمة', '19 يونيو 2026');
const buf = await pptx.write({ outputType: 'nodebuffer' }) as Buffer;
writeFileSync('/tmp/hawkamah_test.pptx', buf);
console.log('WROTE /tmp/hawkamah_test.pptx', buf.length, 'bytes');
if (buf.length < 5000) { console.error('Deck suspiciously small'); process.exit(1); }
console.log('PASS structural');
