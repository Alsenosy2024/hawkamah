import React, { useState, useEffect, useRef } from 'react';
import { Question, UserResponse, Language } from '../types';
import { TRANSLATIONS } from '../constants';

interface AssessmentScreenProps {
  questions: Question[];
  onFinish: (responses: UserResponse[]) => void;
  language: Language;
  timerInSeconds?: number;
}

const CheckIcon = () => (
    <svg className="w-6 h-6 text-white" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
    </svg>
);

const AssessmentScreen: React.FC<AssessmentScreenProps> = ({ questions, onFinish, language, timerInSeconds }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [responses, setResponses] = useState<UserResponse[]>([]);
  const [timeLeft, setTimeLeft] = useState(timerInSeconds);
  // Keep a ref to always-fresh responses so the timer fires onFinish with current answers
  const responsesRef = useRef<UserResponse[]>(responses);
  useEffect(() => { responsesRef.current = responses; }, [responses]);
  // F7: keep onFinish fresh without it being a timer dependency, and ensure the
  // assessment is finished EXACTLY once (timer-expiry vs manual submit can race).
  const onFinishRef = useRef(onFinish);
  useEffect(() => { onFinishRef.current = onFinish; }, [onFinish]);
  const finishedRef = useRef(false);
  const finishOnce = (resp: UserResponse[]) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onFinishRef.current(resp);
  };

  const T = TRANSLATIONS[language];
  const currentQuestion = questions[currentIndex];
  const isLastQuestion = currentIndex === questions.length - 1;

  // F7: register the countdown interval ONCE (deps stable). The old version listed
  // `timeLeft` as a dep, tearing down and recreating the interval every second and
  // re-running the `<=0 → onFinish` branch on each render — a double-finish hazard.
  useEffect(() => {
    if (timerInSeconds === undefined) return;
    const timerId = setInterval(() => {
      setTimeLeft(prev => {
        const next = (prev ?? 0) - 1;
        if (next <= 0) {
          clearInterval(timerId);
          finishOnce(responsesRef.current);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(timerId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerInSeconds]);

  const handleNext = () => {
    if (selectedAnswer === null) return;

    const newResponses = [...responses, { questionIndex: currentIndex, selectedAnswer }];
    setResponses(newResponses);
    setSelectedAnswer(null);

    if (isLastQuestion) {
      finishOnce(newResponses);
    } else {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const handleEndExam = () => {
    const currentResponses = selectedAnswer ? [...responses, { questionIndex: currentIndex, selectedAnswer }] : responses;
    finishOnce(currentResponses);
  };

  const formatTime = (seconds: number) => {
    if (seconds < 0) return '00:00';
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  };

  const progressPercentage = ((currentIndex + 1) / questions.length) * 100;

  if (!currentQuestion) {
    return null; // or a loading state
  }

  const isTimeLow = timeLeft !== undefined && timeLeft <= 60;

  // Option index labels (A B C D …) — purely presentational
  const optionLabels = ['A', 'B', 'C', 'D', 'E', 'F'];

  return (
    <div className="flex flex-col h-full animate-fade-in">

      {/* ── Top rail: overline + timer ── */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-3">
          {/* Question counter — overline style */}
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 tabular-nums">
            {T.question} {currentIndex + 1} / {questions.length}
          </span>

          <div className="flex items-center gap-3">
            {/* Question-type badge */}
            <span className="hw-badge-neutral text-xs">
              {currentQuestion.type}
            </span>

            {/* Timer — neutral until low, then warning */}
            {timeLeft !== undefined && (
              <div
                className={`flex items-center gap-1.5 tabular-nums text-sm font-semibold px-2.5 py-1 rounded-md border transition-colors duration-300 ${
                  isTimeLow
                    ? 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700/40'
                    : 'text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700'
                }`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4 shrink-0"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.414-1.415L11 9.586V6z" clipRule="evenodd" />
                </svg>
                <span>{formatTime(timeLeft)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Progress track — hairline, flat */}
        <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-sm h-1">
          <div
            className="bg-emerald-600 h-1 rounded-sm"
            style={{ width: `${progressPercentage}%`, transition: 'width 0.45s ease-in-out' }}
          />
        </div>
      </div>

      {/* ── Question body ── */}
      <div className="flex-grow">
        <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-6 leading-relaxed max-w-prose">
          {currentQuestion.questionText}
        </h2>

        {/* ── Options ── */}
        <div className="space-y-3">
          {currentQuestion.options.map((option, index) => {
            const isSelected = selectedAnswer === option;
            return (
              <button
                key={index}
                onClick={() => setSelectedAnswer(option)}
                className={`w-full text-start flex items-center gap-3 p-3.5 border rounded-lg transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1 ${
                  isSelected
                    ? 'border-emerald-600 dark:border-emerald-500 bg-emerald-600 dark:bg-emerald-600 text-white'
                    : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-emerald-400 dark:hover:border-emerald-500 hover:bg-slate-50 dark:hover:bg-slate-700/60'
                }`}
              >
                {/* Option letter indicator */}
                <span
                  className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold border transition-colors duration-150 ${
                    isSelected
                      ? 'bg-white/20 border-white/30 text-white'
                      : 'bg-slate-100 dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400'
                  }`}
                  aria-hidden="true"
                >
                  {optionLabels[index] ?? index + 1}
                </span>

                <span className="font-medium leading-relaxed flex-1">{option}</span>

                {/* Selected check */}
                {isSelected && (
                  <span className="shrink-0 ms-auto" aria-hidden="true">
                    <CheckIcon />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Footer actions ── */}
      <div className="mt-8 space-y-3">
        <button
          onClick={handleNext}
          disabled={selectedAnswer === null}
          className="hw-btn hw-btn-primary hw-btn-w"
        >
          {isLastQuestion ? T.finish : T.next}
        </button>

        <div className="text-center">
          <button
            onClick={handleEndExam}
            className="text-sm text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors duration-150 focus:outline-none focus-visible:underline"
          >
            {T.endExam}
          </button>
        </div>
      </div>

    </div>
  );
};

export default AssessmentScreen;