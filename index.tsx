
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

/**
 * Stale-chunk auto-recovery.
 * After a redeploy, a tab opened before the deploy requests an old hashed
 * chunk that Firebase already deleted. The SPA rewrite serves index.html,
 * which fails to parse as a JS module -> "Failed to fetch dynamically
 * imported module". mermaid lazy-loads its diagram-type chunks this way,
 * so this surfaces inside MermaidView. Reload ONCE to pull the fresh
 * index.html + manifest. A sessionStorage timestamp guards against an
 * infinite reload loop (e.g. if the network is genuinely down).
 */
const CHUNK_ERR_RE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

function reloadOnceForStaleChunk(): boolean {
  try {
    const KEY = 'gc-chunk-reload-at';
    const last = Number(sessionStorage.getItem(KEY) || 0);
    // Only reload if we haven't already reloaded in the last ~10s.
    if (Date.now() - last < 10_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable (private mode / blocked) — reload anyway,
    // accepting a rare double reload over a permanently broken page.
  }
  location.reload();
  return true;
}

// Vite's own signal for a failed preload of a dynamically imported chunk.
window.addEventListener('vite:preloadError', (e) => {
  // Prevent Vite's default (which also reloads) so we don't double-fire.
  e.preventDefault();
  reloadOnceForStaleChunk();
});

// Catch dynamic-import failures that bubble up as rejected promises.
window.addEventListener('unhandledrejection', (e) => {
  const msg = String(e?.reason?.message || e?.reason || '');
  if (CHUNK_ERR_RE.test(msg)) reloadOnceForStaleChunk();
});

// Catch dynamic-import failures surfaced as plain error events.
window.addEventListener('error', (e) => {
  const msg = String((e as ErrorEvent)?.message || '');
  if (CHUNK_ERR_RE.test(msg)) reloadOnceForStaleChunk();
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
