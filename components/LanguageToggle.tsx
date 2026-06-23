
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
    <button
      onClick={toggleLanguage}
      className="relative inline-flex items-center h-8 rounded-full w-16 px-1 transition-colors duration-300 ease-in-out focus:outline-none bg-gray-200"
    >
      <span
        className={`absolute left-1 transition-transform duration-300 ease-in-out transform ${
          isEnglish ? 'translate-x-0' : 'translate-x-8'
        } w-6 h-6 bg-white rounded-full shadow-md flex items-center justify-center`}
      />
      <span className={`z-10 w-1/2 text-center text-sm font-semibold ${isEnglish ? 'text-emerald-600' : 'text-gray-500'}`}>
        EN
      </span>
      <span className={`z-10 w-1/2 text-center text-sm font-semibold ${!isEnglish ? 'text-emerald-600' : 'text-gray-500'}`}>
        AR
      </span>
    </button>
  );
};

export default LanguageToggle;
