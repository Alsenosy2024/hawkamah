import { describe, it, expect } from 'vitest';
import { parseSSE } from '../../services/copilotClient';

// ===========================================================================
//  P12/MINOR — SSE-frame parsing (buffer, split on '\n\n', strip 'data: ',
//  JSON.parse) used to be duplicated almost verbatim between askStream and
//  _consumeDraftStream in copilotClient.ts. parseSSE is the single extraction
//  both now call through; these tests pin its framing/decoding behavior in
//  isolation (chunk-split frames, a trailing frame with no closing blank line,
//  malformed data lines, and error propagation from the event handler).
// ===========================================================================

// Build a ReadableStream<Uint8Array> that yields the given string chunks one
// read() at a time — mirrors how a real fetch() body arrives piecemeal.
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

describe('parseSSE — shared frame parser for askStream + _consumeDraftStream (P12/MINOR)', () => {
  it('parses complete "data: <json>\\n\\n" frames in order', async () => {
    const events: any[] = [];
    const body = streamFromChunks([
      'data: {"type":"delta","text":"a"}\n\n',
      'data: {"type":"delta","text":"b"}\n\ndata: {"type":"done","text":"ab"}\n\n',
    ]);
    await parseSSE(body, ev => events.push(ev));
    expect(events).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
      { type: 'done', text: 'ab' },
    ]);
  });

  it('reassembles a frame split mid-JSON across two reads', async () => {
    const events: any[] = [];
    const body = streamFromChunks(['data: {"type":"delta","te', 'xt":"x"}\n\n']);
    await parseSSE(body, ev => events.push(ev));
    expect(events).toEqual([{ type: 'delta', text: 'x' }]);
  });

  it('flushes a trailing frame that never got its closing blank line', async () => {
    const events: any[] = [];
    const body = streamFromChunks(['data: {"type":"done","text":"z"}']);
    await parseSSE(body, ev => events.push(ev));
    expect(events).toEqual([{ type: 'done', text: 'z' }]);
  });

  it('skips a malformed (non-JSON) data line instead of throwing', async () => {
    const events: any[] = [];
    const body = streamFromChunks(['data: not-json\n\ndata: {"type":"done"}\n\n']);
    await parseSSE(body, ev => events.push(ev));
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('ignores blank keep-alive lines between frames', async () => {
    const events: any[] = [];
    const body = streamFromChunks(['data: {"type":"delta","text":"a"}\n\n\n\ndata: {"type":"done"}\n\n']);
    await parseSSE(body, ev => events.push(ev));
    expect(events).toEqual([{ type: 'delta', text: 'a' }, { type: 'done' }]);
  });

  it('propagates an error thrown by the event handler to the caller (backend "error" frame)', async () => {
    const body = streamFromChunks(['data: {"type":"error","detail":"boom"}\n\n']);
    await expect(
      parseSSE(body, ev => { if (ev.type === 'error') throw new Error(`copilot /draft/stream: ${ev.detail}`); }),
    ).rejects.toThrow('boom');
  });
});
