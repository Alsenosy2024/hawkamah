// Paper Assessment Service — creates shareable links with email+password access.
// External users (e.g. department managers) log in, configure the exam, then
// download a print-ready Arabic PDF with questions + model-answer sheet.

import { db } from '../firebase';
import { collection, doc, setDoc, getDoc } from 'firebase/firestore';
import type { PaperAssessmentToken, PaperQuestion, PaperDifficulty, PaperTheories, Language, JobRole } from '../types';
// PaperTheories, PaperDifficulty still used by generatePaperQuestions — do not remove
import { generateJson } from './agentOrchestrator';
import { getRolesForCompany } from '../constants';
import { Type } from '@google/genai';

const C_PAPER = 'paper_assessment_tokens';

// ---- Auth helpers ----

export async function hashPassword(pass: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pass));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function genToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

// ---- Token CRUD ----

export async function createPaperToken(
  tenantId: string,
  projectId: string,
  companyName: string,
  companyLogoUrl: string | undefined,
  language: Language,
  accessEmail: string,
  accessPassword: string,
): Promise<{ token: string; url: string }> {
  const id = genToken();
  const tok: PaperAssessmentToken = {
    id, tenantId, projectId, companyName, language,
    accessEmail: accessEmail.trim().toLowerCase(),
    accessPasswordHash: await hashPassword(accessPassword),
    active: true,
    createdAt: new Date().toISOString(),
    ...(companyLogoUrl ? { companyLogoUrl } : {}),
  };
  await setDoc(doc(db, C_PAPER, id), tok);
  const url = `${window.location.origin}/?paper=${id}`;
  return { token: id, url };
}

export async function getPaperToken(tokenId: string): Promise<PaperAssessmentToken | null> {
  const snap = await getDoc(doc(db, C_PAPER, tokenId));
  if (!snap.exists()) return null;
  return snap.data() as PaperAssessmentToken;
}

// Fetch job roles appropriate for the token's project sector.
// Falls back to empty array on error (caller uses JOB_TITLES_DEFAULT as fallback).
export async function getPaperProjectRoles(token: PaperAssessmentToken): Promise<JobRole[]> {
  try {
    const snap = await getDoc(doc(db, 'gov_projects', token.projectId));
    if (!snap.exists()) return [];
    const project = snap.data() as { industry?: string; jobRoles?: JobRole[] };
    return getRolesForCompany(project);
  } catch {
    return [];
  }
}

export async function verifyPaperAccess(
  token: PaperAssessmentToken,
  email: string,
  password: string,
): Promise<boolean> {
  const hash = await hashPassword(password);
  return token.accessEmail === email.trim().toLowerCase() && token.accessPasswordHash === hash;
}

// ---- Question generation ----

const questionSchema = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type:          { type: Type.STRING },
          text:          { type: Type.STRING },
          options:       { type: Type.ARRAY, items: { type: Type.STRING } },
          correctAnswer: { type: Type.STRING },
          theory:        { type: Type.STRING },
          rationale:     { type: Type.STRING },
        },
        required: ['type', 'text', 'options', 'correctAnswer'],
      },
    },
  },
  required: ['questions'],
};

const DIFFICULTY_AR: Record<PaperDifficulty, string> = {
  easy: 'سهل — أسئلة أساسية واضحة',
  medium: 'متوسط — يتطلب خبرة عملية',
  hard: 'صعب — تحليلي ومتقدم',
};

const THEORY_BRIEFS: { key: keyof PaperTheories; name: string; brief: string }[] = [
  { key: 'birkman',   name: 'Birkman Method',
    brief: 'منهج بيركمان: قِس التوافق البيئي وأنماط الضغط الاجتماعي وأسلوب التعامل تحت الضغط — صِغ مواقف تكشف السلوك المعتاد مقابل سلوك الضغط.' },
  { key: 'holland',   name: 'Holland RIASEC',
    brief: 'كود هولاند المهني (واقعي/بحثي/فني/اجتماعي/مبادِر/تقليدي): صِغ أسئلة تكشف الميول المهنية ومدى توافقها مع متطلبات الوظيفة.' },
  { key: 'psychTech', name: 'Psych Tech Scale',
    brief: 'مقياس السيناريوهات السلوكية المعيارية: مواقف عمل واقعية بخيارات استجابة متدرّجة تقيس الحكم المهني.' },
  { key: 'bloom',     name: "Bloom's Taxonomy",
    brief: 'تصنيف بلوم المعرفي: نوِّع مستويات الأسئلة (تطبيق/تحليل/تقييم) لا الحفظ فقط — خاصة في الأسئلة الفنية.' },
];

// 6 questions per batch: thinking disabled + 32k output budget → safe for complex Arabic scenarios.
const BATCH_MAX = 6;

async function generateBatch(
  jobTitle: string,
  type: 'behavioral' | 'technical',
  count: number,
  difficulty: PaperDifficulty,
  theoryBlock: string,
  signal?: AbortSignal,
): Promise<PaperQuestion[]> {
  const typeLabel = type === 'behavioral'
    ? 'سلوكية (behavioral) — تقيس الكفاءات القيادية والشخصية والمواقف المهنية بسيناريوهات واقعية (STAR method)'
    : 'فنية (technical) — تقيس المعرفة التقنية المتخصصة وتعكس مهام يومية حقيقية للوظيفة';

  const prompt = `أنت خبير تقييم وظيفي. أعدّ بالضبط ${count} سؤال اختيار متعدد لوظيفة: "${jobTitle}".

نوع الأسئلة: ${typeLabel}
ضع القيمة "${type}" في حقل "type" لكل سؤال.
مستوى الصعوبة: ${DIFFICULTY_AR[difficulty]}
${theoryBlock}
الشروط:
- 4 خيارات لكل سؤال (أ / ب / ج / د)
- إجابة صحيحة واحدة
- "rationale": جملة واحدة تشرح سبب صحة الإجابة
- لغة عربية فصيحة
- لا تكرر الأسئلة

أعد JSON فقط:
{"questions":[{"type":"${type}","text":"...","options":["أ. ...","ب. ...","ج. ...","د. ..."],"correctAnswer":"أ","theory":"","rationale":"..."}]}`;

  const res = await generateJson<{ questions: PaperQuestion[] }>(
    prompt,
    questionSchema,
    { signal, temperature: 0.7, maxOutputTokens: 32000, disableThinking: true, retries: 2 },
  );
  // Force the declared type (model occasionally mislabels) + drop malformed.
  return (res.questions || [])
    .filter(q => q && q.text && Array.isArray(q.options) && q.options.length >= 2)
    .map(q => ({ ...q, type }))
    .slice(0, count);
}

function chunkCounts(total: number, max: number): number[] {
  if (total <= 0) return [];
  const batches = Math.ceil(total / max);
  const base = Math.floor(total / batches);
  const rem = total - base * batches;
  return Array.from({ length: batches }, (_, i) => base + (i < rem ? 1 : 0));
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Fill exactly `target` questions of one type, retrying missing quota up to MAX_FILL_ROUNDS.
async function fillType(
  jobTitle: string,
  type: 'behavioral' | 'technical',
  target: number,
  difficulty: PaperDifficulty,
  theoryBlock: string,
  signal?: AbortSignal,
): Promise<PaperQuestion[]> {
  const MAX_FILL_ROUNDS = 2;
  const collected: PaperQuestion[] = [];

  for (let round = 0; round < MAX_FILL_ROUNDS && collected.length < target; round++) {
    if (signal?.aborted) break;
    const need = target - collected.length;
    const batches = chunkCounts(need, BATCH_MAX);
    const settled = await Promise.allSettled(
      batches.map(c => generateBatch(jobTitle, type, c, difficulty, theoryBlock, signal)),
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') collected.push(...s.value);
    }
    if (collected.length < target && round < MAX_FILL_ROUNDS - 1) {
      await sleep(600 * (round + 1));
    }
  }

  return collected.slice(0, target);
}

export async function generatePaperQuestions(
  jobTitle: string,
  count: number,
  difficulty: PaperDifficulty,
  behavioralPct: number,
  theories?: PaperTheories,
  signal?: AbortSignal,
): Promise<PaperQuestion[]> {
  const behCount = Math.round((count * behavioralPct) / 100);
  const techCount = count - behCount;

  const active = THEORY_BRIEFS.filter(t => theories?.[t.key]);
  const theoryBlock = active.length
    ? `\nأطر القياس النفسي/المهني المطلوب دمجها (وزّع الأسئلة المناسبة عليها واذكر الإطار في حقل "theory"):\n${active.map(t => `- ${t.name}: ${t.brief}`).join('\n')}\n`
    : '\nبدون أطر قياس نفسي خاصة — أسئلة كفاءة وظيفية مباشرة. اترك حقل "theory" فارغاً أو "general".\n';

  // Run both types in parallel; each type has its own fill-up loop.
  const [behavioral, technical] = await Promise.all([
    behCount > 0 ? fillType(jobTitle, 'behavioral', behCount, difficulty, theoryBlock, signal) : Promise.resolve([]),
    techCount > 0 ? fillType(jobTitle, 'technical',  techCount, difficulty, theoryBlock, signal) : Promise.resolve([]),
  ]);

  if (behavioral.length + technical.length === 0) {
    throw new Error('GENJSON_EMPTY: no questions generated after all retries');
  }

  return [...behavioral, ...technical];
}

// ---- PDF Builder ----

// Thmanyah font loader (reuses exportService pattern if available, else inline @import).
async function loadThmanyahCss(): Promise<string> {
  try {
    // Try to reuse the cached css from exportService
    const mod = await import('./exportService');
    // @ts-ignore — internal function not exported; fall through if unavailable
    if (typeof (mod as any)._thmanyahCss === 'string') return (mod as any)._thmanyahCss;
  } catch { /* ignore */ }
  // Fallback: load fonts from public/fonts directly
  const weights = [
    { file: 'thmanyah-sans-regular.ttf', weight: '400 600' },
    { file: 'thmanyah-sans-medium.ttf', weight: '500' },
    { file: 'thmanyah-sans-bold.ttf', weight: '700 900' },
  ];
  const faces: string[] = [];
  for (const f of weights) {
    try {
      const r = await fetch(`/fonts/${f.file}`);
      if (!r.ok) continue;
      const ab = await r.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
      faces.push(`@font-face{font-family:'Thmanyah Sans';src:url('data:font/woff2;base64,${b64}') format('woff2');font-weight:${f.weight};font-display:swap;}`);
    } catch { /* skip */ }
  }
  return faces.join('\n');
}

const OPTION_LABELS = ['أ', 'ب', 'ج', 'د'];

export async function buildPaperPdf(
  questions: PaperQuestion[],
  jobTitle: string,
  companyName: string,
  companyLogoUrl?: string,
  examDate?: string,
): Promise<void> {
  const fontCss = await loadThmanyahCss();
  const date = examDate || new Date().toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });

  const logoHtml = companyLogoUrl
    ? `<img src="${companyLogoUrl}" alt="logo" class="logo" />`
    : `<div class="logo-placeholder">شعار الجهة</div>`;

  const behavioral = questions.filter(q => q.type === 'behavioral');
  const technical  = questions.filter(q => q.type === 'technical');

  const renderQuestion = (q: PaperQuestion, idx: number) => `
    <div class="question">
      <div class="q-num">سؤال ${idx + 1}</div>
      <div class="q-text">${q.text}</div>
      <div class="q-options">
        ${q.options.map((opt, oi) => `<div class="opt"><span class="opt-label">${OPTION_LABELS[oi]}</span>${opt.replace(/^[أبجد]\.\s*/, '')}</div>`).join('')}
      </div>
    </div>`;

  const questionsHtml = questions.map((q, i) => renderQuestion(q, i)).join('');

  // Model answer table — includes framework + rationale when present
  const anyTheory = questions.some(q => q.theory && q.theory.toLowerCase() !== 'general');
  const anyRationale = questions.some(q => q.rationale);
  const answerRows = questions.map((q, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="ans-type">${q.type === 'behavioral' ? 'سلوكي' : 'فني'}</td>
      ${anyTheory ? `<td class="ans-theory">${q.theory && q.theory.toLowerCase() !== 'general' ? q.theory : '—'}</td>` : ''}
      <td class="ans-cell">${q.correctAnswer}</td>
      ${anyRationale ? `<td class="ans-rationale">${q.rationale || ''}</td>` : ''}
    </tr>`).join('');

  // Score bands
  const total = questions.length;
  const pass = Math.round(total * 0.6);
  const good = Math.round(total * 0.75);
  const excel = Math.round(total * 0.9);

  const html = `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<title>تقييم ${jobTitle}</title>
<style>
${fontCss}
*, *::before, *::after { box-sizing: border-box; }
body {
  font-family: 'Thmanyah Sans', 'Cairo', 'Tajawal', sans-serif;
  direction: rtl; text-align: right;
  color: #1a1a2e; background: #fff;
  margin: 0; padding: 0;
  font-size: 14px; line-height: 1.9;
}
.page { width: 210mm; min-height: 297mm; padding: 18mm 20mm; margin: 0 auto; }
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { page-break-after: always; }
  .no-break { page-break-inside: avoid; }
}

/* ---- Header ---- */
.header { display: flex; align-items: center; gap: 16px; border-bottom: 3px solid #1B4F72; padding-bottom: 16px; margin-bottom: 24px; }
.logo { height: 64px; width: auto; object-fit: contain; }
.logo-placeholder { width: 64px; height: 64px; border: 2px dashed #ccc; border-radius: 8px; display:flex; align-items:center; justify-content:center; color:#aaa; font-size:10px; text-align:center; }
.header-info { flex: 1; }
.company-name { font-size: 20px; font-weight: 800; color: #1B4F72; }
.exam-title { font-size: 16px; font-weight: 600; color: #2E86C1; margin-top: 2px; }
.exam-meta { font-size: 12px; color: #666; margin-top: 6px; }

/* ---- Candidate box ---- */
.candidate-box {
  border: 1.5px solid #1B4F72; border-radius: 10px;
  padding: 14px 18px; margin-bottom: 24px;
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px;
}
.candidate-box .field { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.candidate-box .field label { font-weight: 700; color: #1B4F72; white-space: nowrap; }
.candidate-box .field .line { flex: 1; border-bottom: 1.5px solid #1B4F72; height: 20px; }

/* ---- Instructions ---- */
.instructions { background: #EBF5FB; border-right: 4px solid #2E86C1; border-radius: 8px; padding: 12px 16px; margin-bottom: 28px; font-size: 13px; }
.instructions h3 { margin: 0 0 8px; font-size: 14px; color: #1B4F72; }
.instructions ul { margin: 0; padding-right: 20px; }
.instructions li { margin-bottom: 4px; }

/* ---- Section header ---- */
.section-header {
  background: linear-gradient(135deg, #1B4F72, #2E86C1);
  color: #fff; padding: 10px 18px; border-radius: 8px;
  font-size: 15px; font-weight: 700; margin: 28px 0 16px;
  display: flex; align-items: center; gap: 10px;
}
.section-badge {
  background: rgba(255,255,255,0.25); border-radius: 20px;
  padding: 2px 12px; font-size: 12px; font-weight: 600;
}

/* ---- Questions ---- */
.question { margin-bottom: 22px; padding: 14px 16px; border: 1px solid #e8e8e8; border-radius: 8px; page-break-inside: avoid; }
.q-num { font-size: 11px; font-weight: 700; color: #2E86C1; margin-bottom: 6px; letter-spacing: 0.5px; }
.q-text { font-size: 14px; font-weight: 600; color: #1a1a2e; margin-bottom: 12px; line-height: 1.7; }
.q-options { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; }
.opt { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; padding: 6px 8px; border-radius: 6px; border: 1px solid #f0f0f0; }
.opt-label { font-weight: 800; color: #1B4F72; min-width: 18px; background: #EBF5FB; border-radius: 4px; padding: 0 5px; text-align: center; flex-shrink: 0; }

/* ---- Answer sheet ---- */
.answer-page { page-break-before: always; }
.answer-header { background: #1B4F72; color: #fff; padding: 16px 20px; border-radius: 10px; text-align: center; margin-bottom: 24px; }
.answer-header h2 { margin: 0; font-size: 20px; }
.answer-header p { margin: 6px 0 0; font-size: 13px; opacity: 0.85; }

table.answer-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 24px; }
table.answer-table th { background: #2E86C1; color: #fff; padding: 10px 14px; font-weight: 700; border: 1px solid #2E86C1; }
table.answer-table td { padding: 9px 14px; border: 1px solid #ddd; text-align: center; }
table.answer-table tr:nth-child(even) td { background: #F8FBFD; }
.ans-cell { font-size: 18px; font-weight: 800; color: #1B4F72; }
.ans-type { font-size: 11px; }
.ans-theory { font-size: 11px; font-weight: 700; color: #8E44AD; }
.ans-rationale { font-size: 11px; text-align: right; color: #555; line-height: 1.6; }
.type-behavioral { color: #8E44AD; }
.type-technical  { color: #117A65; }

/* ---- Score guide ---- */
.score-guide { border: 2px solid #1B4F72; border-radius: 10px; overflow: hidden; margin-top: 20px; }
.score-guide h3 { background: #1B4F72; color: #fff; margin: 0; padding: 10px 16px; font-size: 14px; }
.score-bands { display: grid; grid-template-columns: repeat(4, 1fr); }
.band { padding: 12px; text-align: center; border-left: 1px solid #ddd; }
.band:last-child { border-left: none; }
.band .range { font-size: 18px; font-weight: 800; }
.band .label { font-size: 12px; margin-top: 4px; font-weight: 600; }
.band-fail  { background: #FDEDEC; color: #C0392B; }
.band-pass  { background: #FDFEFE; color: #1a1a2e; }
.band-good  { background: #E9F7EF; color: #196F3D; }
.band-excel { background: #EBF5FB; color: #1B4F72; }

.footer { text-align: center; font-size: 11px; color: #aaa; margin-top: 32px; border-top: 1px solid #eee; padding-top: 12px; }
</style>
</head>
<body>

<!-- ============ EXAM PAGES ============ -->
<div class="page">

  <!-- Header -->
  <div class="header">
    ${logoHtml}
    <div class="header-info">
      <div class="company-name">${companyName}</div>
      <div class="exam-title">اختبار التقييم الوظيفي — ${jobTitle}</div>
      <div class="exam-meta">التاريخ: ${date} &nbsp;|&nbsp; عدد الأسئلة: ${total} سؤال &nbsp;|&nbsp; الزمن: ${Math.ceil(total * 1.5)} دقيقة</div>
    </div>
  </div>

  <!-- Candidate info -->
  <div class="candidate-box">
    <div class="field"><label>اسم المتقدم:</label><div class="line"></div></div>
    <div class="field"><label>الرقم الوظيفي:</label><div class="line"></div></div>
    <div class="field"><label>القسم / الإدارة:</label><div class="line"></div></div>
    <div class="field"><label>توقيع المشرف:</label><div class="line"></div></div>
  </div>

  <!-- Instructions -->
  <div class="instructions">
    <h3>📋 تعليمات الاختبار</h3>
    <ul>
      <li>اقرأ كل سؤال بعناية قبل الإجابة.</li>
      <li>اختر إجابة واحدة فقط لكل سؤال بوضع دائرة حول الحرف المناسب.</li>
      <li>لا يُسمح باستخدام أي مراجع أو أجهزة ذكية خلال الاختبار.</li>
      <li>الوقت المخصص: ${Math.ceil(total * 1.5)} دقيقة — إدارة وقتك بحكمة.</li>
      <li>درجة النجاح: ${pass}/${total} (${Math.round(pass / total * 100)}٪)</li>
    </ul>
  </div>

  ${behavioral.length > 0 ? `
  <!-- Behavioral Section -->
  <div class="section-header">
    <span>الجزء الأول: الأسئلة السلوكية</span>
    <span class="section-badge">${behavioral.length} سؤال</span>
  </div>
  ${behavioral.map((q, i) => renderQuestion(q, i)).join('')}
  ` : ''}

  ${technical.length > 0 ? `
  <!-- Technical Section -->
  <div class="section-header">
    <span>الجزء الثاني: الأسئلة الفنية</span>
    <span class="section-badge">${technical.length} سؤال</span>
  </div>
  ${technical.map((q, i) => renderQuestion(q, behavioral.length + i)).join('')}
  ` : ''}

  <div class="footer">اختبار تقييم وظيفي — ${companyName} — ${date}</div>
</div>

<!-- ============ ANSWER SHEET ============ -->
<div class="page answer-page">
  <div class="answer-header">
    <h2>📋 ورقة الإجابات النموذجية</h2>
    <p>${companyName} &nbsp;|&nbsp; اختبار ${jobTitle} &nbsp;|&nbsp; ${date}</p>
    <p style="opacity:.7;font-size:11px">للاستخدام الداخلي فقط — لا تُوزَّع على المتقدمين</p>
  </div>

  <table class="answer-table">
    <thead>
      <tr>
        <th style="width:50px">رقم</th>
        <th style="width:80px">النوع</th>
        ${anyTheory ? '<th style="width:120px">الإطار</th>' : ''}
        <th style="width:90px">الإجابة</th>
        ${anyRationale ? '<th>مبرر الإجابة</th>' : ''}
      </tr>
    </thead>
    <tbody>
      ${answerRows}
    </tbody>
  </table>

  <!-- Score bands -->
  <div class="score-guide">
    <h3>دليل التصحيح والدرجات</h3>
    <div class="score-bands">
      <div class="band band-fail">
        <div class="range">0 – ${pass - 1}</div>
        <div class="label">دون المستوى</div>
      </div>
      <div class="band band-pass">
        <div class="range">${pass} – ${good - 1}</div>
        <div class="label">مقبول</div>
      </div>
      <div class="band band-good">
        <div class="range">${good} – ${excel - 1}</div>
        <div class="label">جيد</div>
      </div>
      <div class="band band-excel">
        <div class="range">${excel} – ${total}</div>
        <div class="label">ممتاز</div>
      </div>
    </div>
  </div>

  <div style="margin-top:24px;padding:14px 18px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;color:#555;">
    <strong style="color:#1B4F72">ملاحظة التصحيح:</strong><br>
    الأسئلة السلوكية: ${behavioral.length} × 1 درجة = ${behavioral.length} درجة &nbsp;|&nbsp;
    الأسئلة الفنية: ${technical.length} × 1 درجة = ${technical.length} درجة &nbsp;|&nbsp;
    المجموع: ${total} درجة
  </div>

  <div class="footer">ورقة إجابات نموذجية — ${companyName} — يُحظر نشرها قبل الاختبار</div>
</div>

</body>
</html>`;

  // Trigger print-to-PDF
  const w = window.open('', '_blank');
  if (!w) {
    // Fallback: blob download
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `تقييم_${jobTitle}_${date}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  w.document.write(html);
  w.document.close();
  w.onload = () => {
    setTimeout(() => w.print(), 500);
  };
}
