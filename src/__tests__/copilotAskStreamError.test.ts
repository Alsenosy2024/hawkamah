import { describe, it, expect, vi, afterEach } from 'vitest';
import { askStream } from '../../services/copilotClient';

// ===========================================================================
//  P12 follow-up — the backend's /ask SSE now emits a terminal
//  {"type":"error","message":"..."} frame on a mid-stream failure (same
//  protocol /draft/stream already used). askStream previously had no branch
//  for this event type, so it was silently dropped: no onError call, and
//  since the stream closes without ever sending 'done' either, the caller
//  was left "thinking" forever with a partial answer and no sign anything
//  went wrong. These tests pin: the frame is turned into a rejected promise,
//  cb.onError fires with it, and tokens already delivered via onAnswer are
//  left untouched (not retracted).
// ===========================================================================

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

describe('askStream — mid-stream SSE "error" frame', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('rejects, calls onError, and preserves partial text already delivered via onAnswer', async () => {
    const body = sseBody([
      'data: {"type":"delta","text":"جزء من "}\n\ndata: {"type":"delta","text":"الجواب"}\n\n',
      'data: {"type":"error","message":"model timeout"}\n\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body }));

    const delivered: string[] = [];
    let errored: unknown = null;
    let doneCalled = false;

    await expect(
      askStream(
        { corpus: 'c', message: 'q' },
        {
          onAnswer: txt => delivered.push(txt),
          onDone: () => { doneCalled = true; },
          onError: e => { errored = e; },
        },
      ),
    ).rejects.toThrow('model timeout');

    expect(delivered.join('')).toBe('جزء من الجواب');
    expect(errored).toBeInstanceOf(Error);
    expect((errored as Error).message).toBe('model timeout');
    expect(doneCalled).toBe(false); // no terminal 'done' frame ever arrived
  });

  it('falls back to a generic message when the backend omits one', async () => {
    const body = sseBody(['data: {"type":"error"}\n\n']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body }));
    await expect(askStream({ corpus: 'c', message: 'q' }, {})).rejects.toThrow('copilot /ask stream error');
  });

  it('an error frame with no prior deltas still rejects cleanly (empty-bubble case unaffected)', async () => {
    const body = sseBody(['data: {"type":"error","message":"boom"}\n\n']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body }));
    const delivered: string[] = [];
    await expect(
      askStream({ corpus: 'c', message: 'q' }, { onAnswer: t => delivered.push(t) }),
    ).rejects.toThrow('boom');
    expect(delivered).toEqual([]);
  });
});
