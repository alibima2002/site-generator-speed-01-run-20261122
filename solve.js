// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Re-implements the reference pipeline exactly (same outputs byte for byte)
// with: run-based inline Markdown scanning (no per-char escape calls),
// direct block rendering without token objects, cached slugify with an
// ASCII fast path, a scanning front-matter parser, and templates compiled
// to JS functions. All caches are created inside run() — nothing is kept
// from one case to the next.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Manual scan: on the short strings this escapes, a charCode loop beats
// String.replace with a callback (no regex machinery, and the common
// no-specials case returns the input untouched, unallocated).
function escapeHtml(s) {
  let out = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let e = null;
    if (c === 38) e = '&amp;';
    else if (c === 60) e = '&lt;';
    else if (c === 62) e = '&gt;';
    else if (c === 34) e = '&quot;';
    else if (c === 39) e = '&#39;';
    if (e !== null) {
      if (out === null) out = s.slice(0, i);
      else out += s.slice(last, i);
      out += e;
      last = i + 1;
    }
  }
  if (out === null) return s;
  if (last < s.length) out += s.slice(last);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  // date is a validated YYYY-MM-DD string.
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const MARK_RE = /\p{M}/gu;
const SLUG_MAX = 64;
function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}
// ASCII fast path: NFKD is the identity on ASCII and ASCII holds no marks.
function slugifyAscii(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmString(raw, key) {
  if (raw.charCodeAt(0) === 34) {
    // quoted
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: `key "${key}": a quoted string is not closed` };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: `key "${key}": a quoted string holds an escape other than \\" or \\` };
        out += n;
        i++;
      } else if (c === '"') return { error: `key "${key}": a quoted string holds a stray quote` };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return fmString(raw, key);
    case 'date': {
      // YYYY-MM-DD, real day 1970-01-01..2099-12-31
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k];
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Parse front matter of `lines` (already \n-split). Returns {data, bodyStart}
// or {error}.
function parseFrontMatter(lines) {
  if (lines.length === 0 || lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue; // blank or '#...'
    // key: value — key is [a-z_]+, then ':', then end or ' ' + value
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    // drop trailing spaces/tabs of the value
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const ESC_PAIR_RE = /\\[\\`*_\[\]()#+\-.!>]|(\*\*)/g;
const ESC_BRACKET_RE = /\\[\\`*_\[\]()#+\-.!>]|(\])/g;
const STAR_RUN_RE = /\\[\\`*_\[\]()#+\-.!>]|(\*+)/g;

// Escape-pair matcher for the find* helpers: a backslash before an escapable
// char (the same ESCAPABLE set), or the construct being sought.
/** First index >= from where `]` occurs outside a backslash escape, or -1. */
function findUnescaped(s, from) {
  ESC_BRACKET_RE.lastIndex = from;
  let m;
  while ((m = ESC_BRACKET_RE.exec(s)) !== null) {
    if (m[1] !== undefined) return m.index;
  }
  return -1;
}

/** First index >= from where `**` occurs outside a backslash escape, or -1. */
function findStrongClose(s, from) {
  ESC_PAIR_RE.lastIndex = from;
  let m;
  while ((m = ESC_PAIR_RE.exec(s)) !== null) {
    if (m[1] !== undefined) return m.index;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  STAR_RUN_RE.lastIndex = from;
  let m;
  while ((m = STAR_RUN_RE.exec(s)) !== null) {
    if (m[1] === undefined) continue; // an escape pair: skipped
    // A run of L stars, scanned from its first star in steps of 2, yields
    // its last star when L is odd, and none when L is even.
    if (m[1].length % 2 === 1) return m.index + m[1].length - 1;
  }
  return -1;
}

const INLINE_RE = new RegExp('[\\\\`*"\\[&<>"\']', 'g');
const WS_RE = /\s/;

/** `s` rendered inline; `link(target)` resolves a link target. Runs of plain
 *  text (no special char) are copied verbatim — they need no escaping.
 *  The scan regex is shared; inline() recurses, so its lastIndex is saved
 *  on entry and restored on exit. */
function inline(s, link) {
  const re = INLINE_RE;
  const saved = re.lastIndex;
  re.lastIndex = 0;
  const out = [];
  let i = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (j > i) out.push(s.slice(i, j));
    if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        out.push(ESC_MAP[s[j + 1]] ?? s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findStrongClose(s, j + 2);
        if (k > j + 2) {
          out.push('<strong>', inline(s.slice(j + 2, k), link), '</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>', inline(s.slice(j + 1, k), link), '</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, j + 1);
      const n = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = n === -1 ? '' : s.slice(k + 2, n);
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="', escapeHtml(link(target)), '">', inline(s.slice(j + 1, k), link), '</a>');
        i = n + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    } else {
      // one of & < > " '
      out.push(ESC_MAP[c]);
      i = j + 1;
    }
    re.lastIndex = i;
  }
  if (i < s.length) out.push(s.slice(i));
  re.lastIndex = saved;
  return out.join('');
}

// ---- block-level scanning helpers (mirror the reference regexes exactly)

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// Fence open: ``` + lang [A-Za-z0-9_+-]* + spaces/tabs only. Returns lang or null.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading: 1-6 '#', >=1 space/tab, then text (trailing spaces/tabs dropped).
// Returns {depth, text} or null (empty text is not a heading).
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let b = line.length;
  while (b > n + 1) {
    const d = line.charCodeAt(b - 1);
    if (d === 32 || d === 9) b--;
    else break;
  }
  const text = line.slice(n + 1, b);
  if (text === '') return null;
  return { depth: n, text };
}

function isHr(line) {
  const dash = line.startsWith('---');
  const star = line.startsWith('***');
  if (!dash && !star) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  // A paragraph ends at a blank line, a fence, a heading or a thematic
  // break; dispatch on the first character instead of running all four
  // checks (a line opening on anything else cannot be any of them).
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (line === '') return true;
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** Render the body lines (lines[bodyStart..]) to {html, toc, excerpt}. */
function renderMarkdown(lines, bodyStart, link, slugify) {
  const out = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  const n = lines.length;
  let i = bodyStart;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      out.push('<pre><code', lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`, '>');
      while (i < n && !isFenceClose(lines[i])) { out.push(escapeHtml(lines[i]), '\n'); i++; }
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, link);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.startsWith('> ') ? l.slice(2) : l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      out.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    // list?
    let ordered = false;
    let start = 1;
    let firstText = null;
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) { firstText = line.slice(2); }
    else if (c0 >= 48 && c0 <= 57) {
      // digits then '. '
      let d = 0;
      while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true;
        start = Number(line.slice(0, d));
        firstText = line.slice(d + 2);
      }
    }
    if (firstText !== null) {
      const items = [];
      let cur = [trimLine(firstText)];
      i++;
      while (i < n) {
        const l = lines[i];
        let m = null;
        let isOrd = false;
        if (ordered) {
          const d0 = l.charCodeAt(0);
          if (d0 >= 48 && d0 <= 57) {
            let d = 0;
            while (d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
            if (d >= 1 && d <= 9 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) { isOrd = true; m = l.slice(d + 2); }
          }
        } else {
          const b0 = l.charCodeAt(0);
          if ((b0 === 45 || b0 === 42) && l.charCodeAt(1) === 32) m = l.slice(2);
        }
        if (m !== null || isOrd) {
          items.push(cur.join('\n'));
          cur = [trimLine(m)];
          i++;
        } else if (l.length >= 2 && l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32) {
          // CONTINUED: /^ {2,}\S/ — two or more spaces then a non-whitespace char
          let s = 0;
          while (s < l.length && l.charCodeAt(s) === 32) s++;
          const cc = s < l.length ? l.charCodeAt(s) : 32;
          const isWs = cc === 32 || cc === 9 || cc === 11 || cc === 12 || (cc > 127 && /\s/.test(l[s]));
          if (s >= 2 && !isWs) { cur.push(trimLine(l)); i++; }
          else break;
        } else break;
      }
      items.push(cur.join('\n'));
      const tag = ordered ? 'ol' : 'ul';
      out.push(ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (let k = 0; k < items.length; k++) { out.push('<li>', inline(items[k], link), '</li>\n'); }
      out.push(`</${tag}>\n`);
      continue;
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// Count words (runs of non-whitespace) in lines[bodyStart..], without joining.
function wordsInLines(lines, bodyStart) {
  let count = 0;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    let inWord = false;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c === 32 || c === 9) { inWord = false; continue; }
      if (c > 127) {
        if (/\s/.test(line[k])) inWord = false;
        else if (!inWord) { inWord = true; count++; }
        continue;
      }
      if (c === 11 || c === 12) { inWord = false; continue; }
      if (!inWord) { inWord = true; count++; }
    }
  }
  return count;
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// ---- template code generation
// Compiled fn signature: fn(S, R, O, C, D) — S: scope stack (array of vars
// objects, innermost last), R: root vars (null-prototype), O: output array,
// C: {T: Map name->fn, E: escapeHtml}, D: include depth.
// A path's first name resolves, innermost first: a loop variable bound in
// this template (static env), else the runtime scope stack, else R.

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Runtime lookup of a path whose first name is not a static loop variable:
// walk the scope stack top-down, then the root vars, then own properties.
function lk(S, R, p0, rest) {
  let v;
  let found = false;
  for (let k = S.length - 1; k >= 0; k--) {
    if (Object.hasOwn(S[k], p0)) { v = S[k][p0]; found = true; break; }
  }
  if (!found) {
    if (Object.hasOwn(R, p0)) v = R[p0];
    else return undefined;
  }
  for (let k = 0; k < rest.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, rest[k])) return undefined;
    v = v[rest[k]];
  }
  return v;
}

// Segment access on a statically known base: own property or undefined.
function gv(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}

let __uid = 0;

// Generate JS source for a path lookup, given the static env (name -> JS
// variable holding the value). Returns an expression string.
function genPath(path, env) {
  const first = path[0];
  let expr;
  if (Object.hasOwn(env, first)) expr = env[first];
  else if (path.length === 1) return `lk(S,R,${JSON.stringify(first)},[])`;
  else return `lk(S,R,${JSON.stringify(first)},${JSON.stringify(path.slice(1))})`;
  for (let k = 1; k < path.length; k++) expr = `gv(${expr},${JSON.stringify(path[k])})`;
  return expr;
}

function genNodes(nodes, env, out) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push(`O.push(${JSON.stringify(n.text)});`);
    } else if (n.kind === 'var') {
      const id = __uid++;
      out.push(`{const _v${id}=${genPath(n.path, env)};O.push(C.E(typeof _v${id}==='string'?_v${id}:textOf(_v${id})));}`);
    } else if (n.kind === 'raw') {
      const id = __uid++;
      out.push(`{const _v${id}=${genPath(n.path, env)};O.push(typeof _v${id}==='string'?_v${id}:textOf(_v${id}));}`);
    } else if (n.kind === 'if') {
      const cond = `truthy(${genPath(n.path, env)})`;
      out.push(`if(${n.not ? `!(${cond})` : cond}){`);
      genNodes(n.then, env, out);
      out.push('}');
      if (n.else !== null) {
        out.push('else{');
        genNodes(n.else, env, out);
        out.push('}');
      }
    } else if (n.kind === 'for') {
      const id = __uid++;
      const xs = `_x${id}`;
      const k = `_k${id}`;
      const el = `_e${id}`;
      const lp = `_l${id}`;
      const sc = `_s${id}`;
      // The scope object is only observable through an {% include %} in the
      // body (an included template looks its free names up on the stack);
      // every other name in the body resolves statically or via the root
      // vars, so a body with no include skips the push entirely. The loop
      // object is built only when the body reads it (or an include may).
      const pushScope = subtreeHasInclude(n.body);
      const needLp = pushScope || bodyUsesLoop(n.body);
      out.push(`{const ${xs}=${genPath(n.path, env)};if(Array.isArray(${xs})){for(let ${k}=0;${k}<${xs}.length;${k}++){const ${el}=${xs}[${k}];${needLp ? `const ${lp}={index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length};` : ''}${pushScope ? `const ${sc}={[${JSON.stringify(n.name)}]:${el},loop:${lp}};S.push(${sc});` : ''}`);
      const env2 = { ...env, [n.name]: el };
      if (needLp) env2.loop = lp;
      genNodes(n.body, env2, out);
      out.push(`${pushScope ? 'S.pop();' : ''}}}}`);
    } else if (n.kind === 'include') {
      out.push(`{let _t=C.T.get(${JSON.stringify(n.name)});if(_t===undefined)_t=C.G(${JSON.stringify(n.name)});if(_t!==undefined&&D<${INCLUDE_DEPTH})O.push(_t(S,R,C,D+1,textOf,truthy,lk,gv));}`);
    }
  }
}

/** Whether any node in the subtree (inclusive) is an include. */
function subtreeHasInclude(nodes) {
  for (const n of nodes) {
    if (n.kind === 'include') return true;
    if (n.kind === 'for' && subtreeHasInclude(n.body)) return true;
    if (n.kind === 'if' && (subtreeHasInclude(n.then) || (n.else !== null && subtreeHasInclude(n.else)))) return true;
  }
  return false;
}

/**
 * Whether the subtree reads the enclosing for's `loop` (a path whose first
 * name is `loop`, or an include, which may read it from the scope stack).
 * A nested for rebinds `loop`, so its body is not walked: references there
 * read the inner loop, never this one. A nested for's own path is read in
 * this scope, so it is checked.
 */
function bodyUsesLoop(nodes) {
  for (const n of nodes) {
    if (n.kind === 'include') return true;
    if (n.path !== undefined && n.path[0] === 'loop') return true;
    if (n.kind === 'if') {
      if (bodyUsesLoop(n.then)) return true;
      if (n.else !== null && bodyUsesLoop(n.else)) return true;
    }
  }
  return false;
}

function compileTemplate(nodes) {
  __uid = 0;
  const src = [];
  genNodes(nodes, {}, src);
  // new Function bodies see only globals, so the helpers ride in as params.
  // The compiled function builds its output with += and returns it, so no
  // wrapper layer and no output array are needed at the call site.
  // eslint-disable-next-line no-new-func
  return new Function('S', 'R', 'C', 'D', 'textOf', 'truthy', 'lk', 'gv', `const O=[];\n${src.join('\n')}\nreturn O.join('');`);
}

// ---------------------------------------------------------------- pipeline

const RESERVED = ['posts', 'tags', 'page'];

function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function wordsInBody(lines, bodyStart) {
  return wordsInLines(lines, bodyStart);
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  // Per-case caches (nothing survives to the next case).
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      let ascii = true;
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 127) { ascii = false; break; }
      }
      v = ascii ? slugifyAscii(text) : slugifyRaw(text);
      slugCache.set(text, v);
    }
    return v;
  };

  const base = input.site.base_url.replace(/\/+$/, '');

  // 2. Templates, parsed in code-unit order of name. Compilation is lazy:
  // a template is compiled only when first rendered (unused fillers and
  // layouts are never compiled). Parse errors are still reported for all.
  const asts = new Map();
  const compiled = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      asts.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const getFn = (name) => {
    let fn = compiled.get(name);
    if (fn === undefined && asts.has(name)) {
      fn = compileTemplate(asts.get(name));
      compiled.set(name, fn);
    }
    return fn;
  };

  // 1. Sources, sorted by path in code-unit order.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const lines = f.content.split(/\r\n?|\n/);
      sources.push({ path: f.path, lines });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter + refusals, in source order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!asts.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      // A scheme ([A-Za-z][A-Za-z0-9+.-]*:), or a target opening on / or #,
      // is kept as written. (Manual scan: most targets have no ':' at all.)
      const c0 = target.charCodeAt(0);
      if (c0 === 47 || c0 === 35) return target; // '/' or '#'
      const colon = target.indexOf(':');
      if (colon > 0) {
        const f = target.charCodeAt(0);
        if ((f >= 65 && f <= 90) || (f >= 97 && f <= 122)) {
          let scheme = true;
          for (let q = 1; q < colon; q++) {
            const d = target.charCodeAt(q);
            if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 43 || d === 45 || d === 46)) { scheme = false; break; }
          }
          if (scheme) return target;
        }
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards / pages.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  const cardOf = (s) => {
    // reading_minutes is needed twice for a post (its card, then its page);
    // count the body's words once.
    if (s.readingMinutes === undefined) s.readingMinutes = Math.max(1, Math.ceil(wordsInBody(s.lines, s.bodyStart) / 200));
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s.readingMinutes,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  };
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // 7. Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { T: compiled, G: getFn, E: escapeHtml };
  // One root-vars object and one output array, reused across renders: the
  // four per-render names are (re)assigned each time, so a stale value can
  // never leak into a render that does not set it (undefined reads the same
  // as absent: lookup returns undefined either way).
  const R = Object.assign(Object.create(null), { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined });
  const S = []; // scope stack: empty at every render's start and end
  const render = (name, vars) => {
    const fn = getFn(name);
    if (fn === undefined) return null;
    R.page = vars.page;
    R.posts = vars.posts;
    R.pager = vars.pager;
    R.tag = vars.tag;
    return fn(S, R, ctx, 0, textOf, truthy, lk, gv);
  };
  for (const s of sources) {
    const html = render(s.layout, { page: pageOf(s) });
    if (html !== null) output[`${s.outDir}/index.html`] = html;
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const nPages = sources.filter((s) => !s.post).length;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
