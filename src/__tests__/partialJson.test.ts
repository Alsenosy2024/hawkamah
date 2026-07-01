import { describe, it, expect } from 'vitest';
import { extractPartialFields } from '../../services/partialJson';

// V35 — streaming the «الواقع الراهن» diagnostic. `extractPartialFields` lets the
// UI render a live preview from a JSON body that is still being written by the
// model: it returns whatever top-level fields are present so far, INCLUDING a
// string value whose closing quote hasn't arrived yet. These tests lock in that
// lenient-parse contract (complete/mid-stream strings, escapes, numbers, Arabic).
describe('extractPartialFields (V35 streaming-diagnostic partial parser)', () => {
  const S = ['strengths', 'weaknesses', 'recommendations'];
  const N = ['totalScore'];

  it('reads a complete string field', () => {
    const p = extractPartialFields('{"strengths": "قوة موثّقة"}', S, N);
    expect(p.strengths).toBe('قوة موثّقة');
  });

  it('returns a mid-stream string (no closing quote yet)', () => {
    const p = extractPartialFields('{"strengths": "قوة قيد الكتابة', S, N);
    expect(p.strengths).toBe('قوة قيد الكتابة');
  });

  it('decodes an escaped quote inside a value', () => {
    const p = extractPartialFields('{"strengths": "قال \\"مرحبا\\" هنا"}', S, N);
    expect(p.strengths).toBe('قال "مرحبا" هنا');
  });

  it('decodes a \\n newline inside a value (Arabic, multi-line)', () => {
    const p = extractPartialFields('{"weaknesses": "السطر الأول\\nالسطر الثاني"}', S, N);
    expect(p.weaknesses).toBe('السطر الأول\nالسطر الثاني');
  });

  it('decodes a \\uXXXX escape', () => {
    const p = extractPartialFields('{"strengths": "A\\u0042C"}', S, N);
    expect(p.strengths).toBe('ABC');
  });

  it('parses a number field', () => {
    const p = extractPartialFields('{"totalScore": 62}', S, N);
    expect(p.totalScore).toBe(62);
  });

  it('omits fields not present yet', () => {
    const p = extractPartialFields('{"totalScore": 62}', S, N);
    expect(p.strengths).toBeUndefined();
    expect(p.weaknesses).toBeUndefined();
    expect(p.recommendations).toBeUndefined();
  });

  it('does not read a value whose opening quote has not arrived', () => {
    const p = extractPartialFields('{"totalScore": 62, "strengths":', S, N);
    expect(p.totalScore).toBe(62);
    expect(p.strengths).toBeUndefined();
  });

  it('handles a realistic partial: score complete + one string mid-stream', () => {
    const p = extractPartialFields('{"totalScore": 62, "strengths": "نقطة القوة الأولى', S, N);
    expect(p).toEqual({ totalScore: 62, strengths: 'نقطة القوة الأولى' });
  });

  it('reads all three columns + score together when fully present', () => {
    const full = '{"totalScore": 74, "strengths": "قوة", "weaknesses": "ضعف", "recommendations": "توصية", "extra": "x"}';
    const p = extractPartialFields(full, S, N);
    expect(p).toEqual({ totalScore: 74, strengths: 'قوة', weaknesses: 'ضعف', recommendations: 'توصية' });
  });

  it('waits for a numeric token to be terminated (not truncated mid-stream)', () => {
    // Trailing digits with no delimiter yet → omitted until a boundary arrives.
    expect(extractPartialFields('{"totalScore": 6', S, N).totalScore).toBeUndefined();
    expect(extractPartialFields('{"totalScore": 62,', S, N).totalScore).toBe(62);
  });
});
