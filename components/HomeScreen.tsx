import React, { useState, useEffect } from 'react';
import { Language, User, AdminSettings } from '../types';
import { TRANSLATIONS } from '../constants';
import LanguageToggle from './LanguageToggle';
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
        className="mx-auto mb-4 h-16 max-h-16 w-auto object-contain rounded-xl border border-emerald-500/10 shadow-md transform hover:scale-105 transition-transform bg-white p-1"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div className="mx-auto mb-4 w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-400 to-emerald-600 flex items-center justify-center text-white text-2xl font-black shadow-md shadow-emerald-500/15">
      {fallbackText || 'Ai'}
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
    <div className="flex flex-col items-center justify-center text-center h-full animate-fade-in w-full max-w-md mx-auto">
      
      <AppLogo logoUrl={activeClient?.logoUrl || ''} fallbackText={activeClient?.name?.slice(0, 2) || 'Ai'} />
      
      <span className="text-[10px] bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-black uppercase tracking-wider mb-2.5 border border-emerald-100">
        {language === 'ar' ? 'الجهة المستضيفة والمستهدفة بالتقييم' : 'Target Enterprise Under Evaluation'}
      </span>

      <h1 className="text-2xl md:text-3xl font-extrabold text-slate-800 tracking-tight leading-tight">
        {activeClient?.name || settings?.companyName || T.welcome}
      </h1>
      
      <p className="mt-2 text-xs text-slate-500 font-semibold px-4 leading-relaxed line-clamp-2">
        {activeClient?.description || T.welcomeSub}
      </p>

      <div className="mt-1 pb-1">
        <span className="text-[9px] text-slate-400 font-bold">
          {language === 'ar' ? 'تطوير وتشغيل سحابي آمن بواسطة Ailigent.ai 🌐' : 'Powered securely on Ailigent.ai sovereign cloud node'}
        </span>
      </div>
      
      {rawUser ? (
        <div className="mt-8 p-6 bg-slate-50 border border-slate-200/85 rounded-2xl w-full flex flex-col items-center text-center shadow-sm">
          {rawUser.photoURL ? (
            <img 
              src={rawUser.photoURL} 
              alt={guestName} 
              className="w-16 h-16 rounded-full border border-emerald-500/30 shadow-sm mb-3" 
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 text-emerald-600 flex items-center justify-center text-2xl font-black border border-emerald-500/20 mb-3">
              {(rawUser.displayName || rawUser.email || 'U').charAt(0).toUpperCase()}
            </div>
          )}
          <h2 className="font-extrabold text-slate-800 text-base">
            {language === 'ar' ? `مرحباً بك، ${rawUser.displayName || rawUser.email}` : `Welcome, ${rawUser.displayName || rawUser.email}!`}
          </h2>
          <p className="text-slate-500 text-xs mb-6 font-medium">{rawUser.email}</p>

          <div className="w-full flex flex-col gap-2">
            <button
              onClick={() => onStart({ 
                name: rawUser.displayName || rawUser.email?.split('@')[0] || 'الموظف', 
                email: rawUser.email || '', 
                picture: rawUser.photoURL 
              })}
              className="hw-btn hw-btn-primary hw-btn-lg hw-btn-w"
            >
              {T.start}
              <svg className="w-5 h-5 rtl:rotate-180" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </button>
            <button
              onClick={handleSignOut}
              className="text-slate-400 hover:text-rose-500 font-extrabold text-xs transition-colors py-1.5"
            >
              {language === 'ar' ? 'تسجيل الخروج' : 'Sign Out'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-8 w-full flex flex-col items-stretch bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm">
          
          {/* Custom Tabs */}
          <div className="flex bg-slate-100 p-1 rounded-xl mb-5 border border-slate-200/50">
            <button
              onClick={() => { setActiveTab('guest'); setError(''); }}
              className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg transition-all ${activeTab === 'guest' ? 'bg-white text-slate-800 shadow shadow-slate-200/80' : 'text-slate-500 hover:text-slate-700'}`}
            >
              👤 {language === 'ar' ? 'دخول سريع' : 'Guest'}
            </button>
            <button
              onClick={() => { setActiveTab('corporate'); setError(''); }}
              className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg transition-all ${activeTab === 'corporate' ? 'bg-white text-slate-800 shadow shadow-slate-200/80' : 'text-slate-500 hover:text-slate-700'}`}
            >
              🔒 {language === 'ar' ? 'حساب مؤمن' : 'Secured'}
            </button>
            <button
              onClick={() => { setActiveTab('consult'); setError(''); }}
              className={`flex-1 py-1.5 text-[10px] font-bold rounded-lg transition-all ${activeTab === 'consult' ? 'bg-white text-slate-800 shadow shadow-slate-200/80' : 'text-slate-500 hover:text-slate-700'}`}
            >
              🗓️ {language === 'ar' ? 'حجز استشارة' : 'Consulting'}
            </button>
          </div>

          <div className="animate-fade-in text-start text-xs text-slate-700">
            {activeTab === 'guest' && (
              <form onSubmit={(e) => { e.preventDefault(); handleGuestStart(); }} className="space-y-4">
                <div>
                  <label htmlFor="guest_name" className="block text-xs font-bold text-slate-600 mb-1">{T.name}</label>
                  <input 
                    type="text" 
                    id="guest_name" 
                    value={guestName} 
                    onChange={(e) => setGuestName(e.target.value)} 
                    placeholder={language === 'ar' ? 'أدخل اسمك الكريم للتقييم...' : 'Enter your name...'}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm" 
                    required 
                  />
                </div>
                <div>
                  <label htmlFor="guest_email" className="block text-xs font-bold text-slate-600 mb-1">{T.email}</label>
                  <input 
                    type="email" 
                    id="guest_email" 
                    value={guestEmail} 
                    onChange={(e) => setGuestEmail(e.target.value)} 
                    placeholder="name@company.com"
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm" 
                    required 
                  />
                </div>
                
                {error && <p className="text-red-500 text-xs text-center font-bold">{error}</p>}

                <button
                  type="submit"
                  className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white font-bold py-3 px-6 rounded-xl hover:bg-emerald-700 transition-colors shadow-sm text-sm"
                >
                  {T.start}
                  <svg className="w-4 h-4 rtl:rotate-180" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </button>
              </form>
            )}

            {activeTab === 'corporate' && (
              <form onSubmit={handleManualEmailAuth} className="space-y-4">
                
                {isSignUp && (
                  <div>
                    <label htmlFor="authName" className="block text-xs font-bold text-slate-600 mb-1">
                      {language === 'ar' ? 'الاسم الوظيفي الكامل' : 'Corporate Full Name'}
                    </label>
                    <input 
                      type="text" 
                      id="authName" 
                      value={authName} 
                      onChange={(e) => setAuthName(e.target.value)} 
                      placeholder={language === 'ar' ? 'اكتب اسمك الحقيقي لتسجيله بالملف...' : 'Enter your full work name...'}
                      className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm" 
                      required 
                    />
                  </div>
                )}

                <div>
                  <label htmlFor="auth_email" className="block text-xs font-bold text-slate-600 mb-1">{T.email}</label>
                  <input 
                    type="email" 
                    id="auth_email" 
                    value={email} 
                    onChange={(e) => setEmail(e.target.value)} 
                    placeholder="myemail@corporate.com"
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm" 
                    required 
                  />
                </div>

                <div>
                  <label htmlFor="auth_password" className="block text-xs font-bold text-slate-600 mb-1">
                    {language === 'ar' ? 'كلمة المرور' : 'Secure Password'}
                  </label>
                  <input 
                    type="password" 
                    id="auth_password" 
                    value={password} 
                    onChange={(e) => setPassword(e.target.value)} 
                    placeholder="••••••••"
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm" 
                    required 
                  />
                </div>

                {verifyNotice && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-right">
                    <p className="text-amber-800 text-xs font-bold leading-relaxed flex items-start gap-1.5">
                      <span>✉️</span>
                      <span>{verifyNotice}</span>
                    </p>
                    {pendingVerifyEmail && pendingVerifyPassword && (
                      <button
                        type="button"
                        onClick={handleResendVerification}
                        disabled={resendCooldown > 0}
                        className="mt-2 text-[11px] font-extrabold text-amber-700 hover:text-amber-900 disabled:text-amber-400 disabled:cursor-not-allowed underline"
                      >
                        {resendCooldown > 0
                          ? (language === 'ar' ? `إعادة الإرسال بعد ${resendCooldown}ث` : `Resend in ${resendCooldown}s`)
                          : (language === 'ar' ? 'إعادة إرسال رابط التأكيد' : 'Resend verification link')}
                      </button>
                    )}
                  </div>
                )}

                {error && <p className="text-red-500 text-xs text-center font-bold leading-relaxed">{error}</p>}

                <button
                  type="submit"
                  className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 px-6 rounded-xl transition-all shadow-sm text-sm"
                >
                  {isSignUp ? (language === 'ar' ? 'إنشاء حساب جديد' : 'Register Account') : (language === 'ar' ? 'تسجيل دخول' : 'Sign In')}
                </button>

                <div className="flex items-center justify-between mt-2.5 text-xs text-slate-400 font-bold">
                  <button
                    type="button"
                    onClick={() => { setIsSignUp(!isSignUp); setError(''); setVerifyNotice(''); }}
                    className="text-emerald-600 hover:underline"
                  >
                    {isSignUp 
                      ? (language === 'ar' ? 'لديك حساب بالفعل؟ سجل دخول' : 'Have an account? Sign In') 
                      : (language === 'ar' ? 'ليس لديك حساب؟ سجل الآن' : 'No account? Create Register')}
                  </button>
                </div>
                
                {/* Visual Separator */}
                <div className="flex items-center gap-3 pt-3">
                  <div className="h-[1px] bg-slate-100 flex-1"></div>
                  <span className="text-[9px] uppercase font-bold tracking-widest text-slate-400">{language === 'ar' ? 'أو عبر المزود' : 'or via external'}</span>
                  <div className="h-[1px] bg-slate-100 flex-1"></div>
                </div>

                {/* Google Sign in inside Secured tab */}
                <button
                  onClick={handleGoogleSignIn}
                  type="button"
                  className="w-full py-2.5 px-4 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors flex items-center justify-center gap-3 shadow-sm font-extrabold text-slate-700 text-xs"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" xmlns="http://www.w3.org/2000/svg">
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
                <div className="text-center p-6 bg-emerald-50 border border-emerald-200 rounded-2xl space-y-4 animate-scale-up">
                  <span className="text-4xl text-emerald-600 block">🏆</span>
                  <h4 className="font-extrabold text-slate-800 text-sm">
                    {language === 'ar' ? 'تم استلام وتوثيق طلب حجزك الاستشاري!' : 'Consultation Logged Successfully!'}
                  </h4>
                  <p className="text-xs text-slate-600 leading-relaxed font-semibold">
                    {language === 'ar' 
                      ? 'لقد تم إدراج طلبك على أنظمة الحوكمة والتحليلات الاستشارية الخاصة بالدكتور السنوسي، وسيقوم فريق الاستشارات بجدولة وعقد الورشة قريباً بالتوجيه المطلق.' 
                      : 'Your consulting session has been successfully logged with Dr. Alsenosy. The team will contact you soon.'}
                  </p>
                  <button
                    onClick={() => setConsultSuccess(false)}
                    className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-all shadow-sm"
                  >
                    {language === 'ar' ? 'تقديم طلب مواءمة/جلسة أخرى' : 'Schedule Another Consulting Session'}
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmitConsultation} className="space-y-4 font-semibold">
                  
                  <div className="border-b border-emerald-100 pb-2 mb-2">
                    <h4 className="font-extrabold text-slate-800 text-xs flex items-center gap-1">
                      <span>🗓️</span> {language === 'ar' ? 'طلب جدولة جلسة استشارية جديدة' : 'Schedule Consulting Session'}
                    </h4>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {language === 'ar' ? 'يرجى تزويد الدكتور السنوسي ببيانات جهتك لحجز الجلسة مسبقاً.' : 'Log details to request a custom restructuring workshop.'}
                    </p>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'اسم المنشأة والجهة الشريكة *' : 'Organization Name *'}</label>
                    <input 
                      type="text" 
                      required
                      placeholder={language === 'ar' ? 'مثال: الهيئة الوطنية للمعلومات' : 'e.g. FedTech Corp'}
                      value={cClientName}
                      onChange={e => setCClientName(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs text-slate-800"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'القطاع' : 'Industry'}</label>
                      <input 
                        type="text" 
                        placeholder={language === 'ar' ? 'حكومي / طبي' : 'Government/Tech'}
                        value={cIndustry}
                        onChange={e => setCIndustry(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs text-slate-800"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'تاريخ الاستهداف' : 'Target Date'}</label>
                      <input 
                        type="date" 
                        value={cTargetDate}
                        onChange={e => setCTargetDate(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs text-slate-800"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'بريد جهات الاتصال *' : 'Contact Email *'}</label>
                      <input 
                        type="email" 
                        required 
                        placeholder="vip@client.gov"
                        value={cContactEmail}
                        onChange={e => setCContactEmail(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs text-slate-800"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'نوع المحور الاستشاري' : 'Consultancy Type'}</label>
                      <select 
                        value={cRequestType}
                        onChange={e => setCRequestType(e.target.value as any)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs text-slate-800 bg-white cursor-pointer"
                      >
                        <option value="restructuring">{language === 'ar' ? '🔄 إعادة هيكلة وبناء جدارات' : '🔄 System Restructuring'}</option>
                        <option value="efqm_audit">{language === 'ar' ? '🏅 تدقيق نموذج التميز EFQM' : '🏅 EFQM Excellence Audit'}</option>
                        <option value="vocal_benchmark">{language === 'ar' ? '🎤 معايرة صوتية وسلوكية' : '🎤 Vocal Psych Calibration'}</option>
                        <option value="capacity_building">{language === 'ar' ? '📚 ورشة عمل تنمية قدرات' : '📚 Capacity Building'}</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'عنوان الأجندة والمحاضرة' : 'Agenda Topic'}</label>
                    <input 
                      type="text" 
                      placeholder={language === 'ar' ? 'عنوان الجلسة الرئيسية المرغوب' : 'Session topic'}
                      value={cAgendaTopic}
                      onChange={e => setCAgendaTopic(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs text-slate-800"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'مستوى الاستعجال *' : 'Urgency Level *'}</label>
                      <select 
                        value={cUrgency}
                        onChange={e => setCUrgency(e.target.value as any)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs text-slate-800 bg-white cursor-pointer"
                      >
                        <option value="normal">🟢 {language === 'ar' ? 'طبيعي' : 'Normal'}</option>
                        <option value="medium">🟡 {language === 'ar' ? 'متوسط الاستعجال' : 'Urgent'}</option>
                        <option value="high">🔴 {language === 'ar' ? 'مستعجل جداً طوارئ' : 'Critical'}</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">{language === 'ar' ? 'تطلعات وملاحظات المنشأة بالتفصيل' : 'Additional Notes'}</label>
                    <textarea 
                      rows={2}
                      placeholder={language === 'ar' ? 'اكتب تطلعات أو عقبات إدارية تود مناقشتها مع المستشار...' : 'Detail any challenges you want Dr. Ahmed to review beforehand.'}
                      value={cNotes}
                      onChange={e => setCNotes(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs text-slate-800"
                    />
                  </div>

                  {error && <p className="text-red-500 text-xs text-center font-bold">{error}</p>}

                  <button 
                    type="submit"
                    disabled={consultLoading}
                    className="w-full py-3 bg-emerald-600 hover:bg-slate-900 text-white rounded-xl text-xs font-black transition-all shadow-md shadow-emerald-600/10 flex items-center justify-center gap-2"
                  >
                    {consultLoading ? (language === 'ar' ? 'جاري الإبحار وحفظ الطلب استشارياً...' : 'Logging strategic consultation request...') : (
                      <>
                        <span>🚀</span>
                        {language === 'ar' ? 'تأكيد وحفظ نموذج الطلب استشارياً' : 'Book Strategic Consult Request'}
                      </>
                    )}
                  </button>
                </form>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default HomeScreen;
