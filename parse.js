// parse.js — dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
// Written from scratch to match marked 18.1.3 (default options) byte for byte.
// Stateless per call: no cache, no memo, no I/O. Single export: parse(markdown).

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// ---------- escaping ----------

// Escape &, <, >, ", ' — but leave &-sequences that look like a character
// reference alone (&name; / &#123; / &#x1f; with sane digit limits).
// This is the "encode=false" mode: what marked emits for text and attributes.
function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      // entity-like? &#digits; (1-7), &#xhex; (1-6), or &alnum+;
      if (isEntityLike(s, i)) continue;
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    out += s.slice(start, i) + rep;
    start = i + 1;
  }
  return start === 0 ? s : out + s.slice(start);
}

// True when s[i] === '&' and the characters after it form a reference-looking
// sequence: &# + 1..7 decimal digits + ';' | &#x/#X + 1..6 hex + ';' | alnum+ + ';'
function isEntityLike(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n && s.charCodeAt(j) === 35) { // #
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x|X
      j++;
      const st = j;
      while (j < n && isHex(s.charCodeAt(j))) j++;
      const len = j - st;
      return len >= 1 && len <= 6 && j < n && s.charCodeAt(j) === 59;
    }
    const st = j;
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    const len = j - st;
    return len >= 1 && len <= 7 && j < n && s.charCodeAt(j) === 59;
  }
  const st = j;
  while (j < n && isAlnum(s.charCodeAt(j))) j++;
  return j > st && j < n && s.charCodeAt(j) === 59;
}

function isHex(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Escape everything, including &: used for code spans, code blocks, fenced
// info strings and anything that must never look like a reference.
function escFull(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    out += s.slice(start, i) + rep;
    start = i + 1;
  }
  return start === 0 ? s : out + s.slice(start);
}

// marked's cleanUrl: encodeURI, then restore %25 -> %. Throws on lone
// surrogates; callers treat a null result as "link does not render".
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Decode a numeric character reference starting at s[i] === '&'.
// Returns [codePoint, endIndex] or null when it is not a valid numeric ref.
function numericEntity(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n || s.charCodeAt(j) !== 35) return null;
  j++;
  let hex = false;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
  const st = j;
  if (hex) { while (j < n && isHex(s.charCodeAt(j))) j++; }
  else { while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++; }
  const len = j - st;
  if (len < 1 || (hex ? len > 6 : len > 7)) return null;
  if (j >= n || s.charCodeAt(j) !== 59) return null;
  const digits = s.slice(st, j);
  let cp = hex ? parseInt(digits, 16) : parseInt(digits, 10);
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
  return [cp, j + 1];
}

// ---------- small char predicates ----------

function isSpace(c) { return c === 32 || c === 9; } // space or tab
function isSpaceOrNl(c) { return c === 32 || c === 9 || c === 10; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isUnicodeSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
    c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}
// Approximation of Unicode punctuation (general categories P and S) for
// emphasis flanking rules. Covers the punctuation that shows up in practice.
function isUnicodePunct(c) {
  if (isAsciiPunct(c)) return true;
  if (c < 0xA0) return false;
  return (c >= 0xA1 && c <= 0xBF) || c === 0xD7 || c === 0xF7 ||
    (c >= 0x2010 && c <= 0x2027) || (c >= 0x2030 && c <= 0x205E) ||
    (c >= 0x2070 && c <= 0x2071) || c === 0x2074 || c === 0x2075 ||
    (c >= 0x207A && c <= 0x207E) || (c >= 0x2080 && c <= 0x208E) ||
    (c >= 0x20A0 && c <= 0x20BF) || (c >= 0x2100 && c <= 0x214F) ||
    (c >= 0x2190 && c <= 0x2BFF) || (c >= 0x3001 && c <= 0x303F) ||
    (c >= 0xFE10 && c <= 0xFE1F) || (c >= 0xFE30 && c <= 0xFE6F) ||
    (c >= 0xFF01 && c <= 0xFF0F) || (c >= 0xFF1A && c <= 0xFF20) ||
    (c >= 0xFF3B && c <= 0xFF40) || (c >= 0xFF5B && c <= 0xFF65);
}

// Column width of the leading whitespace of a line, tabs advancing to the
// next multiple of 4. Returns [columns, firstNonSpaceIndex].
function indentOf(line) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return [col, i];
}

// Remove `cols` columns from the start of a line, consuming ANY characters
// (markers included, not just whitespace) and expanding a straddling tab.
// Used to strip a blockquote marker or a list marker + its following space.
function stripColumns(line, cols) {
  let col = 0, i = 0;
  const n = line.length;
  while (i < n && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > cols) {
        return ' '.repeat(col + w - cols) + expandLeadingTabs(line.slice(i + 1), col + w);
      }
      col += w; i++;
    } else {
      col++; i++;
    }
  }
  return expandLeadingTabs(line.slice(i), col);
}

// Expand leading tabs/spaces in s to spaces, starting at column startCol.
// Only the leading whitespace run is touched; the rest is verbatim.
function expandLeadingTabs(s, startCol) {
  let j = 0, c = startCol, out = '';
  while (j < s.length) {
    const ch = s.charCodeAt(j);
    if (ch === 9) {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w; j++;
    } else if (ch === 32) {
      out += ' ';
      c++; j++;
    } else break;
  }
  return out + s.slice(j);
}

// Remove `cols` columns of indentation from the start of a line, expanding a
// tab that straddles the boundary into spaces. Used for indented code and
// list item content. Any leading tabs left after the strip are expanded to
// spaces based on their column (tabs are column-sensitive: a tab after a
// blockquote/list marker expands from the marker's column, not from 0).
function stripIndent(line, cols) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > cols) {
        // tab straddles: the remaining part becomes spaces, then expand any
        // further leading tabs from the column the tab ends at
        return ' '.repeat(col + w - cols) + expandLeadingTabs(line.slice(i + 1), col + w);
      }
      col += w; i++;
    } else break;
  }
  return expandLeadingTabs(line.slice(i), col);
}

// Remove up to `cols` columns of indentation from the start of a line. A
// tab straddling the boundary is dropped entirely (marked does not expand
// the remainder to spaces: a content line starting with a tab under a
// fence opener indented 1-3 loses the whole tab). Anything past the strip
// is left verbatim (tabs included). Used for fenced code content.
function stripCols(line, cols) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > cols) return line.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return line.slice(i);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Split source into lines; \r\n and \r are line endings, normalized away.
function splitLines(src) {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.charCodeAt(l.length - 1) === 13) lines[i] = l.slice(0, -1);
  }
  return lines;
}

// ---------- inline parsing ----------

// Reference map: normalized label -> {dest, title}
function normalizeLabel(label) {
  // collapse internal whitespace (including newlines) to single spaces,
  // strip leading/trailing whitespace, Unicode case-fold
  return caseFold(label.replace(/[\s]+/g, ' ').trim());
}

// Unicode case folding (CommonMark: labels match case-insensitively).
// toLowerCase covers most cases; the extras below are the folds where
// lowercasing alone differs from folding: sharp s, final sigma, ligatures.
function caseFold(s) {
  return s.toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ς/g, 'σ')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// True when the label (raw, before normalization) contains an unescaped '['.
// Link labels may not contain unescaped brackets, so such a label can never
// match a definition.
function labelHasRawBracket(label) {
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === 91) return true;
  }
  return false;
}

// Extended autolink: email (loose, marked's flavor). Applied at a local-part
// start; the lookahead stops a match whose domain would end in - or _.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@(?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?![A-Za-z0-9_-])/;
// Same as EMAIL_RE without the trailing lookahead: used to recover the full
// email when the lookahead truncated it at a '_' that is an emphasis closer
// (marked tokenizes an emphasis span's inner text separately, so the email
// there is not followed by the closer at all).
const EMAIL_RE_NOLOOK = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@(?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?/;
// Strict email for <...> autolinks (CommonMark labels start/end alnum).
const EMAIL_STRICT_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;
// Autolink <scheme:...>: scheme is 2..32 chars, first a letter.
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;

// Chars that may end an extended autolink URL by trimming.
function isTrimPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
    c === 42 || c === 95 || c === 126 || c === 39 || c === 34;
}

// Match an extended URL (www. / http:// / https:// / ftp://) starting at j.
// Returns the end index (exclusive) of the link text, or -1.
function matchExtendedUrl(src, j) {
  const n = src.length;
  let p = j;
  if (src.startsWith('www.', j)) p = j + 4;
  else {
    const rest = src.slice(j, j + 8).toLowerCase();
    if (rest.startsWith('http://')) p = j + 7;
    else if (rest.startsWith('https://')) p = j + 8;
    else if (rest.startsWith('ftp://')) p = j + 6;
    else return -1;
  }
  // maximal run: no whitespace, <, > or control chars
  let end = p;
  while (end < n) {
    const c = src.charCodeAt(end);
    if (c <= 32 || c === 60 || c === 62 || c === 127) break;
    end++;
  }
  if (end === p) return -1; // nothing after the prefix
  let m = end;
  // truncate at the first '(' with no ')' after it in the run
  for (let k = p; k < m; k++) {
    if (src.charCodeAt(k) === 40) { // (
      let hasClose = false;
      for (let q = k + 1; q < m; q++) if (src.charCodeAt(q) === 41) { hasClose = true; break; }
      if (!hasClose) { m = k; break; }
    }
  }
  if (m === p) return -1;
  // Trim a trailing entity-like &word; (gfm-627), trailing punctuation, and
  // trailing ')' by balance rules — in ONE loop until stable, because
  // removing a ')' can expose punctuation that must also go, and vice versa
  // (e.g. "https://x.com/a).)" -> "https://x.com/a").
  for (;;) {
    if (m > p && src.charCodeAt(m - 1) === 59) { // ;
      let k = m - 2;
      while (k >= p && isAlnum(src.charCodeAt(k))) k--;
      if (k >= p && src.charCodeAt(k) === 38 && k + 1 < m - 1) { m = k; continue; }
    }
    if (m > p && isTrimPunct(src.charCodeAt(m - 1))) { m--; continue; }
    if (m > p && src.charCodeAt(m - 1) === 41) { // )
      // reduce a trailing run of ')' to at most one (marked never keeps
      // two trailing parens, even when both are matched)
      if (m >= 2 && src.charCodeAt(m - 2) === 41) { m--; continue; }
      // a single trailing ')': keep it only when it closes an unmatched
      // '(' earlier in the URL. Depth scan: an unmatched ')' never drops
      // the depth below 0, so a ')' in the middle (e.g. the one in
      // "...page=4)](./docs/create.md)") does not count against the final
      // one, which does have a matching '('.
      let depth = 0;
      for (let k = j; k < m - 1; k++) {
        const c = src.charCodeAt(k);
        if (c === 40) depth++;
        else if (c === 41 && depth > 0) depth--;
      }
      if (depth === 0) { m--; continue; }
    }
    break;
  }
  return m === p ? -1 : m;
}

// Match an email starting at i (local-part start). Returns end index or -1.
// Handles optional mailto:/xmpp: prefix (only when not preceded by alnum)
// and the single-segment path for xmpp:.
function matchEmail(src, i, textStart) {
  const sub = src.slice(i);
  const m = EMAIL_RE.exec(sub);
  if (!m) return -1;
  let start = i;
  let end = i + m[0].length;
  // prefix: mailto: / xmpp: immediately before the local part
  if (i - 7 >= 0 && src.slice(i - 7, i) === 'mailto:' && !isAlnumBefore(src, i - 7)) {
    start = i - 7;
  } else if (i - 5 >= 0 && src.slice(i - 5, i) === 'xmpp:' && !isAlnumBefore(src, i - 5)) {
    start = i - 5;
    // optional single path segment /seg (labels of [A-Za-z0-9@] joined by .)
    if (src.charCodeAt(end) === 47) { // /
      let q = end + 1;
      const segStart = q;
      while (q < src.length) {
        const c = src.charCodeAt(q);
        if (isAlnum(c) || c === 64) { q++; continue; } // alnum or @
        if (c === 46) { // . needs a label char after it
          if (q + 1 < src.length && (isAlnum(src.charCodeAt(q + 1)) || src.charCodeAt(q + 1) === 64)) { q++; continue; }
        }
        break;
      }
      if (q > segStart) end = q;
    }
  }
  return start === i ? { start, end, prefixed: false } : { start, end, prefixed: true };
}

function isAlnumBefore(src, pos) {
  if (pos <= 0) return false;
  const c = src.charCodeAt(pos - 1);
  if (isAlnum(c)) return true;
  // a non-ASCII letter/digit also blocks the prefix
  if (c >= 128 && !isUnicodeSpace(c) && !isUnicodePunct(c)) return true;
  return false;
}

// Scan back from an '@' at position atPos to the start of the email local
// part (chars [A-Za-z0-9._+-]). Returns the start index.
function emailLocalStart(src, atPos) {
  let i = atPos - 1;
  while (i >= 0) {
    const c = src.charCodeAt(i);
    if (isAlnum(c) || c === 46 || c === 45 || c === 95 || c === 43) i--;
    else break;
  }
  return i + 1;
}

// Match an autolink (<scheme:...> / <email>) or an HTML tag starting at
// src[i] === '<'. Returns the end index (exclusive) or -1. Used while
// scanning a link's text: a '<' that starts a tag/autolink is skipped as
// one unit (so a ']' inside it does not close the link text).
function scanAngle(src, i) {
  const n = src.length;
  const sm = SCHEME_RE.exec(src.slice(i + 1));
  if (sm) {
    let q = i + 1 + sm[0].length;
    while (q < n) {
      const d = src.charCodeAt(q);
      if (d === 62) return q + 1;
      if (d <= 32 || d === 60 || d === 127) break;
      q++;
    }
  }
  const em = EMAIL_STRICT_RE.exec(src.slice(i + 1));
  if (em) {
    const q = i + 1 + em[0].length;
    if (q < n && src.charCodeAt(q) === 62) return q + 1;
  }
  return matchHtmlTag(src, i);
}

// Find the index of the ']' matching the '[' at start (balanced brackets,
// code spans and backslash escapes skipped). -1 when none.
function findLinkTextEnd(src, start) {
  const n = src.length;
  let depth = 1;
  let i = start + 1;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // backslash escape
    if (c === 96) { // backtick run: skip a code span
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const len = j - i;
      const close = findCodeClose(src, j, len);
      if (close === -1) {
        // no exact-length closer: pair with the next backtick run of any
        // length (mismatched lengths are literal text, e.g. ``url`); if
        // there is no backtick at all before the ']', the code span is
        // unclosed and swallows the ']' — the link does not form
        let k = j;
        while (k < n && src.charCodeAt(k) !== 96 && src.charCodeAt(k) !== 93) k++;
        if (k >= n || src.charCodeAt(k) !== 96) return -1;
        while (k < n && src.charCodeAt(k) === 96) k++;
        i = k;
        continue;
      }
      // marked quirk: a code span opened by 2+ backticks whose content
      // contains a backtick, when followed by any further text before the
      // closing ']' of the link, also breaks the link. Only a code span
      // sitting immediately before that ']' is harmless.
      if (len >= 2) {
        let hasBt = false;
        for (let k = j; k < close - len; k++) if (src.charCodeAt(k) === 96) { hasBt = true; break; }
        if (hasBt && !(depth === 1 && close < n && src.charCodeAt(close) === 93)) return -1;
      }
      i = close;
      continue;
    }
    if (c === 60) { // < that could start a tag or autolink
      const nx = i + 1 < n ? src.charCodeAt(i + 1) : -1;
      if ((nx >= 65 && nx <= 90) || (nx >= 97 && nx <= 122) || nx === 33 || nx === 63 || nx === 47) {
        const end = scanAngle(src, i);
        if (end === -1) return -1; // a failed tag/autolink kills the link
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) depth++;
    else if (c === 93) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Find the end (exclusive) of a closing backtick run of length len starting
// the search at from. -1 when none.
function findCodeClose(src, from, len) {
  const n = src.length;
  let i = from;
  while (i < n) {
    if (src.charCodeAt(i) === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      if (j - i === len) return j;
      i = j;
    } else i++;
  }
  return -1;
}

// Like findCodeClose, but the search stops at the first unescaped `|` (a
// table cell boundary): a code span in a table row cannot cross it. An
// escaped pipe `\|` is skipped (it is not a boundary). -1 when no closer
// appears before the boundary.
function findCodeCloseInCell(src, from, len) {
  const n = src.length;
  let i = from;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92 && i + 1 < n && src.charCodeAt(i + 1) === 124) { i += 2; continue; }
    if (c === 124) return -1;
    if (c === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      if (j - i === len) return j;
      i = j;
    } else i++;
  }
  return -1;
}

// Parse a link destination + optional title starting at i (after the '(' of
// an inline link, or at a reference definition value). src[i] is the first
// char after '('. Returns {dest, title, end} where end is the index just
// past the closing ')', or null. `forRef` relaxes the closing paren rule:
// a reference definition ends at the line end instead.
function parseLinkTarget(src, i, forRef) {
  const n = src.length;
  let p = i;
  // skip spaces/tabs/newlines
  while (p < n && isSpaceOrNl(src.charCodeAt(p))) p++;
  if (p >= n) return null;
  let dest;
  if (src.charCodeAt(p) === 60) { // <...>
    let q = p + 1;
    while (q < n) {
      const c = src.charCodeAt(q);
      if (c === 10 || c === 60) return null;
      if (c === 62) break;
      if (c === 92) q += 2;
      else q++;
    }
    if (q >= n || src.charCodeAt(q) !== 62) return null;
    dest = src.slice(p + 1, q);
    p = q + 1;
  } else if (src.charCodeAt(p) === 41) { // () — an empty destination is valid
    dest = '';
  } else {
    // bare destination: no spaces/controls, balanced parens
    let q = p;
    let depth = 0;
    while (q < n) {
      const c = src.charCodeAt(q);
      if (c <= 32 || c === 127) break;
      if (c === 92) { q += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      q++;
    }
    if (q === p) return null;
    dest = src.slice(p, q);
    p = q;
  }
  // optional title
  let title = null;
  let save = p;
  while (p < n && isSpaceOrNl(src.charCodeAt(p))) p++;
  if (p < n) {
    const c = src.charCodeAt(p);
    if (c === 34 || c === 39 || c === 40) { // " ' (
      const open = c;
      const close = c === 40 ? 41 : c;
      let q = p + 1;
      let ok = false;
      if (open === 40) {
        let depth = 1;
        while (q < n) {
          const ch = src.charCodeAt(q);
          if (ch === 92) { q += 2; continue; }
          if (ch === 40) depth++;
          else if (ch === 41) { depth--; if (depth === 0) { ok = true; break; } }
          q++;
        }
      } else {
        while (q < n) {
          const ch = src.charCodeAt(q);
          if (ch === 92) { q += 2; continue; }
          if (ch === close) { ok = true; break; }
          q++;
        }
      }
      if (ok) {
        title = src.slice(p + 1, q);
        p = q + 1;
      } else {
        p = save; // no title; rewind to after the destination
      }
    }
  }
  if (forRef) {
    // reference definition: only whitespace may follow on the line
    let q = p;
    while (q < n && isSpaceOrNl(src.charCodeAt(q))) q++;
    return { dest, title, end: q };
  }
  while (p < n && isSpaceOrNl(src.charCodeAt(p))) p++;
  if (p >= n || src.charCodeAt(p) !== 41) return null;
  return { dest, title, end: p + 1 };
}

// ---------- inline scanner ----------

// Does the link text contain a link? A link's text must not contain a
// link (an image's text may). Scans for a '[' that forms a link, skipping
// code spans and backslash escapes; a '[' that belongs to an image is not
// itself a link, but a link inside the image's text still blocks.
function textHasLink(text, refs) {
  if (text.indexOf('[') === -1) return false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (c === 96) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const len = j - i;
      const close = findCodeClose(text, j, len);
      if (close === -1) { i = j; continue; }
      i = close;
      continue;
    }
    if (c === 91) {
      if (i > 0 && text.charCodeAt(i - 1) === 33) { // ![...]: an image
        const close = findLinkTextEnd(text, i);
        if (close === -1) { i++; continue; }
        if (textHasLink(text.slice(i + 1, close), refs)) return true;
        // skip past the whole image, including its (dest) or [label]:
        // the label is part of the image, not a standalone link
        let end = close + 1;
        if (end < n && text.charCodeAt(end) === 40) { // (
          const t = parseLinkTarget(text, end + 1, false);
          if (t) end = t.end;
        } else if (end < n && text.charCodeAt(end) === 91) { // [
          const lc = findLinkTextEnd(text, end);
          if (lc !== -1) end = lc + 1;
        }
        i = end;
        continue;
      }
      if (tryLink(text, i, refs, false, false)) return true;
      i++;
      continue;
    }
    i++;
  }
  return false;
}

// Strip HTML tags from inline HTML, but let an <img> contribute its alt
// text (an image's alt is the plain text of its children, and a nested
// image contributes its own alt).
function stripTagsKeepImgAlt(html) {
  return html
    .replace(/<img src="[^"]*" alt="([^"]*)"(?: title="[^"]*")?>/g, (m, a) => a)
    .replace(/<[^>]*>/g, '');
}

// Try to parse a link or image starting at src[i] === '[' (i points at the
// '['; for an image the '!' is at i-1 and isImage is true). Returns
// {html, end} or null. `inLink` disables nested links.
function tryLink(src, i, refs, inLink, isImage) {
  const n = src.length;
  if (inLink && !isImage) return null; // links cannot nest inside links
  const close = findLinkTextEnd(src, i);
  if (close === -1) return null;
  const rawText = src.slice(i + 1, close);
  // a link's text must not contain a link (images may contain links)
  if (!isImage && textHasLink(rawText, refs)) return null;
  let dest = null;
  let title = null;
  let end = close + 1;
  let matched = false;
  if (end < n && src.charCodeAt(end) === 40 && (!inLink || isImage)) { // ( inline
    const t = parseLinkTarget(src, end + 1, false);
    if (t) { dest = t.dest; title = t.title; end = t.end; matched = true; }
    // a failed inline target falls through to the reference forms
  }
  if (!matched && end < n && src.charCodeAt(end) === 91) { // [ full / collapsed ref
    const labelClose = findLinkTextEnd(src, end);
    if (labelClose === -1) {
      // unterminated label: fall through to the shortcut form
    } else {
      const label = labelClose === end + 1 ? rawText : src.slice(end + 1, labelClose);
      const ref = refs.get(normalizeLabel(label));
      if (ref) { dest = ref.dest; title = ref.title; end = labelClose + 1; matched = true; }
      // a well-formed label with no matching reference is not a link at
      // all: it does NOT fall through to the shortcut form (cm-571)
      else return null;
    }
  }
  if (!matched && (!inLink || isImage)) { // shortcut reference
    const ref = refs.get(normalizeLabel(rawText));
    if (ref) { dest = ref.dest; title = ref.title; matched = true; }
  }
  if (!matched) return null;
  const href = cleanUrl(unescape(dest));
  if (href === null) {
    // unrenderable destination: the link collapses to its text
    return { html: inline(rawText, refs, true), end };
  }
  if (isImage) {
    const altHtml = inline(rawText, refs, false);
    const alt = escText(stripTagsKeepImgAlt(altHtml));
    let img = '<img src="' + escText(href) + '" alt="' + alt + '"';
    if (title !== null) img += ' title="' + escText(unescape(title)) + '"';
    return { html: img + '>', end };
  }
  const textHtml = inline(rawText, refs, true);
  let a = '<a href="' + escText(href) + '"';
  if (title !== null) a += ' title="' + escText(unescape(title)) + '"';
  return { html: a + '>' + textHtml + '</a>', end };
}

// Match a complete open or close tag at src[i] === '<'. Returns the end
// index (exclusive) or -1. Attribute names must follow whitespace; a close
// tag takes no attributes. This is the CommonMark open-tag grammar.
function matchOpenCloseTag(src, i) {
  const n = src.length;
  let p = i + 1;
  let closing = false;
  if (src.charCodeAt(p) === 47) { closing = true; p++; }
  if (p >= n) return -1;
  const c0 = src.charCodeAt(p);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  p++;
  while (p < n) {
    const c = src.charCodeAt(p);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) p++;
    else break;
  }
  if (closing) {
    while (p < n && isSpaceOrNl(src.charCodeAt(p))) p++;
    if (p < n && src.charCodeAt(p) === 62) return p + 1;
    return -1;
  }
  // pendingSpace carries the whitespace skipped after a valueless
  // attribute over to the next attribute (that whitespace is the
  // separator, and the loop-top skip would otherwise see none).
  let pendingSpace = false;
  for (;;) {
    let hadSpace = pendingSpace;
    pendingSpace = false;
    while (p < n && isSpaceOrNl(src.charCodeAt(p))) { hadSpace = true; p++; }
    if (p >= n) return -1;
    const c = src.charCodeAt(p);
    if (c === 62) return p + 1;
    if (c === 47) {
      if (p + 1 < n && src.charCodeAt(p + 1) === 62) return p + 2;
      return -1;
    }
    if (!hadSpace) return -1;
    // attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return -1;
    p++;
    while (p < n) {
      const d = src.charCodeAt(p);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) ||
        d === 95 || d === 58 || d === 46 || d === 45) p++;
      else break;
    }
    let spAfterName = false;
    while (p < n && isSpaceOrNl(src.charCodeAt(p))) { spAfterName = true; p++; }
    if (p < n && src.charCodeAt(p) === 61) { // =
      p++;
      while (p < n && isSpaceOrNl(src.charCodeAt(p))) p++;
      if (p >= n) return -1;
      const q = src.charCodeAt(p);
      if (q === 34 || q === 39) { // quoted value
        const end = src.indexOf(String.fromCharCode(q), p + 1);
        if (end === -1) return -1;
        p = end + 1;
      } else { // unquoted value
        const st = p;
        while (p < n) {
          const d = src.charCodeAt(p);
          if (isSpaceOrNl(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          p++;
        }
        if (p === st) return -1;
      }
    } else if (spAfterName) {
      pendingSpace = true; // valueless attribute: the space was its separator
    }
  }
}

// Match an inline HTML tag / comment / PI / declaration / CDATA at src[i]
// === '<'. Returns the end index (exclusive) or -1.
function matchHtmlTag(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    if (src.startsWith('<!-->', i)) return i + 5;
    if (src.startsWith('<!--->', i)) return i + 6;
    const end = src.indexOf('-->', i + 4);
    return end === -1 ? -1 : end + 3;
  }
  if (src.startsWith('<?', i)) {
    const end = src.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const end = src.indexOf(']]>', i + 9);
    return end === -1 ? -1 : end + 3;
  }
  if (src.startsWith('<!', i)) {
    const c = src.charCodeAt(i + 2);
    if (c >= 65 && c <= 90) { // <!A-Z declaration
      const end = src.indexOf('>', i + 2);
      return end === -1 ? -1 : end + 1;
    }
    return -1;
  }
  // open or close tag
  return matchOpenCloseTag(src, i);
}

// Flanking for a delimiter run in src: run spans [start, end).
// Returns [canOpen, canClose] for '*'/'~' style delimiters.
function flanking(src, start, end) {
  const n = src.length;
  const before = start === 0 ? -1 : src.charCodeAt(start - 1);
  const after = end >= n ? -1 : src.charCodeAt(end);
  const beforeWS = before === -1 || isUnicodeSpace(before);
  const afterWS = after === -1 || isUnicodeSpace(after);
  const beforePunct = before !== -1 && isUnicodePunct(before);
  const afterPunct = after !== -1 && isUnicodePunct(after);
  const leftFlanking = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const rightFlanking = !beforeWS && (!beforePunct || afterWS || afterPunct);
  return [leftFlanking, rightFlanking];
}

// Is the '_' run at src[i..j) plain text because it lies inside a valid
// email address and cannot pair with another '_' to form emphasis?
// (gfm-632/633: a.b-c_d@a.b — the '_' is intraword, and a live opener like
// _a@b.c also cannot pair and must stay text, or the email's scan-back is
// cut off at the delimiter. A '_' that CAN pair forms emphasis instead
// and the email does not form, e.g. _foo_@bar.com.)
function underscoreIsEmailText(src, i, j, open, close) {
  const n = src.length;
  let start = i;
  while (start > 0) {
    const c = src.charCodeAt(start - 1);
    if (isAlnum(c) || c === 46 || c === 45 || c === 95 || c === 43) start--;
    else break;
  }
  let k = j;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (isAlnum(c) || c === 46 || c === 45 || c === 95 || c === 43) k++;
    else break;
  }
  if (k >= n || src.charCodeAt(k) !== 64) return false; // no @ ahead
  const m = EMAIL_RE.exec(src.slice(start));
  if (!m) return false;
  const emailEnd = start + m[0].length;
  if (emailEnd <= i) return false;
  // forward: this '_' as an opener pairing with a later '_' closer
  if (open) {
    for (let q = j; q < emailEnd; q++) {
      if (src.charCodeAt(q) !== 95) continue;
      let r = q;
      while (r < emailEnd && src.charCodeAt(r) === 95) r++;
      const [lf, rf] = flanking(src, q, r);
      const cl = rf && (!lf || (r < n && isUnicodePunct(src.charCodeAt(r))));
      if (cl) return false;
      q = r - 1;
    }
  }
  // backward: this '_' as a closer pairing with an earlier '_' opener
  if (close) {
    for (let q = i - 1; q >= start; q--) {
      if (src.charCodeAt(q) !== 95) continue;
      let r = q;
      while (r > start && src.charCodeAt(r - 1) === 95) r--;
      const [lf, rf] = flanking(src, r, q + 1);
      const op = lf && (!rf || (r > 0 && isUnicodePunct(src.charCodeAt(r - 1))));
      if (op) return false;
      q = r;
    }
  }
  return true;
}

// The inline parser: src -> HTML. refs is the document's reference map.
function inline(src, refs, inLink) {
  const n = src.length;
  const parts = [];
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) parts.push(escText(src.slice(textStart, end)));
    textStart = end;
  };
  const pushDelim = (ch, start, end, open, close) => {
    parts.push({ t: 'd', ch, n: end - start, open, close });
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    // --- www. / http:// / https:// / ftp:// extended autolinks ---
    // Extended autolinks do not form inside a link's text (a <...> autolink
    // still may). A scheme autolink forms after any preceding character; a
    // www. autolink needs whitespace or ([*_~ before it (or a run start).
    const isWww = c === 119 && src.startsWith('www.', i);
    const isScheme = ((c === 104 || c === 72) && (src.slice(i, i + 7).toLowerCase() === 'http://' || src.slice(i, i + 8).toLowerCase() === 'https://')) ||
      ((c === 102 || c === 70) && src.slice(i, i + 6).toLowerCase() === 'ftp://');
    if ((isWww || isScheme) && !inLink) {
      let prevOk;
      if (isScheme) {
        prevOk = true;
      } else {
        const atRunStart = i === textStart;
        prevOk = atRunStart || i === 0 ||
          isUnicodeSpace(src.charCodeAt(i - 1)) || src.charCodeAt(i - 1) === 40 ||
          src.charCodeAt(i - 1) === 91 || src.charCodeAt(i - 1) === 42 ||
          src.charCodeAt(i - 1) === 126 || src.charCodeAt(i - 1) === 95;
      }
      if (prevOk) {
        const end = matchExtendedUrl(src, i);
        if (end !== -1) {
          const text = src.slice(i, end);
          const href = src.startsWith('www.', i) ? 'http://' + text : text;
          flushText(i);
          parts.push('<a href="' + escText(cleanUrl(href) || '') + '">' + escText(text) + '</a>');
          i = end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    // --- email extended autolink, triggered by @ (not inside a link) ---
    if (c === 64 && !inLink) { // @
      const localStart = Math.max(emailLocalStart(src, i), textStart);
      if (localStart < i) {
        let m = matchEmail(src, localStart, textStart);
        // If the lookahead truncated the email at a '_' run that closes an
        // open '_' emphasis span, the full email still links (marked
        // tokenizes the span's inner text separately, without the closer).
        if (m !== -1) {
          const rm = EMAIL_RE_NOLOOK.exec(src.slice(localStart));
          if (rm && localStart + rm[0].length > m.end &&
              localStart + rm[0].length < n && src.charCodeAt(localStart + rm[0].length) === 95) {
            let hasUndOpen = false;
            for (let q = 0; q < parts.length; q++) {
              const p = parts[q];
              if (typeof p === 'object' && p.t === 'd' && p.ch === '_' && p.open && p.n > 0) { hasUndOpen = true; break; }
            }
            if (hasUndOpen) m = { start: m.start, end: localStart + rm[0].length, prefixed: m.prefixed };
          }
        }
        if (m !== -1) {
          const text = src.slice(m.start, m.end);
          const href = m.prefixed ? text : 'mailto:' + text;
          flushText(m.start);
          parts.push('<a href="' + escText(cleanUrl(href) || '') + '">' + escText(text) + '</a>');
          i = m.end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 92) { // backslash
      if (i + 1 < n && src.charCodeAt(i + 1) === 10) { // hard break
        flushText(i);
        parts.push('<br>');
        i += 2;
        // a hard break strips the next line's leading spaces/tabs
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(src.charCodeAt(i + 1))) {
        // escaped punctuation: the backslash is removed, the char is literal
        // (and always escaped if it is & < > " ' -- an escaped & is not a
        // named-entity start, unlike a literal & in the source)
        flushText(i);
        parts.push(escText(src[i + 1]));
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) { // backtick run: code span
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const len = j - i;
      const close = findCodeClose(src, j, len);
      if (close !== -1) {
        let content = src.slice(j, close - len);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 &&
          content.trim() !== '') {
          content = content.slice(1, -1);
        }
        flushText(i);
        parts.push('<code>' + escFull(content) + '</code>');
        i = close;
        textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) { // ![
      const r = tryLink(src, i + 1, refs, inLink, true);
      if (r) {
        flushText(i);
        parts.push(r.html);
        i = r.end;
        textStart = i;
        continue;
      }
      i++; // literal '!'; the '[' is handled next round
      continue;
    }
    if (c === 91 && !inLink) { // [ link
      const r = tryLink(src, i, refs, inLink, false);
      if (r) {
        flushText(i);
        parts.push(r.html);
        i = r.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 60) { // < autolink or HTML tag
      let handled = false;
      // <scheme:...> or <email>
      const sm = SCHEME_RE.exec(src.slice(i + 1));
      if (sm) {
        let q = i + 1 + sm[0].length;
        while (q < n) {
          const d = src.charCodeAt(q);
          if (d === 62) break;
          if (d <= 32 || d === 60 || d === 127) { q = -1; break; }
          q++;
        }
        if (q !== -1 && q < n) {
          const text = src.slice(i + 1, q);
          const href = cleanUrl(text);
          if (href !== null) {
            flushText(i);
            parts.push('<a href="' + escText(href) + '">' + escText(text) + '</a>');
            i = q + 1;
            textStart = i;
            handled = true;
          }
        }
      }
      if (!handled) {
        const em = EMAIL_STRICT_RE.exec(src.slice(i + 1));
        if (em) {
          const q = i + 1 + em[0].length;
          if (q < n && src.charCodeAt(q) === 62) {
            const text = em[0];
            flushText(i);
            parts.push('<a href="' + escText('mailto:' + text) + '">' + escText(text) + '</a>');
            i = q + 1;
            textStart = i;
            handled = true;
          }
        }
      }
      if (!handled) {
        const tagEnd = matchHtmlTag(src, i);
        if (tagEnd !== -1) {
          flushText(i);
          parts.push(src.slice(i, tagEnd));
          i = tagEnd;
          textStart = i;
          handled = true;
        }
      }
      if (handled) continue;
      i++;
      continue;
    }
    if (c === 38) { // & numeric entity
      const ent = numericEntity(src, i);
      if (ent) {
        flushText(i);
        parts.push(escText(String.fromCodePoint(ent[0])));
        i = ent[1];
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      if (c === 126 && j - i > 2) { i = j; continue; } // ~ runs of 3+ are text
      const [leftF, rightF] = flanking(src, i, j);
      let open, close;
      if (c === 95) { // _
        open = leftF && (!rightF || (i > 0 && isUnicodePunct(src.charCodeAt(i - 1))));
        close = rightF && (!leftF || (j < n && isUnicodePunct(src.charCodeAt(j))));
      } else {
        open = leftF;
        close = rightF;
      }
      // a delimiter that can neither open nor close is plain text
      if (!open && !close) { i = j; continue; }
      // a '_' inside an email address that cannot pair with another '_'
      // is plain text, so the email's scan-back is not cut off
      if (c === 95 && underscoreIsEmailText(src, i, j, open, close)) { i = j; continue; }
      flushText(i);
      pushDelim(c === 42 ? '*' : c === 95 ? '_' : '~', i, j, open, close);
      i = j;
      textStart = i;
      continue;
    }
    if (c === 10) { // newline: hard break if preceded by 2+ spaces
      if (i >= 2 && src.charCodeAt(i - 1) === 32 && src.charCodeAt(i - 2) === 32 &&
        i - 2 >= textStart) {
        let k = i - 1;
        while (k >= textStart && src.charCodeAt(k) === 32) k--;
        flushText(k + 1);
        parts.push('<br>');
        i++;
        // a hard break strips the next line's leading spaces/tabs
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flushText(n);
  resolveEmphasis(parts);
  return partsToString(parts);
}

// Convert the parts array (strings, delimiter objects, wrapper nodes) to a
// single HTML string. Unused delimiters render as literal characters.
function partsToString(parts) {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') out += p;
    else if (p.t === 'd') out += p.ch.repeat(p.n);
    else out += '<' + p.tag + '>' + partsToString(p.children) + '</' + p.tag + '>';
  }
  return out;
}

// Is there a later delimiter in parts (after `closer`) that could close
// `opener` on its own (same char, can close, length >= opener's length)?
// Used by R1b so a shorter closer does not steal a longer opener that has
// its own longer closer coming up.
function hasLaterCloser(parts, closer, opener) {
  const ci = parts.indexOf(closer);
  for (let j = ci + 1; j < parts.length; j++) {
    const p = parts[j];
    if (typeof p === 'object' && p.t === 'd' && p.ch === opener.ch && p.close && p.n >= opener.n) return true;
  }
  return false;
}

// CommonMark Appendix A emphasis resolution over the parts array.
function resolveEmphasis(parts) {
  const openers = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (typeof part !== 'object' || part.t !== 'd') { i++; continue; }
    const closer = part;
    let lastNode = null;
    if (closer.close) {
      // try to match this closer against the most recent eligible opener
      while (closer.n > 0) {
        let oi = -1;
        for (let s = openers.length - 1; s >= 0; s--) {
          const o = openers[s];
          if (o.ch !== closer.ch || o.n === 0) continue;
          if (closer.ch === '~') {
            // strikethrough: opener and closer must have equal length (1 or 2)
            if (o.n !== closer.n) continue;
          } else if (closer.n < o.n && hasLaterCloser(parts, closer, o)) {
            // R1b: a shorter closer must not steal from a longer opener
            // when a later closer of at least the opener's length exists
            // (e.g. in `**a *b*c* d**` the lone `*` stays literal and the
            // `**` opener pairs with its own `**` closer; but in `**foo*`
            // with no later `**` closer, the lone `*` may pair with it).
            continue;
          } else if ((o.open && o.close) || (closer.open && closer.close)) {
            // odd-match rule: when either delimiter can both open and close,
            // the sum of the runs must not be a multiple of 3 unless both are
            const sum = o.n + closer.n;
            if (sum % 3 === 0 && !(o.n % 3 === 0 && closer.n % 3 === 0)) continue;
          }
          oi = s;
          break;
        }
        if (oi === -1) break;
        const opener = openers[oi];
        const k = closer.ch === '~' ? closer.n :
          (opener.n >= 2 && closer.n >= 2 ? 2 : 1);
        const tag = closer.ch === '~' ? 'del' : (k === 2 ? 'strong' : 'em');
        const oiIdx = parts.indexOf(opener);
        const ciIdx = parts.indexOf(closer);
        const children = parts.slice(oiIdx + 1, ciIdx);
        const node = { t: 'w', tag, children };
        lastNode = node;
        opener.n -= k;
        closer.n -= k;
        const replacement = [];
        if (opener.n > 0) replacement.push(opener);
        replacement.push(node);
        if (closer.n > 0) replacement.push(closer);
        parts.splice(oiIdx, ciIdx - oiIdx + 1, ...replacement);
        // drop openers that are now inside the wrapper node
        for (let s = openers.length - 1; s >= 0; s--) {
          if (!parts.includes(openers[s])) openers.splice(s, 1);
        }
        if (k === 2 && closer.ch !== '~' && closer.open && closer.close && opener.open && !opener.close && closer.n === 0) {
          // R2: a closer that can both open and close, matching an opener
          // that can only open to form a STRONG and fully consumed, blocks
          // the nearest enclosing single delimiter opener of the SAME
          // character (`*`/`_` of length 1) from forming emphasis later
          // (e.g. `*a **b**c*` stays literal outside the strong, while
          // `*a**b**c*`, `*a **b** c*`, `*a *b*c*`, `_a **b**c_`,
          // `*a __b__c*` and `*a **b***` still form the outer emphasis).
          for (let s = openers.length - 1; s >= 0; s--) {
            if (openers[s] !== opener && openers[s].ch === closer.ch && openers[s].n === 1) { openers.splice(s, 1); break; }
          }
        }
        if (closer.n === 0) break;
        // continue the while loop to try another opener with this closer
      }
    }
    if (closer.open && closer.n > 0) {
      if (!openers.includes(closer)) openers.push(closer);
    }
    if (lastNode) {
      // resume just past the outermost wrapper (or past the leftover closer)
      const ni = parts.indexOf(lastNode);
      i = closer.n > 0 ? parts.indexOf(closer) + 1 : ni + 1;
    } else {
      i++;
    }
  }
}

// ---------- block parsing ----------

// Resolve backslash escapes (\ + ASCII punctuation -> the punctuation).
// Used for link destinations/titles and fenced-code info strings.
function unescape(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

// ATX heading: 1-6 '#' followed by space/tab or EOL. Returns {level, src}.
function matchATX(line, idx) {
  if (line.charCodeAt(idx) !== 35) return null;
  let p = idx, level = 0;
  while (p < line.length && line.charCodeAt(p) === 35 && level < 6) { level++; p++; }
  if (level === 0) return null;
  if (p < line.length) {
    const c = line.charCodeAt(p);
    if (c !== 32 && c !== 9) return null;
    p++;
  }
  let content = line.slice(p).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(content)) content = '';
  else content = content.replace(/[ \t]+#+$/, '');
  return { level, src: content };
}

// Fenced code: 3+ backticks or tildes. Returns {ch, len, info}.
function matchFence(line, idx) {
  const c = line.charCodeAt(idx);
  if (c !== 96 && c !== 126) return null;
  let p = idx, len = 0;
  while (p < line.length && line.charCodeAt(p) === c) { len++; p++; }
  if (len < 3) return null;
  const info = line.slice(p);
  if (c === 96 && info.indexOf('`') !== -1) return null;
  const first = info.replace(/^[ \t]+/, '').split(/[ \t]/)[0];
  return { ch: c, len, info: first ? unescape(first) : '' };
}

// Thematic break: 3+ of the same char (-, _, *) with only spaces between.
function matchThematicBreak(line, idx) {
  const c = line.charCodeAt(idx);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let p = idx, count = 0;
  while (p < line.length) {
    const ch = line.charCodeAt(p);
    if (ch === c) { count++; p++; }
    else if (ch === 32 || ch === 9) p++;
    else return false;
  }
  return count >= 3;
}

// Setext underline: a run of only '=' (level 1) or only '-' (level 2),
// with only trailing spaces/tabs after it. '= =' and '--- -' are not
// underlines (the latter is a thematic break).
function matchSetext(line, idx) {
  const c = line.charCodeAt(idx);
  if (c !== 61 && c !== 45) return null;
  let p = idx, count = 0;
  while (p < line.length && line.charCodeAt(p) === c) { count++; p++; }
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  if (p < line.length || count === 0) return null;
  return c === 61 ? 1 : 2;
}

// HTML block start. Types (CommonMark numbering, shifted by one here):
// 0 = <pre|<script|<style|<textarea (ends at the matching close tag),
// 1 = <!-- comment, 2 = <? processing instruction, 3 = <!A-Z declaration,
// 4 = <![CDATA[, 5 = block-level tag, 6 = any other complete tag alone on
// the line (type 7 in CommonMark: it never interrupts a paragraph).
// Returns {type, endTag} or null. endTag is the close-tag name for type 0.
function matchHtmlBlockStart(line, idx) {
  if (line.charCodeAt(idx) !== 60) return null;
  if (line.startsWith('<!--', idx)) return { type: 1 };
  if (line.startsWith('<?', idx)) return { type: 2 };
  if (line.startsWith('<![CDATA[', idx)) return { type: 4 };
  if (line.startsWith('<!', idx)) {
    const c = line.charCodeAt(idx + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return { type: 3 };
    return null;
  }
  let p = idx + 1;
  const closing = line.charCodeAt(p) === 47;
  if (closing) p++;
  const c0 = line.charCodeAt(p);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  const ns = p;
  p++;
  while (p < line.length) {
    const c = line.charCodeAt(p);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) p++;
    else break;
  }
  const name = line.slice(ns, p).toLowerCase();
  const after = p < line.length ? line.charCodeAt(p) : 10;
  const slashClose = after === 47 && p + 1 < line.length && line.charCodeAt(p + 1) === 62;
  // pre/script/style/textarea open tags: the block runs to the close tag
  if (!closing && (name === 'pre' || name === 'script' || name === 'style' || name === 'textarea')) {
    if (after === 32 || after === 9 || after === 10 || after === 62 || slashClose) {
      return { type: 0, endTag: name };
    }
    return null;
  }
  if (BLOCK_TAGS.has(name)) {
    if (after === 32 || after === 9 || after === 10 || after === 62 || slashClose) return { type: 5 };
    return null;
  }
  // any other tag: it must be a complete tag and alone on the line
  if (after === 32 || after === 9 || after === 62 || slashClose) {
    const tagEnd = matchOpenCloseTag(line, idx);
    if (tagEnd !== -1) {
      let r = tagEnd;
      while (r < line.length && (line.charCodeAt(r) === 32 || line.charCodeAt(r) === 9)) r++;
      if (r === line.length) return { type: 6 };
    }
  }
  return null;
}

// Blockquote marker: '>' plus one optional space. Returns index after the
// marker, or -1.
function matchBlockquote(line, idx) {
  if (line.charCodeAt(idx) !== 62) return -1;
  let p = idx + 1;
  if (p < line.length && line.charCodeAt(p) === 32) p++;
  return p;
}

// List item marker. col is the indent column of idx. Returns
// {ordered, bullet, start, contentStart, contentIndent} or null.
function matchListItem(line, idx, col) {
  const c = line.charCodeAt(idx);
  let ordered = false, bullet = '', start = 1, markerLen = 0, markerEndIdx = 0;
  if (c === 45 || c === 43 || c === 42) {
    ordered = false; bullet = line[idx]; markerLen = 1; markerEndIdx = idx + 1;
  } else if (c >= 48 && c <= 57) {
    let p = idx, num = 0, digits = 0;
    while (p < line.length && line.charCodeAt(p) >= 48 && line.charCodeAt(p) <= 57) {
      if (digits >= 9) return null;
      num = num * 10 + (line.charCodeAt(p) - 48);
      digits++; p++;
    }
    if (digits === 0) return null;
    const d = line.charCodeAt(p);
    if (d !== 46 && d !== 41) return null;
    ordered = true; bullet = d === 46 ? '.' : ')'; start = num; markerLen = digits + 1; markerEndIdx = p + 1;
  } else return null;
  let p = markerEndIdx, spaces = 0;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) {
    if (line.charCodeAt(p) === 32) spaces++;
    else spaces += 4 - ((col + markerLen + spaces) % 4);
    p++;
  }
  if (p >= line.length) {
    return { ordered, bullet, start, contentStart: p, contentIndent: col + markerLen + 1 };
  }
  if (spaces === 0) return null;
  if (spaces >= 5) {
    return { ordered, bullet, start, contentStart: markerEndIdx + 1, contentIndent: col + markerLen + 1 };
  }
  return { ordered, bullet, start, contentStart: p, contentIndent: col + markerLen + spaces };
}

// Table delimiter row: cells of the form :? -+ :? separated by '|'. Returns
// the aligns array ('left'|'center'|'right'|null) or null.
function matchTableDelimiter(line, idx) {
  const cells = splitTableRow(line.slice(idx));
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^[ \t]*(:?)-+(:?)[ \t]*$/.exec(cell);
    if (!m) return null;
    aligns.push(m[1] && m[2] ? 'center' : m[1] ? 'left' : m[2] ? 'right' : null);
  }
  return aligns;
}

// Split a table row on unescaped '|' (outside code spans). Leading/trailing
// '|' drop the empty edge cell. Cells are trimmed of spaces/tabs.
function splitTableRow(line) {
  const trimmed = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  const cells = [];
  let cur = '';
  let i = 0;
  const n = trimmed.length;
  while (i < n) {
    const c = trimmed.charCodeAt(i);
    if (c === 92 && i + 1 < n && trimmed.charCodeAt(i + 1) === 124) {
      cur += '\\|';
      i += 2;
      continue;
    }
    if (c === 96) {
      let j = i;
      while (j < n && trimmed.charCodeAt(j) === 96) j++;
      const len = j - i;
      // A code span may not cross a cell boundary: the closer must appear
      // before the next unescaped `|`. If it does not, the backticks are
      // literal and the `|` splits the cell (e.g. `` ``add` | `a | b` ``:
      // the `` `` `` opener has no 2-backtick closer in its cell, and the
      // single backtick after `add` must not pair with the one before `a`).
      const close = findCodeCloseInCell(trimmed, j, len);
      if (close === -1) { cur += trimmed.slice(i, j); i = j; continue; }
      // an escaped pipe inside a code span is still an escaped pipe:
      // the table resolves \| to | before the cell is parsed inline
      cur += trimmed.slice(i, close).replace(/\\\|/g, '|');
      i = close;
      continue;
    }
    if (c === 124) {
      cells.push(cur.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));
      cur = '';
      i++;
      continue;
    }
    cur += trimmed[i];
    i++;
  }
  cells.push(cur.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));
  if (trimmed.charCodeAt(0) === 124 && cells.length > 0) cells.shift();
  if (trimmed.charCodeAt(trimmed.length - 1) === 124 && cells.length > 0) cells.pop();
  return cells;
}

// Try to parse a link reference definition starting at lines[j]. Returns
// {label, dest, title, next} (next = index of the line after the def) or null.
// The definition may span lines (label, destination and title can each run
// over several lines) but never a blank line. Title rules, from the spec
// examples: a title on the SAME line as the destination must be well formed
// and end the line, or the whole definition fails; a title on a LATER line
// that is malformed leaves the definition valid without a title; a title
// must be separated from the destination by whitespace.
function tryRefDef(lines, j, hi) {
  const [col, idx] = indentOf(lines[j]);
  if (col > 3) return null;
  // the definition cannot span a blank line: the text ends at the first one
  let end = j;
  while (end < hi && !isBlank(lines[end])) end++;
  const text = lines.slice(j, end).join('\n');
  const n = text.length;
  let p = idx;
  if (text.charCodeAt(p) !== 91) return null;
  const close = findLinkTextEnd(text, p);
  if (close === -1) return null;
  const rawLabel = text.slice(p + 1, close);
  if (rawLabel.length === 0 || rawLabel.length > 999) return null;
  if (labelHasRawBracket(rawLabel)) return null;
  const label = normalizeLabel(rawLabel);
  if (label.length === 0) return null;
  p = close + 1;
  // spaces, tabs and newlines, then ':'
  while (p < n && isSpaceOrNl(text.charCodeAt(p))) p++;
  if (p >= n || text.charCodeAt(p) !== 58) return null;
  p++;
  // spaces, tabs and newlines, then the destination (it may sit on the
  // following line)
  while (p < n && isSpaceOrNl(text.charCodeAt(p))) p++;
  if (p >= n) return null;
  let dest;
  if (text.charCodeAt(p) === 60) { // <...>
    let q = p + 1;
    while (q < n) {
      const c = text.charCodeAt(q);
      if (c === 10 || c === 60) return null;
      if (c === 62) break;
      if (c === 92) q += 2;
      else q++;
    }
    if (q >= n || text.charCodeAt(q) !== 62) return null;
    dest = text.slice(p + 1, q);
    p = q + 1;
  } else {
    let q = p, depth = 0;
    while (q < n) {
      const c = text.charCodeAt(q);
      if (c <= 32 || c === 127) break;
      if (c === 92) { q += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      q++;
    }
    if (q === p) return null;
    dest = text.slice(p, q);
    p = q;
  }
  // the destination ends at p. An optional title may follow on the same line
  // (whitespace-separated) or on a later line.
  let title = null;
  let endPos = p;
  let q = p;
  while (q < n && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9)) q++;
  if (q > p && q < n && (text.charCodeAt(q) === 34 || text.charCodeAt(q) === 39 || text.charCodeAt(q) === 40)) {
    // same-line title: must be well formed and end the line
    const t = scanTitle(text, q);
    if (!t) return null;
    let r = t.end;
    while (r < n && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9)) r++;
    if (r < n && text.charCodeAt(r) !== 10) return null;
    title = t.title;
    endPos = t.end;
  } else if (q < n && text.charCodeAt(q) === 10) {
    // later-line title: the title starts on the following line
    let r = q + 1;
    while (r < n && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9)) r++;
    if (r < n && (text.charCodeAt(r) === 34 || text.charCodeAt(r) === 39 || text.charCodeAt(r) === 40)) {
      const t = scanTitle(text, r);
      if (t) {
        let s = t.end;
        while (s < n && (text.charCodeAt(s) === 32 || text.charCodeAt(s) === 9)) s++;
        if (s >= n || text.charCodeAt(s) === 10) {
          title = t.title;
          endPos = t.end;
        }
      }
      // malformed later-line title: the definition stands without it
    }
  }
  // from endPos, only spaces/tabs may follow on the line
  let r = endPos;
  while (r < n && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9)) r++;
  if (r < n && text.charCodeAt(r) !== 10) return null;
  const consumed = text.slice(0, endPos).split('\n').length;
  return { label, dest, title, next: j + consumed };
}

// Scan a link title starting at text[i] ('"' or "'" or '('). Returns
// {title, end} (end = index just past the closing quote/paren) or null when
// the title never closes. Titles may span lines; '(' titles nest.
function scanTitle(text, i) {
  const n = text.length;
  const open = text.charCodeAt(i);
  const closeCh = open === 40 ? 41 : open;
  let q = i + 1;
  if (open === 40) {
    let depth = 1;
    while (q < n) {
      const ch = text.charCodeAt(q);
      if (ch === 92) { q += 2; continue; }
      if (ch === 40) depth++;
      else if (ch === 41) {
        depth--;
        if (depth === 0) return { title: text.slice(i + 1, q), end: q + 1 };
      }
      q++;
    }
    return null;
  }
  while (q < n) {
    const ch = text.charCodeAt(q);
    if (ch === 92) { q += 2; continue; }
    if (ch === closeCh) return { title: text.slice(i + 1, q), end: q + 1 };
    q++;
  }
  return null;
}

// Parse blocks in lines[lo..hi). Returns an array of block nodes. endsNL
// says whether the source had a newline after its last line; it decides
// whether an HTML block that runs to the end keeps a trailing newline.
// trailingSpaceContinues says a spaces-only line that is the container's
// last line continues a paragraph instead of ending it (true at the top
// level when the source has no trailing newline, and inside a blockquote
// when that last line came from a '>'-prefixed line).
function parseBlocks(lines, lo, hi, refs, endsNL, trailingSpaceContinues, looseOut, inListItem) {
  const blocks = [];
  let i = lo;
  let sawBlank = false;
  let hadBlock = false;
  // Emit a block; a blank line between two direct children marks the
  // container loose (reported through looseOut for list items).
  const emit = (b) => {
    if (sawBlank && hadBlock && looseOut) looseOut.loose = true;
    sawBlank = false;
    hadBlock = true;
    blocks.push(b);
  };
  while (i < hi) {
    const line = lines[i];
    if (isBlank(line)) { sawBlank = true; i++; continue; }
    const [col, idx] = indentOf(line);
    // link reference definitions at the start of a paragraph
    if (col <= 3 && line.charCodeAt(idx) === 91) {
      const d = tryRefDef(lines, i, hi);
      if (d) {
        if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
        // a definition is a block-level element for looseness, even
        // though it renders nothing
        if (sawBlank && hadBlock && looseOut) looseOut.loose = true;
        sawBlank = false;
        hadBlock = true;
        i = d.next;
        continue;
      }
    }
    // indented code
    if (col >= 4) {
      const codeLines = [];
      while (i < hi) {
        const l = lines[i];
        if (isBlank(l)) {
          let k = i + 1;
          while (k < hi && isBlank(lines[k])) k++;
          if (k < hi && indentOf(lines[k])[0] >= 4) {
            // a blank line indented 4+ keeps what is past the 4 columns
            for (let m = i; m < k; m++) {
              const [bc] = indentOf(lines[m]);
              codeLines.push(bc >= 4 ? stripCols(lines[m], 4) : '');
            }
            i = k;
            continue;
          }
          break;
        }
        const [c] = indentOf(l);
        if (c >= 4) { codeLines.push(stripCols(l, 4)); i++; continue; }
        break;
      }
      emit({ t: 'code', text: codeLines.join('\n') + '\n' });
      continue;
    }
    // ATX heading
    const atx = matchATX(line, idx);
    if (atx) { emit({ t: 'heading', level: atx.level, src: atx.src }); i++; continue; }
    // fenced code
    const fence = matchFence(line, idx);
    if (fence) {
      const content = [];
      i++;
      while (i < hi) {
        const l = lines[i];
        const [c2, idx2] = indentOf(l);
        if (c2 <= 3) {
          const fc = l.charCodeAt(idx2);
          if (fc === fence.ch) {
            let p = idx2, len = 0;
            while (p < l.length && l.charCodeAt(p) === fence.ch) { len++; p++; }
            if (len >= fence.len) {
              let ok = true;
              while (p < l.length) {
                if (l.charCodeAt(p) !== 32 && l.charCodeAt(p) !== 9) { ok = false; break; }
                p++;
              }
              if (ok) { i++; break; }
            }
          }
        }
        // fence content: a backtick fence strips up to the opener's indent
        // from content lines; a tilde fence keeps content verbatim (marked
        // treats the two fence kinds differently here)
        content.push(fence.ch === 96 ? stripCols(l, col) : l);
        i++;
      }
      const fenceText = content.join('\n');
      emit({ t: 'fence', info: fence.info, text: fenceText.length > 0 && !fenceText.endsWith('\n') ? fenceText + '\n' : fenceText });
      continue;
    }
    // HTML block
    const hb = matchHtmlBlockStart(line, idx);
    if (hb) {
      const htmlLines = [line];
      i++;
      if (hb.type === 0) {
        // pre/script/style/textarea: ends at the line holding the close tag
        const closer = '</' + hb.endTag;
        if (line.toLowerCase().indexOf(closer) === -1) {
          while (i < hi && lines[i].toLowerCase().indexOf(closer) === -1) { htmlLines.push(lines[i]); i++; }
          if (i < hi) { htmlLines.push(lines[i]); i++; }
        }
      } else if (hb.type === 1 || hb.type === 2 || hb.type === 3 || hb.type === 4) {
        const endMarker = hb.type === 1 ? '-->' : hb.type === 2 ? '?>' : hb.type === 3 ? '>' : ']]>';
        if (line.indexOf(endMarker) === -1) {
          while (i < hi && lines[i].indexOf(endMarker) === -1) { htmlLines.push(lines[i]); i++; }
          if (i < hi) { htmlLines.push(lines[i]); i++; }
        }
      } else {
        // types 5 and 6 run to a blank line
        while (i < hi && !isBlank(lines[i])) { htmlLines.push(lines[i]); i++; }
      }
      let htmlText = htmlLines.join('\n');
      // the block keeps the newline after its last line, unless the next
      // line is exactly empty (a whitespace-only line still leaves it) or
      // it ran to the end of a container whose text has no trailing newline.
      // Exception: types 5/6 end AT a blank line, so the newline after the
      // last content line is not part of the block's output — a
      // whitespace-only terminator must not leave a trailing newline either
      // (e.g. a lone `</details>` line followed by a spaces-only line).
      const blankTerminated = hb.type === 5 || hb.type === 6;
      if (i < hi ? (blankTerminated ? false : lines[i].length > 0) : endsNL) htmlText += '\n';
      emit({ t: 'html', text: htmlText });
      continue;
    }
    // thematic break
    if (matchThematicBreak(line, idx)) { emit({ t: 'hr' }); i++; continue; }
    // blockquote
    if (matchBlockquote(line, idx) !== -1) {
      const q = parseBlockquote(lines, i, hi, refs, inListItem);
      emit({ t: 'quote', children: q.children });
      i = q.next;
      continue;
    }
    // list
    const item = matchListItem(line, idx, col);
    if (item) {
      i = parseList(lines, i, hi, refs, emit, inListItem);
      continue;
    }
    // paragraph
    i = parseParagraph(lines, i, hi, refs, emit, trailingSpaceContinues, inListItem);
  }
  return blocks;
}

// Parse a paragraph starting at lines[i]. Returns the next line index.
// A line of spaces followed by exactly one tab is not blank for table
// purposes: marked renders it as an empty row (a lone trailing tab is not
// a blank line in its table lexer, unlike spaces or multiple tabs).
function isSingleTabLine(line) {
  if (line.length === 0 || line.charCodeAt(line.length - 1) !== 9) return false;
  for (let i = 0; i < line.length - 1; i++) if (line.charCodeAt(i) !== 32) return false;
  return true;
}

function parseParagraph(lines, i, hi, refs, emit, trailingSpaceContinues, inListItem) {
  const paraLines = [lines[i]];
  let j = i + 1;
  while (j < hi) {
    const line = lines[j];
    if (isBlank(line)) {
      // a spaces-only line that is the container's last line continues
      // the paragraph when the container's text has no newline after it
      if (line.length > 0 && j === hi - 1 && trailingSpaceContinues) {
        paraLines.push(line);
        j++;
        continue;
      }
      break;
    }
    const [col, idx] = indentOf(line);
    if (col >= 4) { paraLines.push(line); j++; continue; }
    const se = matchSetext(line, idx);
    if (se) {
      emit({ t: 'heading', level: se, src: paraLines.join('\n').trim() });
      return j + 1;
    }
    if (paraLines.length === 1) {
      const delim = matchTableDelimiter(line, idx);
      if (delim) {
        const headerCells = splitTableRow(paraLines[0]);
        if (headerCells.length === delim.length) {
          const rows = [];
          j++;
          // a row is any non-blank line that does not start a block which
          // interrupts a paragraph (a line without '|' is still a row); a
          // lone trailing tab counts as a row, not a blank line
          while (j < hi && (!isBlank(lines[j]) || isSingleTabLine(lines[j])) && !canInterruptPara(lines, j, inListItem)) { rows.push(splitTableRow(lines[j])); j++; }
          emit({ t: 'table', aligns: delim, header: headerCells, rows });
          return j;
        }
      }
    }
    if (canInterruptPara(lines, j, inListItem)) break;
    paraLines.push(line);
    j++;
  }
  emit({ t: 'para', lines: paraLines });
  return j;
}

// Does the content in `lines` end with an open paragraph? The paragraph
// is open when it is the last block (recursing into quotes and list items)
// and the last line is not blank. Determined by parsing the lines
// collected so far; ref definitions found this way are the container's own
// and are recorded again on the final parse.
function contentEndsWithOpenPara(lines, refs, inListItem) {
  if (lines.length === 0) return false;
  if (isBlank(lines[lines.length - 1])) return false;
  const blocks = parseBlocks(lines, 0, lines.length, refs, false, false, undefined, inListItem);
  return endsWithPara(blocks);
}

function endsWithPara(blocks) {
  if (blocks.length === 0) return false;
  const b = blocks[blocks.length - 1];
  if (b.t === 'para') return true;
  if (b.t === 'quote') return endsWithPara(b.children);
  if (b.t === 'list') {
    if (b.children.length === 0) return false;
    return endsWithPara(b.children[b.children.length - 1].children);
  }
  return false;
}

// Can a single line interrupt a paragraph? ATX, fence, thematic break,
// HTML block types 0-5 and blockquote always can; a list item only when
// it is non-empty and (a bullet, or an ordered item starting at 1 —
// unless the paragraph sits directly inside a list item, where an ordered
// list of any start number interrupts it as a nested list).
function canInterruptParaLine(line, inListItem) {
  const [col, cidx] = indentOf(line);
  if (col >= 4) return false;
  if (matchATX(line, cidx) || matchFence(line, cidx) || matchThematicBreak(line, cidx)) return true;
  const hb = matchHtmlBlockStart(line, cidx);
  if (hb && hb.type <= 5) return true;
  if (matchBlockquote(line, cidx) !== -1) return true;
  const it = matchListItem(line, cidx, col);
  if (it) {
    // an empty item cannot interrupt; an ordered item must start at 1
    if (it.contentStart >= line.length) return false;
    if (it.ordered && it.start !== 1 && !inListItem) return false;
    return true;
  }
  return false;
}

function canInterruptPara(lines, idx, inListItem) {
  return canInterruptParaLine(lines[idx], inListItem);
}

// Parse a blockquote starting at lines[i]. Returns {children, next}.
function parseBlockquote(lines, i, hi, refs, inListItem) {
  const qlines = [];
  let j = i;
  let lastExplicit = false;
  let prevLazy = false;
  // A lazy line that looks like a setext underline or a thematic break
  // stays paragraph text: with a lazy predecessor it is indented 4
  // spaces, otherwise it is merged into the previous line so it is not
  // read as a heading or a break.
  const disguise = (s, sidx) => {
    if (prevLazy) qlines.push('    ' + s.slice(sidx));
    else qlines[qlines.length - 1] += '\n' + s;
    prevLazy = true;
    lastExplicit = false;
  };
  while (j < hi) {
    const line = lines[j];
    if (isBlank(line)) break;
    const [col, idx] = indentOf(line);
    const bq = col <= 3 ? matchBlockquote(line, idx) : -1;
    if (bq !== -1) {
      // columns consumed by the marker: '>' (1) plus the optional space; a
      // tab after '>' counts as the optional space (1 column of the tab)
      let cols = 1;
      if (bq === idx + 2) cols = 2;
      else if (line.charCodeAt(idx + 1) === 9) cols = 2;
      const stripped = stripColumns(line, col + cols);
      qlines.push(stripped);
      lastExplicit = true;
      prevLazy = false;
      j++;
      continue;
    }
    // lazy continuation: only if the quote's content ends with an open
    // paragraph. A line that would start a block ends the quote, except a
    // level-1 setext underline, which stays paragraph text.
    if (contentEndsWithOpenPara(qlines, refs, false)) {
      const [lcol, lidx] = indentOf(line);
      if (lcol <= 3) {
        const se = matchSetext(line, lidx);
        if (se === 1) {
          disguise(line, lidx);
          j++;
          continue;
        }
        if (canInterruptPara(lines, j, inListItem)) break;
        qlines.push(line);
        prevLazy = true;
        lastExplicit = false;
        j++;
        continue;
      }
      // col >= 4: strip 4 columns unless the previous line was lazy
      const s = prevLazy ? line : stripIndent(line, 4);
      const [scol, sidx] = indentOf(s);
      if (scol <= 3 && (matchSetext(s, sidx) || canInterruptParaLine(s, false))) {
        disguise(s, sidx);
        j++;
        continue;
      }
      qlines.push(s);
      prevLazy = true;
      lastExplicit = false;
      j++;
      continue;
    }
    break;
  }
  return { children: parseBlocks(qlines, 0, qlines.length, refs, false, lastExplicit, undefined, false), next: j };
}

// If `lines` end inside an unclosed fenced code block, return the fence
// {ch, len, nested, contentLines}; otherwise null. Used by list collection:
// a fence's content lines belong to the item regardless of their
// indentation — except a fence that sits directly in an ORDERED list item,
// where a line below the content indent ends the item instead. `nested` is
// true when the fence opener sits inside a nested list item (a marker line
// earlier in the item whose content indent the opener meets); a nested fence
// keeps its content lines even in an ordered list. `contentLines` counts the
// lines after the opener: a dedented line ends the item when the fence
// holds no content yet, but stays fence content once it does.
function openFence(lines) {
  let fence = null;
  let nestIndent = null;
  let openerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const [col, idx] = indentOf(line);
    if (col > 3) continue;
    if (!fence) {
      if (isBlank(line)) continue;
      const it = matchListItem(line, idx, col);
      if (it) { nestIndent = it.contentIndent; continue; }
      if (nestIndent !== null && col < nestIndent) nestIndent = null;
      const f = matchFence(line, idx);
      if (f) { fence = { ch: f.ch, len: f.len, nested: nestIndent !== null && col >= nestIndent, openerCol: col }; openerIdx = i; }
    } else {
      const fc = line.charCodeAt(idx);
      if (fc === fence.ch) {
        let p = idx, len = 0;
        while (p < line.length && line.charCodeAt(p) === fence.ch) { len++; p++; }
        if (len >= fence.len) {
          let ok = true;
          while (p < line.length) {
            if (line.charCodeAt(p) !== 32 && line.charCodeAt(p) !== 9) { ok = false; break; }
            p++;
          }
          if (ok) { fence = null; openerIdx = -1; }
        }
      }
    }
  }
  if (fence) fence.contentLines = openerIdx >= 0 ? lines.length - 1 - openerIdx : 0;
  return fence;
}

function parseList(lines, i, hi, refs, emit, inListItem) {
  const [c0, idx0] = indentOf(lines[i]);
  const first = matchListItem(lines[i], idx0, c0);
  const ordered = first.ordered;
  const bullet = first.bullet;
  const items = [];
  let j = i;
  let loose = false;
  let lastContentIndent = first.contentIndent;
  while (j < hi) {
    const line = lines[j];
    if (isBlank(line)) {
      let k = j + 1;
      while (k < hi && isBlank(lines[k])) k++;
      if (k < hi) {
        const [ck, idxk] = indentOf(lines[k]);
        const itk = ck <= 3 ? matchListItem(lines[k], idxk, ck) : null;
        // a sibling item must sit left of the last item's content indent;
        // a marker at/after it is nested content, not a new item
        if (itk && itk.ordered === ordered && itk.bullet === bullet && ck < lastContentIndent) {
          loose = true;
          j = k;
          continue;
        }
      }
      break;
    }
    const [col, idx] = indentOf(line);
    // a thematic break ends the list (it wins over a list item reading)
    if (col <= 3 && matchThematicBreak(line, idx)) break;
    const it = col <= 3 ? matchListItem(line, idx, col) : null;
    if (!it || it.ordered !== ordered || it.bullet !== bullet) break;
    lastContentIndent = it.contentIndent;
    const item = { start: it.start, lines: [], task: null };
    let content = stripColumns(line, it.contentIndent);
    const tm = /^\[([ xX])\][ \t]+\S/.exec(content);
    if (tm) {
      item.task = tm[1] !== ' ';
      content = content.slice(3);
    }
    item.lines.push(content);
    j++;
    while (j < hi) {
      const l2 = lines[j];
      if (isBlank(l2)) {
        let k = j + 1;
        while (k < hi && isBlank(lines[k])) k++;
        if (k >= hi) { j = k; break; }
        const [ck, idxk] = indentOf(lines[k]);
        const itk = ck <= 3 ? matchListItem(lines[k], idxk, ck) : null;
        // a sibling item must sit left of this item's content indent;
        // a marker at/after it is nested content, not a new item
        if (itk && itk.ordered === ordered && itk.bullet === bullet && ck < it.contentIndent) break;
        // blank lines only continue a non-empty item
        if (item.lines.some(l => !isBlank(l)) && ck >= it.contentIndent) {
          for (let m = j; m < k; m++) item.lines.push('');
          j = k;
          continue;
        }
        break;
      }
      const [col2, idx2] = indentOf(l2);
      if (col2 >= it.contentIndent) {
        const stripped = stripIndent(l2, it.contentIndent);
        item.lines.push(stripped);
        j++;
        continue;
      }
      const it2 = col2 <= 3 ? matchListItem(l2, idx2, col2) : null;
      if (it2 && it2.ordered === ordered && it2.bullet === bullet) break;
      // a list item of a different kind ends this list (a new list starts)
      if (it2) break;
      // Fence content: a line inside an unclosed fenced code block belongs
      // to the item regardless of indentation — but ONLY once the fence
      // already holds content. A dedented line right after the opener (zero
      // content lines) ends the item instead: the fence closes empty and
      // the line starts a new block at the parent level (it may itself open
      // a new fence there). With content already in the fence, dedented
      // lines stay fence content until the closing fence.
      // (fence content is literal)
      const of = openFence(item.lines);
      if (of && of.contentLines >= 1) {
        const s = col2 >= it.contentIndent ? stripIndent(l2, it.contentIndent) : l2;
        item.lines.push(s);
        j++;
        continue;
      }
      // lazy continuation: only if the item's content ends with an open
      // paragraph, and the line cannot interrupt one (the line sits in the
      // parent container, so the parent's inListItem flag applies)
      if (contentEndsWithOpenPara(item.lines, refs, true) && !canInterruptPara(lines, j, inListItem)) {
        // a lazy line indented 4+ loses 4 columns
        const s = col2 >= 4 ? stripIndent(l2, 4) : l2;
        const [scol, sidx] = indentOf(s);
        if (scol <= 3 && (matchSetext(s, sidx) || canInterruptParaLine(s, true))) {
          // the stripped line would be re-read as a setext underline or a
          // block start; merge it into the previous line
          item.lines[item.lines.length - 1] += '\n' + s;
        } else {
          item.lines.push(s);
        }
        j++;
        continue;
      }
      break;
    }
    items.push(item);
  }
  // looseness comes from the parsed structure: blank lines between items,
  // or blank lines between an item's own direct children
  const children = items.map(item => {
    const lo = { loose: false };
    const ch = parseBlocks(item.lines, 0, item.lines.length, refs, false, false, lo, true);
    return { task: item.task, children: ch, loose: lo.loose };
  });
  if (children.some(c => c.loose)) loose = true;
  emit({ t: 'list', ordered, start: first.start, tight: !loose,
    children: children.map(c => ({ task: c.task, children: c.children })) });
  return j;
}

// ---------- rendering ----------

function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs);
  return out;
}

function renderBlock(b, refs) {
  switch (b.t) {
    case 'para':
      return '<p>' + inline(b.lines.join('\n'), refs, false) + '</p>\n';
    case 'heading':
      return '<h' + b.level + '>' + inline(b.src, refs, false) + '</h' + b.level + '>\n';
    case 'code':
      return '<pre><code>' + escFull(b.text) + '</code></pre>\n';
    case 'fence': {
      const info = b.info ? ' class="language-' + escText(b.info) + '"' : '';
      return '<pre><code' + info + '>' + escFull(b.text) + '</code></pre>\n';
    }
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return '<blockquote>\n' + renderBlocks(b.children, refs) + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let s = '<' + tag + start + '>\n';
      for (const item of b.children) s += renderItem(item, b.tight, refs);
      return s + '</' + tag + '>\n';
    }
    case 'html':
      return b.text;
    case 'table': {
      let s = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < b.header.length; i++) {
        const al = b.aligns[i] ? ' align="' + b.aligns[i] + '"' : '';
        s += '<th' + al + '>' + inline(b.header[i], refs, false) + '</th>\n';
      }
      s += '</tr>\n</thead>\n';
      if (b.rows.length === 0) return s + '</table>\n';
      s += '<tbody>';
      for (const row of b.rows) {
        s += '<tr>\n';
        for (let i = 0; i < b.header.length; i++) {
          const cell = i < row.length ? row[i] : '';
          const al = b.aligns[i] ? ' align="' + b.aligns[i] + '"' : '';
          s += '<td' + al + '>' + inline(cell, refs, false) + '</td>\n';
        }
        s += '</tr>\n';
      }
      return s + '</tbody></table>\n';
    }
  }
  return '';
}

function renderItem(item, tight, refs) {
  if (item.children.length === 0) {
    if (item.task !== null) {
      const box = item.task
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">';
      return '<li>' + box + '</li>\n';
    }
    return '<li></li>\n';
  }
  const box = item.task === null ? '' : item.task
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
  let s = '<li>';
  let first = true;
  for (const child of item.children) {
    if (child.t === 'para') {
      // in a tight list every paragraph child is rendered bare
      const text = inline(child.lines.join('\n'), refs, false);
      s += tight ? (first ? box : '') + text : '<p>' + (first ? box : '') + text + '</p>\n';
    } else {
      if (first) s += box;
      s += renderBlock(child, refs);
    }
    first = false;
  }
  return s + '</li>\n';
}

export function parse(markdown) {
  const refs = new Map();
  const lines = splitLines(markdown);
  const endsNL = markdown.length > 0 && markdown.charCodeAt(markdown.length - 1) === 10;
  if (endsNL) lines.pop();
  const blocks = parseBlocks(lines, 0, lines.length, refs, endsNL, !endsNL, undefined, false);
  return renderBlocks(blocks, refs);
}
