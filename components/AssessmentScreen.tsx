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

  return (
    <div className="flex flex-col h-full animate-fade-in">
      <div className="mb-6">
        <div className="flex justify-between items-center mb-2 text-sm text-slate-600 dark:text-slate-400">
          <span>{T.question} {currentIndex + 1} {T.of} {questions.length}</span>
           {timeLeft !== undefined && (
            <div className="flex items-center gap-2 text-base font-semibold text-rose-600 dark:text-rose-400 tabular-nums bg-rose-100/80 dark:bg-rose-900/30 px-3 py-1 rounded-full">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.414-1.415L11 9.586V6z" clipRule="evenodd" />
              </svg>
              <span>{formatTime(timeLeft)}</span>
            </div>
          )}
          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${currentQuestion.type === 'Technical' ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300' : 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300'}`}>
            {currentQuestion.type}
          </span>
        </div>
        <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2.5">
          <div className="bg-gradient-to-r from-emerald-400 to-emerald-600 h-2.5 rounded-full" style={{ width: `${progressPercentage}%`, transition: 'width 0.5s ease-in-out' }}></div>
        </div>
      </div>

      <div className="flex-grow">
        <h2 className="text-2xl font-semibold text-slate-800 dark:text-slate-100 mb-6 leading-relaxed">{currentQuestion.questionText}</h2>
        <div className="space-y-4">
          {currentQuestion.options.map((option, index) => (
            <button
              key={index}
              onClick={() => setSelectedAnswer(option)}
              className={`w-full text-start p-4 border rounded-lg transition-all duration-200 flex items-center justify-between ${
                selectedAnswer === option
                  ? 'bg-emerald-600 border-emerald-600 text-white shadow-lg'
                  : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 hover:border-emerald-400'
              }`}
            >
              <span className="font-medium">{option}</span>
              {selectedAnswer === option && (
                <div className="w-7 h-7 bg-white/30 rounded-full flex items-center justify-center">
                    <CheckIcon />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
      
      <div className="mt-8">
        <button
          onClick={handleNext}
          disabled={selectedAnswer === null}
          className="w-full bg-emerald-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-emerald-700 transition-colors duration-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:bg-slate-400 dark:disabled:bg-slate-600 disabled:cursor-not-allowed"
        >
          {isLastQuestion ? T.finish : T.next}
        </button>
        <div className="mt-4 text-center">
          <button onClick={handleEndExam} className="text-sm text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:underline transition-colors duration-200">
            {T.endExam}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AssessmentScreen;