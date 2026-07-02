import { describe, it, expect } from 'vitest';
import {
  genShareToken, shareUrl, snapshotByteLength, snapshotTooLarge,
  buildDocComment, hashAccessCode, MAX_SNAPSHOT_BYTES,
  encryptSharedDocHtml, decryptSharedDocHtml, verifyAccessCode,
  sharedDocIsGated, unlockSharedDocHtml, PBKDF2_ITERATIONS,
} from '../../services/sharedDocService';
import { artifactToMarkdown } from '../../services/canvasDocument';
import type { VisualReviewCheck, SharedDocToken } from '../../types';

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

// ===========================================================================
//  D1 — code-gated shares are AES-GCM encrypted client-side instead of being
//  stored as plaintext html + an unsalted access-code hash in the world-
//  readable `survey_tokens` collection. These pin: the encrypt→decrypt round
//  trip with the right code, GCM authentication failure (no separate hash
//  check) with the wrong code, and that legacy pre-D1 {html, accessCodeHash}
//  shares are still readable.
// ===========================================================================
describe('D1 — encryptSharedDocHtml / decryptSharedDocHtml round trip', () => {
  const html = '<html dir="rtl"><body><h1>ميثاق الحوكمة</h1><p>محتوى سري</p></body></html>';

  it('decrypts back to the exact original html with the right code', async () => {
    const enc = await encryptSharedDocHtml(html, 'sesame-2024');
    const tok = baseTok(enc);
    expect(await decryptSharedDocHtml(tok, 'sesame-2024')).toBe(html);
  });

  it('never stores plaintext html or a code hash on the encrypted payload', async () => {
    const enc = await encryptSharedDocHtml(html, 'sesame-2024');
    expect(enc.enc).toBe(true);
    expect(typeof enc.htmlEnc).toBe('string');
    expect(enc.htmlEnc).not.toContain('ميثاق');
    expect(enc.htmlEnc).not.toContain('<html');
    expect((enc as Record<string, unknown>).html).toBeUndefined();
    expect((enc as Record<string, unknown>).accessCodeHash).toBeUndefined();
    expect(enc.kdfIterations).toBeGreaterThanOrEqual(150_000);
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(150_000);
  });

  it('uses a random salt + IV per encryption (two shares of the same html+code differ)', async () => {
    const a = await encryptSharedDocHtml(html, 'sesame-2024');
    const b = await encryptSharedDocHtml(html, 'sesame-2024');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.htmlEnc).not.toBe(b.htmlEnc);
  });

  it('fails GCM authentication (throws WRONG_CODE) when decrypting with the wrong code', async () => {
    const enc = await encryptSharedDocHtml(html, 'right-code');
    const tok = baseTok(enc);
    await expect(decryptSharedDocHtml(tok, 'wrong-code')).rejects.toThrow('WRONG_CODE');
  });

  it('throws NOT_ENCRYPTED when called on a token with no ciphertext', async () => {
    const tok: SharedDocToken = { ...baseTok({}), enc: undefined };
    await expect(decryptSharedDocHtml(tok, 'anything')).rejects.toThrow('NOT_ENCRYPTED');
  });

  function baseTok(enc: Partial<SharedDocToken>): SharedDocToken {
    return {
      id: 'tok1', type: 'shared_doc', tenantId: 't1', docId: 'd1',
      docTitle: 'ميثاق', allowComments: true, createdAt: new Date().toISOString(),
      ...enc,
    };
  }
});

describe('D1 — legacy {html, accessCodeHash} shares still verify (backward compat)', () => {
  const legacyTok = async (code: string): Promise<SharedDocToken> => ({
    id: 'tok2', type: 'shared_doc', tenantId: 't1', docId: 'd1',
    docTitle: 'وثيقة قديمة', html: '<p>legacy plaintext</p>', allowComments: true,
    createdAt: new Date().toISOString(), accessCodeHash: await hashAccessCode(code),
  });

  it('verifyAccessCode accepts the right code and rejects the wrong one', async () => {
    const tok = await legacyTok('old-code');
    expect(await verifyAccessCode(tok, 'old-code')).toBe(true);
    expect(await verifyAccessCode(tok, 'wrong')).toBe(false);
  });

  it('unlockSharedDocHtml resolves the stored plaintext for a legacy share with the right code', async () => {
    const tok = await legacyTok('old-code');
    expect(await unlockSharedDocHtml(tok, 'old-code')).toBe('<p>legacy plaintext</p>');
  });

  it('unlockSharedDocHtml throws WRONG_CODE for a legacy share with the wrong code', async () => {
    const tok = await legacyTok('old-code');
    await expect(unlockSharedDocHtml(tok, 'nope')).rejects.toThrow('WRONG_CODE');
  });

  it('an open (ungated) share has no gate and resolves its plaintext directly', async () => {
    const tok: SharedDocToken = {
      id: 'tok3', type: 'shared_doc', tenantId: 't1', docId: 'd1',
      docTitle: 'وثيقة عامة', html: '<p>public</p>', allowComments: true,
      createdAt: new Date().toISOString(),
    };
    expect(sharedDocIsGated(tok)).toBe(false);
    expect(await unlockSharedDocHtml(tok, '')).toBe('<p>public</p>');
  });

  it('sharedDocIsGated is true for both the legacy hash gate and the new enc gate', async () => {
    const legacy = await legacyTok('c');
    expect(sharedDocIsGated(legacy)).toBe(true);
    const enc = await encryptSharedDocHtml('<p>x</p>', 'c');
    const encTok: SharedDocToken = {
      id: 'tok4', type: 'shared_doc', tenantId: 't1', docId: 'd1',
      docTitle: 'محمي', allowComments: true, createdAt: new Date().toISOString(), ...enc,
    };
    expect(sharedDocIsGated(encTok)).toBe(true);
  });

  it('unlockSharedDocHtml prefers decryption over the legacy path when a token is somehow enc', async () => {
    const enc = await encryptSharedDocHtml('<p>secret</p>', 'code-x');
    const encTok: SharedDocToken = {
      id: 'tok5', type: 'shared_doc', tenantId: 't1', docId: 'd1',
      docTitle: 'محمي', allowComments: true, createdAt: new Date().toISOString(), ...enc,
    };
    expect(await unlockSharedDocHtml(encTok, 'code-x')).toBe('<p>secret</p>');
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
