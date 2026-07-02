import { describe, it, expect } from 'vitest';
import {
  initialCanvasSessionState,
  openCanvasDoc,
  closeCanvasDoc,
  saveCanvasDoc,
  updateCanvasDocMeta,
  hydrateCanvasCache,
} from '../../hooks/useCanvasSession';

// P17 — pure state-machine logic behind useCanvasSession (GovCopilot's
// canvasDoc/canvasEditsRef/persistCanvasEdits and GovernanceCenter's
// openArtifactInCanvas/saveCanvasArtHtml both now delegate to this). vitest
// runs in a `node` environment (no DOM), so the React wrapper itself isn't
// rendered here — these tests pin the transitions it's built from.
describe('useCanvasSession pure transitions', () => {
  it('open() with no prior cache entry sets the doc with no seeded html', () => {
    const s0 = initialCanvasSessionState<null, undefined>();
    const s1 = openCanvasDoc(s0, 'm1', '# hi');
    expect(s1.doc).toEqual({ id: 'm1', md: '# hi', kind: undefined, html: undefined, meta: undefined });
    expect(s1.cache).toEqual({});
  });

  it('open() with an explicit html seeds AND overwrites the cache for that id', () => {
    const s0 = initialCanvasSessionState();
    const s1 = openCanvasDoc(s0, 'art1', '# charter', 'charter', '<p>prior edit</p>', { title: 'Charter' });
    expect(s1.doc?.html).toBe('<p>prior edit</p>');
    expect(s1.cache).toEqual({ art1: '<p>prior edit</p>' });
  });

  it('open() with no html rehydrates from a PRIOR cache entry for that id (GovCopilot reopen)', () => {
    const s0 = initialCanvasSessionState();
    const seeded = openCanvasDoc(s0, 'm1', '# v1', null, '<p>saved html</p>');
    const closed = closeCanvasDoc(seeded);
    // reopening the SAME message id later, without an explicit html arg
    const reopened = openCanvasDoc(closed, 'm1', '# v1');
    expect(reopened.doc?.html).toBe('<p>saved html</p>');
  });

  it('opening a DIFFERENT id never rehydrates from an unrelated cache entry', () => {
    const s0 = initialCanvasSessionState();
    const seeded = openCanvasDoc(s0, 'm1', '# v1', null, '<p>m1 html</p>');
    const opened2 = openCanvasDoc(seeded, 'm2', '# v2');
    expect(opened2.doc?.html).toBeUndefined();
    expect(opened2.cache).toEqual({ m1: '<p>m1 html</p>' }); // m1's cache entry survives
  });

  it('close() clears doc but preserves the cache (GovCopilot: close/reopen shows edits)', () => {
    const s0 = initialCanvasSessionState();
    const seeded = openCanvasDoc(s0, 'm1', '# v1', null, '<p>x</p>');
    const closed = closeCanvasDoc(seeded);
    expect(closed.doc).toBeNull();
    expect(closed.cache).toEqual({ m1: '<p>x</p>' });
  });

  it('close() on an already-closed session is a no-op (referentially stable)', () => {
    const s0 = initialCanvasSessionState();
    expect(closeCanvasDoc(s0)).toBe(s0);
  });

  it('save() with nothing open returns persistArgs: null (no-op, no persist call)', () => {
    const s0 = initialCanvasSessionState();
    const { state, persistArgs } = saveCanvasDoc(s0, '<p>x</p>');
    expect(persistArgs).toBeNull();
    expect(state).toBe(s0);
  });

  it('save() caches the html under the open doc id and returns persist args', () => {
    const s0 = initialCanvasSessionState<'charter' | null, { title: string }>();
    const opened = openCanvasDoc(s0, 'art1', '# charter', 'charter', undefined, { title: 'Charter' });
    const { state, persistArgs } = saveCanvasDoc(opened, '<p>edited</p>');
    expect(state.cache).toEqual({ art1: '<p>edited</p>' });
    expect(persistArgs).toEqual({
      id: 'art1', html: '<p>edited</p>', kind: 'charter', meta: { title: 'Charter' },
      cache: { art1: '<p>edited</p>' },
    });
  });

  it('save() does NOT itself change doc.html (GovCopilot-style lazy resync — cache only)', () => {
    const s0 = initialCanvasSessionState();
    const opened = openCanvasDoc(s0, 'm1', '# v1');
    const { state } = saveCanvasDoc(opened, '<p>new</p>');
    expect(state.doc?.html).toBeUndefined(); // unchanged — a caller must opt in via updateMeta
    expect(state.cache.m1).toBe('<p>new</p>');
  });

  it('updateMeta() reactively refreshes the open doc html+meta, leaving id/md/kind and cache untouched', () => {
    const s0 = initialCanvasSessionState<'gendoc' | null, { title: string; canvasHtml?: string }>();
    const opened = openCanvasDoc(s0, 'doc1', '# gendoc', 'gendoc', undefined, { title: 'Doc' });
    const { state: afterSave } = saveCanvasDoc(opened, '<p>edit 1</p>');
    const refreshed = updateCanvasDocMeta(afterSave, '<p>edit 1</p>', { title: 'Doc', canvasHtml: '<p>edit 1</p>' });
    expect(refreshed.doc).toEqual({
      id: 'doc1', md: '# gendoc', kind: 'gendoc',
      html: '<p>edit 1</p>', meta: { title: 'Doc', canvasHtml: '<p>edit 1</p>' },
    });
    expect(refreshed.cache).toBe(afterSave.cache); // updateMeta never touches the cache
  });

  it('updateMeta() on a closed session is a no-op', () => {
    const s0 = initialCanvasSessionState();
    expect(updateCanvasDocMeta(s0, '<p>x</p>', undefined)).toBe(s0);
  });

  it('hydrateCache() bulk-replaces the cache (e.g. loading localStorage on mount)', () => {
    const s0 = initialCanvasSessionState();
    const hydrated = hydrateCanvasCache(s0, { m1: '<p>a</p>', m2: '<p>b</p>' });
    expect(hydrated.cache).toEqual({ m1: '<p>a</p>', m2: '<p>b</p>' });
    expect(hydrated.doc).toBeNull();
    // reopening a hydrated id picks up its cached html
    const reopened = openCanvasDoc(hydrated, 'm2', '# two');
    expect(reopened.doc?.html).toBe('<p>b</p>');
  });

  it('a full open → save → close → reopen round-trip shows the persisted edit (GovCopilot flow)', () => {
    let state = initialCanvasSessionState();
    state = openCanvasDoc(state, 'm1', '# original');
    const { state: afterSave, persistArgs } = saveCanvasDoc(state, '<p>edited by user</p>');
    state = afterSave;
    expect(persistArgs?.cache).toEqual({ m1: '<p>edited by user</p>' });
    state = closeCanvasDoc(state);
    state = openCanvasDoc(state, 'm1', '# original'); // reopen, same id, no html arg
    expect(state.doc?.html).toBe('<p>edited by user</p>');
  });

  it('a kind-routed open → save → updateMeta round-trip mirrors GovernanceCenter (eager resync)', () => {
    type Kind = 'charter' | 'gendoc' | 'diagnostic' | null;
    interface Meta { title: string; canvasHtml?: string }
    let state = initialCanvasSessionState<Kind, Meta>();
    state = openCanvasDoc(state, 'charter', '# charter md', 'charter', undefined, { title: 'Charter' });
    const { state: afterSave, persistArgs } = saveCanvasDoc(state, '<p>v1</p>');
    state = afterSave;
    expect(persistArgs?.kind).toBe('charter');
    // caller's kind-routed persist callback merges canvasHtml into its own
    // business object, then calls updateMeta so the render reflects it immediately
    const next: Meta = { ...persistArgs!.meta, canvasHtml: persistArgs!.html };
    state = updateCanvasDocMeta(state, persistArgs!.html, next);
    expect(state.doc?.meta).toEqual({ title: 'Charter', canvasHtml: '<p>v1</p>' });
    expect(state.doc?.html).toBe('<p>v1</p>');
  });
});
