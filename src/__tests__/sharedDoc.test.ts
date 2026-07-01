import { describe, it, expect } from 'vitest';
import {
  genShareToken, shareUrl, snapshotByteLength, snapshotTooLarge,
  buildDocComment, hashAccessCode, MAX_SNAPSHOT_BYTES,
} from '../../services/sharedDocService';
import { artifactToMarkdown } from '../../services/canvasDocument';
import type { VisualReviewCheck } from '../../types';

// ===========================================================================
//  V14 + V20 — client document share + comments. These pin the PURE logic:
//  the share token / URL, the snapshot size guard, the create-only comment
//  payload (incl. the visual-review-check discriminator), the access-code hash,
//  and the stored-record → Markdown bridge that feeds the canvas snapshot.
// ===========================================================================

describe('share token + URL', () => {
  it('mints a 16-char hex token', () => {
    const tok = genShareToken();
    expect(tok).toMatch(/^[0-9a-f]{16}$/);
  });

  it('tokens are unique across calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => genShareToken()));
    expect(seen.size).toBe(50);
  });

  it('builds a /?doc= share URL from the token', () => {
    expect(shareUrl('abc123')).toContain('/?doc=abc123');
  });
});

describe('snapshot size guard', () => {
  it('measures byte length (multi-byte aware)', () => {
    expect(snapshotByteLength('abc')).toBe(3);
    expect(snapshotByteLength('مرحبا')).toBeGreaterThan(5);   // Arabic = 2 bytes/char in UTF-8
  });

  it('flags only oversized snapshots', () => {
    expect(snapshotTooLarge('<p>small</p>')).toBe(false);
    expect(snapshotTooLarge('x'.repeat(MAX_SNAPSHOT_BYTES + 1))).toBe(true);
  });
});

describe('buildDocComment — create-only payload', () => {
  it('is a plain comment when no check is supplied', () => {
    const c = buildDocComment({ tokenId: 'tk', docId: 'd1', tenantId: 't1', author: 'Sara', text: 'looks good' });
    expect(c.kind).toBe('comment');
    expect(c.check).toBeUndefined();
    expect(c).toMatchObject({ tokenId: 'tk', docId: 'd1', tenantId: 't1', author: 'Sara', text: 'looks good' });
    expect(c.id).toMatch(/^dcm_/);
    expect(typeof c.at).toBe('string');
  });

  it('is a review_check when a check is supplied', () => {
    const check: VisualReviewCheck = { diagrams: true, fonts: false, layout: true, content: true, verdict: 'fail' };
    const c = buildDocComment({ tokenId: 'tk', docId: 'd1', tenantId: 't1', author: '', text: '', check });
    expect(c.kind).toBe('review_check');
    expect(c.check).toEqual(check);
    expect(c.author).toBe('client');   // empty author defaults
  });

  it('bounds author + text length', () => {
    const c = buildDocComment({ tokenId: 'tk', docId: 'd1', tenantId: 't1', author: 'a'.repeat(500), text: 'b'.repeat(9000) });
    expect(c.author.length).toBeLessThanOrEqual(120);
    expect(c.text.length).toBeLessThanOrEqual(4000);
  });

  it('has no anchor for a free-text comment', () => {
    const c = buildDocComment({ tokenId: 'tk', docId: 'd1', tenantId: 't1', author: 'Sara', text: 'looks good' });
    expect(c.anchor).toBeUndefined();
  });

  it('carries an inline anchor (quote + prefix/suffix) when supplied', () => {
    const c = buildDocComment({
      tokenId: 'tk', docId: 'd1', tenantId: 't1', author: 'Sara', text: 'reword this',
      anchor: { quote: 'مجلس الإدارة', prefix: 'يجتمع ', suffix: ' مرة', sectionId: 'sec-1' },
    });
    expect(c.kind).toBe('comment');
    expect(c.anchor).toEqual({ quote: 'مجلس الإدارة', prefix: 'يجتمع ', suffix: ' مرة', sectionId: 'sec-1' });
  });

  it('bounds an oversized anchor quote/context and drops empty context', () => {
    const c = buildDocComment({
      tokenId: 'tk', docId: 'd1', tenantId: 't1', author: '', text: '',
      anchor: { quote: 'q'.repeat(5000), prefix: 'p'.repeat(500), suffix: '' },
    });
    expect(c.anchor!.quote.length).toBeLessThanOrEqual(2000);
    expect(c.anchor!.prefix!.length).toBeLessThanOrEqual(200);
    expect(c.anchor!.suffix).toBeUndefined();     // empty context dropped
    expect(c.anchor!.sectionId).toBeUndefined();
  });
});

describe('hashAccessCode', () => {
  it('is deterministic and 64 hex chars (SHA-256)', async () => {
    const a = await hashAccessCode('open-sesame');
    const b = await hashAccessCode('open-sesame');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different codes', async () => {
    expect(await hashAccessCode('one')).not.toBe(await hashAccessCode('two'));
  });
});

describe('artifactToMarkdown — stored record → canvas markdown', () => {
  it('serializes title, summary, sections and diagrams', () => {
    const md = artifactToMarkdown({
      title: 'دليل الحوكمة',
      executiveSummary: 'ملخص تنفيذي',
      sections: [
        { title: 'المقدمة', content: 'نص المقدمة' },
        { title: 'الهيكل', content: 'نص الهيكل' },
      ],
      diagrams: [{ title: 'الهيكل التنظيمي', png: 'data:image/png;base64,AAAA' }],
    });
    expect(md).toContain('# دليل الحوكمة');
    expect(md).toContain('ملخص تنفيذي');
    expect(md).toContain('## المقدمة');
    expect(md).toContain('## الهيكل');
    expect(md).toContain('![الهيكل التنظيمي](data:image/png;base64,AAAA)');
  });

  it('drops empty sections / missing pieces and ends with a newline', () => {
    const md = artifactToMarkdown({ title: 'T', sections: [{ title: '', content: '' }] });
    expect(md).toBe('# T\n');
  });

  it('escapes brackets in a diagram caption', () => {
    const md = artifactToMarkdown({ title: 'T', diagrams: [{ title: 'a[b]c', png: 'data:image/png;base64,Z' }] });
    expect(md).toContain('![abc](data:image/png;base64,Z)');
  });
});
