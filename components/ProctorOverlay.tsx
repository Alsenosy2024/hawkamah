// B3 — Shared proctoring overlay.
//
// The candidate-facing exam surfaces all show the SAME live-proctor furniture:
// a fixed bottom-corner camera tile (with the shared-screen preview beside it and
// a status/integrity chip) plus a top-center cheating-alert banner. The three
// original portals (Unified/Online/Verbal) each inline this markup; the two
// surfaces added in B3 (EmployeePortalScreen, PublicSurveyScreen) render it via
// this component so the UI stays identical across every surface (B3 AC#4).
//
// Purely presentational: it owns no proctor lifecycle. The parent runs the
// useProctor hook, binds `videoRef`/`screenPreviewRef` to the camera + shared
// screen, and passes the hook's `proctor` API straight through.
import React, { type RefObject } from 'react';
import type { UseProctorApi } from '../hooks/useProctor';

interface ProctorOverlayProps {
  proctor: UseProctorApi;
  /** Visible camera preview tile (the engine feeds off its own hidden <video>). */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Visible preview of the shared screen, when screen-share was granted. */
  screenPreviewRef: RefObject<HTMLVideoElement | null>;
  /** Camera-acquisition error copy, shown under the tile. */
  camError?: string;
  language?: 'ar' | 'en';
}

const ProctorOverlay: React.FC<ProctorOverlayProps> = ({ proctor, videoRef, screenPreviewRef, camError, language = 'ar' }) => {
  const ar = language === 'ar';
  const t = (a: string, e: string) => (ar ? a : e);

  return (
    <>
      {/* Camera corner + live proctor chip + shared-screen preview */}
      <div className="fixed bottom-4 left-4 z-50 flex items-end gap-2">
        {/* Visible preview of the shared screen (what the proctor is monitoring). */}
        {proctor.screenStreamRef.current && (
          <div className="relative w-40 h-24 rounded-lg overflow-hidden border border-amber-300 bg-slate-900 shadow-lg">
            <video ref={screenPreviewRef} muted playsInline className="w-full h-full object-contain" />
            <div className="absolute bottom-0.5 right-1 bg-black/70 px-1.5 py-0.5 rounded text-[8px] font-bold text-amber-200 tracking-widest">
              {t('شاشتك المُراقَبة', 'YOUR SCREEN')}
            </div>
          </div>
        )}
        <div className="relative">
          <video
            ref={videoRef}
            muted
            playsInline
            className="w-28 h-20 rounded-lg object-cover border border-slate-300 bg-slate-900 shadow-md"
          />
          {/* Live proctor status chip: status + integrity (green ≥85 / amber ≥70 / rose <70). */}
          {proctor.status !== 'off' && (
            <div className={`absolute bottom-1 left-1 right-1 flex items-center justify-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide ${
              proctor.status === 'live'
                ? (proctor.integrity >= 85 ? 'bg-green-600 text-white' : proctor.integrity >= 70 ? 'bg-amber-500 text-slate-900' : 'bg-rose-600 text-white')
                : proctor.status === 'unavailable' ? 'bg-slate-600 text-white' : 'bg-slate-700 text-slate-200'
            }`}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${proctor.status === 'live' ? 'bg-white animate-pulse' : 'bg-slate-400'}`} />
              {proctor.status === 'live'
                ? t(`مراقبة ${proctor.integrity}`, `Monitoring ${proctor.integrity}`)
                : proctor.status === 'connecting' ? t('جارٍ التوصيل', 'Connecting')
                : proctor.status === 'unavailable' ? t('كاميرا فقط', 'Camera only')
                : t('انتهت', 'Ended')}
            </div>
          )}
          {camError && <p className="text-rose-600 text-xs mt-1 w-28 text-center">{camError}</p>}
        </div>
      </div>

      {/* Live cheating-alert banner — surfaces a real (non-'none') proctor violation. */}
      {proctor.alert && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg border bg-rose-600 text-white border-rose-700">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse flex-shrink-0" />
          <span className="text-xs font-bold">
            {proctor.alert.question != null
              ? t(`سلوك مُريب في السؤال ${proctor.alert.question + 1}`, `Suspicious behavior on question ${proctor.alert.question + 1}`)
              : t('رُصد سلوك مُريب', 'Suspicious behavior detected')}
          </span>
          <span className="text-[11px] opacity-80">{proctor.alert.type} · {proctor.alert.severity}</span>
          <button onClick={() => proctor.setAlert(null)} className="ms-2 text-white/70 hover:text-white leading-none flex items-center justify-center" aria-label={t('إغلاق', 'Dismiss')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      )}
    </>
  );
};

export default ProctorOverlay;
