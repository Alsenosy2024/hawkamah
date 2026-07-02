import { describe, it, expect } from 'vitest';
import { FORMAT_HINT, askMessagePayload, stageChatMessagePayload } from '../../services/copilotClient';

// ===========================================================================
//  P12/CRITICAL — GovCopilot used to append the ~473-char FORMAT_HINT to
//  EVERY /ask message before sending, pushing every real message (even a bare
//  "مرحبا") past the backend's 40-char smalltalk gate
//  (agent.py _SMALLTALK_MAX_CHARS = 40), making the whole conversational
//  smalltalk carve-out unreachable from the real UI. askMessagePayload/
//  stageChatMessagePayload are the two outgoing-message builders GovCopilot
//  now calls at its /ask and stageChat-fallback send sites respectively; this
//  pins the contract that /ask gets the RAW question while the local
//  fallback (no smalltalk gate) keeps the formatting directive.
// ===========================================================================

const _SMALLTALK_MAX_CHARS = 40; // mirrors copilot/hawkama_copilot/agent.py

describe('askMessagePayload — /ask must receive the RAW question, no FORMAT_HINT', () => {
  const greetings = ['مرحبا', 'شكرا', 'هلا', 'صباح الخير', 'hi', 'thanks'];

  it('returns the question completely unchanged', () => {
    for (const g of greetings) expect(askMessagePayload(g)).toBe(g);
  });

  it('never contains the formatting-hint marker', () => {
    for (const g of greetings) expect(askMessagePayload(g)).not.toContain('تعليمات التنسيق');
  });

  it('keeps every short greeting under the backend smalltalk gate', () => {
    for (const g of greetings) expect(askMessagePayload(g).length).toBeLessThan(_SMALLTALK_MAX_CHARS);
  });

  it('is a true no-op identity — appending FORMAT_HINT to the raw text would have failed this', () => {
    const q = 'مرحبا';
    expect(askMessagePayload(q + FORMAT_HINT).length).not.toBeLessThan(_SMALLTALK_MAX_CHARS);
    expect(askMessagePayload(q).length).toBeLessThan(_SMALLTALK_MAX_CHARS);
  });
});

describe('stageChatMessagePayload — the local (no-backend) fallback keeps the formatting directive', () => {
  it('appends FORMAT_HINT verbatim — this path has no smalltalk gate to break', () => {
    expect(stageChatMessagePayload('مرحبا')).toBe('مرحبا' + FORMAT_HINT);
  });

  it('carries the mermaid-formatting instructions', () => {
    expect(stageChatMessagePayload('اكتب لي سياسة')).toContain('mermaid');
  });
});
