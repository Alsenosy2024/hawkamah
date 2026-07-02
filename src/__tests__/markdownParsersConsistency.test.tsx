import { describe, it, expect } from 'vitest';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { parseMarkdown, type MdBlock } from '../../services/markdownAst';
import { markdownToDocSpec, type DocBlock } from '../../services/canvasDocument';
import Markdown from '../../components/Markdown';

// P17/MAJOR-modularity — services/markdownAst.ts (docx/pdf/xlsx export),
// services/canvasDocument.ts's markdownToDocSpec (canvas) and
// components/Markdown.tsx (chat) are three independent Markdown block
// parsers. This file has two jobs:
//   1. Pin a leading-bidi-control (RLM) bullet as correctly recognized by
//      markdownAst.ts — the ONE deliberate behavior fix in this lane (see the
//      NOTE at the top of markdownAst.ts). Before this fix, an RLM-prefixed
//      bullet from any producer (e.g. services/governanceArtifacts.ts) fell
//      through the `^`-anchored bullet check into one garbled paragraph in
//      every Word/PDF/xlsx export.
//   2. Pin today's cross-parser agreement on ordinary block structure (a
//      regression net for future edits — see markdownAst.ts's NOTE for why a
//      full grammar unification is out of scope for this lane).
const RLM = '‏';

describe('markdownAst — RLM-prefixed blocks (P17/MAJOR fix)', () => {
  it('recognizes an RLM-prefixed bullet as a real list item, not a garbled paragraph', () => {
    const blocks = parseMarkdown(`${RLM}- بند أول\n${RLM}- بند ثانٍ`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'bullet', text: 'بند أول' });
    expect(blocks[1]).toMatchObject({ type: 'bullet', text: 'بند ثانٍ' });
  });

  it('recognizes an RLM-prefixed heading', () => {
    const blocks = parseMarkdown(`${RLM}## عنوان`);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2, text: 'عنوان' });
  });

  it('recognizes an RLM-prefixed blockquote', () => {
    const blocks = parseMarkdown(`${RLM}> اقتباس`);
    expect(blocks[0]).toMatchObject({ type: 'quote', text: 'اقتباس' });
  });

  it('recognizes an RLM-prefixed ordered list item', () => {
    const blocks = parseMarkdown(`${RLM}1. أولاً`);
    expect(blocks[0]).toMatchObject({ type: 'bullet', ordered: true, text: 'أولاً' });
  });

  it('recognizes an RLM-prefixed horizontal rule', () => {
    expect(parseMarkdown(`${RLM}---`)).toEqual([{ type: 'rule' }]);
  });

  it('recognizes an RLM-prefixed table (header + divider + row)', () => {
    const md = `${RLM}| العمود | القيمة |\n${RLM}|---|---|\n${RLM}| أ | 1 |`;
    const blocks = parseMarkdown(md);
    expect(blocks[0]).toMatchObject({ type: 'table', headers: ['العمود', 'القيمة'], rows: [['أ', '1']] });
  });

  it('never strips a bidi control that sits mid-line, only the leading run', () => {
    const blocks = parseMarkdown(`- بند ${RLM}وسط النص`);
    expect(blocks[0].type).toBe('bullet');
    expect((blocks[0] as any).text).toContain(RLM);
  });

  it('never strips bidi controls inside a fenced code block\'s content', () => {
    const code = `${RLM}const x = 1;`;
    const blocks = parseMarkdown('```js\n' + code + '\n```');
    expect(blocks[0]).toMatchObject({ type: 'code', lang: 'js' });
    expect((blocks[0] as any).text).toBe(code); // preserved verbatim, not stripped
  });

  it('matches services/canvasDocument.ts\'s pre-existing RLM handling (parity, not a new quirk)', () => {
    const md = `${RLM}- بند أول`;
    const astBlocks = parseMarkdown(md);
    const spec = markdownToDocSpec(md, { title: 'Fixture', lang: 'ar' });
    expect(astBlocks[0].type).toBe('bullet');
    expect(spec.blocks[0]).toMatchObject({ type: 'list', items: ['بند أول'] });
  });
});

// ---------------------------------------------------------------------------
// Cross-parser block-structure agreement
// ---------------------------------------------------------------------------

const FIXTURE = [
  '# عنوان رئيسي',
  '',
  'فقرة تمهيدية مع **نص بارز** و *نص مائل* وإشارة [مصدر 1] و[مصدر 2].',
  '',
  '## قسم فرعي',
  '',
  '- بند أول',
  '- بند ثانٍ',
  '- بند ثالث',
  '',
  '1. الخطوة الأولى',
  '2. الخطوة الثانية',
  '',
  '> اقتباس يوضح نقطة مهمة.',
  '',
  '| العمود | القيمة |',
  '|---|---|',
  '| أ | ≥ 90% |',
  '| ب | ≤ 5% |',
  '',
  '```js',
  'const x = 1;',
  '```',
].join('\n');

interface BlockSummary {
  headings: number;
  listItems: number;
  tables: number;
  tableRows: number;
  codeBlocks: number;
  blockquotes: number;
}

function summarizeAst(md: string): BlockSummary {
  const blocks: MdBlock[] = parseMarkdown(md);
  const tables = blocks.filter((b): b is Extract<MdBlock, { type: 'table' }> => b.type === 'table');
  return {
    headings: blocks.filter(b => b.type === 'heading').length,
    listItems: blocks.filter(b => b.type === 'bullet').length,
    tables: tables.length,
    tableRows: tables.reduce((n, b) => n + b.rows.length, 0),
    codeBlocks: blocks.filter(b => b.type === 'code').length,
    blockquotes: blocks.filter(b => b.type === 'quote').length,
  };
}

function summarizeCanvas(md: string): BlockSummary {
  // Explicit `title` so the leading H1 becomes a real heading block instead of
  // being consumed as the document title (markdownToDocSpec's cover-page
  // behavior) — an intentional difference from markdownAst.ts documented in
  // markdownAst.ts's NOTE, sidestepped here so headings are directly comparable.
  const spec = markdownToDocSpec(md, { title: 'Fixture', lang: 'ar' });
  const blocks: DocBlock[] = spec.blocks;
  const tables = blocks.filter((b): b is Extract<DocBlock, { type: 'table' }> => b.type === 'table');
  const lists = blocks.filter((b): b is Extract<DocBlock, { type: 'list' }> => b.type === 'list');
  return {
    headings: blocks.filter(b => b.type === 'heading' || b.type === 'subheading').length,
    listItems: lists.reduce((n, b) => n + b.items.length, 0),
    tables: tables.length,
    tableRows: tables.reduce((n, b) => n + b.rows.length, 0),
    codeBlocks: blocks.filter(b => b.type === 'code').length,
    blockquotes: blocks.filter(b => b.type === 'callout').length,
  };
}

// components/Markdown.tsx renders straight to React elements (no intermediate
// AST to inspect) — rendered to a static HTML string and summarized from the
// actual markup it produces (font-extrabold is the heading marker it renders
// with; the others are the semantic tags it emits for that block type).
function summarizeChat(md: string): BlockSummary {
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(Markdown, { text: md, rtl: true }));
  const count = (re: RegExp) => (html.match(re) || []).length;
  const trCount = count(/<tr[ >]/g);
  const tableCount = count(/<table[ >]/g);
  return {
    headings: count(/font-extrabold/g),
    listItems: count(/<li[ >]/g),
    tables: tableCount,
    tableRows: Math.max(0, trCount - tableCount), // one <tr> per table is the header row
    codeBlocks: count(/<pre[ >]/g),
    blockquotes: count(/<blockquote[ >]/g),
  };
}

describe('cross-parser block-structure agreement (fixture: headings, lists, table, quote, code, bold/italic, ≥/≤, citations)', () => {
  const expected: BlockSummary = {
    headings: 2, listItems: 5, tables: 1, tableRows: 2, codeBlocks: 1, blockquotes: 1,
  };

  it('services/markdownAst.ts (docx/pdf/xlsx export) matches the expected structure', () => {
    expect(summarizeAst(FIXTURE)).toEqual(expected);
  });

  it('services/canvasDocument.ts markdownToDocSpec (canvas) matches the expected structure', () => {
    expect(summarizeCanvas(FIXTURE)).toEqual(expected);
  });

  it('components/Markdown.tsx (chat) matches the expected structure', () => {
    expect(summarizeChat(FIXTURE)).toEqual(expected);
  });

  it('all three summaries are pairwise identical (single source of truth for the assertion above)', () => {
    const ast = summarizeAst(FIXTURE);
    const canvas = summarizeCanvas(FIXTURE);
    const chat = summarizeChat(FIXTURE);
    expect(ast).toEqual(canvas);
    expect(canvas).toEqual(chat);
  });
});

describe('a KNOWN, documented remaining gap (not part of this lane\'s fix)', () => {
  // components/Markdown.tsx never got the bidi-stripping defense (item 4a
  // scoped it to markdownAst.ts's export path only — see the NOTE at the top
  // of markdownAst.ts). An RLM-prefixed bullet in a CHAT message therefore
  // still renders as plain text there, even though the two file-producing
  // parsers now both handle it. This test documents that gap on purpose so it
  // can't silently regress into a false "all three agree" claim, and so
  // whoever eventually fixes it remembers to update this test.
  const md = `${RLM}- بند بادئته RLM`;

  it('markdownAst.ts and canvasDocument.ts agree: a real list item', () => {
    expect(parseMarkdown(md)[0].type).toBe('bullet');
    expect(markdownToDocSpec(md, { title: 'Fixture', lang: 'ar' }).blocks[0].type).toBe('list');
  });

  it('components/Markdown.tsx does NOT recognize it as a list item (documented gap)', () => {
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(Markdown, { text: md, rtl: true }));
    expect(html).not.toContain('<li');
  });
});
