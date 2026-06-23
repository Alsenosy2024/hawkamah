// Real, deterministic file-text extraction for the governance ingestion pipeline.
//
// Why this exists: the old inputs-path extractor (extractFileContent) sent only the
// FILE NAME to Gemini with no bytes, so every binary produced a hallucinated "audit
// summary" instead of the document's real text — chunks/embeddings/reports were built
// on fabricated content. This module reads the ACTUAL bytes:
//   • text (txt/md/csv/json/xml/html) → direct decode
//   • docx / pptx                     → unzip the OOXML and pull real text (jszip)
//   • xls / xlsx                      → SheetJS → CSV-per-sheet
//   • pdf / images / legacy doc/ppt   → Gemini multimodal with inlineData (real bytes)
// On genuine empty extraction it returns text:'' + a human reason — NO silent drop,
// NO fabricated stub. Never throws (except abort) so a 50-file batch survives one bad file.

import { GoogleGenAI } from '@google/genai';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { MODELS } from '../constants/models';
import { transcribeAudio } from './geminiService';

export interface ExtractResult {
  text: string;
  method: 'text' | 'docx' | 'pptx' | 'xlsx' | 'gemini' | 'audio' | 'none';
  error?: string;   // set when text is empty/partial — surfaced to the user per-file
}

const TEXT_EXTS = ['txt', 'md', 'csv', 'json', 'xml', 'htm', 'html'];
// N4 — voice interviews as a first-class input: transcribe to text, then ingest like any doc.
const AUDIO_EXTS = ['mp3', 'm4a', 'wav', 'ogg', 'aac', 'flac', 'webm', 'opus'];
// Gemini inline-data request cap ~20MB; base64 inflates ~33%. Guard raw at 14MB.
const MAX_INLINE_BYTES = 14 * 1024 * 1024;

const file2base64 = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });

const stripXml = (xml: string): string =>
  xml
    .replace(/<\/w:p>/g, '\n').replace(/<\/a:p>/g, '\n')   // paragraph ends → newline
    .replace(/<w:tab\/>/g, '\t').replace(/<a:br\/>/g, '\n')
    .replace(/<[^>]+>/g, ' ')                              // drop all tags
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** DOCX: real text from word/document.xml (+ headers/footers if present). */
async function extractDocx(file: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parts: string[] = [];
  const main = zip.file('word/document.xml');
  if (main) parts.push(stripXml(await main.async('string')));
  // include header/footer xml so cover/letterhead text isn't lost
  for (const name of Object.keys(zip.files)) {
    if (/^word\/(header|footer)\d*\.xml$/.test(name)) {
      const f = zip.file(name);
      if (f) parts.push(stripXml(await f.async('string')));
    }
  }
  return parts.filter(Boolean).join('\n').trim();
}

/** PPTX: real text from every ppt/slides/slideN.xml, in slide order. */
async function extractPptx(file: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideNames = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] || 0);
      const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] || 0);
      return na - nb;
    });
  const out: string[] = [];
  let i = 1;
  for (const name of slideNames) {
    const f = zip.file(name);
    if (!f) continue;
    const txt = stripXml(await f.async('string'));
    if (txt) out.push(`## شريحة ${i}\n${txt}`);
    i++;
  }
  return out.join('\n\n').trim();
}

/** XLS/XLSX: SheetJS → one CSV block per sheet, sheet name as heading. */
async function extractSpreadsheet(file: Blob): Promise<string> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const out: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws).trim();
    if (csv) out.push(`## ${sheetName}\n${csv}`);
  }
  return out.join('\n\n').trim();
}

/** PDF / images / legacy binary: send the REAL bytes to Gemini multimodal. */
async function extractViaGemini(file: Blob, fileName: string, signal?: AbortSignal): Promise<string> {
  if (file.size > MAX_INLINE_BYTES) {
    // Too big to inline — try a bounded raw text decode (text-bearing PDFs often work).
    try {
      const head = await (file.slice(0, MAX_INLINE_BYTES)).text();
      const t = head.replace(/[^\p{L}\p{N}\s.,;:()\-/]+/gu, ' ').replace(/\s{2,}/g, ' ').trim();
      return t.length > 200 ? t : '';
    } catch { return ''; }
  }
  const base64 = await file2base64(file);
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
  const res = await ai.models.generateContent({
    model: MODELS.TEXT,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: base64, mimeType: (file as File).type || 'application/octet-stream' } },
        { text: 'استخرج كامل النص من هذا المستند حرفيًا مع الحفاظ على العناوين والتسلسل الهرمي (استخدم ## للعناوين). لا تلخّص ولا تضف رأيًا — أعد النص المستخرج فقط.' },
      ],
    }],
    config: { temperature: 0 },
  });
  if (signal?.aborted) throw new Error('aborted');
  return (res.text || '').trim();
}

/**
 * Extract the real text of one file. Never fabricates. On empty/failed extraction
 * returns { text: '', method: 'none', error } so the caller can surface a clear,
 * per-file message instead of silently dropping the file.
 */
export async function extractFileText(file: File, signal?: AbortSignal): Promise<ExtractResult> {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  try {
    if (AUDIO_EXTS.includes(ext) || (file.type || '').startsWith('audio/')) {
      const base64 = await file2base64(file);
      const txt = (await transcribeAudio(base64, (file as File).type || `audio/${ext}`, 'ar')).trim();
      if (signal?.aborted) throw new Error('aborted');
      return txt
        ? { text: `# مقابلة صوتية: ${file.name}\n\n${txt}`, method: 'audio' }
        : { text: '', method: 'none', error: 'تعذّر تفريغ الصوت — قد يكون صامتًا أو غير واضح' };
    }
    if (TEXT_EXTS.includes(ext)) {
      const text = (await file.text()).trim();
      return text
        ? { text, method: 'text' }
        : { text: '', method: 'none', error: 'الملف النصي فارغ' };
    }
    if (ext === 'docx') {
      const text = await extractDocx(file);
      if (text) return { text, method: 'docx' };
      // fall through to Gemini for odd/legacy docx
    }
    if (ext === 'pptx') {
      const text = await extractPptx(file);
      if (text) return { text, method: 'pptx' };
    }
    if (ext === 'xlsx' || ext === 'xls') {
      const text = await extractSpreadsheet(file);
      return text
        ? { text, method: 'xlsx' }
        : { text: '', method: 'none', error: 'الجدول فارغ أو غير مقروء' };
    }
    // pdf, images, legacy doc/ppt, anything else → real bytes to Gemini
    const text = await extractViaGemini(file, file.name, signal);
    return text
      ? { text, method: 'gemini' }
      : { text: '', method: 'none', error: 'تعذّر استخراج نص — قد يكون مستندًا ممسوحًا بلا طبقة نص. جرّب صيغة DOCX/نص أو ألصق المحتوى.' };
  } catch (e: any) {
    if (e?.message === 'aborted') throw e;
    return { text: '', method: 'none', error: `فشل الاستخلاص: ${e?.message || e}` };
  }
}
