
import React from 'react';
import { Language } from '../types';

interface LanguageToggleProps {
  language: Language;
  setLanguage: (lang: Language) => void;
}

const LanguageToggle: React.FC<LanguageToggleProps> = ({ language, setLanguage }) => {
  const isEnglish = language === 'en';

  const toggleLanguage = () => {
    setLanguage(isEnglish ? 'ar' : 'en');
  };

  return (
    <div
      className="inline-flex items-center rounded-md border border-slate-200 bg-white overflow-hidden"
      role="group"
      aria-label="Language selection"
    >
      <button
        onClick={() => setLanguage('en')}
        aria-pressed={isEnglish}
        aria-label="English"
        className={`h-7 px-3 text-xs font-semibold tracking-wide transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-1 ${
          isEnglish
            ? 'bg-emerald-600 text-white'
            : 'bg-white text-slate-500 hover:text-slate-700 hover:bg-slate-50'
        }`}
      >
        EN
      </button>
      <span className="w-px h-4 bg-slate-200 flex-shrink-0" aria-hidden="true" />
      <button
        onClick={() => setLanguage('ar')}
        aria-pressed={!isEnglish}
        aria-label="Arabic"
        className={`h-7 px-3 text-xs font-semibold tracking-wide transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-1 ${
          !isEnglish
            ? 'bg-emerald-600 text-white'
            : 'bg-white text-slate-500 hover:text-slate-700 hover:bg-slate-50'
        }`}
      >
        AR
      </button>
    </div>
  );
};

export default LanguageToggle;
