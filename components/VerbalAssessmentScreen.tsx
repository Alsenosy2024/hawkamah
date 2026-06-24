import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Language, AssessmentConfig, Question, AffectPerQuestion, AffectSignal } from '../types';
import { TRANSLATIONS } from '../constants';
import { speak as ttsSpeak, cancelSpeech, prefetch as ttsPrefetch, unlockAudio } from '../services/ttsService';
import { scoreAnswer, ScoredAnswer, transcribeAudio } from '../services/geminiService';
import { MicRecorder, MicRecordError } from '../lib/audioRecorder';
import { createLiveProctor, type LiveProctorHandle } from '../services/proctorService';
import { type ProctorSummary } from '../services/proctorCore';

// Speech-to-Text now runs through MicRecorder (raw PCM → 16 kHz WAV) + Gemini
// transcription — NOT the browser's webkitSpeechRecognition, which failed
// silently and barely understood Arabic. Support just needs getUserMedia + a
// secure context (https/localhost); both hold on the live deploy.
const STT_SUPPORTED =
    typeof window !== 'undefined' &&
    !!navigator?.mediaDevices?.getUserMedia &&
    !!(window.AudioContext || (window as any).webkitAudioContext);

// --- Avatar ---
const AVATAR = {
    name: 'Dr. Ahmed',
    imageUrl: "https://img.freepik.com/free-photo/handsome-bearded-businessman-rubbing-hands-having-deal_176420-18778.jpg?w=740",
};

// --- UI Icons ---
const MicIcon = ({ off }: { off?: boolean }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        {off ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3zM3 3l18 18" /> : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />}
    </svg>
);
const CamIcon = ({ off }: { off?: boolean }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        {off ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2zM3 3l18 18" /> : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />}
    </svg>
);
const EndCallIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
        <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" transform="rotate(135 12 12)"/>
    </svg>
);
const ReplayIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
);

// Strip a leading "A. " / "ب) " option marker for clean speech.
const stripMarker = (s: string) => s.replace(/^\s*[A-Hأ-ي][\.\)\-:]\s*/, '').trim();
const optionKey = (s: string, i: number) => {
    const m = s.match(/^\s*([A-H])[\.\)\-:]/);
    return m ? m[1].toUpperCase() : String.fromCharCode(65 + i);
};

type Phase = 'idle' | 'speaking' | 'answering' | 'transition' | 'done';

interface AnsweredItem { index: number; question: Question; answer: string; }

interface VerbalAssessmentScreenProps {
    // affect is optional & best-effort: undefined when no browser-native signal could be captured.
    onFinish: (transcript: string, affect?: AffectSignal) => void;
    language: Language;
    config: AssessmentConfig;
    questions: Question[];
    // totalExpected: full count admin requested (may be > questions.length while background batch loads)
    // Used to prevent premature finish when fast candidates answer before remaining questions arrive.
    totalExpected?: number;
    // voiceCount: how many questions are SPOKEN (voice) — comes from the launch token.
    // When omitted, we fall back to the legacy ~15%-of-set heuristic.
    voiceCount?: number;
}

// --- Affect capture (browser-native, no deps, fully feature-detected) ---
// Live accumulators for the CURRENT answering window. Reset on each new question.
interface AffectAccumulator {
    started: boolean;
    startTs: number;
    rmsSum: number;        // running sum of per-frame RMS (0..1)
    frames: number;        // RMS frames sampled
    voicedFrames: number;  // frames whose RMS exceeded the noise floor
    zcrValues: number[];   // per-frame zero-crossing-rate (pitch-proxy spread)
    faceHits: number;      // video frames where a face was detected
    faceSamples: number;   // total video frames sampled
}

// Browser-experimental FaceDetector — typed loosely; entirely optional.
interface FaceDetectorLike { detect(source: CanvasImageSource): Promise<Array<unknown>>; }
type FaceDetectorCtor = new (opts?: { fastMode?: boolean; maxDetectedFaces?: number }) => FaceDetectorLike;

const NOISE_FLOOR = 0.012;  // RMS below this counts as silence
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

const VerbalAssessmentScreen: React.FC<VerbalAssessmentScreenProps> = ({ onFinish, language, config, questions, totalExpected, voiceCount }) => {
    const T = TRANSLATIONS[language];

    // ── MERGED PATH (owner mandate 2026-06-16) ──────────────────────────────
    // One unified interview: MOST questions are silent on-screen written/MCQ
    // (answered by tapping a choice or typing — zero TTS, zero wait), and a small
    // ~10-15% are VOICE questions where the interviewer SPEAKS (instantly) and the
    // candidate answers by voice (live transcription) or types. We pick the voice
    // indices deterministically and spread them evenly across the set (skipping
    // index 0 so the very first question is an instant written one — no cold-start
    // freeze on open). 4-5 voice questions in a typical ~30-question set.
    const voiceIndices = useMemo(() => {
        const n = Math.max(questions.length, totalExpected || 0);
        const set = new Set<number>();
        if (n <= 1) return set;
        // Honor the launch token's voiceCount when provided; else legacy ~15% heuristic.
        const requested = (voiceCount != null && voiceCount >= 0) ? voiceCount : Math.round(n * 0.15);
        const count = Math.min(n - 1, Math.max(0, requested));
        if (count === 0) return set;
        const step = n / (count + 1);  // even interior spacing, never index 0
        for (let k = 1; k <= count; k++) set.add(Math.min(n - 1, Math.max(1, Math.round(step * k))));
        return set;
    }, [questions.length, totalExpected, voiceCount]);
    const isVoiceQ = useCallback((idx: number) => voiceIndices.has(idx), [voiceIndices]);

    // Flow state
    const [step, setStep] = useState<'lobby' | 'meeting'>('lobby');
    const [isMicOn, setIsMicOn] = useState(true);
    const [isCamOn, setIsCamOn] = useState(true);
    const [meetingTime, setMeetingTime] = useState(0);

    const [currentIndex, setCurrentIndex] = useState(0);
    const [phase, setPhase] = useState<Phase>('idle');
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [answered, setAnswered] = useState<AnsweredItem[]>([]);
    const [manualText, setManualText] = useState('');
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [caption, setCaption] = useState('');
    const [error, setError] = useState<string | null>(null);
    // STT live state. `listening` = mic open in the answering window. `micLevel` =
    // live input level 0..1 (drives the VU meter that PROVES we hear the candidate).
    // `thinking` = transcribing/acking a just-finished utterance. `interimText` =
    // last segment recognized (shown so they see their words land). `sttBlocked` =
    // mic denied/unavailable → graceful text+MCQ fallback.
    const [interimText, setInterimText] = useState('');
    const [listening, setListening] = useState(false);
    const [thinking, setThinking] = useState(false);
    const [micLevel, setMicLevel] = useState(0);
    const [sttBlocked, setSttBlocked] = useState(false);
    const [convoHint, setConvoHint] = useState('');  // live human-facing line ("أسمعك الآن")

    // Refs
    const lobbyVideoRef = useRef<HTMLVideoElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const timerIntervalRef = useRef<number | null>(null);

    // --- Live AI proctoring (Gemini Live: camera + screen → cheating signals) ---
    const proctorRef        = useRef<LiveProctorHandle | null>(null);
    const screenStreamRef   = useRef<MediaStream | null>(null);
    const screenPreviewRef  = useRef<HTMLVideoElement>(null);   // VISIBLE screen-share preview tile
    const proctorElsRef     = useRef<HTMLVideoElement[]>([]);   // hidden <video>s feeding the proctor
    const proctorSummaryRef = useRef<ProctorSummary | null>(null);
    const [proctorStatus, setProctorStatus]       = useState<'off' | 'connecting' | 'live' | 'unavailable' | 'closed'>('off');
    const [proctorIntegrity, setProctorIntegrity] = useState(100);
    const [proctorAlert, setProctorAlert]         = useState<{ type: string; severity: string } | null>(null);
    const transcriptRef = useRef<string>('');
    const spokenForIndexRef = useRef<number>(-1);  // guard against double-speak (StrictMode / re-render)

    // --- Conversational STT + deterministic scoring refs ---
    const micRef = useRef<MicRecorder | null>(null);   // live streaming recorder (per voice question)
    const sttPhaseRef = useRef<Phase>('idle');          // latest phase, read inside async callbacks
    const listeningRef = useRef<boolean>(false);        // mirror of `listening` for callbacks
    const ackBusyRef = useRef<boolean>(false);          // true while transcribing/speaking an ack (VAD paused, echo suppressed)
    const answerRef = useRef<string>('');               // running answer text for the current voice question
    const scoresRef = useRef<ScoredAnswer[]>([]);       // per-answer scores (async, non-blocking) → final report
    // --- VAD (voice-activity detection) state, per utterance segment ---
    const vadSpeechFramesRef = useRef<number>(0);       // consecutive frames above the speech threshold
    const vadSilenceFramesRef = useRef<number>(0);      // consecutive silent frames after speech began
    const vadHadSpeechRef = useRef<boolean>(false);     // any speech captured in the current segment
    const awaitingConfirmRef = useRef<boolean>(false);  // true after we asked "هل انتهيت؟" — next utterance is the candidate's yes/no

    // --- Affect capture refs (best-effort, all guarded) ---
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const affectRafRef = useRef<number | null>(null);          // requestAnimationFrame id (audio loop)
    const faceTimerRef = useRef<number | null>(null);          // setInterval id (face sampling)
    const faceDetectorRef = useRef<FaceDetectorLike | null>(null);
    const faceCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const accRef = useRef<AffectAccumulator | null>(null);     // current-question accumulator
    const perQuestionRef = useRef<AffectPerQuestion[]>([]);    // accumulated across the interview
    const audioEverRef = useRef<boolean>(false);
    const faceEverRef = useRef<boolean>(false);
    const teardownAffectRef = useRef<() => void>(() => {});  // latest teardown, for unmount cleanup (avoids decl-order coupling)

    // Gemini neural TTS (reliable Arabic) handles browsers with no ar-SA voice.
    const ttsAvailable = true;

    useEffect(() => () => {
        cancelSpeech();
        teardownAffectRef.current();
        listeningRef.current = false;
        try { micRef.current?.abort(); } catch { /* noop */ }
        micRef.current = null;
        // Backstop: release proctor + screen if the component unmounts without finish().
        try { proctorRef.current?.stop(); } catch { /* noop */ }
        proctorRef.current = null;
        screenStreamRef.current?.getTracks().forEach(t => t.stop());
        screenStreamRef.current = null;
        proctorElsRef.current.forEach(v => { try { v.pause(); v.srcObject = null; v.remove(); } catch { /* noop */ } });
        proctorElsRef.current = [];
    }, []);

    // Speak a phrase fully (real neural audio); resolve on natural end.
    const speak = useCallback(async (text: string): Promise<void> => {
        setCaption(text);
        if (!text.trim()) return;
        setIsSpeaking(true);
        try {
            // instant: cap time-to-first-sound (warm neural if ready, else browser
            // voice immediately) — the interviewer must speak at once, never freeze.
            await ttsSpeak(text, { gender: 'male', lang: language === 'ar' ? 'ar-SA' : 'en-US', instant: true });
        } finally {
            setIsSpeaking(false);
        }
    }, [language]);

    // ════════════════════════════════════════════════════════════════════════
    // CONVERSATIONAL STT — the interview genuinely HEARS the candidate and talks
    // back like a person (owner mandate 2026-06-16). webkitSpeechRecognition is
    // gone (it heard nothing & barely did Arabic). Instead, on a VOICE question:
    //   1. MicRecorder streams raw PCM. onLevel drives a LIVE VU meter — visible
    //      proof "أسمعك الآن" the moment the candidate speaks (fixes "ما بيسمعنيش").
    //   2. A silence-based VAD cuts the stream into utterance segments.
    //   3. Each segment → Gemini transcription (real Arabic), appended to the
    //      answer, and answered with a short SPOKEN human acknowledgement
    //      ("تمام، كمّل") so it's a two-way conversation, not a monologue.
    //   4. Spoken COMMANDS are obeyed: "وريني السؤال اللي جاي"/"التالي" → next,
    //      "أعد/كرر" → replay, "خلصت إجابتي/انتهيت" → finalize & advance.
    //   5. Echo-safe: while it speaks an ack, VAD pauses and the audio captured
    //      during its own speech is discarded (it never transcribes itself —
    //      fixes "بيتكلم مع نفسه").
    // Fully guarded: denied mic / unsupported / any error → text+MCQ fallback.
    // ════════════════════════════════════════════════════════════════════════
    const onAudioFrameRef = useRef<(level: number) => void>(() => {});
    const submitAnswerRef = useRef<(text: string) => void>(() => {});
    const replayRef = useRef<() => void>(() => {});

    const SPEECH_LEVEL = 0.08;   // VU level above this counts as voice
    const SILENCE_HANG = 5;      // ~5 frames (~1.3s) of silence ends an utterance
    const MIN_SPEECH_FRAMES = 2; // need at least this much voice to treat as speech

    // Turn-taking: when the candidate pauses we ASK if they're done, then wait for
    // their yes/no before advancing (owner mandate 2026-06-16, "نقطة مهمة جداً").
    const CONFIRM_Q = useMemo(() => (language === 'ar'
        ? 'هل انتهيت من إجابتك؟'
        : 'Have you finished your answer?'), [language]);
    const KEEP_GOING = useMemo(() => (language === 'ar'
        ? 'تمام، كمّل.'
        : 'Okay, go ahead.'), [language]);

    // Classify one spoken utterance: a short command, or plain answer content.
    // Commands must be SHORT (≤6 words) so a long answer that merely contains a
    // word like "التالي" is never misread as a command.
    const classifyUtterance = useCallback((raw: string): 'next' | 'done' | 'replay' | 'answer' | 'empty' => {
        const t = (raw || '').trim();
        if (!t) return 'empty';
        const norm = t.replace(/[ً-ْ]/g, '').toLowerCase();  // drop Arabic diacritics
        const words = norm.split(/\s+/).filter(Boolean).length;
        const short = words <= 6;
        const has = (re: RegExp) => re.test(norm);
        if (short && (has(/(خلصت|انتهيت|انهيت|كده خلاص|هذا كل|هذه اجابت|انا خلصت|خلاص كده)/) ||
            has(/\b(i'?m done|im done|that'?s all|that is all|finished|done answering|i have finished)\b/))) return 'done';
        if (short && (has(/(السوال (اللي )?(الجاي|القادم|التالي)|ورّ?يني السوال|^التالي$|اللي بعده|انتقل|عدّ?ي ال?سوال|بعده)/) ||
            has(/\b(next question|^next$|skip|move on|go next)\b/))) return 'next';
        if (short && (has(/(^اعد|^أعد|كرر|كرّر|اعاده|عيد|تاني)/) ||
            has(/\b(repeat|say again|again|replay)\b/))) return 'replay';
        return 'answer';
    }, []);

    // Short yes/no detectors for the "هل انتهيت؟" turn-taking step. Gated short so a
    // long answer that merely contains "نعم"/"لا" is never read as a confirmation.
    const isShortAffirm = useCallback((raw: string): boolean => {
        const t = (raw || '').replace(/[ً-ْ]/g, '').trim().toLowerCase();
        if (!t || t.split(/\s+/).filter(Boolean).length > 4) return false;
        return /(^|\s)(نعم|ايوه|أيوه|اه|أه|ايوا|خلاص|تمام|صح|اكيد|أكيد|طبعا|طبعاً|انتهيت|خلصت)(\s|$)/.test(t)
            || /\b(yes|yeah|yep|yup|sure|correct|done|ok|okay|finished)\b/.test(t);
    }, []);
    const isShortNegate = useCallback((raw: string): boolean => {
        const t = (raw || '').replace(/[ً-ْ]/g, '').trim().toLowerCase();
        if (!t || t.split(/\s+/).filter(Boolean).length > 4) return false;
        return /(^|\s)(لا|لأ|لسه|لسا|مش خلصت|مازال|مستني|استني|انتظر|كمان)(\s|$)/.test(t)
            || /\b(no|not yet|wait|hold on|more)\b/.test(t);
    }, []);

    const advanceWithAnswer = useCallback(() => {
        awaitingConfirmRef.current = false;
        const ans = answerRef.current.trim();
        setConvoHint('');
        submitAnswerRef.current(ans || (language === 'ar'
            ? '(انتقل المرشح دون إجابة منطوقة)'
            : '(candidate moved on without a spoken answer)'));
    }, [language]);

    // Process a transcribed utterance. Conversational turn-taking (owner mandate):
    // candidate speaks → pauses → we ASK "هل انتهيت من إجابتك؟" → they say خلاص/نعم
    // → we accept & advance; لا/لسه → we keep listening; more content → we append
    // and ask again. Explicit commands still work at any time.
    const handleUtterance = useCallback(async (text: string) => {
        const kind = classifyUtterance(text);
        if (kind === 'empty') return;
        if (kind === 'replay') { awaitingConfirmRef.current = false; setConvoHint(''); replayRef.current(); return; }
        // Explicit "التالي"/"خلصت" command → advance immediately, no confirm needed.
        if (kind === 'next' || kind === 'done') { advanceWithAnswer(); return; }

        if (awaitingConfirmRef.current) {
            // We just asked "هل انتهيت؟" — read their yes/no.
            if (isShortAffirm(text)) { advanceWithAnswer(); return; }
            if (isShortNegate(text)) {
                awaitingConfirmRef.current = false;
                setConvoHint(language === 'ar' ? '● كمّل إجابتك' : '● keep going');
                await speak(KEEP_GOING);
                return;
            }
            // Neither a clear yes nor no → treat as MORE answer, append and re-ask.
            awaitingConfirmRef.current = false;
        }

        // Plain answer content → append, then ASK whether they're done.
        const piece = text.trim();
        answerRef.current = (answerRef.current ? answerRef.current.trimEnd() + ' ' : '') + piece;
        setManualText(answerRef.current);
        setInterimText(piece);
        awaitingConfirmRef.current = true;
        setConvoHint(language === 'ar' ? 'هل انتهيت من إجابتك؟ قل «خلاص» للانتقال' : 'Finished? say "done" to continue');
        await speak(CONFIRM_Q);
    }, [classifyUtterance, language, speak, isShortAffirm, isShortNegate, advanceWithAnswer, CONFIRM_Q, KEEP_GOING]);

    // Close out the current utterance: flush its audio, transcribe, act on it,
    // then discard whatever leaked in during processing (incl. our own TTS).
    const endUtterance = useCallback(async () => {
        if (ackBusyRef.current) return;
        ackBusyRef.current = true;  // pause VAD + suppress echo
        const seg = micRef.current?.flush() || null;
        vadSpeechFramesRef.current = 0; vadSilenceFramesRef.current = 0; vadHadSpeechRef.current = false;
        if (!seg) { ackBusyRef.current = false; return; }
        setThinking(true);
        setConvoHint(language === 'ar' ? 'بحوّل كلامك لنص…' : 'transcribing…');
        let text = '';
        try { text = await transcribeAudio(seg.base64, seg.mimeType, language); }
        catch { text = ''; }
        setThinking(false);
        try { await handleUtterance(text); } catch { /* non-fatal */ }
        // Drop anything captured during transcription + ack (so we never hear ourselves).
        try { micRef.current?.discard(); } catch { /* noop */ }
        vadSpeechFramesRef.current = 0; vadSilenceFramesRef.current = 0; vadHadSpeechRef.current = false;
        if (listeningRef.current) setConvoHint(language === 'ar' ? '● أسمعك — تكلّم بإجابتك' : '● I hear you — keep speaking');
        ackBusyRef.current = false;
    }, [language, handleUtterance]);

    // The per-frame VAD, kept in a ref so the recorder callback always hits the
    // latest closure without re-creating the recorder.
    onAudioFrameRef.current = (level: number) => {
        setMicLevel(level);
        if (ackBusyRef.current || !listeningRef.current) return;
        if (level >= SPEECH_LEVEL) {
            vadSpeechFramesRef.current++;
            vadSilenceFramesRef.current = 0;
            if (vadSpeechFramesRef.current >= MIN_SPEECH_FRAMES && !vadHadSpeechRef.current) {
                vadHadSpeechRef.current = true;
                setConvoHint(language === 'ar' ? '● أسمعك الآن — تكلّم' : '● I hear you now — speak');
            }
        } else if (vadHadSpeechRef.current) {
            vadSilenceFramesRef.current++;
            if (vadSilenceFramesRef.current >= SILENCE_HANG) endUtterance();
        }
    };

    const armListening = useCallback(async () => {
        if (!STT_SUPPORTED || sttBlocked || !isMicOn) return;
        if (micRef.current) return;  // already open
        answerRef.current = '';
        awaitingConfirmRef.current = false;
        vadSpeechFramesRef.current = 0; vadSilenceFramesRef.current = 0; vadHadSpeechRef.current = false;
        ackBusyRef.current = false;
        const rec = new MicRecorder((lvl) => onAudioFrameRef.current(lvl));
        try {
            await rec.start();
            micRef.current = rec;
            listeningRef.current = true;
            setListening(true);
            setConvoHint(language === 'ar' ? 'المايك مفتوح — تكلّم بإجابتك' : 'Mic is open — speak your answer');
        } catch (e) {
            const reason = (e as MicRecordError)?.reason;
            // Only a hard denial disables voice for good; transient errors still fall back to typing.
            if (reason === 'permission' || reason === 'insecure' || reason === 'unsupported') setSttBlocked(true);
            listeningRef.current = false;
            setListening(false);
            setConvoHint('');
            try { rec.abort(); } catch { /* noop */ }
        }
    }, [language, isMicOn, sttBlocked]);

    const disarmListening = useCallback(() => {
        listeningRef.current = false;
        ackBusyRef.current = false;
        awaitingConfirmRef.current = false;
        setListening(false);
        setMicLevel(0);
        setConvoHint('');
        const rec = micRef.current;
        micRef.current = null;
        try { rec?.abort(); } catch { /* noop */ }
    }, []);

    // Drive the mic lifecycle off the interview phase: open the conversational mic
    // only while answering a VOICE question (written/MCQ need no mic — tap/type).
    useEffect(() => {
        sttPhaseRef.current = phase;
        if (phase === 'answering' && isMicOn && isVoiceQ(currentIndex)) armListening();
        else disarmListening();
    }, [phase, isMicOn, currentIndex, isVoiceQ, armListening, disarmListening]);

    // ---- Affect capture: lazy Web Audio init on the existing mic stream ----
    // Returns true if an analyser is ready. Fully guarded: missing AudioContext,
    // no mic track, or any error → returns false and the interview proceeds normally.
    const ensureAudioGraph = useCallback((): boolean => {
        if (analyserRef.current) return true;
        try {
            const stream = streamRef.current;
            if (!stream || stream.getAudioTracks().length === 0) return false;
            const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
            if (!Ctx) return false;
            const ctx = new Ctx();
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);  // NOT connected to destination → no echo
            audioCtxRef.current = ctx;
            sourceNodeRef.current = source;
            analyserRef.current = analyser;
            return true;
        } catch {
            return false;
        }
    }, []);

    // Lazily build a FaceDetector if the experimental API exists.
    const ensureFaceDetector = useCallback((): FaceDetectorLike | null => {
        if (faceDetectorRef.current) return faceDetectorRef.current;
        try {
            const Ctor = (window as any).FaceDetector as FaceDetectorCtor | undefined;
            if (!Ctor) return null;
            faceDetectorRef.current = new Ctor({ fastMode: true, maxDetectedFaces: 1 });
            return faceDetectorRef.current;
        } catch {
            return null;
        }
    }, []);

    // Begin capturing affect for the answering window of `index`.
    const startAffectCapture = useCallback((index: number) => {
        // Reset accumulator for this question.
        accRef.current = {
            started: true, startTs: Date.now(),
            rmsSum: 0, frames: 0, voicedFrames: 0, zcrValues: [],
            faceHits: 0, faceSamples: 0,
        };

        // --- VOICE: sample RMS + zero-crossing-rate per animation frame ---
        if (ensureAudioGraph() && analyserRef.current) {
            audioEverRef.current = true;
            const analyser = analyserRef.current;
            const buf = new Float32Array(analyser.fftSize);
            const sample = () => {
                const acc = accRef.current;
                if (!acc || !acc.started) return;
                analyser.getFloatTimeDomainData(buf);
                let sumSq = 0, crossings = 0, prev = buf[0];
                for (let i = 0; i < buf.length; i++) {
                    const v = buf[i];
                    sumSq += v * v;
                    if ((v >= 0 && prev < 0) || (v < 0 && prev >= 0)) crossings++;
                    prev = v;
                }
                const rms = Math.sqrt(sumSq / buf.length);
                acc.rmsSum += rms;
                acc.frames++;
                if (rms > NOISE_FLOOR) {
                    acc.voicedFrames++;
                    acc.zcrValues.push(crossings / buf.length);  // pitch-proxy only on voiced frames
                }
                affectRafRef.current = window.requestAnimationFrame(sample);
            };
            affectRafRef.current = window.requestAnimationFrame(sample);
        }

        // --- FACIAL (optional): sample the live video element ~2x/sec ---
        const detector = ensureFaceDetector();
        const video = videoRef.current;
        if (detector && video) {
            faceEverRef.current = true;
            if (!faceCanvasRef.current) faceCanvasRef.current = document.createElement('canvas');
            faceTimerRef.current = window.setInterval(() => {
                const acc = accRef.current;
                const canvas = faceCanvasRef.current;
                if (!acc || !acc.started || !canvas || !video.videoWidth) return;
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const g = canvas.getContext('2d');
                if (!g) return;
                g.drawImage(video, 0, 0, canvas.width, canvas.height);
                acc.faceSamples++;
                detector.detect(canvas)
                    .then(faces => { if (accRef.current === acc && faces.length > 0) acc.faceHits++; })
                    .catch((err: unknown) => { if ((err as any)?.name !== 'AbortError') console.warn('[FaceDetector]', err); });
            }, 500);
        }
    }, [ensureAudioGraph, ensureFaceDetector]);

    // Stop capture for the current window, fold features into perQuestionRef.
    const stopAffectCapture = useCallback((index: number) => {
        const acc = accRef.current;
        accRef.current = null;
        if (affectRafRef.current != null) { window.cancelAnimationFrame(affectRafRef.current); affectRafRef.current = null; }
        if (faceTimerRef.current != null) { window.clearInterval(faceTimerRef.current); faceTimerRef.current = null; }
        if (!acc || acc.frames === 0) return;  // nothing captured (e.g. no audio support)

        const energy = clamp01((acc.rmsSum / acc.frames) * 6);  // RMS is tiny; scale into a usable 0..1 band
        const speechRatio = clamp01(acc.voicedFrames / acc.frames);
        // Pitch-variability proxy: std-dev of zero-crossing-rate across voiced frames.
        let pitchVar = 0;
        if (acc.zcrValues.length > 1) {
            const mean = acc.zcrValues.reduce((s, v) => s + v, 0) / acc.zcrValues.length;
            const variance = acc.zcrValues.reduce((s, v) => s + (v - mean) ** 2, 0) / acc.zcrValues.length;
            pitchVar = clamp01(Math.sqrt(variance) * 12);  // scale std-dev into 0..1
        }
        const item: AffectPerQuestion = {
            questionIndex: index,
            energy, speechRatio, pitchVar,
            durationMs: Date.now() - acc.startTs,
        };
        if (acc.faceSamples > 0) item.facePresent = clamp01(acc.faceHits / acc.faceSamples);
        perQuestionRef.current.push(item);
    }, []);

    // Build the whole-interview aggregate (undefined when nothing was captured).
    const buildAffectSignal = useCallback((): AffectSignal | undefined => {
        const pq = perQuestionRef.current;
        if (pq.length === 0) return undefined;
        const mean = (sel: (i: AffectPerQuestion) => number) => pq.reduce((s, i) => s + sel(i), 0) / pq.length;
        const faceItems = pq.filter(i => typeof i.facePresent === 'number');
        const signal: AffectSignal = {
            perQuestion: pq,
            avgEnergy: clamp01(mean(i => i.energy)),
            avgSpeechRatio: clamp01(mean(i => i.speechRatio)),
            avgPitchVar: clamp01(mean(i => i.pitchVar)),
            audioAvailable: audioEverRef.current,
            faceAvailable: faceEverRef.current,
        };
        if (faceItems.length > 0) {
            signal.avgFacePresent = clamp01(faceItems.reduce((s, i) => s + (i.facePresent || 0), 0) / faceItems.length);
        }
        return signal;
    }, []);

    // Tear down the whole audio graph + timers (on finish/unmount).
    const teardownAffect = useCallback(() => {
        if (affectRafRef.current != null) { window.cancelAnimationFrame(affectRafRef.current); affectRafRef.current = null; }
        if (faceTimerRef.current != null) { window.clearInterval(faceTimerRef.current); faceTimerRef.current = null; }
        try { sourceNodeRef.current?.disconnect(); } catch { /* noop */ }
        try { audioCtxRef.current?.close(); } catch { /* noop */ }
        sourceNodeRef.current = null; analyserRef.current = null; audioCtxRef.current = null;
        accRef.current = null;
    }, []);
    teardownAffectRef.current = teardownAffect;  // keep the unmount cleanup pointed at the live impl

    // Short instant greeting spoken once on join (so the interviewer talks AT ONCE).
    const greetingText = language === 'ar'
        ? 'مرحباً بك، أنا الدكتور أحمد. سنبدأ المقابلة الآن.'
        : 'Welcome, I am Dr. Ahmed. We will begin now.';

    // Build the SPOKEN prompt — only voice questions are spoken. It reads the
    // question then explicitly asks the candidate to answer BY VOICE (with a typed
    // fallback). Written/MCQ questions are never spoken (shown silently on screen).
    const voicePrompt = useCallback((q: Question, idx: number): string => {
        const head = language === 'ar' ? `السؤال ${idx + 1}. ` : `Question ${idx + 1}. `;
        const ask = language === 'ar'
            ? ' من فضلك أجِب صوتيًا بأسلوبك، وسأكتب كلامك أمامك أولاً بأول؛ خذ وقتك، وإن تعذّر فاكتب إجابتك ثم اضغط إرسال.'
            : ' Please answer aloud in your own words — I will transcribe what you say live. Take your time; if you cannot, type your answer and press Send.';
        return head + q.questionText + ask;
    }, [language]);

    // SPEED: only VOICE questions are spoken, so only those need warming. While the
    // candidate answers question N, warm the NEXT voice question's neural audio in
    // the background so when we reach it the spoken prompt plays in the real neural
    // voice instantly (no Web-Speech fallback). Best-effort.
    useEffect(() => {
        if (phase !== 'answering') return;
        // Find the next voice question after the current index and warm it.
        for (let i = currentIndex + 1; i < questions.length; i++) {
            if (isVoiceQ(i)) { ttsPrefetch(voicePrompt(questions[i], i), { gender: 'male' }); break; }
        }
    }, [phase, currentIndex, questions, isVoiceQ, voicePrompt]);

    // SPEED (current voice question): warm the current spoken prompt the moment we
    // land on a voice question, before the driver speaks it.
    useEffect(() => {
        if (step !== 'meeting') return;
        const cur = questions[currentIndex];
        if (cur && isVoiceQ(currentIndex)) ttsPrefetch(voicePrompt(cur, currentIndex), { gender: 'male' });
    }, [step, currentIndex, questions, isVoiceQ, voicePrompt]);

    // SPEED (lobby warmup): warm the greeting (spoken instantly on join) and the
    // FIRST voice question while the candidate is still in the lobby, so both play
    // in the neural voice with no wait once they join.
    useEffect(() => {
        if (step !== 'lobby' || questions.length === 0) return;
        ttsPrefetch(greetingText, { gender: 'male' });
        // Warm the fixed turn-taking phrases too — they recur every question, so
        // pre-warming guarantees Puck (neural) speaks them instantly, never the
        // robotic Web-Speech fallback (owner mandate: بوكا only).
        ttsPrefetch(CONFIRM_Q, { gender: 'male' });
        ttsPrefetch(KEEP_GOING, { gender: 'male' });
        for (let i = 0; i < questions.length; i++) {
            if (isVoiceQ(i)) { ttsPrefetch(voicePrompt(questions[i], i), { gender: 'male' }); break; }
        }
    }, [step, questions, isVoiceQ, voicePrompt, greetingText, CONFIRM_Q, KEEP_GOING]);

    // --- Lobby media ---
    useEffect(() => {
        let cancelled = false;
        (async () => {
            // Best-effort media: camera+mic is nicest, but the interview is mostly
            // written/MCQ and voice questions fall back to typing. So we degrade —
            // try video+audio, then audio-only, then proceed with NO stream. Media is
            // never a hard gate (joinMeeting no longer blocks on this).
            let stream: MediaStream | null = null;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            } catch {
                try {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                } catch {
                    stream = null;
                }
            }
            if (cancelled) { stream?.getTracks().forEach(t => t.stop()); return; }
            if (stream) {
                streamRef.current = stream;
                if (lobbyVideoRef.current) {
                    lobbyVideoRef.current.srcObject = stream;
                    lobbyVideoRef.current.play().catch(() => { /* autoplay guard */ });
                }
                // Recovered from an earlier denial (e.g. user granted on retry) — clear warning.
                setError(null);
            } else {
                // Soft, non-blocking notice. The candidate can still start and answer.
                setError(language === 'ar'
                    ? 'تعذّر الوصول للكاميرا/المايك — يمكنك بدء المقابلة والإجابة كتابةً (الصوت اختياري).'
                    : 'Camera/mic unavailable — you can still start and answer by typing (voice optional).');
            }
        })();
        return () => { cancelled = true; };
    }, [language]);

    // Bind the live stream to the MEETING <video> once it mounts. joinMeeting()
    // can't do this synchronously: it calls setStep('meeting') and then reads
    // videoRef.current in the same tick — but the meeting <video> only mounts on
    // the NEXT render, so videoRef.current is still null there and the candidate's
    // camera stayed black. This effect runs AFTER the meeting view renders, so the
    // ref is live. (Measured 2026-06-14: meeting video had no srcObject before this.)
    useEffect(() => {
        if (step !== 'meeting') return;
        const v = videoRef.current;
        const s = streamRef.current;
        if (v && s && v.srcObject !== s) {
            v.srcObject = s;
            v.play().catch(() => { /* autoplay guard — muted video, should pass */ });
        }
        // Bind the visible screen-share preview now that the meeting view (and its ref) exist.
        const sp = screenPreviewRef.current;
        const ss = screenStreamRef.current;
        if (sp && ss && sp.srcObject !== ss) {
            sp.srcObject = ss;
            sp.play().catch(() => { /* autoplay guard */ });
        }
    }, [step, isCamOn, proctorStatus]);

    // Apply mic/cam toggles to real tracks.
    useEffect(() => {
        const s = streamRef.current;
        if (!s) return;
        s.getAudioTracks().forEach(t => { t.enabled = isMicOn; });
        s.getVideoTracks().forEach(t => { t.enabled = isCamOn; });
    }, [isMicOn, isCamOn, step]);

    // Fold whatever per-answer scores have resolved into a compact numeric block the
    // report's analyzer can anchor on (mirrors the MCQ structured block server-side).
    // Async scoring is best-effort: a pending/failed score simply drops out — no hang.
    const buildScoreBlock = useCallback((): string => {
        const scores = scoresRef.current.filter(s => s.score >= 0);
        if (scores.length === 0) return '';
        const ar = language === 'ar';
        const lines = [...scores].sort((a, b) => a.questionIndex - b.questionIndex).map(s =>
            `${ar ? 'السؤال' : 'Question'} ${s.questionIndex + 1} (${s.questionType}${s.isMcq ? ' · MCQ' : ''}): ${s.score}/100 — ${s.rubric}${s.reasoning ? '. ' + s.reasoning : ''}`
        );
        const avg = Math.round(scores.reduce((a, s) => a + s.score, 0) / scores.length);
        const header = ar
            ? 'تقييم حتمي لكل إجابة (مؤشرات كمية مقيسة أثناء المقابلة — رجّحها كمياً في التقرير):'
            : 'DETERMINISTIC PER-ANSWER SCORES (quantitative signals measured during the interview — weight them in the report):';
        return `\n\n${header}\n${lines.join('\n')}\n${ar ? 'المتوسط' : 'Average'}: ${avg}/100\n`;
    }, [language]);

    const finish = useCallback(() => {
        cancelSpeech();
        if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
        // Close out any in-flight answering window so its features aren't lost.
        if (accRef.current) stopAffectCapture(currentIndex);
        const affect = buildAffectSignal();
        teardownAffect();
        listeningRef.current = false;
        try { micRef.current?.abort(); } catch { /* noop */ }
        micRef.current = null;
        // Stop the live proctor, capture its integrity summary, release screen + hidden els.
        try { proctorSummaryRef.current = proctorRef.current?.stop() ?? proctorSummaryRef.current; } catch { /* noop */ }
        proctorRef.current = null;
        screenStreamRef.current?.getTracks().forEach(t => t.stop());
        screenStreamRef.current = null;
        proctorElsRef.current.forEach(v => { try { v.pause(); v.srcObject = null; v.remove(); } catch { /* noop */ } });
        proctorElsRef.current = [];
        streamRef.current?.getTracks().forEach(t => t.stop());
        const sum = proctorSummaryRef.current;
        const proctorBlock = sum
            ? `\n\n${language === 'ar' ? 'مراقبة النزاهة المباشرة' : 'LIVE INTEGRITY MONITORING'}: ${language === 'ar' ? 'الدرجة' : 'score'} ${sum.integrity}/100 — ${sum.verdict.toUpperCase()}${sum.topSignals.length ? ' · ' + sum.topSignals.map(s => `${s.type}×${s.count}`).join(', ') : ''}\n`
            : '';
        onFinish(transcriptRef.current.trim() + buildScoreBlock() + proctorBlock, affect);
    }, [onFinish, currentIndex, stopAffectCapture, buildAffectSignal, teardownAffect, buildScoreBlock, language]);

    // --- Deterministic driver: speak each question when it becomes current ---
    useEffect(() => {
        if (step !== 'meeting') return;
        if (currentIndex >= questions.length) {
            // F2: we advanced past the loaded questions. Two cases:
            //  (a) every requested question has been answered → finish cleanly.
            //  (b) the background batch of remaining questions hasn't arrived (or
            //      failed). Previously the effect just `return`ed here, leaving the
            //      candidate stuck on "transition" forever (the Q11 hang). Show a
            //      waiting caption and arm a fallback so we ALWAYS finish.
            const expected = totalExpected && totalExpected > 0 ? totalExpected : questions.length;
            if (questions.length >= expected) { finish(); return; }
            setPhase('transition');
            setCaption(language === 'ar'
                ? 'جارٍ تحضير السؤال التالي...'
                : 'Preparing the next question...');
            const t = window.setTimeout(() => {
                // Remaining questions never arrived → wrap up with what we have
                // rather than hang. finish() folds any captured affect + transcript.
                finish();
            }, 20_000);
            return () => window.clearTimeout(t);
        }
        if (spokenForIndexRef.current === currentIndex) return;  // already handled this one
        spokenForIndexRef.current = currentIndex;
        setSelectedKey(null);
        setManualText('');
        setInterimText('');
        const q = questions[currentIndex];
        if (isVoiceQ(currentIndex)) {
            // VOICE question: speak it (instantly) then listen + capture affect.
            setPhase('speaking');
            speak(voicePrompt(q, currentIndex)).then(() => {
                setPhase(p => {
                    if (p !== 'speaking') return p;
                    startAffectCapture(currentIndex);  // prosody/face capture during the spoken answer
                    return 'answering';
                });
            });
        } else {
            // WRITTEN/MCQ question: NO speech, NO wait — show it and accept a tap/type
            // immediately. This is the bulk of the merged interview and is instant.
            setCaption(q.questionText);
            setPhase('answering');
        }
    }, [step, currentIndex, questions, voicePrompt, isVoiceQ, speak, startAffectCapture, finish, language, totalExpected]);

    // Spin up the live AI proctor: hidden <video>s feed the candidate's camera +
    // shared screen to the Gemini Live engine, which streams back scored cheating
    // signals. Graceful: camera-only if screen denied; never throws.
    const startProctor = useCallback(async (screenStream: MediaStream | null) => {
        try {
            const camStream = streamRef.current;
            const mkHidden = (s: MediaStream) => {
                const v = document.createElement('video');
                v.muted = true; v.playsInline = true; v.srcObject = s;
                v.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
                document.body.appendChild(v);
                v.play().catch(() => { /* autoplay guard */ });
                proctorElsRef.current.push(v);
                return v;
            };
            const camEl = (camStream && camStream.getVideoTracks().length) ? mkHidden(camStream) : document.createElement('video');
            const scrEl = screenStream ? mkHidden(screenStream) : null;
            const handle = createLiveProctor({
                cameraEl: camEl,
                screenEl: scrEl,
                intervalMs: 4000,                       // ~1 frame / 4s — cost-efficient
                onAlert: (a) => {
                    // Surface a visible warning (the engine only forwards real, non-'none' alerts).
                    setProctorAlert({ type: a.type, severity: a.severity });
                    window.setTimeout(() => setProctorAlert(null), 6000);
                },
                onState: (s) => setProctorIntegrity(s.integrity),
                onStatus: (st) => setProctorStatus(st),
            });
            proctorRef.current = handle;
            await handle.start();
        } catch {
            setProctorStatus('unavailable');
        }
    }, []);

    const joinMeeting = () => {
        // NOTE: media denial is a soft warning, not a gate — the interview is mostly
        // written/MCQ and voice questions fall back to typing. Never block the join.
        unlockAudio();  // bless an audio element NOW (user gesture) so the delayed neural blob can play
        // Request SCREEN SHARE here: getDisplayMedia REQUIRES a user gesture, and this
        // click is it. Must be called before any await so the gesture isn't consumed.
        setProctorStatus('connecting');
        try {
            navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
                .then(scr => {
                    screenStreamRef.current = scr;
                    // Show the shared screen back to the candidate (bound once the meeting renders below).
                    if (screenPreviewRef.current) {
                        screenPreviewRef.current.srcObject = scr;
                        screenPreviewRef.current.play().catch(() => { /* autoplay guard */ });
                    }
                    startProctor(scr);
                })
                .catch(() => { startProctor(null); });   // denied/cancelled → camera-only proctoring
        } catch {
            startProctor(null);
        }
        if (lobbyVideoRef.current) { try { lobbyVideoRef.current.pause(); lobbyVideoRef.current.srcObject = null; } catch { /* noop */ } }
        setStep('meeting');
        timerIntervalRef.current = window.setInterval(() => setMeetingTime(p => p + 1), 1000);
        if (videoRef.current && streamRef.current) {
            videoRef.current.srcObject = streamRef.current;
            videoRef.current.play().catch(() => { /* noop */ });
        }
        // Q0 is always a WRITTEN question (voiceIndices never selects index 0), so the
        // driver won't speak it. Speak the greeting here, instantly, right on the join
        // gesture — the robot talks immediately, no ~1-min wait.
        speak(greetingText);
    };

    // Record an answer, then move on with NO commentary on the answer itself.
    const submitAnswer = useCallback((answerText: string) => {
        if (phase !== 'answering') return;
        const idx = currentIndex;
        const q = questions[idx];
        const wasVoice = isVoiceQ(idx);
        if (wasVoice) stopAffectCapture(idx);  // close the answering window, fold features (voice only)
        setAnswered(prev => [...prev, { index: idx, question: q, answer: answerText }]);
        transcriptRef.current +=
            `${language === 'ar' ? 'السؤال' : 'Question'} ${idx + 1}: ${q.questionText}\n` +
            `${language === 'ar' ? 'الخيارات' : 'Options'}: ${q.options.join(' | ')}\n` +
            `${language === 'ar' ? 'إجابة المرشح' : 'Candidate answer'}: ${answerText}\n\n`;

        // Score THIS answer async & non-blocking: never delays the transition, never
        // spoken — it only accumulates into the final report. Degrades on failure.
        scoreAnswer(q, answerText, language, config.jobTitle)
            .then(s => {
                if (s.score >= 0) scoresRef.current.push({
                    questionIndex: idx, questionType: q.type || 'General',
                    isMcq: s.isMcq, score: s.score, rubric: s.rubric, reasoning: s.reasoning,
                });
            })
            .catch(() => { /* non-blocking: drop on failure */ });

        // Use totalExpected (admin's requested count) so we don't finish early while
        // the background batch of remaining questions is still loading. Falls back to
        // questions.length once all questions have arrived.
        const expected = totalExpected && totalExpected > questions.length ? totalExpected : questions.length;
        const isLast = idx + 1 >= expected;
        setPhase('transition');
        if (isLast) {
            // Always close with a spoken thank-you, regardless of question type.
            speak(language === 'ar'
                ? 'بهذا نكون قد أنهينا جميع الأسئلة. شكراً لك، سيتم إعداد التقرير الآن.'
                : 'That completes all questions. Thank you, your report is being prepared.')
                .then(() => { setPhase('done'); finish(); });
        } else if (wasVoice) {
            // After a VOICE answer, a brief human bridge that ACKNOWLEDGES the answer
            // (owner: "يفهم — طيب إجابتك واضحة") then advance.
            speak(language === 'ar' ? 'تمام، إجابتك واضحة. ننتقل للسؤال التالي.' : 'Got it, your answer is clear. Moving to the next question.')
                .then(() => setCurrentIndex(idx + 1));
        } else {
            // After a WRITTEN/MCQ answer, advance INSTANTLY — no speech, no wait.
            setCurrentIndex(idx + 1);
        }
    }, [phase, currentIndex, questions, language, speak, finish, stopAffectCapture, isVoiceQ, totalExpected, config.jobTitle]);
    submitAnswerRef.current = submitAnswer;  // expose to the conversational controller (decl-order safe)

    const handleSelectOption = (key: string, optText: string) => {
        if (phase !== 'answering') return;
        setSelectedKey(key);
        submitAnswer(`(${key}) ${optText}`);
    };

    const handleSubmitText = (e: React.FormEvent) => {
        e.preventDefault();
        if (phase !== 'answering' || !manualText.trim()) return;
        submitAnswer(manualText.trim());
    };

    const replayQuestion = () => {
        if (phase === 'transition' || phase === 'done') return;
        const q = questions[currentIndex];
        if (!q) return;  // F8: nothing loaded for this slot (waiting on batch) — no-op
        // F3: tear down the live answering window first, else its RAF/interval keep
        // sampling into the freshly re-armed accumulator (double-count + leak).
        if (accRef.current) stopAffectCapture(currentIndex);
        if (!isVoiceQ(currentIndex)) {
            // WRITTEN question: nothing to replay — just keep the question on screen.
            setCaption(q.questionText);
            setPhase('answering');
            return;
        }
        setPhase('speaking');
        speak(voicePrompt(q, currentIndex)).then(() => {
            setPhase(p => {
                if (p !== 'speaking') return p;
                startAffectCapture(currentIndex);  // re-arm capture (resets this question's window)
                return 'answering';
            });
        });
    };
    replayRef.current = replayQuestion;  // expose to the conversational controller (REPLAY command)

    const formatTime = (s: number) => `${Math.floor(s/60)}:${(s%60).toString().padStart(2, '0')}`;

    // ================== LOBBY ==================
    if (step === 'lobby') {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-[#0d1527] text-white rounded-2xl p-6 md:p-12 animate-fade-in shadow-2xl relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-tr from-emerald-500/10 via-transparent to-teal-500/5 pointer-events-none" />
                <div className="max-w-5xl w-full grid grid-cols-1 md:grid-cols-2 gap-12 items-center relative z-10">
                    <div className="flex flex-col items-center space-y-6">
                        <div className="w-full aspect-video bg-slate-900 rounded-3xl overflow-hidden border-2 border-white/10 shadow-inner relative">
                            <video ref={lobbyVideoRef} muted playsInline className="w-full h-full object-cover transform scale-x-[-1]" />
                            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-4">
                                <button onClick={() => setIsMicOn(!isMicOn)} className={`p-4 rounded-full transition-all ${isMicOn ? 'bg-emerald-600/90 text-white hover:bg-emerald-500' : 'bg-red-500'}`}><MicIcon off={!isMicOn} /></button>
                                <button onClick={() => setIsCamOn(!isCamOn)} className={`p-4 rounded-full transition-all ${isCamOn ? 'bg-emerald-600/90 text-white hover:bg-emerald-500' : 'bg-red-500'}`}><CamIcon off={!isCamOn} /></button>
                            </div>
                        </div>
                    </div>
                    <div className="text-center md:text-start space-y-8">
                        <div>
                            <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-3 py-1 rounded-full font-black uppercase tracking-widest inline-block mb-3">
                                {language === 'ar' ? 'بوابة المقابلات الفورية للتميز' : 'PREMIUM AI INTERACTIVE SUITE'}
                            </span>
                            <h2 className="text-3xl md:text-4xl font-extrabold mb-3 leading-tight text-white tracking-tight">
                                {language === 'ar' ? 'المقابلة التفاعلية جاهزة' : 'Interactive Lobby Ready'}
                            </h2>
                            <p className="text-slate-300 text-base leading-relaxed">
                                {language === 'ar'
                                  ? `شريك القياس د. أحمد بانتظارك لتقييم جدارتك المهنية لشاغل منصب: "${config.jobTitle}". ${questions.length} سؤال.`
                                  : `Expert partner Dr. Ahmed is ready to evaluate your competencies for "${config.jobTitle}". ${questions.length} questions.`}
                            </p>
                            {/* What's coming — merged path: written MCQ + a few interactive voice questions */}
                            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-4 text-start space-y-2 mt-4">
                                <p className="text-xs font-black text-teal-300 tracking-wide">
                                    {language === 'ar' ? 'قبل ما تبدأ — خد بالك:' : "Before you start — here's what to expect:"}
                                </p>
                                <ul className="text-slate-300 text-xs leading-relaxed space-y-1.5 list-none">
                                    <li>{language === 'ar'
                                        ? '• هيجي لك أسئلة في النص: معظمها اختيار من متعدد تظهر على الشاشة، وبينها أسئلة صوتية يطرحها المُقيّم بصوته.'
                                        : '• Questions come woven together: mostly multiple-choice on screen, with a few voice questions spoken by the assessor in between.'}</li>
                                    <li>{language === 'ar'
                                        ? '• السؤال الصوتي: يفتح المايك تلقائياً — اتكلم بطبيعية ويتكتب كلامك حيّ، وبعدين تنتقل للي بعده.'
                                        : '• Voice question: the mic opens automatically — speak naturally, your words appear live, then you move on.'}</li>
                                    <li>{language === 'ar'
                                        ? '• رتّب فكرتك بهدوء قبل ما تجاوب — مفيش إجابة صح واحدة، خذ وقتك.'
                                        : '• Organize your thoughts calmly — there is no single right answer, take your time.'}</li>
                                    <li>{language === 'ar'
                                        ? '• اسمح بالكاميرا والمايك من المتصفح عشان الأسئلة الصوتية تشتغل.'
                                        : '• Allow the camera and mic in your browser so the voice questions work.'}</li>
                                </ul>
                            </div>
                        </div>
                        {!ttsAvailable && (
                            <div className="bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs rounded-xl p-3">
                                {language === 'ar' ? '⚠️ نطق الأسئلة غير مدعوم في هذا المتصفح — ستظهر الأسئلة نصياً.' : '⚠️ Speech not supported here — questions will appear as text only.'}
                            </div>
                        )}
                        {error && <div className="bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs rounded-xl p-3">{error}</div>}
                        <div className="bg-slate-800/40 backdrop-blur-xs border border-slate-700/50 p-4 rounded-2xl flex items-center justify-between">
                            <span className="text-teal-400 font-mono text-xs font-bold tracking-wider">
                                {language === 'ar' ? 'مقابلة موجّهة بالنطق الصوتي' : 'Voice-guided structured interview'}
                            </span>
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        </div>
                        <button onClick={joinMeeting} disabled={questions.length === 0} className="w-full md:w-auto px-10 py-4 bg-teal-500 hover:bg-teal-400 disabled:bg-slate-600 text-slate-900 rounded-2xl font-black text-lg shadow-lg transition-all transform hover:-translate-y-0.5">
                            {language === 'ar' ? 'انضم للمقابلة الآن' : 'Join Assessment Now'}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ================== MEETING ==================
    const q = questions[currentIndex];
    const answeringAllowed = phase === 'answering';

    return (
        <div className="flex flex-col lg:grid lg:grid-cols-12 bg-slate-950 text-white rounded-2xl overflow-hidden relative shadow-2xl min-h-[660px] lg:min-h-[78vh] xl:min-h-[80vh] border border-slate-800">

            {/* Left: avatar */}
            <div className="lg:col-span-5 bg-slate-900 flex flex-col justify-between p-6 border-b lg:border-b-0 lg:border-r border-slate-800/80 relative">
                <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/5 via-transparent to-black/30 pointer-events-none" />
                <div className="flex items-center justify-between relative z-10 mb-4 bg-slate-950/40 p-3 rounded-xl border border-slate-800/45">
                    <div className="flex items-center gap-2.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-teal-400">
                            {isSpeaking ? (language === 'ar' ? 'يتحدّث' : 'SPEAKING') : (language === 'ar' ? 'بانتظار إجابتك' : 'AWAITING ANSWER')}
                        </span>
                        {phase === 'answering' && audioEverRef.current && (
                            <span className="text-[9px] text-emerald-400/80 font-bold ms-1" title={language === 'ar' ? 'يتم تحليل نبرة الصوت' : 'Capturing voice affect'}>
                                {language === 'ar' ? '• تحليل النبرة' : '• affect'}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 text-slate-400">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <span className="text-xs font-bold font-mono text-emerald-300">{formatTime(meetingTime)}</span>
                    </div>
                </div>

                <div className="flex-grow flex flex-col items-center justify-center p-4 relative z-10 my-4">
                    <div className="relative">
                        {/* Speaking aura */}
                        <div className="absolute inset-0 bg-emerald-500/25 rounded-full blur-[70px] transition-opacity duration-500" style={{ opacity: isSpeaking ? 0.8 : 0 }} />
                        {/* Animated rings while talking */}
                        {isSpeaking && (
                            <>
                                <span className="absolute inset-0 rounded-full border border-emerald-400/40 animate-ping" />
                                <span className="absolute -inset-3 rounded-full border border-teal-400/20 animate-ping" style={{ animationDelay: '300ms' }} />
                            </>
                        )}
                        {/* Branded monogram avatar — professional, on-brand, no stock photo */}
                        <div className={`relative w-44 h-44 md:w-56 md:h-56 rounded-full grid place-items-center border-4 shadow-2xl transition-all duration-500 ${isSpeaking ? 'border-teal-400/70 scale-105' : 'border-emerald-500/25 scale-100'}`}
                             style={{ background: 'radial-gradient(circle at 30% 25%, #134e4a 0%, #0f766e 38%, #0b1220 100%)' }}>
                            <div className="flex flex-col items-center">
                                <span className="text-5xl md:text-6xl font-black bg-gradient-to-br from-teal-300 to-emerald-400 bg-clip-text text-transparent select-none leading-none">
                                    {language === 'ar' ? 'د.أ' : 'A'}
                                </span>
                                <span className="mt-2 text-[10px] md:text-xs font-bold tracking-widest text-slate-300/80 uppercase">
                                    {language === 'ar' ? 'محاوِر معتمد' : 'AI Interviewer'}
                                </span>
                            </div>
                            <div className="absolute bottom-3 left-0 right-0 text-center">
                                <span className={`px-3.5 py-1 rounded-full text-[10px] font-bold tracking-widest border transition-all ${isSpeaking ? 'bg-teal-400 text-slate-900 border-teal-300' : 'bg-black/70 text-slate-200 border-white/10'}`}>
                                    {language === 'ar' ? 'د. أحمد السنوسي' : 'DR. AHMED'}
                                </span>
                            </div>
                        </div>
                    </div>
                    {isSpeaking && (
                        <div className="flex items-end gap-1 mt-7 h-7">
                            {[...Array(7)].map((_, i) => (
                                <span key={i} className="w-1.5 bg-gradient-to-t from-emerald-500 to-teal-300 rounded-full animate-pulse" style={{ height: `${10 + (i % 4) * 7}px`, animationDelay: `${i * 80}ms` }} />
                            ))}
                        </div>
                    )}
                </div>

                {/* Caption */}
                <div className="relative z-10 w-full bg-slate-950/50 backdrop-blur-md rounded-2xl p-4 border border-slate-800/60 min-h-[90px] flex items-center justify-center text-center">
                    <p className="text-sm md:text-base font-medium text-slate-100 leading-relaxed text-center">{caption}</p>
                </div>

                {/* Controls */}
                <div className="mt-4 flex items-center justify-center gap-4 relative z-10 pt-2 border-t border-slate-800/40">
                    <button onClick={() => setIsMicOn(!isMicOn)} className={`p-3 rounded-full transition-all ${isMicOn ? 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700' : 'bg-rose-600 text-white'}`}><MicIcon off={!isMicOn} /></button>
                    <button onClick={() => setIsCamOn(!isCamOn)} className={`p-3 rounded-full transition-all ${isCamOn ? 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700' : 'bg-rose-600 text-white'}`}><CamIcon off={!isCamOn} /></button>
                    <button onClick={replayQuestion} disabled={phase === 'transition' || phase === 'done'} className="p-3 rounded-full bg-slate-800 hover:bg-slate-700 text-teal-300 border border-slate-700 disabled:opacity-40" title={language === 'ar' ? 'إعادة نطق السؤال' : 'Replay question'}><ReplayIcon /></button>
                    <div className="w-px h-6 bg-slate-800" />
                    <button onClick={finish} className="px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-black flex items-center gap-2 transition-all shadow"><EndCallIcon /><span>{language === 'ar' ? 'إنهاء وحفظ' : 'End'}</span></button>
                </div>
            </div>

            {/* Right: stacked questions feed */}
            <div className="lg:col-span-7 bg-slate-950 p-6 flex flex-col relative">
                <div className="absolute top-4 right-4 w-32 aspect-video bg-slate-900 rounded-2xl overflow-hidden border border-slate-700 shadow-xl z-20">
                    <video ref={videoRef} muted playsInline className={`w-full h-full object-cover transform scale-x-[-1] ${!isCamOn ? 'hidden' : ''}`} />
                    {proctorStatus !== 'off' && (
                        <div className={`absolute bottom-1 left-1 right-1 flex items-center justify-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold tracking-wide ${
                            proctorStatus === 'live'
                                ? (proctorIntegrity >= 85 ? 'bg-emerald-600/90 text-white' : proctorIntegrity >= 70 ? 'bg-amber-500/90 text-slate-900' : 'bg-rose-600/90 text-white')
                                : proctorStatus === 'unavailable' ? 'bg-slate-700/90 text-slate-200' : 'bg-slate-800/90 text-slate-300'
                        }`}>
                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${proctorStatus === 'live' ? 'bg-white animate-pulse' : 'bg-slate-400'}`} />
                            {proctorStatus === 'live'
                                ? `${language === 'ar' ? 'مراقبة' : 'PROCTORED'} ${proctorIntegrity}`
                                : proctorStatus === 'connecting' ? (language === 'ar' ? 'جارٍ التوصيل' : 'CONNECTING')
                                : proctorStatus === 'unavailable' ? (language === 'ar' ? 'كاميرا فقط' : 'CAMERA-ONLY')
                                : (language === 'ar' ? 'انتهت' : 'ENDED')}
                        </div>
                    )}
                    {!isCamOn && <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500 font-bold">Cam Off</div>}
                    <div className="absolute bottom-1 left-2 bg-black/60 px-1.5 py-0.5 rounded text-[8px] font-bold text-slate-200 uppercase tracking-widest">You</div>
                </div>

                {/* Visible preview of the shared screen (what the proctor is monitoring). */}
                {screenStreamRef.current && (
                    <div className="absolute top-4 right-40 w-40 aspect-video bg-slate-900 rounded-2xl overflow-hidden border border-amber-600/60 shadow-xl z-20">
                        <video ref={screenPreviewRef} muted playsInline className="w-full h-full object-contain" />
                        <div className="absolute bottom-1 left-2 bg-black/60 px-1.5 py-0.5 rounded text-[8px] font-bold text-amber-200 uppercase tracking-widest">
                            {language === 'ar' ? 'شاشتك المُراقَبة' : 'Your screen'}
                        </div>
                    </div>
                )}

                {/* Live cheating-alert banner — surfaces a real (non-'none') proctor violation. */}
                {proctorAlert && (
                    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-xl shadow-lg border bg-rose-600/95 text-white border-rose-400">
                        <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                        <span className="text-xs font-black tracking-wide">
                            {language === 'ar' ? '⚠️ رُصد سلوك مُريب' : '⚠️ Integrity alert'}
                        </span>
                        <span className="text-[11px] font-bold opacity-90">{proctorAlert.type} · {proctorAlert.severity}</span>
                        <button onClick={() => setProctorAlert(null)} className="ms-1 text-white/80 hover:text-white text-xs">✕</button>
                    </div>
                )}

                <div className="border-b border-slate-800 pb-3 text-start mb-4">
                    <span className="text-[10px] font-bold tracking-widest text-teal-400 block mb-1 uppercase">{language === 'ar' ? 'مسار المقابلة' : 'INTERVIEW THREAD'}</span>
                    <h3 className="text-base font-black text-slate-100 flex items-center gap-2"><span>📋</span>{language === 'ar' ? `السؤال ${Math.min(currentIndex + 1, questions.length)} من ${questions.length}` : `Question ${Math.min(currentIndex + 1, questions.length)} of ${questions.length}`}</h3>
                </div>

                {/* Scroll-down stack: answered then active */}
                <div className="flex-grow overflow-y-auto pr-1 space-y-4 max-h-[440px] lg:max-h-[calc(78vh-150px)] xl:max-h-[calc(80vh-150px)]">
                    {answered.map(a => (
                        <div key={a.index} className="bg-slate-900/40 rounded-2xl border border-slate-800/70 p-4 text-start opacity-80">
                            <div className="flex items-center gap-2 mb-1.5">
                                <span className="bg-slate-700/40 text-slate-300 font-mono text-[10px] font-black px-2.5 py-0.5 rounded-lg">Q{a.index + 1}</span>
                                <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider">{language === 'ar' ? 'تمت الإجابة' : 'Answered'}</span>
                            </div>
                            <p className="text-xs text-slate-300 leading-relaxed mb-1.5">{a.question.questionText}</p>
                            <p className="text-xs text-teal-300 font-bold">↳ {a.answer}</p>
                        </div>
                    ))}

                    {q && currentIndex < questions.length && (
                        <div className="bg-slate-900/60 rounded-2xl border border-teal-500/30 p-5 text-start space-y-4 animate-fade-in">
                            <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2">
                                <span className="bg-teal-500/20 text-teal-400 font-mono text-xs font-black px-3 py-1 rounded-lg">Q {currentIndex + 1} / {questions.length}</span>
                                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{q.type === 'Technical' ? (language === 'ar' ? 'جدارة تقنية' : 'Technical') : (language === 'ar' ? 'سمة سلوكية' : 'Behavioral')}</span>
                                {isVoiceQ(currentIndex)
                                    ? <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">{language === 'ar' ? '🎙️ سؤال صوتي — جاوب صوتي' : '🎙️ Voice — answer aloud'}</span>
                                    : <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-slate-700/40 text-slate-300 border border-slate-600/40">{language === 'ar' ? '✍️ اختر الإجابة' : '✍️ Choose answer'}</span>}
                                {phase === 'speaking' && <span className="text-[10px] text-teal-300 animate-pulse ms-auto">{language === 'ar' ? '🔊 يقرأ السؤال...' : '🔊 reading...'}</span>}
                                {phase === 'answering' && thinking && <span className="text-[10px] text-amber-300 animate-pulse ms-auto">{language === 'ar' ? '⏳ يفهم كلامك...' : '⏳ understanding...'}</span>}
                                {phase === 'answering' && listening && !thinking && <span className="text-[10px] text-emerald-300 animate-pulse ms-auto">{language === 'ar' ? '🎙️ يسمعك الآن...' : '🎙️ hearing you...'}</span>}
                            </div>
                            <h4 className="text-base font-bold text-slate-50 leading-relaxed">{q.questionText}</h4>
                            {!isVoiceQ(currentIndex) && (
                            <div className="grid grid-cols-1 gap-2.5 pt-1">
                                {q.options.map((opt, i) => {
                                    const key = optionKey(opt, i);
                                    const txt = stripMarker(opt);
                                    const isSel = selectedKey === key;
                                    return (
                                        <button key={key} onClick={() => handleSelectOption(key, txt)} disabled={!answeringAllowed}
                                            className={`w-full text-start p-3 rounded-xl border transition-all flex items-start gap-3 ${isSel ? 'bg-teal-900/30 border-teal-500 text-teal-300 font-bold' : 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-300 hover:border-slate-700'} ${!answeringAllowed ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                            <span className={`w-6 h-6 rounded-lg text-xs font-black flex items-center justify-center ${isSel ? 'bg-teal-400 text-slate-950' : 'bg-slate-800 text-slate-400'}`}>{key}</span>
                                            <span className="text-xs leading-relaxed flex-1">{txt}</span>
                                        </button>
                                    );
                                })}
                            </div>
                            )}
                            {/* Live conversational panel (voice questions): a VU meter that PROVES the
                                mic hears the candidate, the human-facing hint ("● أسمعك الآن"), and the
                                running transcript so spoken words land on screen as they're recognized. */}
                            {isVoiceQ(currentIndex) && phase === 'answering' && STT_SUPPORTED && !sttBlocked && (listening || thinking || interimText) && (
                                <div className="bg-emerald-950/30 border border-emerald-700/30 rounded-xl px-3.5 py-2.5 text-start space-y-2">
                                    <div className="flex items-center gap-2">
                                        <span className={`w-2 h-2 rounded-full ${thinking ? 'bg-amber-400' : 'bg-emerald-400'} animate-pulse`} />
                                        <span className="text-[10px] font-bold text-emerald-300 uppercase tracking-wider">
                                            {convoHint || (language === 'ar' ? 'المايك مفتوح — تكلّم' : 'mic open — speak')}
                                        </span>
                                        {/* Live VU meter — animated bars scaled by the real input level. */}
                                        <span className="flex items-end gap-0.5 h-4 ms-auto">
                                            {[0.15, 0.4, 0.7, 0.95, 0.55].map((thresh, i) => (
                                                <span key={i}
                                                    className={`w-1 rounded-sm transition-all duration-100 ${micLevel >= thresh ? 'bg-emerald-400' : 'bg-emerald-900/60'}`}
                                                    style={{ height: `${Math.max(20, Math.min(100, (micLevel >= thresh ? micLevel : 0.12) * 100))}%` }} />
                                            ))}
                                        </span>
                                    </div>
                                    <p className="text-xs text-slate-300 leading-relaxed min-h-[1rem]">
                                        {answerRef.current
                                            ? <span className="text-slate-200">{answerRef.current}</span>
                                            : interimText
                                                ? <span className="text-slate-400 italic">{interimText}</span>
                                                : <span className="text-slate-500">{language === 'ar' ? 'قل إجابتك بصوتك… يمكنك قول «وريني السؤال اللي جاي» أو «خلصت إجابتي».' : 'Say your answer aloud… you can say “next question” or “I’m done”.'}</span>}
                                    </p>
                                </div>
                            )}
                            {phase === 'answering' && sttBlocked && (
                                <div className="bg-amber-500/10 border border-amber-500/25 text-amber-200 text-[11px] rounded-xl px-3 py-2 text-start">
                                    {language === 'ar' ? '🎙️ تعذّر الوصول للميكروفون — اكتب إجابتك أو اختر من الخيارات.' : '🎙️ Mic unavailable — type your answer or choose an option.'}
                                </div>
                            )}
                            <form onSubmit={handleSubmitText} className="flex gap-2.5 pt-1">
                                <textarea value={manualText} onChange={e => setManualText(e.target.value)} disabled={!answeringAllowed}
                                    placeholder={STT_SUPPORTED && !sttBlocked
                                        ? (language === 'ar' ? '🎙️ تكلّم أو اكتب إجابتك هنا...' : '🎙️ Speak or type your answer here...')
                                        : (language === 'ar' ? 'أو اكتب إجابتك بأسلوبك...' : 'Or type your own answer...')}
                                    className="flex-grow bg-slate-900 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-emerald-500 resize-none h-14 disabled:opacity-50" />
                                <button type="submit" disabled={!answeringAllowed || !manualText.trim()} className="px-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center h-14">
                                    {language === 'ar' ? 'إرسال' : 'Send'}
                                </button>
                            </form>
                        </div>
                    )}
                </div>

                <div className="mt-4 pt-3 border-t border-slate-800/80 text-[10px] text-slate-500 font-bold">
                    {language === 'ar' ? 'حوكمة الحوار بواسطة Ailigent.ai 🛰️' : 'Structured by Ailigent.ai'}
                </div>
            </div>
        </div>
    );
};

export default VerbalAssessmentScreen;
