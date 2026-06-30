// ===========================================================================
//  Text-quote anchoring for inline review comments (V21).
//
//  A comment is anchored with a TextQuoteSelector — the exact selected text plus
//  a short prefix/suffix of surrounding characters — rather than character
//  offsets, so it survives the Markdown (client review screen) vs. canvas
//  (owner iframe) render difference: the same prose words are present in both,
//  even though the surrounding DOM is entirely different.
//
//  Pipeline:
//    • anchorFromSelection(root, sectionId)  → build an anchor from a live DOM
//      selection (used by the client to attach a comment to what they highlighted).
//    • findAnchorRange(root, anchor)         → re-locate the quote (disambiguated
//      by prefix/suffix) as a DOM Range in any rendered copy of the document.
//    • highlightComments / clearHighlights   → wrap / unwrap the matched ranges
//      in <mark class="cmt-hl"> so the reader sees the highlighted spans.
//
//  The matching itself (locateQuoteInText) is a pure string function with no DOM
//  dependency, so it is unit-tested directly in the node test environment.
// ===========================================================================
import type { GovCommentAnchor } from '../types';

// How many characters of surrounding context to capture as prefix/suffix.
export const ANCHOR_CONTEXT = 40;

// ── pure matching core (no DOM) ─────────────────────────────────────────────

// Collapse every run of whitespace to a single space and trim — used to make the
// quote tolerant of the whitespace differences between two renderings of the
// same prose (Markdown emits different line breaks than the canvas HTML).
export function normalizeQuote(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Like normalizeQuote but WITHOUT trimming — prefix/suffix context is compared at
// the boundary adjacent to the quote, so the boundary space must be preserved
// (trimming it would misalign disambiguation of repeated quotes).
function normalizeContext(s: string): string {
  return (s || '').replace(/\s+/g, ' ');
}

// Build a whitespace-collapsed copy of `raw` together with a map from each
// normalized character index back to its index in `raw` (so a match found in the
// normalized text can be mapped back onto the original DOM text offsets).
function normalizeWithMap(raw: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) { norm += ' '; map.push(i); prevSpace = true; }
    } else {
      norm += ch; map.push(i); prevSpace = false;
    }
  }
  return { norm, map };
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// Locate the anchor's quote inside `text` and return the raw [start, end) offsets,
// or null when the quote can't be found. Whitespace-insensitive; repeated quotes
// are disambiguated by how well the surrounding text matches the stored
// prefix/suffix. PURE — exported for unit tests.
export function locateQuoteInText(text: string, anchor: GovCommentAnchor): { start: number; end: number } | null {
  const nQuote = normalizeQuote(anchor.quote);
  if (!nQuote) return null;
  const { norm, map } = normalizeWithMap(text);

  // Collect every occurrence of the quote in the normalized haystack.
  const occ: number[] = [];
  for (let from = 0, idx = 0; (idx = norm.indexOf(nQuote, from)) !== -1; from = idx + 1) occ.push(idx);
  if (!occ.length) return null;

  let best = occ[0];
  if (occ.length > 1) {
    const nPrefix = normalizeContext(anchor.prefix || '');
    const nSuffix = normalizeContext(anchor.suffix || '');
    let bestScore = -1;
    for (const o of occ) {
      const before = norm.slice(Math.max(0, o - nPrefix.length), o);
      const after = norm.slice(o + nQuote.length, o + nQuote.length + nSuffix.length);
      const score = commonSuffixLen(before, nPrefix) + commonPrefixLen(after, nSuffix);
      if (score > bestScore) { bestScore = score; best = o; }
    }
  }

  const normStart = best;
  const normEnd = best + nQuote.length;        // exclusive (in normalized space)
  const rawStart = map[normStart];
  // map[normEnd-1] is the raw index of the quote's last char; +1 → exclusive end.
  const rawEnd = normEnd - 1 < map.length ? map[normEnd - 1] + 1 : text.length;
  if (rawStart == null || rawEnd == null || rawEnd <= rawStart) return null;
  return { start: rawStart, end: rawEnd };
}

// ── DOM glue ────────────────────────────────────────────────────────────────

interface NodeSpan { node: Text; start: number; end: number; }

// Flatten every visible text node under `root` into one string plus a map back to
// the contributing text nodes (offsets into the flat string).
function collectText(root: Node): { text: string; spans: NodeSpan[] } {
  const doc = root.ownerDocument || (root as Document);
  const spans: NodeSpan[] = [];
  let text = '';
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = (n as Text).parentElement;
      if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode() as Text | null;
  while (node) {
    const s = node.data;
    if (s) { spans.push({ node, start: text.length, end: text.length + s.length }); text += s; }
    node = walker.nextNode() as Text | null;
  }
  return { text, spans };
}

// The raw flat-text offset of a (container, offset) DOM boundary inside `root`.
function rawOffsetOf(spans: NodeSpan[], container: Node, offset: number): number {
  if (container.nodeType === 3 /* Text */) {
    const sp = spans.find(s => s.node === container);
    return sp ? sp.start + Math.min(offset, (container as Text).data.length) : 0;
  }
  // Element boundary: just before childNodes[offset]. Use the first text node at
  // or after that child (an approximation that's only used for prefix/suffix
  // context, which merely disambiguates repeated quotes).
  const el = container as Element;
  const ref = el.childNodes[offset] || null;
  if (!ref) return spans.length ? spans[spans.length - 1].end : 0;
  for (const sp of spans) {
    if (ref === sp.node || (ref.nodeType === 1 && (ref as Element).contains(sp.node))) return sp.start;
  }
  return 0;
}

// Build an anchor from the current selection within `root`. Returns null when
// there's no usable (non-collapsed, in-root) selection.
export function anchorFromSelection(root: HTMLElement, sectionId?: string): GovCommentAnchor | null {
  const win = root.ownerDocument?.defaultView;
  const sel = win?.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const quote = sel.toString().trim();
  if (quote.length < 2) return null;

  const { text, spans } = collectText(root);
  const startOff = rawOffsetOf(spans, range.startContainer, range.startOffset);
  const endOff = rawOffsetOf(spans, range.endContainer, range.endOffset);
  const lo = Math.min(startOff, endOff);
  const hi = Math.max(startOff, endOff);
  const prefix = text.slice(Math.max(0, lo - ANCHOR_CONTEXT), lo);
  const suffix = text.slice(hi, hi + ANCHOR_CONTEXT);
  return {
    quote,
    ...(prefix.trim() ? { prefix } : {}),
    ...(suffix.trim() ? { suffix } : {}),
    ...(sectionId ? { sectionId } : {}),
  };
}

// Re-locate an anchor's quote as a DOM Range inside `root`, or null when absent.
export function findAnchorRange(root: HTMLElement, anchor: GovCommentAnchor): Range | null {
  const { text, spans } = collectText(root);
  const hit = locateQuoteInText(text, anchor);
  if (!hit) return null;
  const doc = root.ownerDocument;
  if (!doc) return null;
  let startNode: Text | null = null, startLocal = 0, endNode: Text | null = null, endLocal = 0;
  for (const sp of spans) {
    if (!startNode && hit.start >= sp.start && hit.start < sp.end) { startNode = sp.node; startLocal = hit.start - sp.start; }
    if (hit.end > sp.start && hit.end <= sp.end) { endNode = sp.node; endLocal = hit.end - sp.start; }
  }
  if (!startNode || !endNode) return null;
  try {
    const r = doc.createRange();
    r.setStart(startNode, startLocal);
    r.setEnd(endNode, endLocal);
    return r;
  } catch { return null; }
}

// Wrap one text node's [a, b) slice in a <mark> for comment `id`.
function wrapTextSlice(doc: Document, tn: Text, a: number, b: number, id: string, implemented: boolean): void {
  a = Math.max(0, a); b = Math.min(tn.data.length, b);
  if (b <= a) return;
  let target: Text = tn;
  if (a > 0) target = target.splitText(a);
  if (b - a < target.data.length) target.splitText(b - a);
  const mark = doc.createElement('mark');
  mark.className = 'cmt-hl' + (implemented ? ' cmt-hl-done' : '');
  mark.setAttribute('data-cmt-id', id);
  const parent = target.parentNode;
  if (!parent) return;
  parent.replaceChild(mark, target);
  mark.appendChild(target);
}

// Unwrap every comment highlight we previously injected under `root`, restoring
// the original text nodes (normalize() merges the split fragments back, keeping
// any React-owned text node reference intact).
export function clearHighlights(root: HTMLElement): void {
  root.querySelectorAll('mark.cmt-hl').forEach(m => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  try { root.normalize(); } catch { /* noop */ }
}

export interface AnchoredComment { id: string; anchor?: GovCommentAnchor; status?: 'open' | 'implemented'; }

// Highlight every anchored comment inside `root`. Idempotent — clears any prior
// highlights first. Returns the ids that were successfully located, in order.
export function highlightComments(root: HTMLElement, comments: AnchoredComment[]): string[] {
  const doc = root.ownerDocument;
  if (!doc) return [];
  clearHighlights(root);
  const matched: string[] = [];
  for (const c of comments) {
    if (!c.anchor?.quote) continue;
    // Re-flatten each pass: a previous comment's <mark> wrappers don't change the
    // flat text, so offsets stay valid; collecting fresh keeps the node refs live.
    const { text, spans } = collectText(root);
    const hit = locateQuoteInText(text, c.anchor);
    if (!hit) continue;
    // Snapshot the intersecting text-node slices BEFORE mutating (each text node
    // is distinct, so wrapping one doesn't shift another's local offsets).
    const targets: { node: Text; a: number; b: number }[] = [];
    for (const sp of spans) {
      if (sp.end <= hit.start || sp.start >= hit.end) continue;
      targets.push({ node: sp.node, a: Math.max(hit.start, sp.start) - sp.start, b: Math.min(hit.end, sp.end) - sp.start });
    }
    if (!targets.length) continue;
    for (const tgt of targets) wrapTextSlice(doc, tgt.node, tgt.a, tgt.b, c.id, c.status === 'implemented');
    matched.push(c.id);
  }
  return matched;
}

// Scroll the first highlight for `id` into view inside `root`'s document and
// return the element (so the caller can flash it). No-op when not found.
export function scrollToComment(root: HTMLElement, id: string): HTMLElement | null {
  const el = root.querySelector(`mark.cmt-hl[data-cmt-id="${id}"]`) as HTMLElement | null;
  if (!el) return null;
  try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { el.scrollIntoView(); }
  return el;
}
