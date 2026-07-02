import { describe, it, expect } from 'vitest';
import { replaceMermaidFence } from '../../services/mermaidDetect';

// ===========================================================================
//  P8 — GovCopilot's chat-rendered ```mermaid fences become editable via
//  EditableDiagram; accepting an edit must rewrite ONLY that exact fence back
//  into the message's stored Markdown, leaving everything else byte-identical.
// ===========================================================================

const OLD_CODE = 'flowchart TD\n  A[البداية] --> B[النهاية]';
const NEW_CODE = 'flowchart TD\n  A[البداية] --> B[مرحلة وسيطة] --> C[النهاية]';

describe('replaceMermaidFence', () => {
  it('replaces the exact matching fenced block with the new code', () => {
    const content = ['# عنوان', '', '```mermaid', OLD_CODE, '```', '', 'فقرة بعد المخطط.'].join('\n');
    const out = replaceMermaidFence(content, OLD_CODE, NEW_CODE);
    expect(out).toContain(NEW_CODE);
    expect(out).not.toContain(OLD_CODE.split('\n')[1]); // the old B[النهاية] edge is gone
    expect(out).toContain('# عنوان');
    expect(out).toContain('فقرة بعد المخطط.');
  });

  it('preserves the fence language tag', () => {
    const content = ['```mermaid', OLD_CODE, '```'].join('\n');
    const out = replaceMermaidFence(content, OLD_CODE, NEW_CODE);
    expect(out.startsWith('```mermaid\n')).toBe(true);
  });

  it('replaces only the FIRST matching occurrence, leaving a later identical block untouched', () => {
    const content = ['```mermaid', OLD_CODE, '```', '', 'نص فاصل', '', '```mermaid', OLD_CODE, '```'].join('\n');
    const out = replaceMermaidFence(content, OLD_CODE, NEW_CODE);
    const occurrencesOfNew = out.split(NEW_CODE).length - 1;
    const occurrencesOfOld = out.split(OLD_CODE).length - 1;
    expect(occurrencesOfNew).toBe(1);
    expect(occurrencesOfOld).toBe(1); // the second block still has the OLD code
  });

  it('leaves OTHER fenced blocks (different code) completely untouched', () => {
    const otherBlock = 'sequenceDiagram\n  A->>B: مرحبا';
    const content = ['```mermaid', OLD_CODE, '```', '', '```mermaid', otherBlock, '```'].join('\n');
    const out = replaceMermaidFence(content, OLD_CODE, NEW_CODE);
    expect(out).toContain(NEW_CODE);
    expect(out).toContain(otherBlock);
  });

  it('is a no-op when no fence matches the old code', () => {
    const content = ['```mermaid', 'flowchart TD\n  X --> Y', '```'].join('\n');
    const out = replaceMermaidFence(content, OLD_CODE, NEW_CODE);
    expect(out).toBe(content);
  });

  it('is a no-op on content with no fences at all', () => {
    const content = 'فقرة عادية بدون أي مخطط.';
    const out = replaceMermaidFence(content, OLD_CODE, NEW_CODE);
    expect(out).toBe(content);
  });

  it('is a no-op when oldCode is empty', () => {
    const content = ['```mermaid', OLD_CODE, '```'].join('\n');
    expect(replaceMermaidFence(content, '', NEW_CODE)).toBe(content);
  });

  it('matches regardless of surrounding whitespace inside the fence', () => {
    const content = ['```mermaid', '  ' + OLD_CODE + '  ', '```'].join('\n');
    const out = replaceMermaidFence(content, OLD_CODE, NEW_CODE);
    expect(out).toContain(NEW_CODE);
  });

  it('handles empty/undefined content without throwing', () => {
    expect(replaceMermaidFence('', OLD_CODE, NEW_CODE)).toBe('');
    expect(replaceMermaidFence(undefined as unknown as string, OLD_CODE, NEW_CODE)).toBeUndefined();
  });
});
