// [MAJOR/modularity] Shared "open generated markdown in DocumentCanvas, track
// live edits, persist them across reopen" state machine.
//
// GovCopilot (canvasDoc + canvasEditsRef + persistCanvasEdits → localStorage,
// keyed by chat-message id) and GovernanceCenter (openArtifactInCanvas /
// saveCanvasArtHtml + canvasArtKind routing → Firestore / React state, keyed
// by artifact kind) independently hand-rolled the SAME open/track/persist
// mechanics with two different storage backends. This hook owns the shared
// mechanics — doc identity, the edited-HTML cache, reopen rehydration, and
// triggering an injected persist callback on save — while leaving storage
// entirely to the caller, so neither backend changes.
//
// The two callers also have a genuine, load-bearing difference in resync
// timing that this hook preserves rather than papers over:
//   - GovCopilot's cache is a plain ref (`getCachedHtml`) — mutating it never
//     re-renders the panel by itself, so the canvas only resyncs to a fresh
//     save incidentally, on whatever next render some OTHER state change
//     causes. That matches its pre-refactor `canvasEditsRef` exactly.
//   - GovernanceCenter wants an immediate, reactive resync after every save
//     (it already called `setCanvasArt(next)` as the first line of
//     `saveCanvasArtHtml`, for every kind, before this refactor). `updateMeta`
//     exists for exactly that: a caller's persist callback can opt into a
//     synchronous `doc` update, GovCopilot's callback simply never calls it.
//
// The pure transition functions below (`openCanvasDoc` / `closeCanvasDoc` /
// `saveCanvasDoc` / `updateCanvasDocMeta` / `hydrateCanvasCache`) contain ALL
// of the actual logic and are unit-tested directly (this repo's vitest
// environment is `node` — no DOM/React rendering available, see
// vitest.config.ts). `useCanvasSession` is a thin, side-effect-free-in-render
// React wrapper around them.

import { useCallback, useRef, useState } from 'react';

export interface CanvasSessionDoc<K = null, M = undefined> {
  id: string;
  md: string;
  kind: K;
  html: string | undefined;
  meta: M;
}

export interface CanvasSessionState<K = null, M = undefined> {
  doc: CanvasSessionDoc<K, M> | null;
  /** Edited HTML cache, keyed by doc id — survives close/reopen within a session. */
  cache: Record<string, string>;
}

export const initialCanvasSessionState = <K = null, M = undefined>(): CanvasSessionState<K, M> => ({
  doc: null,
  cache: {},
});

/**
 * Open (or switch to) a doc. `html`, when given, seeds/overwrites the cache
 * entry for `id` (e.g. GovernanceCenter re-embeds a prior `canvasHtml` on the
 * artifact object being opened); when omitted, the doc rehydrates from
 * whatever is already cached for `id` (e.g. GovCopilot reopening a message
 * whose edits were loaded from localStorage earlier in the session).
 */
export function openCanvasDoc<K, M>(
  state: CanvasSessionState<K, M>,
  id: string,
  md: string,
  kind?: K,
  html?: string,
  meta?: M,
): CanvasSessionState<K, M> {
  const cache = html !== undefined ? { ...state.cache, [id]: html } : state.cache;
  const seeded = html !== undefined ? html : cache[id];
  return { cache, doc: { id, md, kind: kind as K, html: seeded, meta: meta as M } };
}

export function closeCanvasDoc<K, M>(state: CanvasSessionState<K, M>): CanvasSessionState<K, M> {
  return state.doc ? { ...state, doc: null } : state;
}

export interface CanvasSavePersistArgs<K, M> {
  id: string;
  html: string;
  kind: K;
  meta: M;
  cache: Record<string, string>;
}

export interface CanvasSaveResult<K, M> {
  state: CanvasSessionState<K, M>;
  /** Args to invoke the injected persist callback with; null when nothing is open (no-op save). */
  persistArgs: CanvasSavePersistArgs<K, M> | null;
}

/** Cache the edited html under the open doc's id; the caller fires persist with the returned args. */
export function saveCanvasDoc<K, M>(state: CanvasSessionState<K, M>, html: string): CanvasSaveResult<K, M> {
  if (!state.doc) return { state, persistArgs: null };
  const cache = { ...state.cache, [state.doc.id]: html };
  return {
    state: { ...state, cache },
    persistArgs: { id: state.doc.id, html, kind: state.doc.kind, meta: state.doc.meta, cache },
  };
}

/**
 * Reactively refresh the CURRENTLY open doc's html/meta (id/md/kind untouched)
 * without going through the cache. For callers (GovernanceCenter) whose
 * business object needs to reflect the just-saved edit immediately.
 */
export function updateCanvasDocMeta<K, M>(
  state: CanvasSessionState<K, M>,
  html: string,
  meta: M,
): CanvasSessionState<K, M> {
  if (!state.doc) return state;
  return { ...state, doc: { ...state.doc, html, meta } };
}

/** Bulk-replace the cache (e.g. loading a prior session's edits from localStorage on mount). */
export function hydrateCanvasCache<K, M>(
  state: CanvasSessionState<K, M>,
  cache: Record<string, string>,
): CanvasSessionState<K, M> {
  return { ...state, cache: { ...cache } };
}

export type CanvasSessionPersist<K = null, M = undefined> = (
  id: string,
  html: string,
  kind: K,
  meta: M,
  cache: Readonly<Record<string, string>>,
) => void | Promise<void>;

export interface UseCanvasSessionResult<K = null, M = undefined> {
  doc: CanvasSessionDoc<K, M> | null;
  open: (id: string, md: string, kind?: K, html?: string, meta?: M) => void;
  close: () => void;
  /** Caches `html` under the open doc, then fires the injected persist callback. */
  save: (html: string) => void;
  /** Reactive refresh of the open doc's html/meta — see the module comment. */
  updateMeta: (html: string, meta: M) => void;
  getCachedHtml: (id: string) => string | undefined;
  hydrateCache: (cache: Record<string, string>) => void;
}

export function useCanvasSession<K = null, M = undefined>(
  persist: CanvasSessionPersist<K, M>,
): UseCanvasSessionResult<K, M> {
  const [state, setState] = useState<CanvasSessionState<K, M>>(() => initialCanvasSessionState<K, M>());
  // Mirrors `state` synchronously so the stable callbacks below always read the
  // latest doc/cache without needing to be re-created (and without reaching for
  // the functional setState form, which would put the persist side-effect
  // inside a state updater — React may invoke updaters more than once).
  const stateRef = useRef(state);
  stateRef.current = state;
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const open = useCallback((id: string, md: string, kind?: K, html?: string, meta?: M) => {
    const next = openCanvasDoc(stateRef.current, id, md, kind, html, meta);
    stateRef.current = next;
    setState(next);
  }, []);

  const close = useCallback(() => {
    const next = closeCanvasDoc(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const save = useCallback((html: string) => {
    const { state: next, persistArgs } = saveCanvasDoc(stateRef.current, html);
    stateRef.current = next;
    setState(next);
    if (persistArgs) {
      persistRef.current(persistArgs.id, persistArgs.html, persistArgs.kind, persistArgs.meta, persistArgs.cache);
    }
  }, []);

  const updateMeta = useCallback((html: string, meta: M) => {
    const next = updateCanvasDocMeta(stateRef.current, html, meta);
    stateRef.current = next;
    setState(next);
  }, []);

  const getCachedHtml = useCallback((id: string) => stateRef.current.cache[id], []);

  const hydrateCache = useCallback((cache: Record<string, string>) => {
    const next = hydrateCanvasCache(stateRef.current, cache);
    stateRef.current = next;
    setState(next);
  }, []);

  return { doc: state.doc, open, close, save, updateMeta, getCachedHtml, hydrateCache };
}
