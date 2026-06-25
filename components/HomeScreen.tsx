import React, { useState, useEffect } from 'react';
import { Language, User, AdminSettings } from '../types';
import { TRANSLATIONS } from '../constants';
import { auth, db } from '../firebase';
import { doc, setDoc } from 'firebase/firestore';
import { 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  sendEmailVerification
} from 'firebase/auth';

interface HomeScreenProps {
  onStart: (user: User) => void;
  language: Language;
  setLanguage: (lang: Language) => void;
  settings?: AdminSettings;
}

const AppLogo: React.FC<{ logoUrl?: string; fallbackText?: string }> = ({ logoUrl, fallbackText }) => {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt="Target Client Logo"
        className="h-14 max-h-14 w-auto object-contain rounded-lg border border-slate-200 bg-white p-1.5"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div className="w-14 h-14 rounded-xl bg-emerald-600 flex items-center justify-center text-white" aria-label={fallbackText || 'Organization'}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7" aria-hidden="true">
        <path d="M3 21h18" />
        <path d="M5 21V10l7-4 7 4v11" />
        <path d="M9.5 21v-5h5v5" />
        <path d="M9.5 12h.01M14.5 12h.01" />
      </svg>
    </div>
  );
};

const HomeScreen: React.FC<HomeScreenProps> = ({ onStart, language, setLanguage, settings }) => {
  const activeClient = settings?.clientProfiles?.find(p => p.id === settings?.activeClientProfileId) || settings?.clientProfiles?.[0];
  
  // Tabs: 'guest' (Quick Candidate entry), 'corporate' (Company account login/signup) or 'consult' (Strategic consult booking)
  const [activeTab, setActiveTab] = useState<'guest' | 'corporate' | 'consult'>('guest');
  
  // Guest inputs
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');

  // Corporate account inputs
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  // Email-verification flow (email/password accounts only; Google accounts are auto-verified)
  const [pendingVerifyEmail, setPendingVerifyEmail] = useState('');
  const [pendingVerifyPassword, setPendingVerifyPassword] = useState('');
  const [verifyNotice, setVerifyNotice] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  // Consultation request form inputs
  const [cClientName, setCClientName] = useState('');
  const [cIndustry, setCIndustry] = useState('');
  const [cTargetDate, setCTargetDate] = useState('');
  const [cRequestType, setCRequestType] = useState<'restructuring' | 'efqm_audit' | 'vocal_benchmark' | 'capacity_building'>('restructuring');
  const [cAgendaTopic, setCAgendaTopic] = useState('');
  const [cUrgency, setCUrgency] = useState<'normal' | 'medium' | 'high'>('normal');
  const [cContactEmail, setCContactEmail] = useState('');
  const [cNotes, setCNotes] = useState('');
  const [consultSuccess, setConsultSuccess] = useState(false);
  const [consultLoading, setConsultLoading] = useState(false);

  // States
  const [error, setError] = useState('');
  const [rawUser, setRawUser] = useState<any>(null);

  const T = TRANSLATIONS[language];

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        setRawUser(firebaseUser);
        setGuestName(firebaseUser.displayName || '');
        setGuestEmail(firebaseUser.email || '');
      } else {
        setRawUser(null);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleGoogleSignIn = async () => {
    setError('');
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      if (result.user) {
        const u: User = {
          name: result.user.displayName || result.user.email?.split('@')[0] || 'الموظف',
          email: result.user.email || '',
          picture: result.user.photoURL || undefined
        };
        onStart(u);
      }
    } catch (err: any) {
      console.error("Popup sign-in failed:", err);
      setError(language === 'en' ? 'Google Sign-In failed. Please try again.' : 'فشل تسجيل الدخول بجوجل. يرجى المحاولة ثانية.');
    }
  };

  const handleManualEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email.trim() || !password.trim()) {
      setError(language === 'en' ? 'Please fill in both email and password.' : 'يرجى ملء حقول البريد الإلكتروني وكلمة المرور.');
      return;
    }

    try {
      if (isSignUp) {
        if (!authName.trim()) {
          setError(language === 'en' ? 'Please enter your professional name.' : 'يرجى كتابة الاسم المهني الكامل.');
          return;
        }
        if (password.length < 6) {
          setError(language === 'en' ? 'Password must be at least 6 characters.' : 'يجب أن تحتوي كلمة المرور على 6 أحرف على الأقل.');
          return;
        }

        const res = await createUserWithEmailAndPassword(auth, email, password);
        if (res.user) {
          await updateProfile(res.user, { displayName: authName });
          // Send verification email; block entry until the user confirms it.
          await sendEmailVerification(res.user);
          await signOut(auth);
          setPendingVerifyEmail(email);
          setPendingVerifyPassword(password);
          setResendCooldown(60);
          setVerifyNotice(language === 'en'
            ? `A verification link was sent to ${email}. Confirm it, then sign in.`
            : `أرسلنا رابط تأكيد إلى ${email}. فعّل الرابط ثم سجّل الدخول.`);
          setPassword('');
        }
      } else {
        const res = await signInWithEmailAndPassword(auth, email, password);
        if (res.user) {
          // Gate unverified email/password accounts.
          if (!res.user.emailVerified) {
            await signOut(auth);
            setPendingVerifyEmail(email);
            setPendingVerifyPassword(password);
            setVerifyNotice(language === 'en'
              ? `Please verify ${email} first. Check your inbox or resend the link.`
              : `لازم تأكّد ${email} أولاً. راجع بريدك أو أعد إرسال الرابط.`);
            setPassword('');
            return;
          }
          const u: User = {
            name: res.user.displayName || res.user.email?.split('@')[0] || 'الموظف',
            email: res.user.email || email,
            picture: res.user.photoURL || undefined
          };
          onStart(u);
        }
      }
    } catch (err: any) {
      console.error("Manual authentication error:", err);
      if (err.code === 'auth/email-already-in-use') {
        setError(language === 'en' ? 'This email is already registered.' : 'البريد الإلكتروني هذا مسجل بالفعل بالمنصة.');
      } else if (err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
        setError(language === 'en' ? 'Incorrect email or password.' : 'البريد الإلكتروني أو كلمة المرور غير صحيحة.');
      } else {
        setError(language === 'en' ? `Authentication failed: ${err.message}` : `فشل تسجيل الدخول: ${err.message}`);
      }
    }
  };

  // Countdown for the resend-verification button.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  const handleResendVerification = async () => {
    if (resendCooldown > 0 || !pendingVerifyEmail || !pendingVerifyPassword) return;
    setError('');
    try {
      // Re-authenticate transiently to obtain a user handle, resend, then sign back out.
      const res = await signInWithEmailAndPassword(auth, pendingVerifyEmail, pendingVerifyPassword);
      if (res.user) {
        if (res.user.emailVerified) {
          await signOut(auth);
          setVerifyNotice(language === 'en'
            ? 'This email is already verified. You can sign in now.'
            : 'هذا البريد مؤكَّد بالفعل. تقدر تسجّل الدخول دلوقتي.');
          return;
        }
        await sendEmailVerification(res.user);
        await signOut(auth);
        setResendCooldown(60);
        setVerifyNotice(language === 'en'
          ? `Verification link re-sent to ${pendingVerifyEmail}.`
          : `أعدنا إرسال رابط التأكيد إلى ${pendingVerifyEmail}.`);
      }
    } catch (err: any) {
      console.error('Resend verification failed:', err);
      setError(language === 'en'
        ? 'Could not resend the link. Try signing in again.'
        : 'تعذّر إعادة إرسال الرابط. حاول تسجّل الدخول من جديد.');
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setGuestName('');
      setGuestEmail('');
      setEmail('');
      setPassword('');
      setAuthName('');
    } catch (err) {
      console.error("Sign out failed:", err);
    }
  };

  const handleGuestStart = () => {
    if (!guestName.trim() || !guestEmail.trim()) {
      setError(language === 'en' ? 'Please fill in all guest fields.' : 'يرجى ملء جميع حقول الدخول كـ زائر.');
      return;
    }
    if (!/\S+@\S+\.\S+/.test(guestEmail)) {
      setError(language === 'en' ? 'Please enter a valid email address.' : 'يرجى إدخال بريد إلكتروني صالح.');
      return;
    }
    setError('');
    onStart({ name: guestName, email: guestEmail });
  };

  const handleSubmitConsultation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cClientName.trim() || !cContactEmail.trim()) {
      setError(language === 'ar' ? 'يرجى ملء كافة الحقول الإلزامية كاسم المنشأة والبريد الإلكتروني.' : 'Please fill all mandatory fields: client name and email.');
      return;
    }
    setConsultLoading(true);
    setError('');

    const newReq = {
      id: 'consult_' + Date.now(),
      clientName: cClientName,
      industry: cIndustry || (language === 'ar' ? 'عام / غير محدد' : 'General / Unspecified'),
      consultantName: 'Dr. Ahmed Alsenosy',
      requestType: cRequestType,
      agendaTopic: cAgendaTopic || (language === 'ar' ? 'تدقيق الجودة وإعادة الهيكلة الشاملة للعمليات والمؤشر الكلي للجهة' : 'Standard operational audit, quality check and restructuring'),
      urgency: cUrgency,
      targetDate: cTargetDate || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().split('T')[0],
      contactEmails: cContactEmail,
      additionalNotes: cNotes,
      status: 'requested',
      timestamp: new Date().toISOString()
    };

    try {
      await setDoc(doc(db, 'consultation_requests', newReq.id), newReq);
      setConsultSuccess(true);
      // Reset
      setCClientName('');
      setCIndustry('');
      setCAgendaTopic('');
      setCContactEmail('');
      setCNotes('');
      setCTargetDate('');
    } catch (err: any) {
      console.error("Booking consultation failed:", err);
      setError(language === 'ar' ? 'حدث خطأ أثناء إرسال طلب الحجز. يرجى مراجعة الاتصال بالشبكة.' : 'Failed saving your booking request, check your connection.');
    } finally {
      setConsultLoading(false);
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-center animate-fade-in">
      <div className="grid lg:grid-cols-2 items-center gap-10 lg:gap-16 w-full max-w-5xl mx-auto px-4 py-4 lg:py-8">

        {/* Identity panel — who is being assessed, on calm credible ground */}
        <section className="flex flex-col items-center lg:items-start text-center lg:text-start gap-5">
          <AppLogo logoUrl={activeClient?.logoUrl || ''} fallbackText={activeClient?.name?.slice(0, 2) || 'Ai'} />

          <div className="flex flex-col items-center lg:items-start gap-2.5">
            <span className="inline-flex items-center text-[11px] bg-emerald-50 text-emerald-700 px-2.5 py-0.5 rounded-sm font-semibold tracking-wide border border-emerald-200/70">
              {language === 'ar' ? 'الجهة المستهدفة بالتقييم' : 'Enterprise Under Evaluation'}
            </span>
            <h1 className="text-2xl md:text-3xl lg:text-[2rem] font-serif font-bold text-slate-900 tracking-tight leading-[1.2]">
              {activeClient?.name || settings?.companyName || T.welcome}
            </h1>
            <p className="text-sm text-slate-500 leading-relaxed max-w-sm">
              {activeClient?.description || T.welcomeSub}
            </p>
          </div>

          {/* Credibility — what makes the assessment defensible (desktop) */}
          <ul className="hidden lg:flex flex-col gap-3 w-full max-w-sm pt-1">
            {[
              { ar: 'مبني على أطر معتمدة عالمياً: EFQM، Birkman، Holland.', en: 'Built on globally recognized frameworks: EFQM, Birkman, Holland.', icon: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
              { ar: 'مراقبة نزاهة حية وعادلة بالذكاء الاصطناعي.', en: 'Live, fair AI integrity monitoring.', icon: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z' },
              { ar: 'تشغيل سحابي آمن · Ailigent.ai', en: 'Secured cloud node · Ailigent.ai', icon: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4' },
            ].map((it, i) => (
              <li key={i} className="flex items-start gap-2.5 text-xs text-slate-600 leading-relaxed">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true"><path d={it.icon} /></svg>
                <span>{language === 'ar' ? it.ar : it.en}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Action panel — entry */}
        <section className="w-full max-w-md mx-auto lg:mx-0 text-center">
      {rawUser ? (
        <div className="hw-card p-5 w-full flex flex-col items-center text-center">
          {rawUser.photoURL ? (
            <img
              src={rawUser.photoURL}
              alt={guestName}
              className="w-12 h-12 rounded-full border border-slate-200 mb-3"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-700 flex items-center justify-center text-lg font-bold border border-emerald-200 mb-3">
              {(rawUser.displayName || rawUser.email || 'U').charAt(0).toUpperCase()}
            </div>
          )}
          <h2 className="font-bold text-slate-900 text-sm">
            {language === 'ar' ? `مرحباً، ${rawUser.displayName || rawUser.email}` : `Welcome back, ${rawUser.displayName || rawUser.email}`}
          </h2>
          <p className="text-slate-500 text-xs mt-0.5 mb-5">{rawUser.email}</p>

          <div className="w-full flex flex-col gap-2.5">
            <button
              onClick={() => onStart({
                name: rawUser.displayName || rawUser.email?.split('@')[0] || 'الموظف',
                email: rawUser.email || '',
                picture: rawUser.photoURL
              })}
              className="hw-btn hw-btn-primary hw-btn-w"
            >
              {T.start}
              <svg className="w-4 h-4 rtl:rotate-180" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </button>
            <button
              onClick={handleSignOut}
              className="text-slate-400 hover:text-rose-500 text-xs transition-colors duration-150 py-1"
            >
              {language === 'ar' ? 'تسجيل الخروج' : 'Sign Out'}
            </button>
          </div>
        </div>
      ) : (
        <div className="hw-card p-5 w-full flex flex-col items-stretch">

          {/* Tabs — line indicator, no pill */}
          <div className="flex border-b border-slate-200 mb-5 -mx-5 px-5 gap-1">
            <button
              onClick={() => { setActiveTab('guest'); setError(''); }}
              className={`flex-1 pb-2.5 text-xs font-semibold transition-colors duration-150 border-b-2 -mb-px ${activeTab === 'guest' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              {language === 'ar' ? 'دخول سريع' : 'Guest'}
            </button>
            <button
              onClick={() => { setActiveTab('corporate'); setError(''); }}
              className={`flex-1 pb-2.5 text-xs font-semibold transition-colors duration-150 border-b-2 -mb-px ${activeTab === 'corporate' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              {language === 'ar' ? 'حساب مؤمن' : 'Account'}
            </button>
            <button
              onClick={() => { setActiveTab('consult'); setError(''); }}
              className={`flex-1 pb-2.5 text-xs font-semibold transition-colors duration-150 border-b-2 -mb-px ${activeTab === 'consult' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              {language === 'ar' ? 'استشارة' : 'Consulting'}
            </button>
          </div>

          <div className="animate-fade-in text-start text-xs text-slate-700">
            {activeTab === 'guest' && (
              <form onSubmit={(e) => { e.preventDefault(); handleGuestStart(); }} className="space-y-3.5">
                <div>
                  <label htmlFor="guest_name" className="block text-xs font-semibold text-slate-600 mb-1">{T.name}</label>
                  <input
                    type="text"
                    id="guest_name"
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    placeholder={language === 'ar' ? 'الاسم الكامل' : 'Your full name'}
                    className="hw-input"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="guest_email" className="block text-xs font-semibold text-slate-600 mb-1">{T.email}</label>
                  <input
                    type="email"
                    id="guest_email"
                    value={guestEmail}
                    onChange={(e) => setGuestEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="hw-input"
                    required
                  />
                </div>

                {error && (
                  <p className="text-rose-600 text-xs text-center leading-relaxed">{error}</p>
                )}

                <button
                  type="submit"
                  className="hw-btn hw-btn-primary hw-btn-w mt-1"
                >
                  {T.start}
                  <svg className="w-4 h-4 rtl:rotate-180" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </button>
              </form>
            )}

            {activeTab === 'corporate' && (
              <form onSubmit={handleManualEmailAuth} className="space-y-3.5">

                {isSignUp && (
                  <div>
                    <label htmlFor="authName" className="block text-xs font-semibold text-slate-600 mb-1">
                      {language === 'ar' ? 'الاسم الوظيفي الكامل' : 'Full Name'}
                    </label>
                    <input
                      type="text"
                      id="authName"
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      placeholder={language === 'ar' ? 'الاسم الكامل' : 'Your full work name'}
                      className="hw-input"
                      required
                    />
                  </div>
                )}

                <div>
                  <label htmlFor="auth_email" className="block text-xs font-semibold text-slate-600 mb-1">{T.email}</label>
                  <input
                    type="email"
                    id="auth_email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@corporate.com"
                    className="hw-input"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="auth_password" className="block text-xs font-semibold text-slate-600 mb-1">
                    {language === 'ar' ? 'كلمة المرور' : 'Password'}
                  </label>
                  <input
                    type="password"
                    id="auth_password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="hw-input"
                    required
                  />
                </div>

                {verifyNotice && (
                  <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
                    <p className="text-amber-800 text-xs leading-relaxed">
                      {verifyNotice}
                    </p>
                    {pendingVerifyEmail && pendingVerifyPassword && (
                      <button
                        type="button"
                        onClick={handleResendVerification}
                        disabled={resendCooldown > 0}
                        className="mt-2 text-xs font-semibold text-amber-700 hover:text-amber-900 disabled:text-amber-400 disabled:cursor-not-allowed underline"
                      >
                        {resendCooldown > 0
                          ? (language === 'ar' ? `إعادة الإرسال بعد ${resendCooldown}ث` : `Resend in ${resendCooldown}s`)
                          : (language === 'ar' ? 'إعادة إرسال رابط التأكيد' : 'Resend verification link')}
                      </button>
                    )}
                  </div>
                )}

                {error && <p className="text-rose-600 text-xs text-center leading-relaxed">{error}</p>}

                <button
                  type="submit"
                  className="hw-btn hw-btn-primary hw-btn-w mt-1"
                >
                  {isSignUp ? (language === 'ar' ? 'إنشاء حساب' : 'Create Account') : (language === 'ar' ? 'تسجيل الدخول' : 'Sign In')}
                </button>

                <div className="flex items-center justify-between mt-1">
                  <button
                    type="button"
                    onClick={() => { setIsSignUp(!isSignUp); setError(''); setVerifyNotice(''); }}
                    className="text-xs text-emerald-600 hover:text-emerald-700 hover:underline transition-colors"
                  >
                    {isSignUp
                      ? (language === 'ar' ? 'لديك حساب؟ سجّل الدخول' : 'Already have an account? Sign in')
                      : (language === 'ar' ? 'ليس لديك حساب؟ أنشئ واحداً' : "Don't have an account? Sign up")}
                  </button>
                </div>

                {/* Separator */}
                <div className="flex items-center gap-3 pt-1">
                  <div className="h-px bg-slate-200 flex-1"></div>
                  <span className="text-[10px] text-slate-400 tracking-wider">{language === 'ar' ? 'أو' : 'or'}</span>
                  <div className="h-px bg-slate-200 flex-1"></div>
                </div>

                {/* Google Sign In */}
                <button
                  onClick={handleGoogleSignIn}
                  type="button"
                  className="hw-btn hw-btn-ghost hw-btn-w text-xs"
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
                  </svg>
                  {T.signInWithGoogle}
                </button>
              </form>
            )}

            {activeTab === 'consult' && (
              consultSuccess ? (
                <div className="text-center py-6 px-2 bg-green-50 border border-green-200 rounded-lg space-y-3 animate-fade-in">
                  <svg className="w-8 h-8 text-green-600 mx-auto" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <h4 className="font-bold text-slate-800 text-sm">
                    {language === 'ar' ? 'تم استلام طلب الحجز' : 'Consultation Logged'}
                  </h4>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {language === 'ar'
                      ? 'تم إدراج طلبك وسيتواصل فريق الاستشارات معك قريباً.'
                      : 'Your request has been logged. The consulting team will reach out shortly.'}
                  </p>
                  <button
                    onClick={() => setConsultSuccess(false)}
                    className="hw-btn hw-btn-subtle hw-btn-w text-xs"
                  >
                    {language === 'ar' ? 'تقديم طلب جديد' : 'Submit Another Request'}
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmitConsultation} className="space-y-3">

                  <div className="mb-1">
                    <h4 className="font-semibold text-slate-800 text-xs">
                      {language === 'ar' ? 'طلب جلسة استشارية' : 'Schedule a Consulting Session'}
                    </h4>
                    <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                      {language === 'ar' ? 'أدخل بيانات جهتك لحجز الجلسة.' : 'Fill in your details to request a session.'}
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">{language === 'ar' ? 'اسم المنشأة *' : 'Organization *'}</label>
                    <input
                      type="text"
                      required
                      placeholder={language === 'ar' ? 'مثال: الهيئة الوطنية للمعلومات' : 'e.g. FedTech Corp'}
                      value={cClientName}
                      onChange={e => setCClientName(e.target.value)}
                      className="hw-input"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">{language === 'ar' ? 'القطاع' : 'Industry'}</label>
                      <input
                        type="text"
                        placeholder={language === 'ar' ? 'حكومي / طبي' : 'Gov / Tech'}
                        value={cIndustry}
                        onChange={e => setCIndustry(e.target.value)}
                        className="hw-input"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">{language === 'ar' ? 'التاريخ المستهدف' : 'Target Date'}</label>
                      <input
                        type="date"
                        value={cTargetDate}
                        onChange={e => setCTargetDate(e.target.value)}
                        className="hw-input"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">{language === 'ar' ? 'البريد الإلكتروني *' : 'Contact Email *'}</label>
                      <input
                        type="email"
                        required
                        placeholder="name@org.gov"
                        value={cContactEmail}
                        onChange={e => setCContactEmail(e.target.value)}
                        className="hw-input"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">{language === 'ar' ? 'نوع الاستشارة' : 'Session Type'}</label>
                      <select
                        value={cRequestType}
                        onChange={e => setCRequestType(e.target.value as any)}
                        className="hw-input bg-white cursor-pointer"
                      >
                        <option value="restructuring">{language === 'ar' ? 'إعادة هيكلة' : 'Restructuring'}</option>
                        <option value="efqm_audit">{language === 'ar' ? 'تدقيق EFQM' : 'EFQM Audit'}</option>
                        <option value="vocal_benchmark">{language === 'ar' ? 'معايرة سلوكية' : 'Vocal Calibration'}</option>
                        <option value="capacity_building">{language === 'ar' ? 'تنمية قدرات' : 'Capacity Building'}</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">{language === 'ar' ? 'موضوع الجلسة' : 'Agenda Topic'}</label>
                    <input
                      type="text"
                      placeholder={language === 'ar' ? 'عنوان الجلسة المرغوب' : 'Session topic'}
                      value={cAgendaTopic}
                      onChange={e => setCAgendaTopic(e.target.value)}
                      className="hw-input"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">{language === 'ar' ? 'مستوى الاستعجال' : 'Urgency'}</label>
                    <select
                      value={cUrgency}
                      onChange={e => setCUrgency(e.target.value as any)}
                      className="hw-input bg-white cursor-pointer"
                    >
                      <option value="normal">{language === 'ar' ? 'طبيعي' : 'Normal'}</option>
                      <option value="medium">{language === 'ar' ? 'متوسط' : 'Urgent'}</option>
                      <option value="high">{language === 'ar' ? 'طوارئ' : 'Critical'}</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">{language === 'ar' ? 'ملاحظات إضافية' : 'Additional Notes'}</label>
                    <textarea
                      rows={2}
                      placeholder={language === 'ar' ? 'تطلعات أو عقبات إدارية تود مناقشتها...' : 'Challenges or context for the consultant.'}
                      value={cNotes}
                      onChange={e => setCNotes(e.target.value)}
                      className="hw-textarea"
                    />
                  </div>

                  {error && <p className="text-rose-600 text-xs text-center leading-relaxed">{error}</p>}

                  <button
                    type="submit"
                    disabled={consultLoading}
                    className="hw-btn hw-btn-primary hw-btn-w mt-1"
                  >
                    {consultLoading
                      ? (language === 'ar' ? 'جاري الحفظ...' : 'Submitting...')
                      : (language === 'ar' ? 'تأكيد الطلب' : 'Submit Request')}
                  </button>
                </form>
              )
            )}
          </div>
        </div>
      )}
        </section>
      </div>
    </div>
  );
};

export default HomeScreen;
