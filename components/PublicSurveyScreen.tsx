// Public survey page — accessed via ?s=TOKEN (no admin login needed).
// Reads the token to get tenant/company context, shows a participant info form,
// then shows WorkplaceSurveyScreen. No other company names or data are ever shown here.
import React, { useState, useEffect, useRef } from 'react';
import { getSurveyToken, savePublicResponse } from '../services/surveyTokenService';
import WorkplaceSurveyScreen from './WorkplaceSurveyScreen';
import ProctorOverlay from './ProctorOverlay';
import { useProctor } from '../hooks/useProctor';
import type { SurveyToken, WorkEnvironmentAnswers } from '../types';
import PortalShell from './PortalShell';
import PortalSpinner from './PortalSpinner';
import PortalErrorCard from './PortalErrorCard';
import PortalThankYou from './PortalThankYou';
import ParticipantInfoForm from './ParticipantInfoForm';

interface Props {
  token: string;
}

interface ParticipantInfo {
  name: string;
  email: string;
  jobTitle: string;
  department: string;
}

const PublicSurveyScreen: React.FC<Props> = ({ token }) => {
  const [tokenData, setTokenData] = useState<SurveyToken | null>(null);
  const [state, setState] = useState<'loading' | 'info_form' | 'survey' | 'submitting' | 'done' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [participant, setParticipant] = useState<ParticipantInfo>({ name: '', email: '', jobTitle: '', department: '' });
  const [formErr, setFormErr] = useState('');

  const ar = tokenData?.language !== 'en';
  const t = (a: string, e: string) => ar ? a : e;

  // ── B3: live AI proctoring (camera + screen-share → Gemini Live signals) ──
  // The environment survey is candidate-facing; the owner asked for full proctoring
  // here too. The shared useProctor hook owns the engine lifecycle; this screen owns
  // the camera stream and the visible preview tiles (rendered via ProctorOverlay).
  const proctor = useProctor({ language: ar ? 'ar' : 'en', intervalMs: 4000 });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const screenPreviewRef = useRef<HTMLVideoElement | null>(null);
  const [camError, setCamError] = useState('');

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
    } catch {
      setCamError(t('تعذّر الوصول للكاميرا — يستمر الاستبيان.', 'Camera unavailable — the survey continues.'));
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(tr => tr.stop());
    streamRef.current = null;
    proctor.stopProctor();   // captures the integrity summary + releases screen tracks & hidden engine feeds
  };

  // Bind the visible previews once the survey view (and its <video>s) has mounted —
  // the gesture grabs the streams before these elements exist.
  useEffect(() => {
    if (state !== 'survey' && state !== 'submitting') return;
    if (videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
    const sp = screenPreviewRef.current, ss = proctor.screenStreamRef.current;
    if (sp && ss && sp.srcObject !== ss) { sp.srcObject = ss; sp.play().catch(() => {}); }
  }, [state, proctor.status]);

  // Release camera + proctor on unmount.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(tr => tr.stop());
    proctor.stopProctor();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getSurveyToken(token)
      .then(tok => {
        if (!tok) {
          setErrorMsg('هذا الرابط غير صحيح أو انتهت صلاحيته.');
          setState('error');
          return;
        }
        setTokenData(tok);
        setState('info_form');
      })
      .catch(() => {
        setErrorMsg('تعذّر تحميل الاستبيان. تحقق من اتصالك وأعد المحاولة.');
        setState('error');
      });
  }, [token]);

  const handleInfoSubmit = () => {
    if (!participant.name.trim()) { setFormErr(t('الاسم مطلوب.', 'Name is required.')); return; }
    if (!participant.email.trim() || !participant.email.includes('@')) { setFormErr(t('بريد إلكتروني صالح مطلوب.', 'Valid email required.')); return; }
    if (!participant.jobTitle.trim()) { setFormErr(t('المسمى الوظيفي مطلوب.', 'Job title required.')); return; }
    setFormErr('');
    setState('survey');
    // B3 — begin proctoring on THIS user gesture (getDisplayMedia requires one).
    // Request the screen first, then start the camera + Gemini-Live engine once the
    // screen decision resolves, so the engine receives both streams (or camera-only
    // if screen-share is declined). Never throws — degrades gracefully.
    proctor.requestScreen().then(async (scr) => {
      if (scr && screenPreviewRef.current) {
        screenPreviewRef.current.srcObject = scr;
        screenPreviewRef.current.play().catch(() => {});
      }
      await startCamera();
      proctor.startProctor(streamRef.current, proctor.screenStreamRef.current);
    });
  };

  const handleSubmit = async (answers: WorkEnvironmentAnswers) => {
    if (!tokenData) return;
    setState('submitting');
    stopCamera();   // stop camera + proctor and capture the integrity summary before persisting
    try {
      await savePublicResponse({
        tokenId: token,
        tenantId: tokenData.tenantId,
        projectId: tokenData.projectId,
        companyName: tokenData.companyName,
        answers,
        submittedAt: new Date().toISOString(),
        respondentName: participant.name,
        respondentEmail: participant.email,
        respondentJobTitle: participant.jobTitle,
        ...(participant.department.trim() ? { respondentDepartment: participant.department } : {}),
        ...(proctor.summaryRef.current ? { proctorSummary: proctor.summaryRef.current } : {}),
      });
      setState('done');
    } catch {
      setErrorMsg(t('حدث خطأ أثناء الإرسال. أعد المحاولة.', 'An error occurred. Please try again.'));
      setState('error');
    }
  };

  return (
      <PortalShell
        language={tokenData?.language}
        companyName={tokenData?.companyName}
        subtitle={t('استبيان بيئة العمل', 'Workplace Environment Survey')}
      >
        {state === 'loading' && (
          <PortalSpinner message={t('جارٍ التحميل…', 'Loading…')} />
        )}

        {state === 'error' && (
          <PortalErrorCard message={errorMsg} language={tokenData?.language} />
        )}

        {state === 'submitting' && (
          <PortalSpinner message={t('جارٍ إرسال إجاباتك…', 'Submitting your answers…')} />
        )}

        {state === 'done' && (
          <PortalThankYou
            title={t('شكراً جزيلاً!', 'Thank you!')}
            message={
              <>
                {t('تم استلام إجاباتك بنجاح.', 'Your answers have been received successfully.')}
                {tokenData && <> {t('ستصل نتائجك لإدارة', 'Results will reach the management of')} <strong>{tokenData.companyName}</strong>.</>}
              </>
            }
            footnote={t('يمكنك إغلاق هذه النافذة الآن.', 'You may close this window now.')}
            language={tokenData?.language}
          />
        )}

        {state === 'info_form' && tokenData && (
          <ParticipantInfoForm
            values={participant}
            onChange={patch => setParticipant(p => ({ ...p, ...patch }))}
            onSubmit={handleInfoSubmit}
            error={formErr}
            language={tokenData.language}
            title={t('بياناتك الشخصية', 'Your Information')}
            subtitle={t('نحتاج هذه المعلومات لمعرفة من ملأ الاستبيان', 'We need this information to know who completed the survey')}
            showConsent
            consentContext="survey"
          />
        )}

        {state === 'survey' && tokenData && (
          <div className="w-full max-w-3xl">
            <WorkplaceSurveyScreen
              onSubmit={handleSubmit}
              language={tokenData.language}
              mandatory={true}
            />
          </div>
        )}

        {/* B3 — live proctoring furniture (camera tile + screen preview + status chip + alert banner).
            Rendered inside PortalShell so it inherits the RTL/LTR direction (matches EmployeePortalScreen). */}
        {(state === 'survey' || state === 'submitting') && (
          <ProctorOverlay
            proctor={proctor}
            videoRef={videoRef}
            screenPreviewRef={screenPreviewRef}
            camError={camError}
            language={ar ? 'ar' : 'en'}
          />
        )}
      </PortalShell>
  );
};

export default PublicSurveyScreen;
