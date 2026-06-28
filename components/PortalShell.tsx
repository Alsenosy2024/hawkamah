// B4 — Shared portal shell.
//
// The constant page frame for every candidate query flow: background, RTL/LTR
// direction (from the token language), the persistent branded PortalHeader, and a
// centered <main> slot that swaps the active screen body. Both the environment
// survey and the employee assessment render every screen inside this shell, so the
// frame, header, and direction are identical across both flows.
import React from 'react';
import PortalHeader from './PortalHeader';
import type { Language } from '../types';

interface Props {
  language?: Language;
  companyName?: string;
  logoUrl?: string;
  subtitle: string;
  children: React.ReactNode;
}

const PortalShell: React.FC<Props> = ({ language = 'ar', companyName, logoUrl, subtitle, children }) => {
  const dir = language === 'en' ? 'ltr' : 'rtl';
  return (
    <div className="min-h-screen flex flex-col bg-[#F7FAFB] dark:bg-slate-950" dir={dir}>
      <PortalHeader companyName={companyName} logoUrl={logoUrl} subtitle={subtitle} language={language} />
      <main className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8">
        {children}
      </main>
    </div>
  );
};

export default PortalShell;
