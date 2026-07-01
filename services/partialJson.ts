// Lenient extractor for a POSSIBLY-INCOMPLETE JSON string produced by a
// streaming model. Pulls whatever top-level fields are available *so far* —
// including a string value whose closing quote hasn't arrived yet — so the UI
// can render a live preview of the diagnostic as it is being written. Pure and
// synchronous; never throws. Fields not yet present are simply omitted.
//
// This is best-effort ONLY (for the streaming preview). The authoritative
// report is always parsed with a real JSON.parse once the stream completes.

// Escape a field name so it is safe to embed in a RegExp (names are simple
// identifiers today, but callers may pass anything).
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// JSON-unescape a captured raw string body. Handles the common escapes plus
// \uXXXX. Tolerant of an incomplete trailing escape (mid-stream) — a lone `\`
// or a truncated `\u12` at the end is dropped rather than corrupting output.
function jsonUnescape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = s[i + 1];
    if (next === undefined) break; // trailing backslash still streaming — drop
    switch (next) {
      case 'n': out += '\n'; i++; break;
      case 't': out += '\t'; i++; break;
      case 'r': out += '\r'; i++; break;
      case 'b': out += '\b'; i++; break;
      case 'f': out += '\f'; i++; break;
      case '/': out += '/'; i++; break;
      case '"': out += '"'; i++; break;
      case '\\': out += '\\'; i++; break;
      case 'u': {
        const hex = s.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          i = s.length; // incomplete \uXXXX mid-stream — stop, drop the partial
        }
        break;
      }
      default: out += next; i++; break;
    }
  }
  return out;
}

// Index just after the `"field"\s*:` for a top-level key, or -1 if not found.
function keyValueStart(text: string, field: string): number {
  const re = new RegExp('"' + escapeRegex(field) + '"\\s*:');
  const m = re.exec(text);
  return m ? m.index + m[0].length : -1;
}

// Read a (possibly still-streaming) string value for `field`. Returns the
// JSON-unescaped value read up to the first UNescaped closing quote OR the end
// of the buffer. Returns null when the value/opening quote hasn't arrived yet.
function extractPartialString(text: string, field: string): string | null {
  const start = keyValueStart(text, field);
  if (start === -1) return null;
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return null;   // value not started yet
  if (text[i] !== '"') return null;    // not a string value / quote not here yet
  i++;                                 // past the opening quote
  let raw = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      // Preserve the escape sequence verbatim; jsonUnescape decodes it below.
      raw += ch;
      i++;
      if (i < text.length) { raw += text[i]; i++; }
      continue;
    }
    if (ch === '"') break; // unescaped closing quote → value complete
    raw += ch;
    i++;
  }
  return jsonUnescape(raw);
}

// Read a numeric value for `field`, but only once the token is fully written
// (a delimiter follows it) so a mid-stream digit sequence isn't truncated.
function extractNumber(text: string, field: string): number | null {
  const re = new RegExp('"' + escapeRegex(field) + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)(?=[\\s,}\\]])');
  const m = re.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Scan a possibly-incomplete JSON string for the requested top-level fields and
 * return whatever is available so far. String fields may be mid-stream (their
 * closing quote hasn't arrived); number fields are returned only when fully
 * written. Fields not yet present are omitted from the result.
 */
export function extractPartialFields(
  text: string,
  stringFields: string[],
  numberFields: string[],
): { [k: string]: string | number } {
  const out: { [k: string]: string | number } = {};
  for (const f of stringFields) {
    const v = extractPartialString(text, f);
    if (v != null) out[f] = v;
  }
  for (const f of numberFields) {
    const v = extractNumber(text, f);
    if (v != null) out[f] = v;
  }
  return out;
}
