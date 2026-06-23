// Real functional test of W3 (exact count) + W4 (industry-grounded, names company).
// Calls the live generateQuestions service against the real Gemini API. No Firestore, no auth.
import { generateQuestions } from '../services/geminiService';

const COMPANY = 'شركة تال الإعمارية للمقاولات';
const orgContext = `الشركة: ${COMPANY} — قطاع المقاولات والإنشاءات والبنية التحتية. تعمل في تطوير وتنفيذ مشاريع البناء، إدارة المقاولين والمناقصات، تسليم الوحدات، حوكمة الشركات والتحول الرقمي.`;
const N = 40;

const norm = (s: string) => (s || '').replace(/[ًٌٍَُِّْـ]/g, '');
const CONSTRUCTION_TERMS = ['مشروع', 'مقاول', 'مناقص', 'تسليم', 'موقع', 'بناء', 'إنشاء', 'وحد', 'عقار', 'بنية'];

const qs = await generateQuestions('مدير مشاريع', N, 'ar', true, undefined, orgContext);

const count = qs.length;
const text = qs.map(q => (q as any).questionText || '').join('\n');
const ntext = norm(text);
const namesCompany = qs.filter(q => /تال|الإعمارية|الاعمارية/.test(norm((q as any).questionText || ''))).length;
const termHits = CONSTRUCTION_TERMS.filter(t => ntext.includes(norm(t)));
const cats = qs.map(q => (q as any).category || (q as any).type || '?');
const tech = qs.filter(q => /tech|تقن/i.test((q as any).category || (q as any).competencyType || (q as any).framework || '')).length;
const letters = qs.map(q => (q as any).correctAnswer);
const letterDist = letters.reduce((a: any, l) => (a[l] = (a[l] || 0) + 1, a), {});
const minWordsRange = [Math.min(...qs.map(q => (q as any).minWords || 0)), Math.max(...qs.map(q => (q as any).minWords || 0))];

console.log('=== W3/W4 functional test ===');
console.log('requested count :', N, '| got:', count, count === N ? 'PASS' : 'FAIL');
console.log('names company   :', namesCompany, 'questions reference the company', namesCompany >= 2 ? 'PASS' : 'WARN(<2)');
console.log('industry terms  :', termHits.length, '/', CONSTRUCTION_TERMS.length, '→', termHits.join(' '));
console.log('correct-letter  :', JSON.stringify(letterDist), Object.keys(letterDist).length >= 3 ? 'PASS(distributed)' : 'WARN(skewed)');
console.log('minWords range  :', minWordsRange, minWordsRange[0] >= 8 ? 'PASS(floor>=8)' : 'FAIL');
console.log('\n--- sample Q1 ---\n', ((qs[0] as any).questionText || '').slice(0, 300));
const named = qs.find(q => /تال|الإعمارية|الاعمارية/.test(norm((q as any).questionText || '')));
if (named) console.log('\n--- a question naming the company ---\n', ((named as any).questionText || '').slice(0, 300));
