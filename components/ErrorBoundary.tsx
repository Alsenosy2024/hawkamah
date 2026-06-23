import React from 'react';

interface Props { children: React.ReactNode; }
interface State { hasError: boolean; message?: string; }

/**
 * App-wide error boundary. Without this, any throw inside the heavy screens
 * (GovernanceCenter / AdminPanel / ResultsScreen) white-screens the whole app.
 * Catches render/lifecycle errors and shows a recoverable RTL fallback.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  // This project ships no @types/react, so `React.Component` resolves to `any`
  // and inherited members aren't typed. Declare the ones we use.
  declare props: Props;
  declare setState: (partial: Partial<State>) => void;
  state: State = { hasError: false };

  static getDerivedStateFromError(err: unknown): State {
    return { hasError: true, message: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('[ErrorBoundary] Uncaught UI error:', error, info);
  }

  private reset = () => this.setState({ hasError: false, message: undefined });

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div dir="rtl" className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 bg-slate-100 text-center">
        <div className="max-w-md bg-white rounded-2xl shadow-lg border border-slate-200 p-8 space-y-4">
          <div className="text-5xl">⚠️</div>
          <h1 className="text-xl font-black text-slate-800">حدث خطأ غير متوقع</h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            تعذّر عرض هذا الجزء من التطبيق. تم تسجيل الخطأ. يمكنك إعادة المحاولة أو تحديث الصفحة.
          </p>
          {this.state.message && (
            <pre className="text-[11px] text-rose-600 bg-rose-50 rounded-lg p-3 overflow-auto text-start whitespace-pre-wrap">{this.state.message}</pre>
          )}
          <div className="flex gap-3 justify-center pt-2">
            <button onClick={this.reset} className="px-4 py-2 rounded-xl bg-teal-600 text-white font-bold text-sm hover:bg-teal-700">
              إعادة المحاولة
            </button>
            <button onClick={() => window.location.reload()} className="px-4 py-2 rounded-xl bg-slate-200 text-slate-800 font-bold text-sm hover:bg-slate-300">
              تحديث الصفحة
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
