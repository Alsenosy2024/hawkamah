import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Language, WorkEnvironmentAnswers } from '../types';
import { TRANSLATIONS } from '../constants';
import { SURVEY_FIELD_META, SurveyComplexity, transcribeAudio } from '../services/geminiService';
import { MicRecorder, MicRecordError } from '../lib/audioRecorder';

interface WorkplaceSurveyScreenProps {
  onSubmit: (answers: WorkEnvironmentAnswers) => void;
  language: Language;
  wordLimits?: { [field: string]: number };  // per-question minimum word counts (org-aware)
  mandatory?: boolean;  // admin-locked: answering enforced
}

// Count words (Arabic + Latin), collapsing whitespace.
const countWords = (text: string): number =>
  text.trim() ? text.trim().split(/\s+/).length : 0;

const COMPLEXITY_BADGE: Record<SurveyComplexity, { ar: string; en: string; cls: string }> = {
  low:    { ar: 'بسيط',  en: 'Simple',  cls: 'bg-sky-50 text-sky-600 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-800' },
  medium: { ar: 'متوسط', en: 'Medium',  cls: 'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800' },
  high:   { ar: 'تحليلي', en: 'In-depth', cls: 'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800' },
};

const PER_PAGE = 3;

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTIVE BRANCHING (deterministic, rule-based — no mid-survey LLM call).
//
// A follow-up is a targeted question that is revealed only when the respondent's
// answer to its parent base field satisfies `when(answer)`. Visibility is a pure
// function of the current answers, recomputed on every render, so it updates
// reactively as the user types/selects without ever discarding entered text
// (follow-up text lives in its own keyed state and persists even if hidden again).
//
// Each base field may declare zero or more follow-ups. Reveal is inline: an active
// follow-up is inserted into the flow right after its parent, then pagination and
// "next/submit" gating operate on the resulting visible list.
// ─────────────────────────────────────────────────────────────────────────────
interface SurveyFollowUp {
  id: string;                                  // stable key, stored in answers.followUps[id]
  parent: keyof WorkEnvironmentAnswers;        // base field this branch hangs off
  when: (parentAnswer: string) => boolean;     // deterministic gate over the parent's answer
  complexity: SurveyComplexity;
  icon: string;
  minWords: number;                            // intrinsic minimum for the follow-up
  label: { ar: string; en: string };
  desc: { ar: string; en: string };
  placeholder: { ar: string; en: string };
}

// Helper gates (deterministic, content-based).
const isSubstantive = (a: string) => countWords(a) >= 3;
const mentionsAny = (a: string, terms: string[]) => {
  const t = a.toLowerCase();
  return terms.some(w => t.includes(w.toLowerCase()));
};

// Seeded branch rules — visibly demonstrate the feature.
//   1) If the respondent actually describes a challenge → ask for one concrete example.
//   2) If their digital-infrastructure answer reports weakness/old/slow tooling →
//      ask which single tool, if fixed, would help the most.
const FOLLOW_UPS: SurveyFollowUp[] = [
  {
    id: 'challengeConcreteExample',
    parent: 'challengesAndProblems',
    when: isSubstantive, // any substantive challenge answer triggers a concrete example
    complexity: 'high',
    icon: '',
    minWords: 12,
    label: { ar: 'مثال محدد على التحدي', en: 'A concrete example of the challenge' },
    desc: {
      ar: 'بما أنك ذكرت تحدياً، صف حادثة واقعية واحدة حدثت مؤخراً: ماذا حصل، ومتى، وما الأثر الفعلي على العمل؟',
      en: 'Since you reported a challenge, describe one real recent incident: what happened, when, and the actual impact on the work.',
    },
    placeholder: {
      ar: 'مثال: في الأسبوع الماضي تأخر اعتماد أمر شراء عاجل 4 أيام مما أوقف خط الفحص...',
      en: 'e.g., Last week an urgent purchase order took 4 days to approve, halting the inspection line...',
    },
  },
  {
    id: 'digitalTopFix',
    parent: 'digitalInfrastructure',
    when: (a) => isSubstantive(a) && mentionsAny(a, [
      // Arabic weakness signals
      'قديم', 'بطيء', 'بطء', 'ضعيف', 'ينقص', 'نقص', 'انقطاع', 'مشكلة', 'يحتاج', 'تحديث', 'متوسط',
      // English weakness signals
      'old', 'slow', 'weak', 'lack', 'missing', 'outdated', 'down', 'issue', 'need', 'upgrade', 'intermediate', 'basic',
    ]),
    complexity: 'medium',
    icon: '',
    minWords: 8,
    label: { ar: 'الأولوية الرقمية الأهم', en: 'The single most impactful digital fix' },
    desc: {
      ar: 'لاحظنا إشارة لضعف أو نقص رقمي. لو أمكن إصلاح أداة أو نظام واحد فقط، فما هو ولماذا سيكون الأكثر تأثيراً؟',
      en: 'We noticed a sign of a digital gap. If only one tool or system could be fixed, which one and why would it matter most?',
    },
    placeholder: {
      ar: 'مثال: نظام ERP موحد يربط المشتريات بالمخزون، لأنه يلغي الإدخال اليدوي المزدوج...',
      en: 'e.g., A unified ERP linking procurement and inventory, because it removes duplicate manual entry...',
    },
  },
];

const WorkplaceSurveyScreen: React.FC<WorkplaceSurveyScreenProps> = ({ onSubmit, language, wordLimits, mandatory = true }) => {
  const T = TRANSLATIONS[language];

  // Raw states keyed to WorkEnvironmentAnswers fields.
  const [procedures, setProcedures] = useState('');
  const [digitalInfo, setDigitalInfo] = useState('');
  const [challenges, setChallenges] = useState('');
  const [relations, setRelations] = useState('');
  const [aspirations, setAspirations] = useState('');
  const [reconstruct, setReconstruct] = useState('');
  // Follow-up answers live in their own keyed map so they are never lost when a
  // branch is temporarily hidden (e.g. the user edits the parent back and forth).
  const [followUpValues, setFollowUpValues] = useState<{ [id: string]: string }>({});
  const [attempted, setAttempted] = useState(false);
  const [page, setPage] = useState(0);

  // ── Per-field dictation (STT): speak instead of typing long free-text answers ──
  // Rebuilt on MicRecorder (raw PCM → 16 kHz WAV) + Gemini transcription, NOT the
  // browser's webkitSpeechRecognition which recorded then SAVED NOTHING here (owner
  // report 2026-06-16: "قعدت أسجل وما سجلش"). Tap to record, tap again to stop →
  // we transcribe the captured audio and APPEND it to the field. Feature-detected;
  // any failure surfaces a clear reason and falls back to typing.
  const STT_OK = typeof window !== 'undefined' &&
    !!navigator?.mediaDevices?.getUserMedia &&
    !!(window.AudioContext || (window as any).webkitAudioContext);
  const [micKey, setMicKey] = useState<string | null>(null);        // field currently recording
  const [transcribingKey, setTranscribingKey] = useState<string | null>(null);  // field being transcribed
  const [micBlocked, setMicBlocked] = useState(false);              // permission denied / unavailable
  const [micLevel, setMicLevel] = useState(0);                      // live VU level 0..1 (proves capture)
  const recRef = useRef<MicRecorder | null>(null);
  const micBaseRef = useRef('');                                    // text already in the field when recording started
  const micSetRef = useRef<(v: string) => void>(() => { /* noop */ });
  const micKeyRef = useRef<string | null>(null);                    // active field key, for async callbacks

  // Stop the active recorder, transcribe what was captured, append to the field.
  const stopMic = useCallback(async () => {
    const rec = recRef.current;
    const key = micKeyRef.current;
    const set = micSetRef.current;
    recRef.current = null;
    micKeyRef.current = null;
    setMicKey(null);
    setMicLevel(0);
    if (!rec || !key) return;
    let wav: { base64: string; mimeType: string } | null = null;
    try { wav = await rec.stop(); }
    catch (e) {
      // 'empty' = nothing captured (user stopped instantly) → just no-op, not an error banner.
      if ((e as MicRecordError)?.reason !== 'empty') setMicBlocked(true);
      return;
    }
    setTranscribingKey(key);
    try {
      const text = await transcribeAudio(wav.base64, wav.mimeType, language);
      if (text.trim()) set(micBaseRef.current + text.trim());
    } catch { /* transcription failed → leave existing text, user can type */ }
    finally { setTranscribingKey(k => (k === key ? null : k)); }
  }, [language]);

  const toggleMic = useCallback(async (key: string, value: string, set: (v: string) => void) => {
    if (micKey === key) { await stopMic(); return; }       // tap again on same field → stop + transcribe
    if (recRef.current) { try { recRef.current.abort(); } catch { /* noop */ } recRef.current = null; }  // switching field → drop the other
    const rec = new MicRecorder((lvl) => setMicLevel(lvl));
    micBaseRef.current = value ? value.trimEnd() + ' ' : '';
    micSetRef.current = set;
    try {
      await rec.start();
      recRef.current = rec;
      micKeyRef.current = key;
      setMicBlocked(false);
      setMicKey(key);
    } catch (e) {
      const reason = (e as MicRecordError)?.reason;
      if (reason === 'permission' || reason === 'insecure' || reason === 'unsupported') setMicBlocked(true);
      try { rec.abort(); } catch { /* noop */ }
      recRef.current = null;
      micKeyRef.current = null;
      setMicKey(null);
    }
  }, [micKey, stopMic]);

  // Stop any active recorder on unmount (prevents leaked mic capture).
  useEffect(() => () => { try { recRef.current?.abort(); } catch { /* noop */ } recRef.current = null; }, []);

  type VisibleItem = {
    key: string;                 // base field key OR follow-up id (unique, used for DOM id)
    kind: 'base' | 'followUp';
    value: string;
    set: (v: string) => void;
    label: string;
    desc: string;
    placeholder: string;
    icon: string;
    complexity: SurveyComplexity;
    minWords: number;            // intrinsic minimum (org-aware override applies for base fields)
  };

  const setFollowUp = (id: string) => (v: string) =>
    setFollowUpValues(prev => ({ ...prev, [id]: v }));

  // The 6 static base fields.
  const baseFields: {
    key: keyof WorkEnvironmentAnswers;
    value: string;
    set: (v: string) => void;
    label: string;
    desc: string;
    placeholder: string;
    icon: string;
  }[] = [
    { key: 'proceduresAndPolicies', value: procedures, set: setProcedures, label: T.proceduresLabel, desc: T.proceduresDesc, icon: '',
      placeholder: language === 'ar' ? 'مثال: المعاملات الإدارية تسير ببطء والسياسات غير واضحة للجميع...' : 'e.g., Administrative approvals take several days...' },
    { key: 'digitalInfrastructure', value: digitalInfo, set: setDigitalInfo, label: T.digitalLabel, desc: T.digitalDesc, icon: '',
      placeholder: language === 'ar' ? 'مثال: الأجهزة قديمة وتحتاج لتحديث ونعاني من انقطاع الخدمة المتقطع...' : 'e.g., The tools are modern but we lack centralized cloud solutions...' },
    { key: 'challengesAndProblems', value: challenges, set: setChallenges, label: T.challengesLabel, desc: T.challengesDesc, icon: '',
      placeholder: language === 'ar' ? 'مثال: تضارب الصلاحيات، تأخر صرف بدلات أو موافقة على عقود فحص جودة...' : 'e.g., Major delays on supplier contracts and unclear individual KPIs...' },
    { key: 'employeeRelationships', value: relations, set: setRelations, label: T.employeeRelationsLabel, desc: T.employeeRelationsDesc, icon: '',
      placeholder: language === 'ar' ? 'مثال: التعاون ممتاز ولكن التواصل بين الأقسام منقطع جزئياً...' : 'e.g., Outstanding coworker relationship but vertical communications are heavily layered...' },
    { key: 'aspirationsAndDevelopment', value: aspirations, set: setAspirations, label: T.aspirationsLabel, desc: T.aspirationsDesc, icon: '',
      placeholder: language === 'ar' ? 'مثال: أطمح لعمل خطة تأصيلية للمهارات وتوفير مسار ترقية عادل...' : 'e.g., Clear technical scale up track and fair advancement frameworks...' },
    { key: 'organizationalReconstructionOpinion', value: reconstruct, set: setReconstruct, label: T.reconstructionLabel, desc: T.reconstructionDesc, icon: '',
      placeholder: language === 'ar' ? 'مثال: دمج الإدارة الوسطى لتسهيل القرارات أو تعيين منسقي جودة إضافيين...' : 'e.g., Decentering operational tasks and giving more autonomous authority to line managers...' },
  ];

  // Read the current value of any base field (used by branch gates).
  const baseValueOf = (key: keyof WorkEnvironmentAnswers): string =>
    baseFields.find(b => b.key === key)?.value ?? '';

  // Dynamic per-question minimum for BASE fields: max of the field's intrinsic
  // baseline and any org-aware override from deriveSurveyMinimums. No flat floor.
  const baseMinFor = (key: string) => {
    if (!mandatory) return 0;
    const base = SURVEY_FIELD_META[key]?.baseMin ?? 0;
    return Math.max(base, wordLimits?.[key] ?? 0);
  };

  // Build the reactive VISIBLE list: each base field, followed inline by any of
  // its follow-ups whose `when(parentAnswer)` currently holds. Pure function of
  // the current answers ⇒ recomputed every render, so visibility tracks input live.
  const visibleItems: VisibleItem[] = [];
  for (const b of baseFields) {
    visibleItems.push({
      key: b.key,
      kind: 'base',
      value: b.value,
      set: b.set,
      label: b.label,
      desc: b.desc,
      placeholder: b.placeholder,
      icon: b.icon,
      complexity: SURVEY_FIELD_META[b.key]?.complexity ?? 'medium',
      minWords: baseMinFor(b.key),
    });
    for (const fu of FOLLOW_UPS) {
      if (fu.parent !== b.key) continue;
      if (!fu.when(b.value)) continue;
      visibleItems.push({
        key: fu.id,
        kind: 'followUp',
        value: followUpValues[fu.id] ?? '',
        set: setFollowUp(fu.id),
        label: language === 'ar' ? fu.label.ar : fu.label.en,
        desc: language === 'ar' ? fu.desc.ar : fu.desc.en,
        placeholder: language === 'ar' ? fu.placeholder.ar : fu.placeholder.en,
        icon: fu.icon,
        complexity: fu.complexity,
        minWords: mandatory ? fu.minWords : 0,
      });
    }
  }

  const deficient = visibleItems.filter(it => countWords(it.value) < it.minWords);

  // Pagination operates on the visible list (which may grow/shrink as branches open).
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = visibleItems.slice(safePage * PER_PAGE, safePage * PER_PAGE + PER_PAGE);
  const pageDeficient = pageItems.filter(it => countWords(it.value) < it.minWords);

  // Auto-fill template to make testing super fast and rich
  const handleAutoFill = () => {
    if (language === 'ar') {
      setProcedures('الإجراءات الإدارية واضحة ولكن نعاني من بطء في سلسلة الموافقات واعتماد بعض المعاملات بسبب البيروقراطية والتوقيعات المتعددة.');
      setDigitalInfo('البنية الرقمية متوسطة؛ لدينا أجهزة جيدة وشبكة داخلية مقبولة، ولكن ينقصنا نظام موحد لإدارة المشاريع السحابية ERP يربط كل الأقسام معاً وسرعة الدعم الفني تحتاج لتحسين.');
      setChallenges('أبرز التحديات هي ضعف التنسيق بين الإدارات لإنجاز المعاملات، والموافقة المتأخرة على طلبات الشراء اللوجستية، وازدواجية المهام في بعض الأحيان.');
      setRelations('العلاقة بين الزملاء ممتازة ويسودها الاحترام وبناءة، ولكن التواصل مع بعض الإدارات العليا يحتاج إلى قنوات أكثر مرونة ومباشرة.');
      setAspirations('أطمح إلى توفير خطط تدريب واضحة ومسار مهني محدد، والمساهمة في بناء بيئة عمل متميزة عبر تبني ممارسات الجودة الشاملة.');
      setReconstruct('أقترح دمج قسم المشتريات والخدمات المساندة لتبسيط المعاملات وتوفير لوحة تحكم ذكية لتتبع حالة المعاملات المباشرة فورياً.');
      setFollowUpValues({
        challengeConcreteExample: 'الأسبوع الماضي تأخر اعتماد أمر شراء عاجل لمواد فحص الجودة أربعة أيام بسبب غياب أحد الموقعين، مما أوقف خط الفحص وأخّر تسليم المشروع للعميل.',
        digitalTopFix: 'أهم إصلاح هو نظام ERP موحد يربط المشتريات بالمخزون والمالية، لأنه يلغي الإدخال اليدوي المزدوج ويقلّل الأخطاء ويسرّع الموافقات بشكل كبير.',
      });
    } else {
      setProcedures('Administrative processes are clear but we suffer from slow sequential approval workflows due to excessive hierarchy and multiple physical signatures.');
      setDigitalInfo('The digital system is intermediate. Hardware is acceptable but we lack an integrated ERP cloud system linking all departments. IT helpdesk speeds need upgrade.');
      setChallenges('Core issues relate to delayed cross-department feedback on client deliverables, slow logistics supply line approvals, and repetitive task assignments.');
      setRelations('Strong respectful coworker synergies. However, communication channels leading to senior management are rigid and could be more direct.');
      setAspirations('I aspire to see comprehensive training roadmaps, structured professional pathing, and participative innovation councils for quality initiatives.');
      setReconstruct('I suggest merging the logistics and procurement desks to streamline overhead, and creating a live digital tracking dashboard for request lifecycle status.');
      setFollowUpValues({
        challengeConcreteExample: 'Last week an urgent purchase order for quality-inspection materials took four days to approve because a signatory was away, which halted the inspection line and delayed the client deliverable.',
        digitalTopFix: 'The most impactful fix would be a unified ERP linking procurement, inventory and finance, because it eliminates duplicate manual entry and dramatically speeds approvals.',
      });
    }
  };

  const scrollToFirstDeficient = (list: VisibleItem[]) => {
    const el = document.getElementById(`survey-field-${list[0].key}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleNext = () => {
    setAttempted(true);
    if (pageDeficient.length > 0) { scrollToFirstDeficient(pageDeficient); return; }
    stopMic();  // fields on this page are about to unmount
    setAttempted(false);
    setPage(Math.min(totalPages - 1, safePage + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleBack = () => {
    stopMic();
    setAttempted(false);
    setPage(Math.max(0, safePage - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    // Validate the whole VISIBLE survey; jump to the first page that still has a gap.
    if (deficient.length > 0) {
      const firstBadPage = Math.floor(visibleItems.findIndex(it => it.key === deficient[0].key) / PER_PAGE);
      if (firstBadPage !== safePage) { setPage(firstBadPage); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      scrollToFirstDeficient(deficient);
      return;
    }
    // Only persist follow-up answers that are currently visible (active branches).
    const activeFollowUps: { [id: string]: string } = {};
    for (const it of visibleItems) {
      if (it.kind === 'followUp' && it.value.trim()) activeFollowUps[it.key] = it.value;
    }
    onSubmit({
      proceduresAndPolicies: procedures,
      digitalInfrastructure: digitalInfo,
      challengesAndProblems: challenges,
      employeeRelationships: relations,
      aspirationsAndDevelopment: aspirations,
      organizationalReconstructionOpinion: reconstruct,
      ...(Object.keys(activeFollowUps).length ? { followUps: activeFollowUps } : {}),
    });
  };

  const isLastPage = safePage === totalPages - 1;

  return (
    <div className="flex flex-col h-full animate-fade-in text-start">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pb-5 mb-5 border-b border-slate-200 dark:border-slate-700">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-slate-100">
            {T.workplaceSurveyTitle}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{T.workplaceSurveyExplain}</p>
        </div>
        <button
          type="button"
          onClick={handleAutoFill}
          className="shrink-0 self-start text-xs text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 font-semibold py-1.5 px-3 rounded-md border border-emerald-200 dark:border-emerald-800 transition-colors duration-150"
        >
          {language === 'ar' ? 'تعبئة افتراضية' : 'Demo fill'}
        </button>
      </div>

      {/* Step progress */}
      <div className="mb-5">
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
          <span className="font-semibold">
            {language === 'ar' ? `الصفحة ${safePage + 1} من ${totalPages}` : `Page ${safePage + 1} of ${totalPages}`}
          </span>
          <span>
            {language === 'ar'
              ? `${visibleItems.length - deficient.length} / ${visibleItems.length} مكتمل`
              : `${visibleItems.length - deficient.length} / ${visibleItems.length} complete`}
          </span>
        </div>
        <div className="h-1 w-full bg-slate-100 dark:bg-slate-700 rounded-sm overflow-hidden">
          <div
            className="h-full bg-emerald-600 rounded-sm transition-all duration-300"
            style={{ width: `${((safePage + 1) / totalPages) * 100}%` }}
          />
        </div>
      </div>

      {/* Intro note */}
      <div className="bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 rounded-md px-4 py-3 mb-6 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
        {T.surveyIntro}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Single-column question list */}
        <div className="space-y-4">
          {pageItems.map(it => {
            const min = it.minWords;
            const wc = countWords(it.value);
            const short = wc < min;
            const badge = COMPLEXITY_BADGE[it.complexity];
            const isFollowUp = it.kind === 'followUp';
            return (
              <div
                key={it.key}
                id={`survey-field-${it.key}`}
                className={`rounded-lg border transition-colors duration-150 ${
                  isFollowUp
                    ? 'bg-slate-50/60 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 animate-fade-in ms-4'
                    : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700'
                }`}
              >
                {/* Card header band */}
                <div className={`flex items-center justify-between gap-3 px-4 py-3 border-b ${
                  isFollowUp
                    ? 'border-slate-100 dark:border-slate-700/60'
                    : 'border-slate-100 dark:border-slate-700/60'
                }`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {isFollowUp && (
                      <span className="text-emerald-500 dark:text-emerald-400 text-xs font-semibold shrink-0 select-none">↳</span>
                    )}
                    <label
                      htmlFor={`textarea-${it.key}`}
                      className="text-sm font-semibold text-slate-800 dark:text-slate-100 leading-snug cursor-pointer"
                    >
                      {it.label}
                    </label>
                  </div>
                  <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-sm border ${badge.cls}`}>
                    {language === 'ar' ? badge.ar : badge.en}
                  </span>
                </div>

                {/* Card body */}
                <div className="px-4 py-3 space-y-3">
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{it.desc}</p>

                  <textarea
                    id={`textarea-${it.key}`}
                    required={min > 0}
                    value={it.value}
                    onChange={(e) => it.set(e.target.value)}
                    rows={4}
                    className={`w-full p-3 border rounded-md focus:outline-none focus:ring-2 text-sm bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 leading-relaxed resize-y transition-colors duration-150 ${
                      attempted && short
                        ? 'border-rose-400 focus:ring-rose-400/40'
                        : 'border-slate-200 dark:border-slate-600 focus:ring-emerald-500/30 focus:border-emerald-500'
                    }`}
                    placeholder={it.placeholder}
                  />

                  {/* Dictation button */}
                  {STT_OK && (
                    <button
                      type="button"
                      disabled={transcribingKey === it.key}
                      onClick={() => { void toggleMic(it.key, it.value, it.set); }}
                      className={`w-full flex items-center justify-center gap-2 py-2 px-3 rounded-md border font-semibold text-xs transition-colors duration-150 ${
                        micKey === it.key
                          ? 'bg-rose-500 border-rose-500 text-white'
                          : transcribingKey === it.key
                            ? 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-700 text-amber-700 dark:text-amber-300 cursor-wait'
                            : 'bg-slate-50 dark:bg-slate-700/50 border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-emerald-700 dark:hover:text-emerald-300 hover:border-emerald-300 dark:hover:border-emerald-700'
                      }`}
                    >
                      {micKey === it.key ? (
                        <>
                          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                          {language === 'ar' ? 'إيقاف التسجيل' : 'Stop recording'}
                          {/* Live VU bars */}
                          <span className="flex items-end gap-0.5 h-3.5 ms-1">
                            {[0.15, 0.4, 0.7, 0.95].map((thresh, i) => (
                              <span
                                key={i}
                                className={`w-1 rounded-sm ${micLevel >= thresh ? 'bg-white' : 'bg-white/40'}`}
                                style={{ height: `${Math.max(25, Math.min(100, (micLevel >= thresh ? micLevel : 0.15) * 100))}%` }}
                              />
                            ))}
                          </span>
                        </>
                      ) : transcribingKey === it.key ? (
                        <>
                          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                          {language === 'ar' ? 'يحوّل كلامك إلى نص…' : 'Transcribing…'}
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3z" />
                          </svg>
                          {language === 'ar' ? 'سجّل صوتك بدل الكتابة' : 'Record instead of typing'}
                        </>
                      )}
                    </button>
                  )}

                  {/* Recording status line */}
                  {micKey === it.key && (
                    <div className="flex items-center gap-2 text-[11px] font-semibold text-rose-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                      {language === 'ar'
                        ? 'يسجّل الآن... تكلّم ثم اضغط «إيقاف».'
                        : 'Recording — speak, then press Stop.'}
                    </div>
                  )}

                  {/* Word count */}
                  {min > 0 && (
                    <div className={`flex items-center gap-1.5 text-[11px] font-semibold ${short ? 'text-rose-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                      {short ? (
                        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z" />
                        </svg>
                      ) : (
                        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      <span>
                        {language === 'ar'
                          ? `${wc} / ${min} كلمة (الحد الأدنى)`
                          : `${wc} / ${min} words (minimum)`}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Mic blocked notice */}
        {micBlocked && (
          <div className="flex items-start gap-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 px-4 py-3 rounded-lg text-sm">
            <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z" />
            </svg>
            <span>
              {language === 'ar'
                ? 'تعذّر الوصول للميكروفون — تأكّد من السماح للميكروفون أو اكتب إجابتك يدويًا.'
                : 'Microphone unavailable — allow mic access or type your answers manually.'}
            </span>
          </div>
        )}

        {/* Validation notice */}
        {attempted && pageDeficient.length > 0 && (
          <div className="flex items-start gap-2.5 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 px-4 py-3 rounded-lg text-sm">
            <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z" />
            </svg>
            <span>
              {language === 'ar'
                ? `يجب استيفاء الحد الأدنى لعدد الكلمات في ${pageDeficient.length} حقل في هذه الصفحة قبل المتابعة.`
                : `Please meet the minimum word count in ${pageDeficient.length} field(s) on this page before continuing.`}
            </span>
          </div>
        )}

        {/* Wizard nav */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleBack}
            disabled={safePage === 0}
            className="text-sm font-semibold py-2.5 px-5 rounded-md border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors duration-150"
          >
            {language === 'ar' ? 'السابق' : 'Back'}
          </button>

          {!isLastPage ? (
            <button
              type="button"
              onClick={handleNext}
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 px-5 rounded-md transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 flex items-center justify-center gap-2"
            >
              {language === 'ar' ? 'التالي' : 'Next'}
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={language === 'ar' ? "M10 19l-7-7m0 0l7-7m-7 7h18" : "M14 5l7 7m0 0l-7 7m7-7H3"} />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold py-2.5 px-5 rounded-md transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 flex items-center justify-center gap-2"
            >
              {language === 'ar' ? 'إرسال الاستبيان وإنشاء التشخيص النهائي' : 'Submit Survey & Open Comprehensive Reports'}
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={language === 'ar' ? "M10 19l-7-7m0 0l7-7m-7 7h18" : "M14 5l7 7m0 0l-7 7m7-7H3"} />
              </svg>
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export default WorkplaceSurveyScreen;
