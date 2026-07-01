import React, { useState, useEffect } from 'react';
import { Language, OrganizationDocument, AdminSettings, ClientProfile, SurveyScope, AssessmentKind, SurveyLaunchConfig, ProjectSurveySettings, GovProject, toKindArray } from '../types';
import { deriveSurveyMinimums } from '../services/geminiService';
import { compileChunkContext } from '../services/governanceService';
import { TRANSLATIONS } from '../constants';
import { db } from '../firebase';
import { collection, getDocs, doc, updateDoc, setDoc } from 'firebase/firestore';
import { useToast } from './ToastProvider';
import { exportAssessmentsReport, exportEmployeeReport, type AssessmentExportFormat } from '../services/exportService';
import SurveyLab from './SurveyLab';
import ResponsesCenter from './ResponsesCenter';
import {
  KpiCards,
  RiasecBarChart,
  MatchQualityChart,
  EngagementChart,
  CompetencyBullets,
  TalentCompositionRing,
  ActivityHeatmap,
  ActivityTimeline,
} from './dashboard/DashboardCharts';
import {
  computeKpis,
  computeRiasec,
  computeScoreBuckets,
  buildWeeklyEngagement,
  riasecValue,
  computeTalentComposition,
  buildActivityHeatmap,
  buildActivityTimeline,
} from './dashboard/dashboardData';

const ARABIC_FONTS = [
  { id: 'Thmanyah Sans', name_ar: 'خط ثمانية (Thmanyah) — الافتراضي', name_en: 'Thmanyah Sans (default)' },
  { id: 'Thmanyah Serif Display', name_ar: 'خط ثمانية عريض للعناوين (Thmanyah Serif)', name_en: 'Thmanyah Serif Display' },
  { id: 'Tajawal', name_ar: 'خط تجول (Tajawal)', name_en: 'Tajawal Font' },
  { id: 'Almarai', name_ar: 'خط الثمانية / المراعي (Almarai)', name_en: 'Thamanya / Almarai Font' },
  { id: 'Cairo', name_ar: 'خط القاهرة (Cairo)', name_en: 'Cairo Font' },
  { id: 'Noto Sans Arabic', name_ar: 'خط نوتو سانز (Noto Sans)', name_en: 'Noto Sans Arabic' },
  { id: 'Noto Kufi Arabic', name_ar: 'خط نوتو كوفي متميز (Noto Kufi)', name_en: 'Noto Kufi Arabic' },
  { id: 'Noto Naskh Arabic', name_ar: 'خط نوتو نسخ رصين (Noto Naskh)', name_en: 'Noto Naskh Arabic' },
  { id: 'Readex Pro', name_ar: 'خط ريدكس برو المتناسق (Readex)', name_en: 'Readex Pro Font' },
  { id: 'Alexandria', name_ar: 'خط الإسكندرية هندسي (Alexandria)', name_en: 'Alexandria Font' },
  { id: 'El Messiri', name_ar: 'خط المسيري الفني (El Messiri)', name_en: 'El Messiri Font' },
  { id: 'Amiri', name_ar: 'خط أميري تراثي أنيق (Amiri)', name_en: 'Amiri Book Font' }
];

const renderBoldSpans = (text: string) => {
  // Simple regex parser to bold **text** portions
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <span key={index} className="text-slate-800 font-extrabold text-[11.5px] bg-slate-100 px-1 rounded mx-0.5">
          {part}
        </span>
      );
    }
    return part;
  });
};

const renderFormattedMessage = (text: string, language: string) => {
  const lines = text.split('\n');
  return (
    <div className="space-y-2 text-xs">
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={idx} className="h-2" />;
        }
        
        // Headers e.g. ### or ## or #
        if (trimmed.startsWith('####')) {
          return (
            <h5 key={idx} className="text-xs font-black text-emerald-700 mt-2 mb-1 border-b border-emerald-50 pb-0.5">
              {trimmed.replace(/^####\s*/, '')}
            </h5>
          );
        }
        if (trimmed.startsWith('###')) {
          return (
            <h4 key={idx} className="text-xs font-black text-emerald-800 mt-3 mb-1 border-b border-emerald-100 pb-1">
              {trimmed.replace(/^###\s*/, '')}
            </h4>
          );
        }
        if (trimmed.startsWith('##')) {
          return (
            <h3 key={idx} className="text-sm font-black text-slate-800 mt-4 mb-2 border-b border-slate-200 pb-1">
              {trimmed.replace(/^##\s*/, '')}
            </h3>
          );
        }
        if (trimmed.startsWith('#')) {
          return (
            <h2 key={idx} className="text-base font-black text-emerald-900 mt-5 mb-2.5 pb-1">
              {trimmed.replace(/^#\s*/, '')}
            </h2>
          );
        }

        // Bullet point
        if (trimmed.startsWith('*') || trimmed.startsWith('-')) {
          const content = trimmed.replace(/^[\*\-]\s*/, '');
          return (
            <div key={idx} className="flex items-start gap-1.5 pl-3 rtl:pr-3 rtl:pl-0 my-0.5 leading-relaxed text-slate-700 font-semibold">
              <span className="text-emerald-600 mt-1.5 flex-shrink-0 text-[8px]">●</span>
              <span>{renderBoldSpans(content)}</span>
            </div>
          );
        }

        // Checklist point
        if (trimmed.startsWith('[ ]') || trimmed.startsWith('[x]')) {
          const isChecked = trimmed.startsWith('[x]');
          const content = trimmed.slice(3).trim();
          return (
            <div key={idx} className="flex items-center gap-2 pl-3 rtl:pr-3 rtl:pl-0 my-1 font-semibold">
              <input type="checkbox" checked={isChecked} readOnly className="w-3.5 h-3.5 text-emerald-600 border-gray-300 rounded focus:ring-emerald-500" />
              <span className={isChecked ? "line-through text-slate-400" : "text-slate-700"}>{renderBoldSpans(content)}</span>
            </div>
          );
        }

        // Table lines
        if (trimmed.startsWith('|')) {
          const cols = trimmed.split('|').map(c => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
          if (cols.every(c => c.startsWith('---') || c.startsWith(':---') || c === '')) {
            return null; // skip dividing lines
          }
          return (
            <div key={idx} className="overflow-x-auto my-1 bg-slate-50 border border-slate-200 p-2 rounded-lg">
              <div className="flex gap-2 divide-x divide-slate-200 rtl:divide-x-reverse">
                {cols.map((col, cIdx) => (
                  <span key={cIdx} className="px-2 text-[11px] font-bold text-slate-700 flex-1 break-words">
                    {renderBoldSpans(col)}
                  </span>
                ))}
              </div>
            </div>
          );
        }

        // Standard text
        return (
          <p key={idx} className="leading-relaxed font-semibold text-slate-700 text-xs">
            {renderBoldSpans(trimmed)}
          </p>
        );
      })}
    </div>
  );
};

interface AdminPanelProps {
  documents: OrganizationDocument[];
  onAddDocument: (doc: Omit<OrganizationDocument, 'id' | 'uploadedAt'>) => void;
  onDeleteDocument: (id: string) => void;
  settings: AdminSettings;
  onUpdateSettings: (settings: AdminSettings) => void;
  language: Language;
  allAssessments?: any[];
  onRefreshAssessments?: () => void;
  currentUserEmail?: string;
  currentUserName?: string;
  onOpenGovernanceCenter?: () => void;
}

const AdminPanel: React.FC<AdminPanelProps> = ({
  documents,
  onAddDocument,
  onDeleteDocument,
  settings,
  onUpdateSettings,
  language,
  allAssessments = [],
  onRefreshAssessments,
  currentUserEmail = '',
  currentUserName = '',
  onOpenGovernanceCenter,
}) => {
  const T = TRANSLATIONS[language];
  const toast = useToast();


  // Local setting states to apply
  const [questionCount, setQuestionCount] = useState<number>(settings.questionCount);
  const [birkman, setBirkman] = useState(settings.theories.birkman);
  const [holland, setHolland] = useState(settings.theories.holland);
  const [psychTech, setPsychTech] = useState(settings.theories.psychTech);
  const [bloom, setBloom] = useState(settings.theories.bloomTaxonomy);

  // Corporate identity parameters (Platform operator)
  const [companyName, setCompanyName] = useState<string>(settings.companyName || 'Ailigent.ai');
  const [fontFamily, setFontFamily] = useState<string>(settings.fontFamily || 'Tajawal');
  const [logoUrl, setLogoUrl] = useState<string>(settings.logoUrl || '');
  const [aiPresetPersona, setAiPresetPersona] = useState<'academic' | 'executive' | 'technical' | 'supportive'>(settings.aiPresetPersona || 'executive');

  // == Survey launch configuration ==
  const [surveyScopeDefault, setSurveyScopeDefault] = useState<SurveyScope>(settings.surveyScopeDefault || 'both');
  const [surveyWordLimits, setSurveyWordLimits] = useState<{ [field: string]: number }>(settings.surveyWordLimits || {});

  // == Admin-locked launch configuration (type/scope/mandatory) ==
  const [launchKinds, setLaunchKinds] = useState<AssessmentKind[]>(toKindArray(settings.surveyLaunchConfig?.assessmentKind));
  const [launchScope, setLaunchScope] = useState<SurveyScope>(settings.surveyLaunchConfig?.scope || settings.surveyScopeDefault || 'both');
  const [launchLocked, setLaunchLocked] = useState<boolean>(settings.surveyLaunchConfig?.locked ?? true);
  const [launchMandatory, setLaunchMandatory] = useState<boolean>(settings.surveyLaunchConfig?.mandatory ?? true);
  const [launching, setLaunching] = useState(false);

  // == Target client profiles states ==
  const [clientProfiles, setClientProfiles] = useState<ClientProfile[]>(settings.clientProfiles || []);
  const [activeClientProfileId, setActiveClientProfileId] = useState<string>(settings.activeClientProfileId || '');
  const [settingsSubTab, setSettingsSubTab] = useState<'platform' | 'clients'>('platform');

  // Form states for creating a new Client Profile
  const [newClientName, setNewClientName] = useState('');
  const [newClientDescription, setNewClientDescription] = useState('');
  const [newClientIndustry, setNewClientIndustry] = useState('');
  const [newClientLogo, setNewClientLogo] = useState('');

  // Cropper States
  const [rawImageSrc, setRawImageSrc] = useState<string | null>(null);
  const [scale, setScale] = useState<number>(1);

  // Unified toast shim: every legacy setNotif(msg) routes into the shared toast
  // system, variant inferred from content. setNotif('') (the old auto-clear) is a no-op.
  const setNotif = (msg: string) => {
    if (!msg) return;
    if (/⚠️|تعذّر|فشل|خطأ|failed|error/i.test(msg)) toast.error(msg);
    else toast.success(msg);
  };
  const [selectedAssessment, setSelectedAssessment] = useState<any | null>(null);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'responses' | 'config'>('dashboard');

  // Central Database Logs Tab & State
  const [dbActiveTab, setDbActiveTab] = useState<'analytics' | 'journey' | 'assessments' | 'surveylab' | 'logins' | 'consultations'>('analytics');
  const [journeyQuery, setJourneyQuery] = useState('');
  const [journeyType, setJourneyType] = useState<'all' | 'verbal' | 'text' | 'survey'>('all');
  const [reportFmt, setReportFmt] = useState<AssessmentExportFormat>('docx');
  const [reportBusy, setReportBusy] = useState('');

  // R5 #3: export employee assessment OUTCOMES (technical + behavioral), not the questionnaire
  const exportOpts = () => ({ language, companyName, logoUrl } as any);
  const handleExportAllAssessments = async (recs: any[]) => {
    if (!recs.length) { toast.warning(language === 'ar' ? 'لا توجد تقييمات للتصدير.' : 'No assessments to export.'); return; }
    setReportBusy(language === 'ar' ? 'تجهيز التقرير الشامل' : 'Building company report');
    try {
      const res = await exportAssessmentsReport(recs, exportOpts(), { format: reportFmt, companyName });
      toast.success(language === 'ar' ? `تم تصدير تقرير ${res.employees} موظف (${res.assessments} تقييم)` : `Exported report: ${res.employees} employees / ${res.assessments} assessments`);
    } catch (e: any) { toast.error((language === 'ar' ? 'فشل التصدير: ' : 'Export failed: ') + (e?.message || e)); }
    finally { setReportBusy(''); }
  };
  const handleExportEmployee = async (person: { name: string; email: string; items: any[] }) => {
    setReportBusy(language === 'ar' ? `تجهيز تقرير ${person.name}` : `Building report for ${person.name}`);
    try {
      await exportEmployeeReport(person, exportOpts(), reportFmt);
      toast.success(language === 'ar' ? `تم تصدير تقرير ${person.name}` : `Exported ${person.name}'s report`);
    } catch (e: any) { toast.error((language === 'ar' ? 'فشل التصدير: ' : 'Export failed: ') + (e?.message || e)); }
    finally { setReportBusy(''); }
  };
  const [logins, setLogins] = useState<any[]>([]);
  const [loadingLogins, setLoadingLogins] = useState(false);

  // Expanded candidate row ID for the advanced inline scorecard drawer
  const [expandedAssessmentId, setExpandedAssessmentId] = useState<string | null>(null);

  // Consultation and Restructuring session queue states
  const [consultationRequests, setConsultationRequests] = useState<any[]>([]);
  const [loadingConsultations, setLoadingConsultations] = useState(false);
  
  // Consultation Request form inputs
  const [cClientName, setCClientName] = useState('');
  const [cIndustry, setCIndustry] = useState('');
  const [cRequestType, setCRequestType] = useState<'restructuring' | 'efqm_audit' | 'capacity_building' | 'vocal_benchmark'>('restructuring');
  const [cAgendaTopic, setCAgendaTopic] = useState('');
  const [cUrgency, setCUrgency] = useState<'high' | 'medium' | 'normal'>('normal');
  const [cTargetDate, setCTargetDate] = useState('');
  const [cContactEmail, setCContactEmail] = useState('');
  const [cNotes, setCNotes] = useState('');

  // Evaluator Manual Review State
  const [revName, setRevName] = useState('');
  const [revEmail, setRevEmail] = useState('');
  const [revRating, setRevRating] = useState(5);
  const [revComments, setRevComments] = useState('');
  const [revStatus, setRevStatus] = useState<'approved' | 'rejected' | 'needs_revision'>('approved');
  const [isSavingReview, setIsSavingReview] = useState(false);

  // Sync inputs dynamically on record focus
  useEffect(() => {
    if (selectedAssessment) {
      setRevName(selectedAssessment.evaluatorReview?.reviewerName || currentUserName || '');
      setRevEmail(selectedAssessment.evaluatorReview?.reviewerEmail || currentUserEmail || '');
      setRevRating(selectedAssessment.evaluatorReview?.rating || 5);
      setRevComments(selectedAssessment.evaluatorReview?.comments || '');
      setRevStatus(selectedAssessment.evaluatorReview?.status || 'approved');
    }
  }, [selectedAssessment, currentUserName, currentUserEmail]);

  // Load existing consultation requests from Firestore
  const loadConsultations = async () => {
    setLoadingConsultations(true);
    try {
      const snap = await getDocs(collection(db, 'consultation_requests'));
      const list: any[] = [];
      snap.forEach(dSnap => {
        list.push(dSnap.data());
      });
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setConsultationRequests(list);
    } catch (err) {
      console.error("Failed to load consultations database:", err);
    } finally {
      setLoadingConsultations(false);
    }
  };

  // Add Consultation Request callback to Firestore
  const handleAddConsultationRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cClientName.trim() || !cContactEmail.trim()) return;
    const newReq = {
      id: 'consult_' + Date.now(),
      clientName: cClientName,
      industry: cIndustry || 'عام / متصل بتكنولوجيا المعلومات',
      consultantName: 'Dr. Ahmed Alsenosy',
      requestType: cRequestType,
      agendaTopic: cAgendaTopic || 'تدقيق الجودة وإعادة الهيكلة الشاملة للعمليات والمؤشرات الكبرى',
      urgency: cUrgency,
      targetDate: cTargetDate || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().split('T')[0],
      contactEmails: cContactEmail,
      additionalNotes: cNotes,
      status: 'requested',
      timestamp: new Date().toISOString()
    };

    try {
      await setDoc(doc(db, 'consultation_requests', newReq.id), newReq);
      setConsultationRequests(prev => [newReq, ...prev]);
      // Clear form inputs
      setCClientName('');
      setCIndustry('');
      setCAgendaTopic('');
      setCContactEmail('');
      setCNotes('');
      setNotif(language === 'ar' 
        ? '🚀 تم جدولة طلب الاستشارة الفاخر سحابياً وتوجيهه إلى الدكتور أحمد السنوسي بنجاح!' 
        : 'Your strategic consultation request has been logged and assigned directly to Dr. Ahmed Alsenosy!');
      setTimeout(() => setNotif(''), 3500);
    } catch (err) {
      console.error("Firestore Write Consultation Failed:", err);
    }
  };

  // Load Logins Audit Trail from database
  const loadLogins = async () => {
    setLoadingLogins(true);
    try {
      const snap = await getDocs(collection(db, 'user_logins'));
      const list: any[] = [];
      snap.forEach(dSnap => {
        list.push(dSnap.data());
      });
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setLogins(list);
    } catch (err) {
      console.error("Failed to load logins audit database:", err);
    } finally {
      setLoadingLogins(false);
    }
  };

  useEffect(() => {
    if (dbActiveTab === 'logins' || dbActiveTab === 'analytics') {
      loadLogins();
    }
    if (dbActiveTab === 'consultations') {
      loadConsultations();
    }
  }, [dbActiveTab]);

  const handleSaveReview = async () => {
    if (!selectedAssessment) return;
    setIsSavingReview(true);
    try {
      const reviewObj = {
        reviewerName: revName || 'مسؤول الجودة والتدقيق',
        reviewerEmail: revEmail || 'quality@ailigent.ai',
        rating: revRating,
        comments: revComments,
        status: revStatus,
        reviewedAt: new Date().toISOString()
      };

      await updateDoc(doc(db, 'assessments', selectedAssessment.id), {
        evaluatorReview: reviewObj
      });

      setSelectedAssessment(prev => prev ? {
        ...prev,
        evaluatorReview: reviewObj
      } : null);

      if (onRefreshAssessments) {
        onRefreshAssessments();
      }

      setNotif(language === 'ar' ? 'تم تأكيد وحفظ تقييم المقيّم البشري للملف بالحبكة السحابية!' : 'Professional evaluator review submitted with success!');
      setTimeout(() => setNotif(''), 3000);
    } catch (err) {
      console.error("Failed to write manual review feedback:", err);
    } finally {
      setIsSavingReview(false);
    }
  };

  // Align inputs when global settings property changes dynamically
  useEffect(() => {
    setQuestionCount(settings.questionCount);
    setBirkman(settings.theories.birkman);
    setHolland(settings.theories.holland);
    setPsychTech(settings.theories.psychTech);
    setBloom(settings.theories.bloomTaxonomy);
    setCompanyName(settings.companyName || 'Ailigent.ai');
    setFontFamily(settings.fontFamily || 'Tajawal');
    setLogoUrl(settings.logoUrl || '');
    setClientProfiles(settings.clientProfiles || []);
    setActiveClientProfileId(settings.activeClientProfileId || '');
    setAiPresetPersona(settings.aiPresetPersona || 'executive');
    setSurveyScopeDefault(settings.surveyScopeDefault || 'both');
    setSurveyWordLimits(settings.surveyWordLimits || {});
    setLaunchKinds(toKindArray(settings.surveyLaunchConfig?.assessmentKind));
    setLaunchScope(settings.surveyLaunchConfig?.scope || settings.surveyScopeDefault || 'both');
    setLaunchLocked(settings.surveyLaunchConfig?.locked ?? true);
    setLaunchMandatory(settings.surveyLaunchConfig?.mandatory ?? true);
  }, [settings]);

  // Client profiles handlers
  const handleAddClientProfile = () => {
    if (!newClientName.trim()) return;
    const newProfile: ClientProfile = {
      id: 'client_' + Date.now(),
      name: newClientName,
      logoUrl: newClientLogo || '',
      description: newClientDescription || '',
      industry: newClientIndustry || '',
      uploadedAt: new Date().toISOString()
    };
    const updated = [...clientProfiles, newProfile];
    setClientProfiles(updated);
    
    // Automatically make it active if it is the first or by choice
    if (!activeClientProfileId || clientProfiles.length === 0) {
      setActiveClientProfileId(newProfile.id);
    }
    
    // Reset form
    setNewClientName('');
    setNewClientDescription('');
    setNewClientIndustry('');
    setNewClientLogo('');
    
    setNotif(language === 'ar' ? 'تم إضافة بروفايل الشركة العميل بنجاح!' : 'Client corporate profile created!');
    setTimeout(() => setNotif(''), 2500);
  };

  const handleDeleteClientProfile = (id: string) => {
    const updated = clientProfiles.filter(p => p.id !== id);
    setClientProfiles(updated);
    if (activeClientProfileId === id) {
      setActiveClientProfileId(updated[0]?.id || '');
    }
    setNotif(language === 'ar' ? 'تم حذف بروفايل الشركة العميل!' : 'Client profile removed!');
    setTimeout(() => setNotif(''), 2500);
  };

  const handleClientLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setNewClientLogo(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  // Project-first model: survey settings live per-project. Build a ProjectSurveySettings
  // from the current admin controls and write it to BOTH defaultSurveyTemplate (the
  // template seeded into new projects) AND the active project's `survey` — so the
  // employee gate (which reads activeProjectSurvey) sees the correct config.
  const buildSurveyTemplate = (launchCfg?: SurveyLaunchConfig, wordLimits?: { [k: string]: number }): ProjectSurveySettings => ({
    questionCount,
    theories: { birkman, holland, psychTech, bloomTaxonomy: bloom },
    surveyScopeDefault,
    surveyWordLimits: wordLimits ?? surveyWordLimits,
    surveyLaunchConfig: launchCfg ?? settings.clientProfiles?.find(p => p.id === activeClientProfileId)?.survey?.surveyLaunchConfig,
  });
  // Patch the active project's survey within the clientProfiles array.
  const profilesWithSurvey = (tpl: ProjectSurveySettings): GovProject[] =>
    clientProfiles.map(p => p.id === activeClientProfileId ? { ...p, survey: tpl } : p);

  const handleSaveSettings = () => {
    const tpl = buildSurveyTemplate();
    onUpdateSettings({
      questionCount,
      theories: {
        birkman,
        holland,
        psychTech,
        bloomTaxonomy: bloom,
      },
      companyName,
      fontFamily,
      logoUrl,
      activeClientProfileId,
      clientProfiles: profilesWithSurvey(tpl),
      aiPresetPersona,
      surveyScopeDefault,
      surveyWordLimits,
      defaultSurveyTemplate: tpl,
    });
    setNotif(language === 'ar' ? 'تم حفظ التكوينات وهوية المنصة وملفات العملاء بالكامل!' : 'Branding configurations and target client profiles saved successfully!');
    setTimeout(() => setNotif(''), 3000);
  };

  // Admin locks the assessment: derive per-question minimums from the ingested
  // knowledge (chunk context, fallback to raw docs), then persist a locked
  // SurveyLaunchConfig. Employees can only answer — they cannot change type/scope.
  const handleLaunchAssessment = async () => {
    if (launching) return;
    setLaunching(true);
    try {
      const tenantId = settings.activeClientProfileId || 'default';
      let ctx = '';
      try { ctx = await compileChunkContext(tenantId, 12000); } catch { ctx = ''; }
      if (!ctx) {
        ctx = documents.length
          ? documents.map(d => `[${d.name}]\n${d.content}`).join('\n\n').slice(0, 12000)
          : '';
      }
      const derived = await deriveSurveyMinimums(ctx, language);
      const kinds = toKindArray(launchKinds);
      const config: SurveyLaunchConfig = {
        locked: launchLocked,
        assessmentKind: kinds,
        scope: launchScope,
        mandatory: launchMandatory,
        launchedAt: new Date().toISOString(),
        launchedByEmail: currentUserEmail || undefined,
      };
      setSurveyWordLimits(derived);
      const tpl: ProjectSurveySettings = {
        questionCount,
        theories: { birkman, holland, psychTech, bloomTaxonomy: bloom },
        surveyScopeDefault: launchScope,
        surveyWordLimits: derived,
        surveyLaunchConfig: config,
      };
      onUpdateSettings({
        questionCount, theories: { birkman, holland, psychTech, bloomTaxonomy: bloom },
        companyName, fontFamily, logoUrl, activeClientProfileId,
        clientProfiles: clientProfiles.map(p => p.id === activeClientProfileId ? { ...p, survey: tpl } : p),
        aiPresetPersona,
        surveyScopeDefault: launchScope, surveyWordLimits: derived, surveyLaunchConfig: config,
        defaultSurveyTemplate: tpl,
      });
      const kindLabel = kinds.map(k => k === 'behavioral' ? 'سلوكي' : 'جدارات').join(' + ');
      setNotif(language === 'ar'
        ? `🚀 تم إطلاق التقييم وقفله بواسطة الأدمن (${kindLabel}). تم استنباط الحدود الدنيا من سياق الملفات.`
        : `🚀 Assessment launched & locked by admin. Per-question minimums derived from file context.`);
    } catch (err) {
      console.error('Launch assessment failed:', err);
      setNotif(language === 'ar' ? '⚠️ تعذّر إطلاق التقييم. حاول مجدداً.' : '⚠️ Failed to launch assessment. Retry.');
    } finally {
      setLaunching(false);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const resultStr = reader.result as string;
        setRawImageSrc(resultStr);
        setLogoUrl(resultStr); // set initially as draft preview
      };
      reader.readAsDataURL(file);
    }
  };

  const handleApplyCropping = () => {
    if (!rawImageSrc) return;
    const img = new Image();
    img.src = rawImageSrc;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 250;
      canvas.height = 250;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 250, 250);

        const minDim = Math.min(img.width, img.height);
        // Crop-scale factors
        const sWidth = minDim / scale;
        const sHeight = minDim / scale;
        const sx = (img.width - sWidth) / 2;
        const sy = (img.height - sHeight) / 2;

        ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, 250, 250);
        setLogoUrl(canvas.toDataURL('image/png'));
        setRawImageSrc(null); // Close crop viewer
        setNotif(language === 'ar' ? 'تم قص وتطبيق شعار الشركة الجديد بنجاح!' : 'New logo cropped and loaded!');
        setTimeout(() => setNotif(''), 3000);
      }
    };
  };


  return (
    <div className="flex flex-col text-start animate-fade-in space-y-6">
      {/* Title */}
      <div className="border-b border-slate-200 pb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {T.adminGate}
          </h1>
          <p className="text-sm text-slate-500 mt-1 leading-relaxed">{language === 'ar' ? 'إدارة ملفات الشركات وإعدادات التقييمات والنماذج التنظيمية' : 'Configure company profiles, assessment scopes, and organizational models.'}</p>
        </div>
        {onOpenGovernanceCenter && (
          <button onClick={onOpenGovernanceCenter} className="hw-btn hw-btn-primary self-center gap-2">
            {language === 'ar' ? 'مركز الحوكمة' : 'Governance Center'}
          </button>
        )}
      </div>

      {/* Top-level Admin Tabs */}
      <div className="hw-tabs-pill self-start flex-wrap">
        {([
          { key: 'dashboard', labelAr: 'التحليلات والسجلات', labelEn: 'Analytics & Records' },
          { key: 'responses', labelAr: 'مركز الردود', labelEn: 'Responses Center' },
          { key: 'config', labelAr: 'الإعداد والعلامة', labelEn: 'Setup & Branding' },
        ] as const).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`hw-tab-pill${activeTab === tab.key ? ' hw-tab-active' : ''}`}
          >
            {tab.key === 'dashboard' && (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            )}
            {tab.key === 'responses' && (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
            )}
            {tab.key === 'config' && (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            )}
            {language === 'ar' ? tab.labelAr : tab.labelEn}
          </button>
        ))}
      </div>

      {/* Responses Center tab */}
      {activeTab === 'responses' && (
        <ResponsesCenter
          tenantId={settings.activeClientProfileId || ''}
          language={language}
          companyName={(settings.clientProfiles || []).find(p => p.id === settings.activeClientProfileId)?.name}
        />
      )}

      {/* Config tab: assessment scope, models & branding */}
      {activeTab === 'config' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5 animate-fade-in">
          <div className="border-b border-slate-200 pb-3">
            <h2 className="text-base font-bold text-slate-900">{T.adminSettings}</h2>
            <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{T.methodsExplain}</p>
          </div>

          {/* Question Count */}
          <div className="space-y-2">
            <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider">{T.selectNumQuestions}</label>
            <div className="grid grid-cols-3 gap-2">
              {[30, 40, 50].map((num) => (
                <button
                  key={num}
                  type="button"
                  onClick={() => setQuestionCount(num)}
                  className={`py-2 px-3 rounded-md text-sm font-bold transition-colors ${
                    questionCount === num
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300'
                  }`}
                >
                  {num} {language === 'ar' ? 'سؤال' : 'Q'}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400">
              {language === 'ar'
                ? 'محددة إدارياً. يرى المتقدم عدد الأسئلة المقررة من قبلك دون تغيير.'
                : 'Controlled strictly by administrator. Candidate will take exactly this count.'}
            </p>
          </div>

          {/* Theory Toggles */}
          <div className="space-y-2 pt-1">
            <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider">{language === 'ar' ? 'النظريات المفعّلة' : 'Enabled Theories'}</label>

            {/* Birkman */}
            <label className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-md cursor-pointer hover:bg-slate-50 transition-colors">
              <input
                type="checkbox"
                checked={birkman}
                onChange={(e) => setBirkman(e.target.checked)}
                className="w-4 h-4 accent-emerald-600"
              />
              <div>
                <span className="font-semibold block text-sm text-slate-800">Birkman Method</span>
                <span className="text-xs text-slate-500">{language === 'ar' ? 'توافق البيئة والضغوط الاجتماعية' : 'Environmental compatibilities & social stressors.'}</span>
              </div>
            </label>

            {/* Holland */}
            <label className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-md cursor-pointer hover:bg-slate-50 transition-colors">
              <input
                type="checkbox"
                checked={holland}
                onChange={(e) => setHolland(e.target.checked)}
                className="w-4 h-4 accent-emerald-600"
              />
              <div>
                <span className="font-semibold block text-sm text-slate-800">Holland RIASEC Code</span>
                <span className="text-xs text-slate-500">{language === 'ar' ? 'المواءمة المهنية مع الأدوار الوظيفية' : 'Occupational match with corporate roles.'}</span>
              </div>
            </label>

            {/* Psych Tech */}
            <label className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-md cursor-pointer hover:bg-slate-50 transition-colors">
              <input
                type="checkbox"
                checked={psychTech}
                onChange={(e) => setPsychTech(e.target.checked)}
                className="w-4 h-4 accent-emerald-600"
              />
              <div>
                <span className="font-semibold block text-sm text-slate-800">Psych Tech Scale</span>
                <span className="text-xs text-slate-500">{language === 'ar' ? 'سيناريوهات سلوكية موحدة' : 'Standardized behavioral scenarios.'}</span>
              </div>
            </label>

            {/* Bloom's Taxonomy */}
            <label className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-md cursor-pointer hover:bg-slate-50 transition-colors">
              <input
                type="checkbox"
                checked={bloom}
                onChange={(e) => setBloom(e.target.checked)}
                className="w-4 h-4 accent-emerald-600"
              />
              <div>
                <span className="font-semibold block text-sm text-slate-800">Bloom's Taxonomy</span>
                <span className="text-xs text-slate-500">{language === 'ar' ? 'قدرات (تطبيق، تحليل، تقييم)' : 'Aptitude (Applying, Analyzing, Evaluating).'}</span>
              </div>
            </label>
          </div>

          {/* Corporate Branding & Logo Settings with Two Sub-Tabs */}
          <div className="space-y-4 pt-4 border-t border-slate-200">
            {/* Visual Header */}
            <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider">
              {language === 'ar' ? 'البوابة والشركات وهوية العمليات' : 'Multi-Enterprise Branding & Audits'}
            </label>

            {/* Sub-Tabs Selector */}
            <div className="hw-tabs-line">
              <button type="button" onClick={() => setSettingsSubTab('platform')}
                className={settingsSubTab === 'platform' ? 'hw-tab-line hw-tab-active' : 'hw-tab-line'}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 inline-block me-1"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                {language === 'ar' ? 'هوية منصتك (Ailigent.ai)' : 'Platform branding'}
              </button>
              {/* P1-3: company management lives ONLY in Governance → Projects.
                  This is a direct nav action, not a dead in-panel tab. */}
              {onOpenGovernanceCenter && (
                <button type="button" onClick={onOpenGovernanceCenter} className="hw-tab-line"
                  title={language === 'ar' ? 'إدارة الشركات في مركز الحوكمة' : 'Manage companies in Governance Center'}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 inline-block me-1"><path d="M3 21h18M3 7v14M21 7v14M6 21V7M18 21V7M9 21v-4h6v4M9 7V3h6v4"/></svg>
                  {language === 'ar' ? 'ملفات الشركات المستهدفة ↪' : 'Assessed Companies ↪'}
                </button>
              )}
            </div>

            {/* Sub-tab 1: Platform operator (Ailigent.ai) */}
            {settingsSubTab === 'platform' && (
              <div className="space-y-4 animate-fade-in">
                {/* Company Name */}
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    {language === 'ar' ? 'اسم منصة التقييم الرئيسية' : 'Main Platform Brand Name'}
                  </label>
                  <input
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Ailigent.ai"
                    className="hw-input"
                  />
                  <p className="text-[10px] text-slate-400 mt-1">
                    {language === 'ar' ? 'هذا الاسم سيظهر كعنوان في شريط تصفح المنصة الخارجي الرئيسي.' : 'This appears in the primary browser header and system navigation bar.'}
                  </p>
                </div>

                {/* Font Family Selection */}
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    {language === 'ar' ? 'الخط والنمط المعتمد للموقع بالكامل' : 'Global Site Typography Family'}
                  </label>
                  <select
                    value={fontFamily}
                    onChange={(e) => setFontFamily(e.target.value)}
                    className="hw-input cursor-pointer font-semibold"
                  >
                    {ARABIC_FONTS.map(f => (
                      <option key={f.id} value={f.id} style={{ fontFamily: f.id }}>
                        {language === 'ar' ? f.name_ar : f.name_en}
                      </option>
                    ))}
                  </select>
                </div>

                {/* AI Advisor Persona Selection */}
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    {language === 'ar' ? 'نمط وشخصية المستشار الذكي (د. أحمد)' : 'AI Advisor Personality Model Preset'}
                  </label>
                  <select
                    value={aiPresetPersona}
                    onChange={(e) => setAiPresetPersona(e.target.value as any)}
                    className="hw-input cursor-pointer font-semibold"
                  >
                    <option value="executive">{language === 'ar' ? 'استشاري تنفيذي استراتيجي (افتراضي)' : 'Strategic Executive Consultant (Default)'}</option>
                    <option value="academic">{language === 'ar' ? 'أكاديمي رصين وباحث علمي' : 'Academic Scholar & Critic'}</option>
                    <option value="technical">{language === 'ar' ? 'خبير تقني ورقمي سحابي متعمق' : 'Tech Infrastructure Architect'}</option>
                    <option value="supportive">{language === 'ar' ? 'موجه مرشد ومتعاطف للكوادر البشرية' : 'Supportive Career Coach'}</option>
                  </select>
                  <p className="text-[10px] text-slate-400 mt-1">
                    {language === 'ar' ? 'هذا الإعداد يتحكم في نبرة وصيغة واهتمامات الذكاء الاصطناعي (الدكتور أحمد) عند التفاعل معه بمستودع الوثائق.' : 'Controls the vocabulary, rigor, and orientation of Dr. Ahmed AI co-pilot.'}
                  </p>
                </div>

                {/* Admin-Locked Assessment Launch */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-bold text-slate-800">
                      {language === 'ar' ? 'إطلاق التقييم وقفله (الأدمن يتحكّم بالكامل)' : 'Launch & Lock Assessment (Admin-controlled)'}
                    </h4>
                    {settings.surveyLaunchConfig?.locked && (
                      <span className="hw-badge-success text-[10px]">
                        {language === 'ar' ? 'مقفول حالياً' : 'Currently locked'}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    {language === 'ar'
                      ? 'الأدمن يحدد نوع التقييم والنطاق والإجبارية ويقفلها. الموظف يجاوب فقط — لا يختار نطاقاً ولا نوعاً. الحدود الدنيا للكلمات تُستنبط تلقائياً من سياق الملفات المرفوعة لكل سؤال حسب تعقيده.'
                      : 'Admin sets type, scope and mandatory answering, then locks. Employees only answer — they cannot pick scope or type. Per-question word minimums are auto-derived from the uploaded file context by complexity.'}
                  </p>

                  {/* Assessment kind — multi-select (one or both) */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">
                      {language === 'ar' ? 'نوع التقييم (يمكن اختيار الاثنين معاً)' : 'Assessment Type (select one or both)'}
                    </label>
                    {(() => {
                      const toggleKind = (k: AssessmentKind) => {
                        setLaunchKinds(prev => {
                          const has = prev.includes(k);
                          const next = has ? prev.filter(x => x !== k) : [...prev, k];
                          return next.length ? next : prev; // never allow empty
                        });
                      };
                      const KindBox: React.FC<{ k: AssessmentKind; icon: React.ReactNode; label: string }> = ({ k, icon, label }) => {
                        const on = launchKinds.includes(k);
                        return (
                          <label className={`flex items-center gap-2 rounded-md p-2.5 cursor-pointer border transition-colors ${on ? 'bg-emerald-50 border-emerald-400 ring-1 ring-emerald-300' : 'bg-white border-slate-200 hover:border-slate-300'}`}>
                            <input type="checkbox" checked={on} onChange={() => toggleKind(k)} className="w-4 h-4 accent-emerald-600" />
                            <span className="text-sm font-bold text-slate-700 flex items-center gap-1">{icon} {label}</span>
                          </label>
                        );
                      };
                      return (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <KindBox k="competency" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>} label={language === 'ar' ? 'تقييم جدارات' : 'Competency-based'} />
                          <KindBox k="behavioral" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M12 2a9 9 0 0 1 9 9c0 4.97-4.03 9-9 9S3 15.97 3 11a9 9 0 0 1 9-9z"/><path d="M9 10h.01M15 10h.01M9.5 14.5s1 1.5 2.5 1.5 2.5-1.5 2.5-1.5"/></svg>} label={language === 'ar' ? 'تقييم سلوكي' : 'Behavioral'} />
                        </div>
                      );
                    })()}
                  </div>

                  {/* Scope (admin decides; employee cannot change) */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">
                      {language === 'ar' ? 'نطاق التقييم (يحدده الأدمن)' : 'Assessment Scope (admin decides)'}
                    </label>
                    <select
                      value={launchScope}
                      onChange={(e) => setLaunchScope(e.target.value as SurveyScope)}
                      className="hw-input cursor-pointer font-semibold"
                    >
                      <option value="both">{language === 'ar' ? 'تقييم الشخص وبيئة العمل معاً' : 'Person + Work Environment'}</option>
                      <option value="person">{language === 'ar' ? 'تقييم الشخص فقط' : 'Person Only'}</option>
                      <option value="environment">{language === 'ar' ? 'تقييم بيئة العمل فقط' : 'Work Environment Only'}</option>
                    </select>
                  </div>

                  {/* Lock + Mandatory toggles */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className="flex items-center gap-2 bg-white border border-slate-200 rounded-md p-2.5 cursor-pointer hover:bg-slate-50 transition-colors">
                      <input type="checkbox" checked={launchLocked} onChange={(e) => setLaunchLocked(e.target.checked)} className="w-4 h-4 accent-emerald-600" />
                      <span className="text-[11px] font-semibold text-slate-700">{language === 'ar' ? 'قفل الاختيارات للموظف' : 'Lock choices for employee'}</span>
                    </label>
                    <label className="flex items-center gap-2 bg-white border border-slate-200 rounded-md p-2.5 cursor-pointer hover:bg-slate-50 transition-colors">
                      <input type="checkbox" checked={launchMandatory} onChange={(e) => setLaunchMandatory(e.target.checked)} className="w-4 h-4 accent-emerald-600" />
                      <span className="text-[11px] font-semibold text-slate-700">{language === 'ar' ? 'إجبارية الإجابة' : 'Mandatory answering'}</span>
                    </label>
                  </div>

                  <button
                    onClick={handleLaunchAssessment}
                    disabled={launching}
                    className="hw-btn hw-btn-primary hw-btn-w flex items-center justify-center gap-2"
                  >
                    {launching ? (
                      <>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 animate-spin"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                        {language === 'ar' ? 'يستنبط الحدود الدنيا من الملفات…' : 'Deriving minimums from files…'}
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                        {language === 'ar' ? 'إطلاق وقفل التقييم' : 'Launch & Lock Assessment'}
                      </>
                    )}
                  </button>

                  {/* Auto min-words — fully dynamic, no manual table. Read-only status only. */}
                  <div className="rounded-md bg-white border border-slate-200 p-3 flex items-start gap-2">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 mt-0.5 shrink-0"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M12 11V7M9 7h6M7 15h.01M12 15h.01M17 15h.01"/></svg>
                    <div className="flex-1">
                      <div className="text-xs font-bold text-slate-700">
                        {language === 'ar' ? 'الحد الأدنى لكلمات كل سؤال — تلقائي بالكامل' : 'Per-question word minimum — fully automatic'}
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {language === 'ar'
                          ? 'يُستنبط لكل سؤال حسب طبيعته وتعقيده من سياق ملفات الشركة عند الإطلاق. لا حاجة لإدخال أرقام يدوياً. الحد الأدنى المطلق 8 كلمات.'
                          : 'Derived per question by its nature and complexity from the company file context at launch. No manual numbers needed. Absolute floor is 8 words.'}
                      </p>
                      {Object.keys(surveyWordLimits || {}).length > 0 && (
                        <div className="text-[10px] text-emerald-600 mt-1 font-semibold">
                          {language === 'ar'
                            ? `✓ مستنبَط لـ ${Object.keys(surveyWordLimits).length} حقل في آخر إطلاق.`
                            : `✓ Derived for ${Object.keys(surveyWordLimits).length} fields at last launch.`}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Platform Logo */}
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    {language === 'ar' ? 'شعار المنصة الرئيسي (أعلى اليمين)' : 'Platform White-label Logo'}
                  </label>

                  <div className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-md">
                    {logoUrl ? (
                      <img src={logoUrl} alt="Platform Logo Preview" className="w-12 h-12 rounded-lg object-contain border border-slate-100 bg-slate-50" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-lg flex items-center justify-center font-black text-xs border border-emerald-100">Ai</div>
                    )}
                    
                    <div className="flex-1 overflow-hidden">
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleLogoUpload}
                        className="block w-full text-xs text-slate-500 file:me-2 file:py-1 file:px-2.5 file:rounded-md file:border-0 file:text-[10px] file:font-bold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 cursor-pointer"
                      />
                      <p className="text-[10px] text-slate-400 mt-1 truncate">
                        {language === 'ar' ? 'يمكنك تحجيم وتقريب الشعار بالأسفل' : 'Select images, adjustments tools active below'}
                      </p>
                    </div>
                  </div>

                  {/* Crop Modal / Interactive Canvas Cropping Widget */}
                  {rawImageSrc && (
                    <div className="mt-3 p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3 animate-fade-in text-center">
                      <p className="text-xs font-bold text-slate-700 leading-tight">
                        {language === 'ar' ? 'أداة محاذاة وقص الشعار' : 'Center & Scale Branding Logo'}
                      </p>

                      {/* Bounding shape horizontal preview */}
                      <div className="mx-auto w-48 h-20 rounded-md border border-slate-300 overflow-hidden relative bg-white flex items-center justify-center p-2">
                        <img
                          src={rawImageSrc}
                          alt="Crop target"
                          style={{
                            transform: `scale(${scale})`,
                            transition: 'transform 0.1s ease-out',
                          }}
                          className="max-w-full max-h-full object-contain"
                          referrerPolicy="no-referrer"
                        />
                      </div>

                      {/* Slider Control */}
                      <div className="space-y-1">
                        <div className="flex justify-between text-[10px] text-slate-500 font-bold">
                          <span>1.0x</span>
                          <span>{language === 'ar' ? 'تقريب الصورة' : 'Crop Zoom Factor'}</span>
                          <span>3.0x</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="3"
                          step="0.1"
                          value={scale}
                          onChange={(e) => setScale(parseFloat(e.target.value))}
                          className="w-full accent-emerald-600 cursor-pointer"
                        />
                      </div>

                      {/* Action buttons inside cropper */}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleApplyCropping}
                          className="hw-btn hw-btn-primary hw-btn-sm flex-1"
                        >
                          {language === 'ar' ? 'قص وحفظ الشعار' : 'Crop Logo'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRawImageSrc(null)}
                          className="hw-btn hw-btn-ghost hw-btn-sm"
                        >
                          {language === 'ar' ? 'إلغاء' : 'Cancel'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>

          <button
            onClick={handleSaveSettings}
            className="hw-btn hw-btn-primary hw-btn-w"
          >
            {language === 'ar' ? 'حفظ هوية المنصة والملاحظات' : 'Save Platform Identity & Target Profiles'}
          </button>
        </div>
      )}

      {/* Dashboard tab: executive analytics + records vault */}
      {activeTab === 'dashboard' && (
      <div className="bg-white border border-slate-200 rounded-xl p-5 md:p-6 space-y-5 animate-fade-in">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              {language === 'ar' ? 'مستودع السجلات وسجلات حوكمة الولوج' : 'Audit Trail & Centralized Records Vault'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
              {language === 'ar'
                ? 'تحليل متكامل لعمليات التقييم، وجداول الحوكمة المكتملة، وجدول تدقيق حركة دخول الموظفين للشركة.'
                : 'Centralized registry verifying evaluated reports, human grading logs, and structural user logins.'}
            </p>
          </div>

          {/* Database Section Sub-tabs — unified pill system */}
          <div className="hw-tabs-pill flex-wrap self-start shrink-0">
            <button
              onClick={() => setDbActiveTab('analytics')}
              className={`hw-tab-pill${dbActiveTab === 'analytics' ? ' hw-tab-active' : ''}`}
            >
              {language === 'ar' ? 'التحليلات' : 'Analytics'}
            </button>
            <button
              onClick={() => setDbActiveTab('journey')}
              className={`hw-tab-pill${dbActiveTab === 'journey' ? ' hw-tab-active' : ''}`}
            >
              {language === 'ar' ? 'المسار' : 'Journey'}
            </button>
            <button
              onClick={() => setDbActiveTab('assessments')}
              className={`hw-tab-pill${dbActiveTab === 'assessments' ? ' hw-tab-active' : ''}`}
            >
              {language === 'ar' ? 'الجدارات' : 'Assessments'}
            </button>
            <button
              onClick={() => setDbActiveTab('surveylab')}
              className={`hw-tab-pill${dbActiveTab === 'surveylab' ? ' hw-tab-active' : ''}`}
            >
              {language === 'ar' ? 'مختبر الاستبيانات' : 'Survey Lab'}
            </button>
            <button
              onClick={() => setDbActiveTab('logins')}
              className={`hw-tab-pill${dbActiveTab === 'logins' ? ' hw-tab-active' : ''}`}
            >
              {language === 'ar' ? 'سجلات الدخول' : 'Logins'}
            </button>
            <button
              onClick={() => setDbActiveTab('consultations')}
              className={`hw-tab-pill${dbActiveTab === 'consultations' ? ' hw-tab-active' : ''}`}
            >
              {language === 'ar' ? 'الاستشارات' : 'Consults'}
            </button>
          </div>
        </div>

        {dbActiveTab === 'analytics' && (() => {
          // Dynamic analytical variables and charts code
          const kpis = computeKpis(allAssessments, logins);
          const riasecData = computeRiasec(allAssessments);
          const scoreBuckets = computeScoreBuckets(allAssessments);
          const weeklyEngagement = buildWeeklyEngagement(allAssessments, logins);
          const talentComposition = computeTalentComposition(allAssessments);
          const activityHeatmap = buildActivityHeatmap(allAssessments, logins);
          const activityTimeline = buildActivityTimeline(allAssessments, logins, consultationRequests);

          // Share/Clipboard generation summary for beneficiary
          const handleCopyAuditSummary = () => {
            const text = `
📊 [تقرير حوكمة الجدارات التنفيذية للجهة المستفيدة - Ailigent.ai]
--------------------------------------------------
الجهة المستهدفة بالدراسة: ${settings.clientProfiles?.find(p => p.id === settings.activeClientProfileId)?.name || (settings.companyName || 'الجهة المستفيدة')}
العدد الإجمالي للمرشحين والموظفين الذين خضعوا للتقييم: ${kpis.totalCandidates} موظف
متوسط نسبة الملاءمة الكلية للجدارات: ${kpis.avgScore}%
معدل اعتماد اللجان والتقييم البشري العالي: ${kpis.approvalRatio}%
إجمالي جلسات حوكمة تسجيل الدخول المسجلة بالمنصة سحابياً: ${kpis.totalLogins} جلسة

تحليلات سمات الاهتمام المهني السائدة (جدارات هولاند RIASEC):
- مبادر وعيادي (E): ${riasecValue(riasecData, 'E')} نقطة تراكمية
- بحثي وتطويري (I): ${riasecValue(riasecData, 'I')} نقطة تراكمية
- اجتماعي وتواصلي (S): ${riasecValue(riasecData, 'S')} نقطة تراكمية

تم استخراج وحيازة هذا الملف آلياً من سجل الحوكمة المركزي للمنصة ومشاركته مع الإدارة العليا الشريكة بنجاح.
توقيع حوكمة النظام: Ailigent.ai Cloud Engine ${new Date().toLocaleDateString('ar-EG')}
            `;
            if (navigator.clipboard) {
              navigator.clipboard.writeText(text.trim());
              setNotif(language === 'ar' ? '📋 تم نسخ حوصلة التقرير والرسوم البيانية إلى الحافظة بنجاح، يمكنك مشاركتها الآن!' : 'Executive summary report copied to clipboard successfully!');
              setTimeout(() => setNotif(''), 3000);
            }
          };

          return (
            <div className="space-y-6">
              <KpiCards kpis={kpis} language={language} />

              {/* Charts grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <RiasecBarChart data={riasecData} language={language} />
                <MatchQualityChart buckets={scoreBuckets} language={language} />
                <TalentCompositionRing composition={talentComposition} language={language} />
                <EngagementChart data={weeklyEngagement} language={language} />
              </div>

              {/* Top Competencies — bullet charts (value + target + quality bands) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <CompetencyBullets
                  title={language === 'ar' ? 'أقوى الجدارات المكتشفة في الكوادر' : 'Top Talent Strengths'}
                  language={language}
                  rows={[
                    { ar: 'التحول الرقمي والذكاء الاصطناعي', en: 'Digital Transformation & AI', value: 92, target: 85 },
                    { ar: 'المرونة التشغيلية والتكيف مع المتغيرات', en: 'Operational Agility & Adaptability', value: 88, target: 85 },
                    { ar: 'النزاهة والاتساق الأخلاقي والمثالي', en: 'Corporate Integrity & Governance', value: 85, target: 85 },
                  ]}
                />
                <CompetencyBullets
                  title={language === 'ar' ? 'الجدارات المستهدفة للتطوير والتدريب الموصى بها' : 'Development Gaps & Recommended Interventions'}
                  language={language}
                  rows={[
                    { ar: 'التعاون والموازنة الفاعلة للموارد المشتركة', en: 'Cross-functional Collaboration', value: 64, target: 75 },
                    { ar: 'مؤشرات معيار التميز الأوروبي طاقة الـ EFQM', en: 'EFQM Institutional Excellence Alignment', value: 59, target: 75 },
                    { ar: 'التمكن الإحصائي والتحليلي للممارسات والبيانات', en: 'Data-driven Operational Diagnostics', value: 55, target: 75 },
                  ]}
                />
              </div>

              {/* Temporal activity — heatmap (12-week) + recent-events timeline. */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <ActivityHeatmap data={activityHeatmap} language={language} />
                <ActivityTimeline events={activityTimeline} language={language} />
              </div>

              {/* Bottom Executive Share Box */}
              <div className="border border-slate-200 p-4 rounded-lg flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <h4 className="font-bold text-slate-900 text-sm">
                    {language === 'ar' ? 'مشاركة مؤشرات الحوكمة للجهة المستفيدة' : 'Share Certified Corporate Synopsis'}
                  </h4>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    {language === 'ar'
                      ? 'انسخ الملخص الشامل وضمّنه في بريد الإدارة الشريكة أو خطابات التصدير.'
                      : 'Generate and copy a professional corporate appraisal log ready to report in high-level briefs.'}
                  </p>
                </div>

                <button
                  onClick={handleCopyAuditSummary}
                  className="hw-btn hw-btn-primary shrink-0"
                >
                  {language === 'ar' ? 'نسخ تقرير الجهة المستفيدة' : 'Copy Beneficiary Synopsis'}
                </button>
              </div>
            </div>
          );
        })()}

        {dbActiveTab === 'journey' && (() => {
          const ar = language === 'ar';
          // فلترة + تجميع بالموظف (بالبريد) → مسار زمني للتقييمات المكتملة
          const q = journeyQuery.trim().toLowerCase();
          const filtered = allAssessments.filter((a: any) => {
            if (journeyType !== 'all' && a.assessmentType !== journeyType) return false;
            if (!q) return true;
            return ((a.userName || '') + (a.userEmail || '') + (a.jobTitle || '')).toLowerCase().includes(q);
          });
          const groups: Record<string, any[]> = {};
          filtered.forEach((a: any) => {
            const key = a.userEmail || a.userName || 'unknown';
            (groups[key] = groups[key] || []).push(a);
          });
          const people = Object.entries(groups).map(([key, items]) => ({
            key,
            name: items[0].userName || key,
            email: items[0].userEmail || '',
            items: [...items].sort((x, y) => new Date(y.timestamp).getTime() - new Date(x.timestamp).getTime()),
          })).sort((a, b) => new Date(b.items[0].timestamp).getTime() - new Date(a.items[0].timestamp).getTime());

          const typeBadge = (tp: string): React.ReactNode => tp === 'verbal'
            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 inline-block"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>
            : tp === 'survey'
            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 inline-block"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 inline-block"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>;
          return (
            <div className="space-y-4">
              {/* فلاتر */}
              <div className="flex flex-wrap items-center gap-2">
                <input value={journeyQuery} onChange={e => setJourneyQuery(e.target.value)}
                  placeholder={ar ? 'ابحث باسم الموظف أو البريد أو الوظيفة…' : 'Search name / email / job…'}
                  className="hw-input flex-1 min-w-[220px] text-sm" />
                <div className="flex gap-1">
                  {(['all','text','verbal','survey'] as const).map(tp => (
                    <button key={tp} onClick={() => setJourneyType(tp)}
                      className={`hw-tab-pill${journeyType === tp ? ' hw-tab-active' : ''}`}>
                      {tp === 'all' ? (ar ? 'الكل' : 'All') : tp === 'text' ? (ar ? 'تحريري' : 'Written') : tp === 'verbal' ? (ar ? 'شفهي' : 'Verbal') : (ar ? 'استبيان' : 'Survey')}
                    </button>
                  ))}
                </div>
              </div>
              {/* عدّادات */}
              <div className="grid grid-cols-3 gap-px bg-slate-200 border border-slate-200 rounded-lg overflow-hidden">
                <div className="bg-white p-3">
                  <div className="text-lg font-bold text-slate-800 tabular-nums">{people.length}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wide font-bold">{ar ? 'موظف لديه تقييمات' : 'Employees Assessed'}</div>
                </div>
                <div className="bg-white p-3">
                  <div className="text-lg font-bold text-slate-800 tabular-nums">{filtered.length}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wide font-bold">{ar ? 'تقييم مكتمل' : 'Completed'}</div>
                </div>
                <div className="bg-white p-3">
                  <div className="text-lg font-bold text-emerald-600 tabular-nums">
                    {filtered.filter((a: any) => a.evaluatorReview?.status === 'approved').length}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wide font-bold">{ar ? 'معتمد من المقيّم' : 'Approved'}</div>
                </div>
              </div>
              {/* R5 #3: تصدير تقارير التقييمات (فنية + سلوكية) — مش الاستبيان */}
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 border border-slate-200 p-2.5">
                <span className="text-[11px] font-bold text-slate-700">{ar ? 'تصدير تقارير التقييمات' : 'Export assessment reports'}</span>
                <select value={reportFmt} onChange={e => setReportFmt(e.target.value as AssessmentExportFormat)} className="hw-input text-xs py-1">
                  <option value="docx">Word (.docx)</option>
                  <option value="pdf">PDF</option>
                  <option value="xlsx">Excel (.xlsx)</option>
                </select>
                <button onClick={() => handleExportAllAssessments(filtered)} disabled={!!reportBusy || !filtered.length}
                  title={ar ? 'تقرير شامل لكل تقييمات الجهة: الدرجات + الجدارات الفنية + الملف السلوكي' : 'Company-wide report: scores + technical competencies + behavioral profile'}
                  className="hw-btn hw-btn-primary hw-btn-sm disabled:opacity-50">
                  {reportBusy
                    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 inline-block me-1 animate-spin"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 inline-block me-1"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                  }{ar ? `التقرير الشامل للجهة (${filtered.length})` : `Company report (${filtered.length})`}
                </button>
                {reportBusy && <span className="text-[11px] text-emerald-700 font-bold">{reportBusy}…</span>}
              </div>

              {/* مسار كل موظف */}
              {people.length === 0 ? (
                <div className="text-center py-10 bg-slate-50 rounded-md border border-dashed border-slate-200">
                  <p className="text-slate-400 text-sm">{ar ? 'لا توجد تقييمات مطابقة.' : 'No matching assessments.'}</p>
                </div>
              ) : people.map(person => (
                <div key={person.key} className="rounded-md border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-2 mb-3 pb-2 border-b border-slate-100">
                    <div className="min-w-0">
                      <div className="font-black text-slate-800 truncate">{person.name}</div>
                      {person.email && <div className="text-xs text-slate-400 truncate">{person.email}</div>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="hw-badge-brand text-xs">
                        {person.items.length} {ar ? 'تقييم' : 'assessments'}
                      </span>
                      <button onClick={() => handleExportEmployee(person)} disabled={!!reportBusy}
                        title={ar ? 'تقرير مفصّل لهذا الموظف (فني + سلوكي)' : 'Detailed report for this employee (technical + behavioral)'}
                        className="hw-btn hw-btn-primary hw-btn-sm disabled:opacity-50">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 inline-block me-1"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                        {ar ? 'تقرير الموظف' : 'Employee report'}
                      </button>
                    </div>
                  </div>
                  {/* الخط الزمني */}
                  <div className="relative ps-5 space-y-3">
                    <div className="absolute top-1 bottom-1 start-1.5 w-px bg-emerald-200"></div>
                    {person.items.map((a: any, i: number) => {
                      const score = a.reportData?.totalScore;
                      const st = a.evaluatorReview?.status;
                      return (
                        <div key={a.id || i} className="relative">
                          <div className="absolute -start-[14px] top-1.5 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-white"></div>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm">{typeBadge(a.assessmentType)}</span>
                              <span className="font-bold text-slate-700 text-sm truncate">{a.jobTitle || (ar ? 'تقييم' : 'Assessment')}</span>
                              <span className="text-[11px] text-slate-400">{a.timestamp ? new Date(a.timestamp).toLocaleString(ar ? 'ar-EG' : 'en-US') : ''}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {typeof score === 'number' && <span className="font-black text-emerald-600 text-sm">{Math.round(score)}%</span>}
                              {st && (
                                <span className={`px-2 py-0.5 text-[9px] font-semibold rounded-sm border ${st === 'approved' ? 'bg-green-50 text-green-700 border-green-200' : st === 'needs_revision' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                                  {st === 'approved' ? (ar ? 'معتمد' : 'Approved') : st === 'needs_revision' ? (ar ? 'مراجعة' : 'Revise') : (ar ? 'مرفوض' : 'Rejected')}
                                </span>
                              )}
                              <button onClick={() => setSelectedAssessment(a)}
                                className="hw-btn hw-btn-subtle hw-btn-sm whitespace-nowrap flex items-center gap-1">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                {ar ? 'التقرير' : 'Report'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}

        {dbActiveTab === 'assessments' && (
          allAssessments.length === 0 ? (
            <div className="text-center py-10 bg-slate-50 rounded-xl border border-dashed border-slate-200">
              <p className="text-slate-400 text-sm font-semibold">
                {language === 'ar' ? 'لا توجد سجلات تقييم منجزة في قاعدة البيانات السحابية بعد.' : 'No completed assessment records found in the Cloud Database yet.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-start">
                <thead className="text-[10px] font-black uppercase tracking-wider bg-slate-100 text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-start">{language === 'ar' ? 'الموظف / البريد' : 'Employee / E-mail'}</th>
                    <th className="px-4 py-3 text-start">{language === 'ar' ? 'المسمى الوظيفي المستهدف' : 'Target Job Title'}</th>
                    <th className="px-4 py-3 text-start">{language === 'ar' ? 'نوع التقييم' : 'Assessment Type'}</th>
                    <th className="px-4 py-3 text-start">{language === 'ar' ? 'مراجعة المقيّم البشري' : 'Evaluator Revision'}</th>
                    <th className="px-4 py-3 text-center">{language === 'ar' ? 'الدرجة الكلية' : 'Overall Match'}</th>
                    <th className="px-4 py-3 text-center">{language === 'ar' ? 'المعاينة' : 'Actions'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {allAssessments.map((item: any, idx: number) => {
                    const timestampStr = item.timestamp ? new Date(item.timestamp).toLocaleString(language === 'ar' ? 'ar-EG' : 'en-US') : 'N/A';
                    return (
                      <React.Fragment key={item.id || idx}>
                        <tr className="hover:bg-slate-50/70 transition-colors">
                          <td className="px-4 py-3 text-start">
                            <div className="font-bold text-slate-800">{item.userName}</div>
                            <div className="text-xs text-slate-400 font-medium">{item.userEmail}</div>
                            <span className="block text-[9px] text-slate-400 font-medium mt-0.5">{timestampStr}</span>
                          </td>
                          <td className="px-4 py-3 text-start font-semibold text-slate-700">{item.jobTitle}</td>
                          <td className="px-4 py-3 text-start">
                            <span className={`inline-block px-2 py-0.5 text-[9px] font-bold rounded-sm uppercase leading-none ${
                              item.assessmentType === 'verbal'
                                ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                : 'bg-green-50 text-green-700 border border-green-200'
                            }`}>
                              {item.assessmentType === 'verbal' ? (language === 'ar' ? 'شفهي AI' : 'Verbal Audio') : (language === 'ar' ? 'تحريري MCQ' : 'Written MCQ')}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-start">
                            {item.evaluatorReview ? (
                              <div className="flex flex-col">
                                <span className={`inline-block self-start px-2 py-0.5 text-[9px] font-semibold rounded-sm ${
                                  item.evaluatorReview.status === 'approved'
                                    ? 'bg-green-50 text-green-700 border border-green-200'
                                    : item.evaluatorReview.status === 'needs_revision'
                                    ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                    : 'bg-red-50 text-red-700 border border-red-200'
                                }`}>
                                  {item.evaluatorReview.status === 'approved' ? (language === 'ar' ? 'معتمد' : 'Approved') : item.evaluatorReview.status === 'needs_revision' ? (language === 'ar' ? 'مراجعة إضافية' : 'Needs Revision') : (language === 'ar' ? 'مرفوض' : 'Rejected')}
                                </span>
                                <span className="text-[10px] text-slate-500 font-bold mt-0.5">
                                  {'★'.repeat(item.evaluatorReview.rating || 5)}{'☆'.repeat(5 - (item.evaluatorReview.rating || 5))}
                                </span>
                                <span className="text-[10px] text-slate-400 mt-0.5 truncate max-w-[120px]" title={item.evaluatorReview.reviewerName}>
                                  {language === 'ar' ? 'بواسطة:' : 'By:'} {item.evaluatorReview.reviewerName}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[11px] text-slate-400 font-bold italic flex items-center gap-1">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                                {language === 'ar' ? 'بانتظار المقيّم' : 'Pending Evaluator'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="font-black text-emerald-600 text-base">
                              {item.reportData?.totalScore ? `${Math.round(item.reportData.totalScore)}%` : 'N/A'}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex flex-wrap items-center justify-center gap-1.5">
                              <button
                                onClick={() => setSelectedAssessment(item)}
                                className="hw-btn hw-btn-subtle hw-btn-sm whitespace-nowrap flex items-center gap-1"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                {language === 'ar' ? 'التقرير المفصل' : 'View Report'}
                              </button>
                              <button
                                onClick={() => setExpandedAssessmentId(expandedAssessmentId === item.id ? null : item.id)}
                                className={`hw-btn hw-btn-sm whitespace-nowrap flex items-center gap-1 ${
                                  expandedAssessmentId === item.id
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-300 border'
                                    : 'hw-btn-ghost'
                                }`}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                                {language === 'ar' ? 'مواءمة خاطفة' : 'Quick Fit'}
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expandedAssessmentId === item.id && (
                          <tr className="bg-slate-50/50 border-b border-slate-100">
                            <td colSpan={6} className="px-5 py-4">
                              <div className="bg-white border border-slate-200 rounded-md p-4 space-y-4 text-start animate-fade-in">
                                
                                {/* Inside Title */}
                                <div className="flex items-center justify-between border-b pb-2 mb-2">
                                  <h5 className="font-extrabold text-xs text-emerald-950 flex items-center gap-2">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4-6.2-4.5-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
                                    {language === 'ar' ? 'بطاقة المراجعة والتدقيق الخاطفة للمرشح' : 'Executive Core Candidate Fit Card'}
                                  </h5>
                                  <button 
                                    onClick={() => setExpandedAssessmentId(null)}
                                    className="text-slate-400 hover:text-slate-600 font-extrabold text-xs"
                                  >
                                    ✕
                                  </button>
                                </div>
                                
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <div className="space-y-1.5 p-3 rounded-md border border-slate-200 bg-slate-50">
                                    <p className="text-[11px] font-bold text-slate-700 border-b border-slate-200 pb-1">{language === 'ar' ? 'النقاط القوية والرئيسية' : 'Core Strengths'}</p>
                                    <p className="text-xs text-slate-700 leading-relaxed max-h-[100px] overflow-y-auto whitespace-pre-wrap">{item.reportData?.strengths || (language === 'ar' ? 'لم تتوفر معلومات بعد.' : 'N/A')}</p>
                                  </div>
                                  <div className="space-y-1.5 p-3 rounded-md border border-rose-100 bg-rose-50/30">
                                    <p className="text-[11px] font-bold text-rose-800 border-b border-rose-100 pb-1">{language === 'ar' ? 'جوانب التطوير والتحسين' : 'Development Areas'}</p>
                                    <p className="text-xs text-slate-700 leading-relaxed max-h-[100px] overflow-y-auto whitespace-pre-wrap">{item.reportData?.weaknesses || (language === 'ar' ? 'لم تتوفر معلومات بعد.' : 'N/A')}</p>
                                  </div>
                                </div>

                                {/* Competency tags */}
                                {item.reportData?.competencyScores && item.reportData.competencyScores.length > 0 && (
                                  <div className="space-y-2 border-t pt-3">
                                    <p className="text-[11px] font-extrabold text-slate-600">{language === 'ar' ? 'قياس نسب الكفاءة والجدارات الاستراتيجية المعتمدة:' : 'Extracted Competency Ratios:'}</p>
                                    <div className="flex flex-wrap gap-2">
                                      {item.reportData.competencyScores.map((c: any, cIdx: number) => (
                                        <span key={cIdx} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 text-[10px] font-extrabold rounded-lg border border-slate-200 select-none transition-colors">
                                          <span className="w-1.5 h-1.5 bg-emerald-600 rounded-full animate-pulse"></span>
                                          {c.competency}: <strong className="text-emerald-600">{c.score}%</strong>
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {dbActiveTab === 'surveylab' && (
          <SurveyLab
            language={language}
            settings={settings}
            allAssessments={allAssessments}
            onRefreshAssessments={onRefreshAssessments}
          />
        )}

        {dbActiveTab === 'logins' && (
          loadingLogins ? (
            <div className="flex justify-center items-center py-10 space-x-2">
              <svg className="animate-spin h-5 w-5 text-emerald-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className="text-slate-500 font-bold text-xs">{language === 'ar' ? 'جاري تحميل سجلات الولود...' : 'Fetching device authentication trail...'}</span>
            </div>
          ) : logins.length === 0 ? (
            <div className="text-center py-10 bg-slate-50 rounded-xl border border-dashed border-slate-200">
              <p className="text-slate-400 text-sm font-semibold">
                {language === 'ar' ? 'لم يتم العثور على سجلات ولوج للنظام بعد.' : 'No system login history records logged yet.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-start">
                <thead className="text-[10px] font-black uppercase tracking-wider bg-slate-100 text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-start">{language === 'ar' ? 'هوية المستخدم / البريد' : 'User Identity / E-mail'}</th>
                    <th className="px-4 py-3 text-start">{language === 'ar' ? 'آلية تسجيل الدخول' : 'Access Mode'}</th>
                    <th className="px-4 py-3 text-start">{language === 'ar' ? 'توقيت الدخول الفعلي' : 'Login Time'}</th>
                    <th className="px-4 py-3 text-start">{language === 'ar' ? 'المتصفح وتفاصيل التجهيزات' : 'Browser Agent Details'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {logins.map((lgSnap: any, idx: number) => {
                    const loginTimeStr = lgSnap.timestamp ? new Date(lgSnap.timestamp).toLocaleString(language === 'ar' ? 'ar-EG' : 'en-US') : 'N/A';
                    return (
                      <tr key={lgSnap.id || idx} className="hover:bg-slate-50/70 transition-colors">
                        <td className="px-4 py-3 text-start">
                          <div className="font-extrabold text-slate-800">{lgSnap.userName || 'مجهول'}</div>
                          <div className="text-xs text-slate-400 font-bold">{lgSnap.userEmail || 'guest@example.com'}</div>
                        </td>
                        <td className="px-4 py-3 text-start">
                          <span className={`inline-block px-2 py-0.5 text-[9px] font-semibold rounded-sm ${
                            lgSnap.isGuest
                              ? 'bg-slate-100 text-slate-600 border border-slate-200'
                              : 'bg-green-50 text-green-700 border border-green-200'
                          }`}>
                            {lgSnap.isGuest ? (language === 'ar' ? 'دخول كـ زائر' : 'Guest Bypass') : (language === 'ar' ? 'حساب جوجل / معتمد' : 'Google Auth')}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-start text-xs text-slate-400 font-bold tabular-nums">
                          {loginTimeStr}
                        </td>
                        <td className="px-4 py-3 text-start text-[11px] text-slate-500 font-medium truncate max-w-[240px]" title={lgSnap.userAgent}>
                          {lgSnap.userAgent || 'Unknown Browser'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {dbActiveTab === 'consultations' && (
          <div className="space-y-6 animate-fade-in text-start">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              
              {/* Form Col: 1/3 size */}
              <div className="lg:col-span-1 bg-white p-4 rounded-lg border border-slate-200 space-y-4">
                <div className="border-b border-slate-200 pb-3">
                  <h4 className="font-bold text-slate-900 text-sm">
                    {language === 'ar' ? 'طلب جدولة جلسة استشارية جديدة' : 'Schedule Custom Consultation'}
                  </h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {language === 'ar' ? 'سوف يقوم النظام بتوجيه الطلب للدكتور السنوسي وجدولته.' : 'Instantly logged into Dr. Alsenosy appointment queue.'}
                  </p>
                </div>

                <form onSubmit={handleAddConsultationRequest} className="space-y-4">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'اسم المنشأة / العميل الشريك' : 'Partner/Client Name'}</label>
                    <input 
                      type="text" 
                      required
                      placeholder={language === 'ar' ? 'مثال: الهيئة الوطنية للمعلومات' : 'e.g. FedTech Corp'}
                      value={cClientName}
                      onChange={e => setCClientName(e.target.value)}
                      className="hw-input text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'قطاع الصناعة' : 'Industry sector'}</label>
                      <input 
                        type="text" 
                        placeholder={language === 'ar' ? 'تقنية / حكومي' : 'Government/Tech'}
                        value={cIndustry}
                        onChange={e => setCIndustry(e.target.value)}
                        className="hw-input text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'تاريخ الاستهداف' : 'Target Date'}</label>
                      <input 
                        type="date" 
                        value={cTargetDate}
                        onChange={e => setCTargetDate(e.target.value)}
                        className="hw-input text-xs"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'نوع المحور الاستشاري' : 'Consultancy Type'}</label>
                    <select 
                      value={cRequestType}
                      onChange={e => setCRequestType(e.target.value as any)}
                      className="hw-input text-xs cursor-pointer"
                    >
                      <option value="restructuring">{language === 'ar' ? 'إعادة هيكلة وبناء جدارات' : 'System Restructuring'}</option>
                      <option value="efqm_audit">{language === 'ar' ? 'تدقيق نموذج التميز EFQM' : 'EFQM Excellence Audit'}</option>
                      <option value="vocal_benchmark">{language === 'ar' ? 'معايرة صوتية وسلوكية' : 'Vocal Psych Calibration'}</option>
                      <option value="capacity_building">{language === 'ar' ? 'ورشة عمل تنمية قدرات' : 'Capacity Building'}</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'عنوان الأجندة والمحاضرة' : 'Agenda Topic'}</label>
                    <input 
                      type="text" 
                      placeholder={language === 'ar' ? 'مثال: مواءمة أدلة التوصيف الوظيفي الفيدرالي الجديدة' : 'e.g. Aligning federal job guidelines'}
                      value={cAgendaTopic}
                      onChange={e => setCAgendaTopic(e.target.value)}
                      className="hw-input text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'مستوى الاستعجال' : 'Urgency Level'}</label>
                      <select 
                        value={cUrgency}
                        onChange={e => setCUrgency(e.target.value as any)}
                        className="hw-input text-xs cursor-pointer"
                      >
                        <option value="normal">{language === 'ar' ? 'طبيعي' : 'Normal'}</option>
                        <option value="medium">{language === 'ar' ? 'متوسط الاستعجال' : 'Urgent'}</option>
                        <option value="high">{language === 'ar' ? 'مستعجل جداً (طوارئ)' : 'Critical (Express)'}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'بريد جهات الاتصال' : 'Contact E-mail'}</label>
                      <input 
                        type="email" 
                        required 
                        placeholder="vip@client.gov"
                        value={cContactEmail}
                        onChange={e => setCContactEmail(e.target.value)}
                        className="hw-input text-xs"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'ملاحظات وتحديات الجهة جلياً' : 'Aspirations & Notes'}</label>
                    <textarea 
                      rows={2}
                      placeholder={language === 'ar' ? 'أدخل تحديات هذه المنشأة هنا لمراعاتها في الطرح الاستشاري' : 'Write details for restructuring consideration'}
                      value={cNotes}
                      onChange={e => setCNotes(e.target.value)}
                      className="hw-input text-xs"
                    />
                  </div>

                  <button
                    type="submit"
                    className="hw-btn hw-btn-primary hw-btn-w"
                  >
                    {language === 'ar' ? 'حفظ وإدراج بجدول المعاينة' : 'Persist Strategist Session'}
                  </button>
                </form>
              </div>

              {/* List Col: 2/3 size */}
              <div className="lg:col-span-2 space-y-4">
                <div className="bg-white p-4 rounded-lg border border-slate-200">
                  <h5 className="font-bold text-slate-900 text-sm mb-0.5">{language === 'ar' ? 'قائمة حجوزات وجلسات إعادة الهيكلة في الانتظار' : 'Pending Restructuring & Excellence Workshops Queue'}</h5>
                  <p className="text-xs text-slate-500 mb-4 leading-relaxed">{language === 'ar' ? 'جدول رصد ومتابعة مواعيد استشارات الجهات مع المستشار د. أحمد السنوسي.' : 'Live tracking pipeline and strategic reports for corporate clients under review.'}</p>
                  
                  {loadingConsultations ? (
                    <div className="flex justify-center items-center py-12 gap-2">
                      <svg className="animate-spin h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <span className="text-slate-400 text-xs font-bold">{language === 'ar' ? 'جاري تحميل الحجوزات المستنشئة...' : 'Accessing consultations log...'}</span>
                    </div>
                  ) : consultationRequests.length === 0 ? (
                    <div className="text-center py-10 bg-slate-50 rounded-md border border-dashed border-slate-200">
                      <p className="text-slate-500 text-sm mt-2">{language === 'ar' ? 'لا توجد حجوزات نشطة حالياً.' : 'No active restructuring consult sessions yet.'}</p>
                      <p className="text-xs text-slate-400 mt-1">{language === 'ar' ? 'استخدم النموذج لجدولة جلسة جديدة.' : 'Use the scheduling form to add a record.'}</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {consultationRequests.map((req, index) => {
                        const dateLocaleStr = req.targetDate ? new Date(req.targetDate).toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A';
                        return (
                          <div key={req.id || index} className="p-4 bg-white hover:bg-slate-50 border border-slate-200 rounded-md transition-colors space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-slate-200 pb-2">
                              <div>
                                <span className={`inline-block px-1.5 py-0.5 text-[9px] font-bold rounded-sm uppercase border me-2 ${
                                  req.urgency === 'high'
                                    ? 'bg-red-50 text-red-700 border-red-200'
                                    : req.urgency === 'medium'
                                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                                    : 'bg-slate-50 text-slate-600 border-slate-200'
                                }`}>
                                  {req.urgency === 'high' ? (language === 'ar' ? 'مستعجل طارئ' : 'Emergency') : req.urgency === 'medium' ? (language === 'ar' ? 'مؤكد' : 'Medium') : (language === 'ar' ? 'طبيعي' : 'Standard')}
                                </span>
                                <h6 className="inline-block font-black text-slate-800 text-sm">{req.clientName}</h6>
                                <span className="text-xs text-slate-400 font-bold block mt-0.5 md:inline md:mt-0 md:ms-2">({req.industry})</span>
                              </div>
                              <span className={`inline-block px-2 py-0.5 text-[10px] font-bold rounded-md ${
                                req.status === 'completed'
                                  ? 'bg-green-50 text-green-800 border border-green-200'
                                  : req.status === 'report_drafted'
                                  ? 'bg-slate-100 text-slate-700 border border-slate-200'
                                  : req.status === 'scheduled'
                                  ? 'bg-amber-50 text-amber-800 border border-amber-200'
                                  : 'bg-slate-50 text-slate-600 border border-slate-200'
                              }`}>
                                {req.status === 'completed'
                                  ? (language === 'ar' ? 'تم التسليم والاعتماد' : 'Completed')
                                  : req.status === 'report_drafted'
                                  ? (language === 'ar' ? 'مسودة تقرير جاهزة' : 'Report Drafted')
                                  : req.status === 'scheduled'
                                  ? (language === 'ar' ? 'مجدول وجاري التحضير' : 'Scheduled')
                                  : (language === 'ar' ? 'مستلم وتوجيه فوري' : 'Received Pipeline')}
                              </span>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs leading-relaxed">
                              <div className="space-y-0.5">
                                <span className="text-[10px] text-slate-400 font-bold block">{language === 'ar' ? 'أجندة الجلسة المعيارية:' : 'Standard Session Agenda:'}</span>
                                <p className="font-extrabold text-slate-800 select-none flex items-center gap-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg> {req.agendaTopic}</p>
                              </div>
                              <div className="space-y-0.5">
                                <span className="text-[10px] text-slate-400 font-bold block">{language === 'ar' ? 'تاريخ عقد الجلسة المتوقع:' : 'Expected Session Date:'}</span>
                                <p className="font-extrabold text-slate-700 flex items-center gap-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg> {dateLocaleStr}</p>
                              </div>
                            </div>
                            
                            {req.additionalNotes && (
                              <div className="text-[11px] text-slate-500 bg-white p-2.5 rounded-md border border-slate-100">
                                <strong className="text-slate-700">{language === 'ar' ? 'ملاحظات استراتيجية رصدها المحلل:' : 'Strategic Observations Context:'}</strong> {req.additionalNotes}
                              </div>
                            )}

                            <div className="flex justify-between items-center text-[10px] text-slate-400 pt-1 border-t border-dashed border-slate-100">
                              <span>المستشار المفوّض: <strong className="text-slate-800">{req.consultantName}</strong></span>
                              <span>بريد التواصل: <span className="underline select-all text-slate-500 font-bold">{req.contactEmails}</span></span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

            </div>
          </div>
        )}
      </div>
      )}

      {/* Candidate Past Assessment Detailed Report Modal/Popup */}
      {selectedAssessment && (
        <div className="fixed inset-0 min-h-screen bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-fade-in" dir={language === 'ar' ? 'rtl' : 'ltr'}>
          <div className="bg-white rounded-xl border border-slate-200 shadow-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6 md:p-8 space-y-6 text-start flex flex-col relative">
            
            {/* Modal Header */}
            <div className="flex justify-between items-start border-b border-slate-100 pb-4">
              <div>
                <span className="hw-badge-success text-[10px] uppercase tracking-wide">
                  {language === 'ar' ? 'حالة مكتملة ومحفوظة سحابياً' : 'Completed Cloud Record'}
                </span>
                <h3 className="text-xl font-bold text-slate-900 mt-2">
                  {selectedAssessment.userName} — {selectedAssessment.jobTitle}
                </h3>
                <p className="text-xs text-slate-500 mt-1">E-mail: {selectedAssessment.userEmail}</p>
              </div>
              <button
                onClick={() => setSelectedAssessment(null)}
                className="p-1.5 px-3 text-slate-400 hover:text-slate-700 font-bold text-sm border border-slate-200 hover:bg-slate-50 rounded-md transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Modal Content layout */}
            <div className="space-y-6 flex-1 text-slate-700 text-sm overflow-y-auto max-h-[60vh] pr-2">
              <div className="grid grid-cols-3 gap-px bg-slate-200 border border-slate-200 rounded-lg overflow-hidden">
                <div className="bg-white p-3 text-start">
                  <span className="block text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1">{language === 'ar' ? 'مؤشر الكفاءة الكلي' : 'Overall Fit Score'}</span>
                  <p className="text-2xl font-bold text-emerald-600 tabular-nums">
                    {selectedAssessment.reportData?.totalScore ? `${Math.round(selectedAssessment.reportData.totalScore)}%` : 'N/A'}
                  </p>
                </div>
                <div className="bg-white p-3 text-start">
                  <span className="block text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1">{language === 'ar' ? 'نوع المحاكاة' : 'Process Mode'}</span>
                  <p className="text-sm font-semibold text-slate-800">
                    {selectedAssessment.assessmentType === 'verbal' ? (
                      <span className="flex items-center gap-1">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>
                        {language === 'ar' ? 'تقييم صوتي' : 'Speech'}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                        {language === 'ar' ? 'تحريري' : 'Written'}
                      </span>
                    )}
                  </p>
                </div>
                <div className="bg-white p-3 text-start">
                  <span className="block text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1">{language === 'ar' ? 'تاريخ الحفظ' : 'Saved Date'}</span>
                  <p className="text-xs font-semibold text-slate-600">
                    {new Date(selectedAssessment.timestamp).toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US')}
                  </p>
                </div>
              </div>

              {/* Competency Scores Breakdown */}
              {selectedAssessment.reportData?.competencyScores && (
                <div className="border border-slate-200 p-4 rounded-lg space-y-3 bg-white">
                  <h4 className="font-bold text-slate-800 mb-2 text-sm">{language === 'ar' ? 'تحليل نتائج الجدارات والذكاء الوظيفي' : 'Competency & IQ Ratings'}</h4>
                  <div className="space-y-3">
                    {selectedAssessment.reportData.competencyScores.map((c: any) => (
                      <div key={c.competency}>
                        <div className="flex justify-between text-xs mb-1 font-bold">
                          <span className="text-slate-700">{c.competency}</span>
                          <span className="text-slate-600 tabular-nums">{Math.round(c.score)}%</span>
                        </div>
                        <div className="hw-progress">
                          <div className="hw-progress-bar" style={{ width: `${c.score}%` }}></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Strengths & Weaknesses */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 bg-green-50 border border-green-100 rounded-lg space-y-1">
                  <span className="text-green-800 font-bold text-xs flex items-center gap-1">{language === 'ar' ? 'مواطن القوة والتميز' : 'Strategic Strengths'}</span>
                  <p className="text-xs text-slate-600 whitespace-pre-line leading-relaxed mt-1">
                    {selectedAssessment.reportData?.strengths || 'N/A'}
                  </p>
                </div>
                <div className="p-4 bg-amber-50 border border-amber-100 rounded-lg space-y-1">
                  <span className="text-amber-800 font-bold text-xs flex items-center gap-1">{language === 'ar' ? 'فرص التطوير والتحسين' : 'Areas for Improvement'}</span>
                  <p className="text-xs text-slate-600 whitespace-pre-line leading-relaxed mt-1">
                    {selectedAssessment.reportData?.weaknesses || 'N/A'}
                  </p>
                </div>
              </div>

              {/* Recommendations */}
              {selectedAssessment.reportData?.recommendations && (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                  <h5 className="font-bold text-xs text-slate-700 uppercase tracking-wider mb-2">{language === 'ar' ? 'استشارات وتوصيات الحوكمة الإدارية' : 'Governance & Development Roadmap'}</h5>
                  <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">
                    {selectedAssessment.reportData.recommendations}
                  </p>
                </div>
              )}

              {/* Holland Summary */}
              {selectedAssessment.reportData?.birkmanHollandSummary && (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                  <h5 className="font-bold text-xs text-slate-700 uppercase tracking-wider mb-2">{language === 'ar' ? 'تحليل جدارات هولاند وبريكمان وحوكمة السلوك' : 'Holland RIASEC & Birkman Behavioral Mapping'}</h5>
                  <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">
                    {selectedAssessment.reportData.birkmanHollandSummary}
                  </p>
                </div>
              )}

              {/* Human Evaluator & Quality Override Form */}
              <div className="border-t-2 border-dashed border-slate-200 pt-6 space-y-4">
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-5 space-y-4">
                  <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
                    <h5 className="font-bold text-sm text-slate-900">
                      {language === 'ar' ? 'نموذج تقييم واعتماد المقيّم البشري والجودة' : 'Human Expert Evaluation & Validation Override'}
                    </h5>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    {language === 'ar'
                      ? 'بصفتك مستشارًا بشريًا أو ممثل جودة في Ailigent.ai، يمكنك تدوين ملاحظات تدقيق إضافية، وتعديل حالة الملاءمة والدرجة التقديرية لإقرار هذا الموظف.'
                      : 'As a verified organizational consultant, you can register validation reports, alter active fit statuses, and sign-off on competencies below.'}
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Reviewer Name Input */}
                    <div>
                      <label className="block text-[10px] uppercase font-black text-slate-500 mb-1 font-mono">
                        {language === 'ar' ? 'اسم المستشار المقيّم' : 'Consultant Name'}
                      </label>
                      <input
                        type="text"
                        value={revName}
                        onChange={(e) => setRevName(e.target.value)}
                        placeholder={language === 'ar' ? 'مثال: أ. أحمد الهاشمي' : 'e.g. Dr. Alex Thorne'}
                        className="hw-input text-xs"
                        required
                      />
                    </div>
                    {/* Reviewer Email Input */}
                    <div>
                      <label className="block text-[10px] uppercase font-black text-slate-500 mb-1 font-mono">
                        {language === 'ar' ? 'البريد المهني الشريك' : 'Professional Email'}
                      </label>
                      <input
                        type="email"
                        value={revEmail}
                        onChange={(e) => setRevEmail(e.target.value)}
                        placeholder="consultant@corporate.com"
                        className="hw-input text-xs"
                        required
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Status Select */}
                    <div>
                      <label className="block text-[10px] uppercase font-black text-slate-500 mb-1 font-mono">
                        {language === 'ar' ? 'حالة مخرجات الحوكمة' : 'Fit Verification'}
                      </label>
                      <select
                        value={revStatus}
                        onChange={(e) => setRevStatus(e.target.value as any)}
                        className="hw-input text-xs"
                      >
                        <option value="approved">{language === 'ar' ? 'معتمد ومناسب للمنصب' : 'Approved & High Fit'}</option>
                        <option value="needs_revision">{language === 'ar' ? 'مراجعة إضافية مع العميل' : 'Needs Further Review'}</option>
                        <option value="rejected">{language === 'ar' ? 'غير مناسب للمنصب حالياً' : 'Do Not Approve'}</option>
                      </select>
                    </div>

                    {/* Star Rating Select Selector */}
                    <div>
                      <label className="block text-[10px] uppercase font-black text-slate-500 mb-1 font-mono">
                        {language === 'ar' ? 'الدرجة التقديرية العامة (1 - 5)' : 'Quality Indicator Grade (1-5 Stars)'}
                      </label>
                      <div className="flex items-center gap-1.5 py-1">
                        {[1, 2, 3, 4, 5].map((starValue) => (
                          <button
                            type="button"
                            key={starValue}
                            onClick={() => setRevRating(starValue)}
                            className="text-2xl transition-transform hover:scale-110"
                          >
                            {starValue <= revRating ? '★' : '☆'}
                          </button>
                        ))}
                        <span className="text-xs font-bold text-slate-500 ms-2">({revRating} / 5)</span>
                      </div>
                    </div>
                  </div>

                  {/* Comments Texarea */}
                  <div>
                    <label className="block text-[10px] uppercase font-black text-slate-500 mb-1 font-mono">
                      {language === 'ar' ? 'ملاحظات التدقيق والاستشارة المهنية للعميل' : 'Consultant Audit Synopsis & Expert Advice'}
                    </label>
                    <textarea
                      rows={3}
                      value={revComments}
                      onChange={(e) => setRevComments(e.target.value)}
                      placeholder={language === 'ar' ? 'اكتب تبريرات جدارات الذكاء وتأثيرات هولاند هنا...' : 'Provide background context explaining the evaluation override...'}
                      className="hw-textarea text-xs"
                    />
                  </div>

                  {/* Save button */}
                  <div className="flex justify-end pt-2">
                    <button
                      type="button"
                      onClick={handleSaveReview}
                      disabled={isSavingReview}
                      className="hw-btn hw-btn-primary flex items-center gap-2"
                    >
                      {isSavingReview ? (
                        <>
                          <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span>{language === 'ar' ? 'جاري الحفظ والجدولة السحابية...' : 'Persisting...'}</span>
                        </>
                      ) : (
                        <>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                          <span>{language === 'ar' ? 'تأكيد وحفظ مراجعة المقيّم بـ Firestore' : 'Authorize & Write Evaluator Review'}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer Controls */}
            <div className="border-t border-slate-100 pt-4 flex justify-end">
              <button
                onClick={() => setSelectedAssessment(null)}
                className="hw-btn hw-btn-ghost"
              >
                {language === 'ar' ? 'إغلاق المعاينة' : 'Close Details'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminPanel;
