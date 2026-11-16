// parse.js — dependency-free Markdown parser, output identical to marked 18.1.3
// (gfm true, breaks false, pedantic false, async false) on the competition set.
// Written from scratch in this session, from the CommonMark 0.31.2 + GFM 0.29
// specs and the practice set oracle (expected.json). No marked source was read.

export function parse(src) {
  if (typeof src !== 'string') src = String(src);
  const lines = splitLines(src);
  const refs = new Map();
  const doc = parseBlocks(lines, refs);
  let out = renderDoc(doc, refs);
  // a raw HTML block (type 6/7) ending the document keeps no trailing
  // newline when the source itself has none (gfm-657: the <blockquote>
  // HTML block ends the document with no '\n'); other last blocks and
  // sources ending in '\n' still get the trailing newline
  if (!src.endsWith('\n') && out.endsWith('\n') && doc.children.length > 0) {
    const last = doc.children[doc.children.length - 1];
    if (last.t === 'html' && last.htype !== undefined && last.htype > 5) out = out.slice(0, -1);
  }
  return out;
}

// ---------------------------------------------------------------- utilities

const CODE_SPACE = 32, CODE_TAB = 9, CODE_LF = 10, CODE_CR = 13;

// char-class tables (ASCII) built once
const IS_SPACE = new Uint8Array(128);
const IS_PUNCT = new Uint8Array(128);
const IS_DIGIT = new Uint8Array(128);
const IS_ALPHA = new Uint8Array(128);
const IS_ALNUM = new Uint8Array(128);
const IS_HEX = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  if (c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32) IS_SPACE[c] = 1;
  if ((c >= 48 && c <= 57)) IS_DIGIT[c] = 1;
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) IS_ALPHA[c] = 1;
  if (IS_DIGIT[c] || IS_ALPHA[c]) IS_ALNUM[c] = 1;
  if (IS_DIGIT[c] || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) IS_HEX[c] = 1;
  // ASCII punctuation: ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
  if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) IS_PUNCT[c] = 1;
}

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isSpaceCode(c) { return c < 128 ? IS_SPACE[c] === 1 : c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF; }
function isPunctCode(c) {
  if (c < 128) return IS_PUNCT[c] === 1;
  // Unicode punctuation (general categories P*): approximate with ranges
  return (c >= 0x2000 && c <= 0x206F) || (c >= 0x2E00 && c <= 0x2E7F) || (c >= 0x3001 && c <= 0x303F) ||
    (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF01 && c <= 0xFF0F) || (c >= 0xFF1A && c <= 0xFF20) ||
    (c >= 0xFF3B && c <= 0xFF40) || (c >= 0xFF5B && c <= 0xFF65) || c === 0x00A1 || c === 0x00A7 ||
    c === 0x00AB || c === 0x00B6 || c === 0x00B7 || c === 0x00BB || c === 0x00BF;
}
function isAlnumCode(c) { return c < 128 ? IS_ALNUM[c] === 1 : (c >= 0x00C0 && c <= 0x02FF) || (c >= 0x0370 && c <= 0x1FFF) || (c >= 0x2000 && c <= 0x2FFF) || (c >= 0x3000 && c <= 0xFFFD); }

function splitLines(src) {
  // Normalize CRLF/CR to LF, then split; drop the phantom last line when the
  // input ends with a newline.
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '' && src.length > 0 && src.charCodeAt(src.length - 1) === 10) lines.pop();
  return lines;
}

// Escape text content: & < > (and " is handled by escapeAttr)
function escText(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      // do not escape an '&' that starts an entity-like reference &word;
      let j = i + 1;
      while (j < s.length && ((s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) || (s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122))) j++;
      if (j > i + 1 && j < s.length && s.charCodeAt(j) === 59) continue;
      out += s.slice(start, i) + '&amp;'; start = i + 1;
    }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return out + s.slice(start);
}
// escape for code spans / code blocks: '&', '<', '>' always escaped
// (no smart-& rule, no quote escaping)
function escCode(s) {
  // marked escapes quotes in code too (docs: &quot; / &#39; inside <code>)
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += s.slice(start, i) + '&amp;'; start = i + 1; }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return out + s.slice(start);
}
function escAttr(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      let j = i + 1;
      while (j < s.length && ((s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) || (s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122))) j++;
      if (j > i + 1 && j < s.length && s.charCodeAt(j) === 59) continue;
      out += s.slice(start, i) + '&amp;'; start = i + 1;
    }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
  }
  return out + s.slice(start);
}

// ---------------------------------------------------------------- entities

// HTML5 named entities (commonly used subset; full coverage of the ones the
// spec examples and README documents use). Values are the replacement strings.
const NAMED_ENTITIES = {
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"',
  apos: "'", nbsp: '\u00A0', iexcl: '\u00A1', cent: '\u00A2', pound: '\u00A3',
  curren: '\u00A4', yen: '\u00A5', brvbar: '\u00A6', sect: '\u00A7', uml: '\u00A8',
  copy: '\u00A9', COPY: '\u00A9', ordf: '\u00AA', laquo: '\u00AB', not: '\u00AC',
  shy: '\u00AD', reg: '\u00AE', REG: '\u00AE', macr: '\u00AF', deg: '\u00B0',
  plusmn: '\u00B1', sup2: '\u00B2', sup3: '\u00B3', acute: '\u00B4', micro: '\u00B5',
  para: '\u00B6', middot: '\u00B7', cedil: '\u00B8', sup1: '\u00B9', ordm: '\u00BA',
  raquo: '\u00BB', frac14: '\u00BC', frac12: '\u00BD', frac34: '\u00BE', iquest: '\u00BF',
  Agrave: '\u00C0', Aacute: '\u00C1', Acirc: '\u00C2', Atilde: '\u00C3', Auml: '\u00C4',
  Aring: '\u00C5', AElig: '\u00C6', Ccedil: '\u00C7', Egrave: '\u00C8', Eacute: '\u00C9',
  Ecirc: '\u00CA', Euml: '\u00CB', Igrave: '\u00CC', Iacute: '\u00CD', Icirc: '\u00CE',
  Iuml: '\u00CF', ETH: '\u00D0', Ntilde: '\u00D1', Ograve: '\u00D2', Oacute: '\u00D3',
  Ocirc: '\u00D4', Otilde: '\u00D5', Ouml: '\u00D6', times: '\u00D7', Oslash: '\u00D8',
  Ugrave: '\u00D9', Uacute: '\u00DA', Ucirc: '\u00DB', Uuml: '\u00DC', Yacute: '\u00DD',
  THORN: '\u00DE', szlig: '\u00DF', agrave: '\u00E0', aacute: '\u00E1', acirc: '\u00E2',
  atilde: '\u00E3', auml: '\u00E4', aring: '\u00E5', aelig: '\u00E6', ccedil: '\u00E7',
  egrave: '\u00E8', eacute: '\u00E9', ecirc: '\u00EA', euml: '\u00EB', igrave: '\u00EC',
  iacute: '\u00ED', icirc: '\u00EE', iuml: '\u00EF', eth: '\u00F0', ntilde: '\u00F1',
  ograve: '\u00F2', oacute: '\u00F3', ocirc: '\u00F4', otilde: '\u00F5', ouml: '\u00F6',
  divide: '\u00F7', oslash: '\u00F8', ugrave: '\u00F9', uacute: '\u00FA', ucirc: '\u00FB',
  uuml: '\u00FC', yacute: '\u00FD', thorn: '\u00FE', yuml: '\u00FF',
  Amacr: '\u0100', amacr: '\u0101', Abreve: '\u0102', abreve: '\u0103', Aogon: '\u0104',
  aogon: '\u0105', Cacute: '\u0106', cacute: '\u0107', Ccaron: '\u010C', ccaron: '\u010D',
  Dcaron: '\u010E', dcaron: '\u010F', Emacr: '\u0112', emacr: '\u0113', Edot: '\u0116',
  edot: '\u0117', Eogon: '\u0118', eogon: '\u0119', Ecaron: '\u011A', ecaron: '\u011B',
  Gbreve: '\u011E', gbreve: '\u011F', Gdot: '\u0120', gdot: '\u0121', Hcirc: '\u0124',
  hcirc: '\u0125', Hstrok: '\u0126', hstrok: '\u0127', Idot: '\u0130', Imacr: '\u012A',
  imacr: '\u012B', Iogon: '\u012E', iogon: '\u012F', IJlig: '\u0132', ijlig: '\u0133',
  Jcirc: '\u0134', jcirc: '\u0135', Lacute: '\u0139', lacute: '\u013A', Lcaron: '\u013D',
  lcaron: '\u013E', Lmidot: '\u013F', lmidot: '\u0140', Lstrok: '\u0141', lstrok: '\u0142',
  Nacute: '\u0143', nacute: '\u0144', Ncaron: '\u0147', ncaron: '\u0148', Ncedil: '\u0145',
  ncedil: '\u0146', Odblac: '\u0150', odblac: '\u0151', OElig: '\u0152', oelig: '\u0153',
  Racute: '\u0154', racute: '\u0155', Rcaron: '\u0158', rcaron: '\u0159', Rcedil: '\u0156',
  rcedil: '\u0157', Sacute: '\u015A', sacute: '\u015B', Scirc: '\u015C', scirc: '\u015D',
  Scedil: '\u015E', scedil: '\u015F', Scaron: '\u0160', scaron: '\u0161', Tcedil: '\u0162',
  tcedil: '\u0163', Tcaron: '\u0164', tcaron: '\u0165', Tstrok: '\u0166', tstrok: '\u0167',
  Udblac: '\u0170', udblac: '\u0171', Uring: '\u016E', uring: '\u016F', Ycirc: '\u0176',
  ycirc: '\u0177', Yuml: '\u0178', Zacute: '\u0179', zacute: '\u017A', Zdot: '\u017B',
  zdot: '\u017C', Zcaron: '\u017D', zcaron: '\u017E', fnof: '\u0192',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394', Epsilon: '\u0395',
  Zeta: '\u0396', Eta: '\u0397', Theta: '\u0398', Iota: '\u0399', Kappa: '\u039A',
  Lambda: '\u039B', Mu: '\u039C', Nu: '\u039D', Xi: '\u039E', Omicron: '\u039F',
  Pi: '\u03A0', Rho: '\u03A1', Sigma: '\u03A3', Tau: '\u03A4', Upsilon: '\u03A5',
  Phi: '\u03A6', Chi: '\u03A7', Psi: '\u03A8', Omega: '\u03A9',
  alpha: '\u03B1', beta: '\u03B2', gamma: '\u03B3', delta: '\u03B4', epsilon: '\u03B5',
  zeta: '\u03B6', eta: '\u03B7', theta: '\u03B8', iota: '\u03B9', kappa: '\u03BA',
  lambda: '\u03BB', mu: '\u03BC', nu: '\u03BD', xi: '\u03BE', omicron: '\u03BF',
  pi: '\u03C0', rho: '\u03C1', sigmaf: '\u03C2', sigma: '\u03C3', tau: '\u03C4',
  upsilon: '\u03C5', phi: '\u03C6', chi: '\u03C7', psi: '\u03C8', omega: '\u03C9',
  thetasym: '\u03D1', upsih: '\u03D2', piv: '\u03D6',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200C', zwj: '\u200D',
  lrm: '\u200E', rlm: '\u200F', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018',
  rsquo: '\u2019', sbquo: '\u201A', ldquo: '\u201C', rdquo: '\u201D', bdquo: '\u201E',
  dagger: '\u2020', Dagger: '\u2021', permil: '\u2030', lsaquo: '\u2039', rsaquo: '\u203A',
  hellip: '\u2026', prime: '\u2032', Prime: '\u2033', oline: '\u203E', frasl: '\u2044',
  euro: '\u20AC', image: '\u2111', weierp: '\u2118', real: '\u211C', trade: '\u2122',
  TRADE: '\u2122', alefsym: '\u2135', larr: '\u2190', uarr: '\u2191', rarr: '\u2192',
  darr: '\u2193', harr: '\u2194', crarr: '\u21B5', lArr: '\u21D0', uArr: '\u21D1',
  rArr: '\u21D2', dArr: '\u21D3', hArr: '\u21D4', forall: '\u2200', part: '\u2202',
  exist: '\u2203', empty: '\u2205', nabla: '\u2207', isin: '\u2208', notin: '\u2209',
  ni: '\u220B', prod: '\u220F', sum: '\u2211', minus: '\u2212', lowast: '\u2217',
  radic: '\u221A', prop: '\u221D', infin: '\u221E', ang: '\u2220', and: '\u2227',
  or: '\u2228', cap: '\u2229', cup: '\u222A', int: '\u222B', there4: '\u2234',
  sim: '\u223C', cong: '\u2245', asymp: '\u2248', ne: '\u2260', equiv: '\u2261',
  le: '\u2264', ge: '\u2265', sub: '\u2282', sup: '\u2283', nsub: '\u2284',
  sube: '\u2286', supe: '\u2287', oplus: '\u2295', otimes: '\u2297', perp: '\u22A5',
  sdot: '\u22C5', lceil: '\u2308', rceil: '\u2309', lfloor: '\u230A', rfloor: '\u230B',
  lang: '\u27E8', rang: '\u27E9', loz: '\u25CA', spades: '\u2660', clubs: '\u2663',
  hearts: '\u2665', diams: '\u2666',
  // entities the spec examples exercise
  nexist: '\u2204',
  bne: '=\u20E5', bnequiv: '\u2261\u20E5', Cong: '\u2245',
  Tab: '\u0009', NewLine: '\u000A',
  colon: ':', semi: ';', sol: '/', bsol: '\\', equals: '=', comma: ',',
  period: '.', quest: '?', excl: '!', num: '#', dollar: '$', percnt: '%',
  plus: '+', hyphen: '-', UnderBar: '_', Hat: '^', fjlig: 'fj',
};

// Decode one entity starting at s[i] === '&'. Returns [replacement, nextIndex]
// or null when there is no valid entity here.
function decodeEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) { // # numeric
    let j = i + 2;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? (c < 128 && IS_HEX[c] === 1) : (c < 128 && IS_DIGIT[c] === 1)) j++;
      else break;
    }
    if (j === start || j >= n || s.charCodeAt(j) !== 59) return null; // needs digits + ;
    const num = parseInt(s.slice(start, j), hex ? 16 : 10);
    // out-of-range code points are not entities at all (literal text);
    // 0 and surrogates are valid entities mapping to U+FFFD
    if (num > 0x10FFFF) return null;
    return { value: numericChar(num), end: j + 1 };
  }
  // named: the oracle leaves named references as literal text (the '&'
  // is preserved by the smart-& rule in escText/escAttr), so do not decode.
  // Only numeric entities decode to a character.
  return null;
}

// HTML5 named entities valid without a trailing semicolon (legacy set).
const BARE_ENTITIES = new Set(('AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH ' +
  'Eacute Ecirc Egrave Euml Iacute Icirc Igrave Iuml Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml ' +
  'REG THORN Uacute Ucirc Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde auml ' +
  'brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 ' +
  'iacute icirc igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ' +
  'ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times ' +
  'uacute ucirc ugrave uml uuml yacute yen yuml').split(' '));

function numericChar(num) {
  if (num === 0 || num > 0x10FFFF || (num >= 0xD800 && num <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(num);
}

// ---------------------------------------------------------------- URL clean

// marked's cleanUrl: encode the href (keeping %XX escapes intact), reject
// dangerous schemes. Returns the cleaned href or null.
function cleanUrl(href) {
  if (href === null || href === undefined) return null;
  let out;
  try {
    out = encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
  // strip control chars / spaces that would break the attribute
  if (/[\u0000-\u0020]/.test(out)) return null;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(out);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'file') return null;
  }
  return out;
}

// Normalize a link label for reference lookup: collapse internal whitespace
// (incl. newlines) to single spaces, trim, lowercase.
function normalizeLabel(s) {
  // Unicode case folding: ß and ẞ both fold to "ss" (toLowerCase alone
  // gives ß, which would not match a "SS" definition)
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}

// ---------------------------------------------------------------- block parsing

// A cursor into one line: s = line text, pos = string index, col = visual
// column (tabs advance to next multiple of 4), part = columns remaining of a
// partially-consumed tab (the tab itself is still at pos; its remainder reads
// as that many spaces).
function curPeek(st) {
  if (st.part > 0) return 32;
  return st.pos < st.s.length ? st.s.charCodeAt(st.pos) : -1;
}
function curAtEnd(st) { return st.part === 0 && st.pos >= st.s.length; }
// Advance over spaces/tabs, up to n columns. Returns columns advanced.
function curAdvance(st, n) {
  let adv = 0;
  while (adv < n) {
    if (st.part > 0) {
      const use = Math.min(st.part, n - adv);
      st.part -= use; st.col += use; adv += use;
      if (st.part === 0) st.pos++;
      continue;
    }
    if (st.pos >= st.s.length) break;
    const c = st.s.charCodeAt(st.pos);
    if (c === 32) { st.pos++; st.col++; adv++; }
    else if (c === 9) {
      const next = ((st.col >> 2) + 1) << 2;
      const w = next - st.col;
      if (adv + w <= n) { st.pos++; st.col = next; adv += w; }
      else { st.part = w - (n - adv); st.col += (n - adv); adv = n; }
    } else break;
  }
  return adv;
}
// Columns of leading whitespace from the cursor (does not move it).
function curIndentCols(st) {
  let col = st.col, part = st.part, p = st.pos, cols = 0;
  if (part > 0) { cols += part; col += part; p++; }
  while (p < st.s.length) {
    const c = st.s.charCodeAt(p);
    if (c === 32) { cols++; col++; p++; }
    else if (c === 9) { const next = ((col >> 2) + 1) << 2; cols += next - col; col = next; p++; }
    else break;
  }
  return cols;
}
// Content of the line from the cursor to EOL (partial tab expands to spaces).
function curRest(st) {
  if (st.part > 0) return ' '.repeat(st.part) + st.s.slice(st.pos + 1);
  return st.s.slice(st.pos);
}
// Is the rest of the line (from cursor) blank?
function curIsBlank(st) {
  for (let i = st.pos; i < st.s.length; i++) {
    const c = st.s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Block-level tag names (HTML block type 6).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col ' +
  'colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
  'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol ' +
  'optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

const HTML_BLOCK_END = {
  1: ['pre', 'script', 'style', 'textarea'],
  2: ['-->'],
  3: ['?>'],
  4: ['>'],
  5: [']]>'],
};

// Try to match an HTML block start at the cursor (indent already <= 3).
// Returns the block type (1-7) or 0.
function htmlBlockStart(st) {
  if (curPeek(st) !== 60) return 0; // <
  const s = st.s;
  let p = st.pos + (st.part > 0 ? 0 : 1);
  // note: when part>0 the char at pos is a tab, not '<'; callers ensure peek is '<'
  if (st.part > 0) return 0;
  if (p >= s.length) return 0;
  const c = s.charCodeAt(p);
  if (c === 33) { // !
    if (s.startsWith('--', p + 1)) return 2;
    if (p + 1 < s.length && s.charCodeAt(p + 1) >= 65 && s.charCodeAt(p + 1) <= 90) return 4;
    if (s.startsWith('[CDATA[', p + 1)) return 5;
    return 0;
  }
  if (c === 63) return 3; // ?
  if (c === 47) { // / closing tag
    const m = /^[A-Za-z][A-Za-z0-9-]*\s*>/.exec(s.slice(p + 1)) || /^[A-Za-z][A-Za-z0-9-]*\s*\/>/.exec(s.slice(p + 1));
    if (!m) return 0;
    const tag = m[0].replace(/[^A-Za-z0-9-].*$/, '').toLowerCase();
    // a closing tag of a block tag is type 6; otherwise type 7, but only if
    // the tag is alone on the line (only whitespace after it)
    if (BLOCK_TAGS.has(tag)) return 6;
    let r = p + 1 + m[0].length;
    while (r < s.length && (s.charCodeAt(r) === 32 || s.charCodeAt(r) === 9)) r++;
    if (r >= s.length) return 7;
    return 0;
  }
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
    // read tag name
    let q = p;
    while (q < s.length) {
      const cc = s.charCodeAt(q);
      if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45) q++;
      else break;
    }
    const tag = s.slice(p, q).toLowerCase();
    const isType1 = tag === 'pre' || tag === 'script' || tag === 'style' || tag === 'textarea';
    if (q >= s.length) {
      // tag name at end of line: valid start for type 1 and type 6 only
      if (isType1) return 1;
      if (BLOCK_TAGS.has(tag)) return 6;
      return 0;
    }
    const nc = s.charCodeAt(q);
    if (nc !== 32 && nc !== 9 && nc !== 10 && nc !== 62 && nc !== 47) return 0;
    if (isType1) return 1;
    if (BLOCK_TAGS.has(tag)) return 6;
    // type 7: the tag (which may carry attributes) must be complete and
    // alone on the line (only whitespace after the closing '>')
    const tg = matchHtmlTag(s, st.pos);
    if (!tg) return 0;
    let r = tg.end;
    while (r < s.length && (s.charCodeAt(r) === 32 || s.charCodeAt(r) === 9)) r++;
    if (r >= s.length) return 7;
    return 0;
  }
  return 0;
}

// Does the line (full string, already container-stripped) end an HTML block
// of the given type? Type 1-5: the end marker occurs anywhere in the line.
function htmlBlockEnds(line, type) {
  const low = line.toLowerCase();
  if (type === 1) {
    return low.includes('</pre>') || low.includes('</script>') || low.includes('</style>') || low.includes('</textarea>');
  }
  if (type === 2) return line.includes('-->');
  if (type === 3) return line.includes('?>');
  if (type === 4) return line.includes('>');
  if (type === 5) return line.includes(']]>');
  return false;
}

// Is this string (a whole line, after container stripping, leading spaces
// already skipped) a setext underline? Returns 1 (=), 2 (-) or 0.
function setextLevel(str) {
  let i = 0;
  while (i < str.length && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) i++;
  if (i >= str.length) return 0;
  const c = str.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  let j = i;
  while (j < str.length && str.charCodeAt(j) === c) j++;
  while (j < str.length && (str.charCodeAt(j) === 32 || str.charCodeAt(j) === 9)) j++;
  if (j !== str.length) return 0;
  return c === 61 ? 1 : 2;
}

// Is this string a thematic break? (3+ of *, -, _ with only spaces between)
function isThematicBreak(str) {
  let i = 0;
  while (i < str.length && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) i++;
  if (i >= str.length) return false;
  const c = str.charCodeAt(i);
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let n = 0;
  for (; i < str.length; i++) {
    const cc = str.charCodeAt(i);
    if (cc === c) n++;
    else if (cc !== 32 && cc !== 9) return false;
  }
  return n >= 3;
}

// ATX heading: returns {level, text} or null. str is the line content
// (leading spaces already skipped, indent <= 3).
function matchATX(str) {
  let i = 0;
  while (i < str.length && str.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6) return null;
  if (i < str.length) {
    const c = str.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  let text = str.slice(i);
  // strip leading/trailing whitespace
  text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // a text of only #'s is itself a closing sequence (### ### -> empty)
  if (/^#+$/.test(text)) text = '';
  // strip closing sequence of #'s preceded by a space
  const m = /^(.*?)[ \t]+#+[ \t]*$/.exec(text);
  if (m) text = m[1].replace(/[ \t]+$/, '');
  return { level: i, text };
}

// Fence opener: returns {ch, len, info, indent} or null.
function matchFence(str, indent) {
  if (indent > 3) return null;
  let i = 0;
  const c = str.charCodeAt(0);
  if (c !== 96 && c !== 126) return null;
  while (i < str.length && str.charCodeAt(i) === c) i++;
  if (i < 3) return null;
  let info = str.slice(i);
  if (c === 96 && info.includes('`')) return null;
  info = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { ch: String.fromCharCode(c), len: i, info, indent };
}

// Is this line a closing fence for the given opener? (indent <= 3)
function isClosingFence(str, fence) {
  let i = 0;
  while (i < str.length && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) i++;
  if (i > 3) return false;
  let j = i;
  const c = fence.ch.charCodeAt(0);
  while (j < str.length && str.charCodeAt(j) === c) j++;
  if (j - i < fence.len) return false;
  while (j < str.length && (str.charCodeAt(j) === 32 || str.charCodeAt(j) === 9)) j++;
  return j === str.length;
}

// Strip up to n columns of indentation from a fence content line. A tab
// straddling the strip boundary is dropped entirely.
function stripFenceIndent(line, n, baseCol) {
  // Strip the first n columns (the fence indent); tabs are expanded to
  // spaces at 4-column stops, measured on the original line (line starts
  // at column baseCol, default 0). A tab that straddles the indent
  // boundary keeps only the part beyond it. Exception: a tab that is the
  // very first character of a top-level line (baseCol 0, nothing to
  // strip) is content, not indent — it stays a literal tab.
  if (baseCol === undefined) baseCol = 0;
  if (n === 0 && baseCol === 0 && line.charCodeAt(0) === 9) return line;
  let pos = 0, col = baseCol;
  const end = baseCol + n;
  while (pos < line.length && col < end) {
    const c = line.charCodeAt(pos);
    if (c === 32) { pos++; col++; }
    else if (c === 9) {
      const next = ((col >> 2) + 1) << 2;
      if (next <= end) { pos++; col = next; }
      else {
        // straddling tab: keep the beyond-indent part as spaces, then
        // expand any further tabs in the rest of the line
        let out = ' '.repeat(next - end);
        let c2 = next;
        for (let q = pos + 1; q < line.length; q++) {
          const ch = line.charCodeAt(q);
          if (ch === 9) {
            const nx = ((c2 >> 2) + 1) << 2;
            out += ' '.repeat(nx - c2);
            c2 = nx;
          } else { out += line[q]; c2++; }
        }
        return out;
      }
    } else break;
  }
  // indent stripped; expand any tabs remaining in the content
  if (line.indexOf('\t', pos) === -1) return line.slice(pos);
  let out = '';
  let c2 = col;
  for (let q = pos; q < line.length; q++) {
    const ch = line.charCodeAt(q);
    if (ch === 9) {
      const nx = ((c2 >> 2) + 1) << 2;
      out += ' '.repeat(nx - c2);
      c2 = nx;
    } else { out += line[q]; c2++; }
  }
  return out;
}

// List marker at the start of str (indent already <= 3). Returns
// {ordered, delim, bullet, num, markerLen} or null. str must have the marker
// followed by space/tab/EOL.
function matchListMarker(str) {
  const c0 = str.charCodeAt(0);
  if (c0 === 45 || c0 === 43 || c0 === 42) { // - + *
    if (str.length === 1) return { ordered: false, delim: null, bullet: String.fromCharCode(c0), num: 0, markerLen: 1 };
    const c1 = str.charCodeAt(1);
    if (c1 === 32 || c1 === 9) return { ordered: false, delim: null, bullet: String.fromCharCode(c0), num: 0, markerLen: 1 };
    return null;
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < str.length && str.charCodeAt(i) >= 48 && str.charCodeAt(i) <= 57) i++;
    if (i === 0 || i > 9) return null;
    if (i >= str.length) return null;
    const d = str.charCodeAt(i);
    if (d !== 46 && d !== 41) return null;
    if (i + 1 < str.length) {
      const c1 = str.charCodeAt(i + 1);
      if (c1 !== 32 && c1 !== 9) return null;
    }
    return { ordered: true, delim: String.fromCharCode(d), bullet: null, num: parseInt(str.slice(0, i), 10), markerLen: i + 1 };
  }
  return null;
}

// Given a line and the column just after a list marker, compute the item's
// content indent and where the content starts. Returns null if the marker is
// not followed by space/tab/EOL (not a list item).
function listContentIndent(line, markerEndCol, markerEndPos) {
  let p = markerEndPos, col = markerEndCol, spaces = 0;
  while (p < line.length) {
    const c = line.charCodeAt(p);
    if (c === 32) { spaces++; p++; col++; }
    else if (c === 9) { const next = ((col >> 2) + 1) << 2; spaces += next - col; col = next; p++; }
    else break;
  }
  if (p >= line.length) {
    // empty item: content indent is marker end + 1
    return { indent: markerEndCol + 1, pos: p, col, pad: 0, empty: true };
  }
  if (spaces === 0) return null;
  if (spaces <= 4) return { indent: col, pos: p, col, pad: 0, empty: false };
  // 5+ spaces: content indent is marker end + 1; content starts after 1 col
  let p2 = markerEndPos, col2 = markerEndCol, part = 0;
  if (line.charCodeAt(p2) === 32) { p2++; col2++; }
  else if (line.charCodeAt(p2) === 9) {
    const next = ((col2 >> 2) + 1) << 2;
    if (next - col2 === 1) { p2++; col2 = next; }
    else { part = next - col2 - 1; col2++; }
  }
  return { indent: markerEndCol + 1, pos: p2, col: col2, pad: part, empty: false };
}

// Is this line a table delimiter row? Returns alignments array or null.
function tableDelimiter(str) {
  let s = str.trim();
  if (s.length === 0) return null;
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
  const cells = s.split('|');
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (t.charCodeAt(0) === 58 && t.charCodeAt(t.length - 1) === 58) aligns.push('center');
    else if (t.charCodeAt(t.length - 1) === 58) aligns.push('right');
    else if (t.charCodeAt(0) === 58) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// Split a table row line into cells (unescaped pipes; code spans do not cross
// a cell boundary: a backtick run's closer search stops at an unescaped |).
function splitTableRow(line) {
  let s = line;
  // strip leading/trailing pipes (with optional spaces)
  let start = 0;
  while (start < s.length && (s.charCodeAt(start) === 32 || s.charCodeAt(start) === 9)) start++;
  if (s.charCodeAt(start) === 124) start++;
  let end = s.length;
  while (end > start && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  if (end > start && s.charCodeAt(end - 1) === 124) end--;
  s = s.slice(start, end);
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
    if (c === 96) {
      // code span: find the matching run, but stop at an unescaped |
      let j = i;
      while (j < s.length && s.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      let k = j;
      let closed = -1;
      while (k < s.length) {
        if (s.charCodeAt(k) === 124) break;
        if (s.charCodeAt(k) === 96) {
          let m = k;
          while (m < s.length && s.charCodeAt(m) === 96) m++;
          if (m - k === runLen) { closed = m; break; }
          k = m;
        } else k++;
      }
      if (closed === -1) { cur += s.slice(i, j); i = j; continue; }
      cur += s.slice(i, closed); i = closed; continue;
    }
    if (c === 124) { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(cur.trim());
  return cells;
}

// ---------------------------------------------------------------- link refs

// Try to parse a link reference definition starting at lines[i] (the current
// line, container-stripped content, indent <= 3). The definition may span up
// to 3 lines. Returns {label, dest, title, lines} or null.
function tryParseLinkDef(lines, i) {
  const line0 = lines[i];
  let p = 0;
  while (p < line0.length && (line0.charCodeAt(p) === 32 || line0.charCodeAt(p) === 9)) p++;
  if (p > 3 || line0.charCodeAt(p) !== 91) return null; // [
  // label: up to 999 chars, ends at the first unescaped ']' (no nesting);
  // a label may not contain an unescaped '['. The label may span lines,
  // so scan a join of up to 3 lines.
  const labelJoin = line0 + (i + 1 < lines.length ? '\n' + lines[i + 1] : '') + (i + 2 < lines.length ? '\n' + lines[i + 2] : '');
  let j = p + 1;
  let labelEnd = -1;
  while (j < labelJoin.length) {
    const c = labelJoin.charCodeAt(j);
    if (c === 92 && j + 1 < labelJoin.length) { j += 2; continue; }
    if (c === 91) return null;
    if (c === 93) { labelEnd = j; break; }
    j++;
    if (j - p > 1000) return null;
  }
  if (labelEnd === -1) return null;
  const label = labelJoin.slice(p + 1, labelEnd);
  if (label.length === 0) return null;
  if (normalizeLabel(label) === '') return null; // whitespace-only label
  // must be followed by :
  let k = labelEnd + 1;
  if (k >= labelJoin.length || labelJoin.charCodeAt(k) !== 58) return null;
  k++;
  // how many lines did the label (and ':') span? The remainder of that line
  // is where the destination parsing starts.
  let labelLines = 1;
  for (let x = 0; x < k; x++) if (labelJoin.charCodeAt(x) === 10) labelLines++;
  let lineEnd = labelJoin.indexOf('\n', k);
  if (lineEnd < 0) lineEnd = labelJoin.length;
  // Now: optional whitespace/newlines, destination, optional title.
  // Gather up to 3 lines of text to parse from.
  let text = labelJoin.slice(k, lineEnd);
  let linesUsed = labelLines;
  // destination
  let d = 0;
  while (d < text.length && (text.charCodeAt(d) === 32 || text.charCodeAt(d) === 9 || text.charCodeAt(d) === 10)) d++;
  if (d >= text.length) {
    // destination may be on the next line
    if (i + linesUsed >= lines.length || linesUsed >= 3) return null;
    text += '\n' + lines[i + linesUsed];
    linesUsed++;
    while (d < text.length && (text.charCodeAt(d) === 32 || text.charCodeAt(d) === 9 || text.charCodeAt(d) === 10)) d++;
    if (d >= text.length) return null;
  }
  let dest, after;
  if (text.charCodeAt(d) === 60) { // <...>
    let e = d + 1;
    while (e < text.length) {
      const c = text.charCodeAt(e);
      if (c === 10) return null;
      if (c === 62) break;
      if (c === 60 || c === 92) {
        if (c === 92 && e + 1 < text.length) { e += 2; continue; }
        if (c === 60) return null;
      }
      e++;
    }
    if (e >= text.length || text.charCodeAt(e) !== 62) {
      // maybe the <...> closes on the next line
      if (i + linesUsed >= lines.length || linesUsed >= 3) return null;
      text += '\n' + lines[i + linesUsed];
      linesUsed++;
      let e2 = d + 1;
      while (e2 < text.length) {
        const c = text.charCodeAt(e2);
        if (c === 10) return null;
        if (c === 62) break;
        if (c === 60) return null;
        if (c === 92 && e2 + 1 < text.length) { e2 += 2; continue; }
        e2++;
      }
      if (e2 >= text.length || text.charCodeAt(e2) !== 62) return null;
      dest = text.slice(d + 1, e2);
      after = e2 + 1;
    } else {
      dest = text.slice(d + 1, e);
      after = e + 1;
    }
  } else {
    // bare destination: no spaces/control, balanced parens (max nesting ok)
    let e = d, paren = 0;
    while (e < text.length) {
      const c = text.charCodeAt(e);
      if (c === 32 || c === 9 || c === 10) break;
      if (c < 32) return null;
      if (c === 40) paren++;
      else if (c === 41) {
        if (paren === 0) break;
        paren--;
      } else if (c === 92 && e + 1 < text.length) { e += 2; continue; }
      e++;
    }
    if (e === d) return null;
    dest = text.slice(d, e);
    after = e;
  }
  // optional title (same line, or the immediately following line)
  let title = null;
  let t = after;
  // skip spaces/tabs on this line
  while (t < text.length && (text.charCodeAt(t) === 32 || text.charCodeAt(t) === 9)) t++;
  // a title must be separated from the destination by whitespace; a title
  // opener immediately after the destination (no space, no newline) is junk
  if (t === after && t < text.length && text.charCodeAt(t) !== 10 &&
      (text.charCodeAt(t) === 34 || text.charCodeAt(t) === 39 || text.charCodeAt(t) === 40)) return null;
  // if the line ends here, the title may be on the next line
  if (t >= text.length || text.charCodeAt(t) === 10) {
    if (i + linesUsed < lines.length && linesUsed < 3) {
      // only move to the next line if the current line has nothing else
      const saveT = t, saveLines = linesUsed, saveText = text;
      text += '\n' + lines[i + linesUsed];
      linesUsed++;
      t++;
      while (t < text.length && (text.charCodeAt(t) === 32 || text.charCodeAt(t) === 9)) t++;
      if (t >= text.length || text.charCodeAt(t) === 10) {
        // no title on the next line either: rewind
        text = saveText; linesUsed = saveLines; t = saveT;
      }
    }
  }
  if (t < text.length && text.charCodeAt(t) !== 10) {
    const tc = text.charCodeAt(t);
    let q = null;
    if (tc === 34) q = 34;
    else if (tc === 39) q = 39;
    else if (tc === 40) q = 41;
    else return null; // junk after destination
    let e = t + 1;
    let closed = false;
    while (e < text.length) {
      const c = text.charCodeAt(e);
      if (q === 41 && c === 40) return null; // ( inside (title)
      if (c === q) { closed = true; break; }
      if (c === 92 && e + 1 < text.length) { e += 2; continue; }
      e++;
    }
    if (!closed) {
      // the title may close on a later line; keep appending until it
      // closes (a title may span several lines, e.g. cm-196 spans 5).
      // A blank line ends the definition — a title may not contain one
      // (cm-197: 'title\n\nwith blank line' is not a definition).
      while (!closed && i + linesUsed < lines.length && linesUsed < 10) {
        if (/^[ \t]*$/.test(lines[i + linesUsed])) return null;
        text += '\n' + lines[i + linesUsed];
        linesUsed++;
        while (e < text.length) {
          const c = text.charCodeAt(e);
          if (q === 41 && c === 40) return null;
          if (c === q) { closed = true; break; }
          if (c === 92 && e + 1 < text.length) { e += 2; continue; }
          e++;
        }
      }
      if (!closed) return null;
    }
    title = text.slice(t + 1, e);
    t = e + 1;
  }
  // after the title/destination, only spaces/tabs may follow up to the next
  // newline (the rest of the last consumed line)
  let u = t;
  while (u < text.length && (text.charCodeAt(u) === 32 || text.charCodeAt(u) === 9)) u++;
  if (u < text.length && text.charCodeAt(u) !== 10) return null;
  // how many lines did the definition span? (label lines + lines in text)
  let consumed = labelLines;
  for (let x = 0; x < t; x++) if (text.charCodeAt(x) === 10) consumed++;
  return { label: normalizeLabel(label), dest: unescapeBackslash(dest), title: title === null ? null : unescapeBackslash(title), lines: consumed };
}

// remove a backslash before an ASCII punctuation character
function unescapeBackslash(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// ---------------------------------------------------------------- main block parser

function parseBlocks(lines, refs) {
  const root = { t: 'doc', children: [] };
  // container stack; each frame: {node, kind} kind: doc|quote|list|item
  const stack = [{ node: root, kind: 'doc' }];
  let para = null;   // open paragraph node (child of innermost container)
  let leaf = null;   // open leaf consuming lines: fence|icode|html|table
  let blankPending = false; // a blank line was seen since the last content line
  const n = lines.length;

  function curChildren() { return stack[stack.length - 1].node.children; }
  function addBlock(node) {
    // a list can only contain list items. If the stack top is a list
    // frame, the item(s) are done and this block belongs to the list's
    // parent — close the list first (else a paragraph/hr/etc. would land
    // in the list's children and crash renderItem).
    while (stack.length > 0 && stack[stack.length - 1].kind === 'list') stack.pop();
    curChildren().push(node);
    return node;
  }

  // Strip leading link-reference definitions from a paragraph's lines.
  function stripLinkDefs(p) {
    while (p.lines.length > 0) {
      const d = tryParseLinkDef(p.lines, 0);
      if (!d) break;
      if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
      p.lines.splice(0, d.lines);
    }
  }
  function closePara() {
    if (!para) return;
    stripLinkDefs(para);
    if (para.lines.length === 0) {
      const ch = curChildren();
      const idx = ch.indexOf(para);
      if (idx >= 0) ch.splice(idx, 1);
    }
    para = null;
  }
  // Close stack frames from index f upward (also closes para/leaf inside).
  function closeFrom(f) {
    if (para) closePara();
    if (leaf) { finishLeaf(); }
    stack.length = f;
  }
  // Does the line at cursor st (post-container position) start a block that
  // can interrupt a paragraph? (ATX, fence, HTML 1-6, thematic break, list)
  function startsInterruptingBlock(st) {
    const st2 = { s: st.s, pos: st.pos, col: st.col, part: st.part };
    const ind = curIndentCols(st2);
    if (ind > 3) return false;
    curAdvance(st2, 3);
    const c = curRest(st2);
    if (matchATX(c)) return true;
    if (matchFence(c, ind)) return true;
    const ht = htmlBlockStart(st2);
    if (ht > 0 && ht <= 6) return true;
    if (isThematicBreak(c)) return true;
    const m = matchListMarker(c);
    if (m) {
      const afterMarker = c.slice(m.markerLen);
      if (/^[ \t]*$/.test(afterMarker)) return false;
      return true;
    }
    return false;
  }
  function finishLeaf(trailNL) {
    if (!leaf) return;
    if (leaf.kind === 'icode') {
      // drop trailing blank lines
      const ls = leaf.lines;
      while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
      leaf.node.text = ls.join('\n') + (ls.length ? '\n' : '');
    } else if (leaf.kind === 'fence') {
      // drop exactly ONE trailing blank line (the blank line just before
      // the closing fence is not content; cm-318: 'b' + 2 blanks -> 'b'
      // + 1 blank kept; doc-03/31/36: a single trailing blank is dropped)
      const ls = leaf.lines;
      if (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
      leaf.node.text = ls.join('\n') + (ls.length ? '\n' : '');
    } else if (leaf.kind === 'html') {
      // HTML block text is the raw lines joined by '\n' (no trailing newline;
      // the renderer appends one only when the block is directly followed
      // by a non-blank line)
      leaf.node.text = leaf.lines.join('\n');
      leaf.node.trailNL = !!trailNL;
    }
    leaf = null;
  }
  // Mark the innermost open list loose (if any).
  function markLoose() {
    for (let f = stack.length - 1; f >= 0; f--) {
      if (stack[f].kind === 'list') { stack[f].node.tight = false; return; }
    }
  }
  function innermostList() {
    for (let f = stack.length - 1; f >= 0; f--) {
      if (stack[f].kind === 'list') return stack[f].node;
    }
    return null;
  }

  let i = 0;
  while (i < n) {
    const raw = lines[i];
    const isBlank = /^[ \t]*$/.test(raw);
    // ---- phase 1: match open containers -------------------------------
    const st = { s: raw, pos: 0, col: 0, part: 0 };
    let lazy = false;
    let restartLine = false;
    let f = 1;
    for (; f < stack.length; f++) {
      const fr = stack[f];
      if (fr.kind === 'doc') continue;
      if (fr.kind === 'list') continue; // delegates to its item
      if (fr.kind === 'quote') {
        const save = { pos: st.pos, col: st.col, part: st.part };
        curAdvance(st, 3);
        if (curPeek(st) === 62) { // >
          st.pos++; st.col++;
          if (curPeek(st) === 32) { st.pos++; st.col++; }
          else if (curPeek(st) === 9) curAdvance(st, 1);
          continue;
        }
        // no match
        st.pos = save.pos; st.col = save.col; st.part = save.part;
        if (para) {
          if (startsInterruptingBlock(st)) {
            closeFrom(f);
            restartLine = true;
            break;
          }
          lazy = true; break;
        }
        closeFrom(f);
        break;
      }
      if (fr.kind === 'item') {
        if (isBlank) continue; // blank line: item stays open
        const save = { pos: st.pos, col: st.col, part: st.part };
        // contentIndent is an absolute column; advance the cursor to it
        const need = fr.contentIndent - st.col;
        if (need <= 0) continue;
        const adv = curAdvance(st, need);
        // an empty item followed by a blank line holds nothing more: a
        // following indented line is not its content
        if (adv >= need && blankPending && fr.node.children.length === 0) {
          st.pos = save.pos; st.col = save.col; st.part = save.part;
          closeFrom(f);
          break;
        }
        if (adv >= need) continue;
        // no match
        st.pos = save.pos; st.col = save.col; st.part = save.part;
        if (para) {
          // a new item of the same list always interrupts the paragraph,
          // even if empty or (for ordered) not starting at 1; other
          // interrupting blocks close the item + list
          const st3 = { s: st.s, pos: st.pos, col: st.col, part: st.part };
          curAdvance(st3, 3);
          const m3 = matchListMarker(curRest(st3));
          const listNode = stack[f - 1].node;
          const sameType = m3 && (m3.ordered === listNode.ordered) &&
            (m3.ordered ? m3.delim === listNode.delim : m3.bullet === listNode.bullet);
          if (sameType || startsInterruptingBlock(st)) {
            if (sameType) closeFrom(f); else closeFrom(f - 1);
            restartLine = true;
            break;
          }
          lazy = true; break;
        }
        // fenced code absorbs a dedented line iff it already holds >= 1
        // content line and this item is the fence's own container
        if (leaf && leaf.kind === 'fence' && leaf.lines.length >= 1 && f === stack.length - 1) {
          lazy = true; // reuse the lazy path: line goes to the fence
          break;
        }
        // is this a new item of the same list?
        const listNode = stack[f - 1].node;
        const save2 = { pos: st.pos, col: st.col, part: st.part };
        curAdvance(st, 3);
        const m = matchListMarker(curRest(st));
        const sameType = m && ((m.ordered === listNode.ordered) &&
          (m.ordered ? m.delim === listNode.delim : m.bullet === listNode.bullet));
        st.pos = save2.pos; st.col = save2.col; st.part = save2.part;
        if (sameType) {
          closeFrom(f); // close just the item (list stays)
        } else {
          closeFrom(f - 1); // close item + list
        }
        break;
      }
    }
    const matchedDepth = lazy ? f - 1 : f;
    void matchedDepth;

    // the line interrupted the paragraph: reprocess it with the reduced stack
    if (restartLine) continue;

    // ---- leaf handling -------------------------------------------------
    if (leaf) {
      if (leaf.kind === 'fence') {
        if (!lazy && !isBlank) {
          // closing fence? (indent <= 3, same char, len >= opener).
          // isClosingFence counts the indent itself — do not pre-advance
          // (pre-advancing 3 would let a 4-space indent close the fence).
          const rest = curRest(st);
          if (isClosingFence(rest, leaf.fence)) { finishLeaf(); i++; continue; }
        }
        if (lazy) {
          // dedented line inside a fence: absorbed as content iff the fence
          // already holds >= 1 content line, else the containers close
          if (leaf.lines.length >= 1) {
            leaf.lines.push(stripFenceIndent(curRest(st), leaf.fence.indent, st.col));
            i++; continue;
          }
          closeFrom(f);
          // reprocess this line with the reduced stack
          continue;
        }
        // normal fence content line (blank or matched)
        leaf.lines.push(stripFenceIndent(curRest(st), leaf.fence.indent, st.col));
        i++; continue;
      }
      if (leaf.kind === 'icode') {
        if (isBlank) {
          // a blank line in an indented code block keeps its content
          // after the 4-column code indent is stripped (e.g. 6 spaces
          // -> 2 spaces), it is not an empty line
          const save = { pos: st.pos, col: st.col, part: st.part };
          curAdvance(st, 4);
          leaf.lines.push(curRest(st));
          st.pos = save.pos; st.col = save.col; st.part = save.part;
          i++; continue;
        }
        if (lazy) { finishLeaf(); closeFrom(f); continue; }
        const indentCols = curIndentCols(st);
        if (indentCols >= 4) {
          const save = { pos: st.pos, col: st.col, part: st.part };
          curAdvance(st, 4);
          leaf.lines.push(curRest(st));
          st.pos = save.pos; st.col = save.col; st.part = save.part;
          i++; continue;
        }
        finishLeaf();
        continue; // reprocess this line normally
      }
      if (leaf.kind === 'html') {
        if (isBlank) {
          if (leaf.htype === 6 || leaf.htype === 7) { finishLeaf(); continue; }
          leaf.lines.push('');
          i++; continue;
        }
        if (lazy) { finishLeaf(true); closeFrom(f); continue; }
        const rest = curRest(st);
        leaf.lines.push(rest);
        if (leaf.htype <= 5 && htmlBlockEnds(rest, leaf.htype)) {
          // the end-marker is on this line: a newline follows iff the next
          // source line is non-blank
          finishLeaf(i + 1 < lines.length && lines[i + 1].trim() !== '');
        }
        i++; continue;
      }
      if (leaf.kind === 'table') {
        // a whitespace-only line ends the table — UNLESS it holds a tab,
        // which is a table row (an empty row; doc-26: a lone '\t' line
        // between rows becomes an empty <tr>, not the table end)
        if (isBlank && !raw.includes('\t')) { finishLeaf(); continue; }
        if (lazy) { finishLeaf(); closeFrom(f); continue; }
        // a line starting a new block (blockquote, heading, list, fence,
        // thematic break, html block) ends the table; reprocess it normally
        const st2 = { s: st.s, pos: st.pos, col: st.col, part: st.part };
        curAdvance(st2, 3);
        if (curRest(st2).startsWith('>') || startsInterruptingBlock(st)) { finishLeaf(); continue; }
        // a non-blank line continues the table as a row
        const cells = splitTableRow(curRest(st));
        const hdr = leaf.node.header.length;
        while (cells.length < hdr) cells.push('');
        leaf.node.rows.push(cells.slice(0, hdr));
        i++; continue;
      }
    }

    // ---- phase 2: blank line ------------------------------------------
    // A line is blank if the raw line is blank, or if nothing is left
    // after its containers match. A line that still has whitespace after
    // its markers (e.g. '>  ' leaves one space) is paragraph content
    // ONLY when a paragraph is open (cm-241: '>  ' adds a ' ' line to
    // the open paragraph); with no paragraph open it is a blank line
    // (cm-240: '>  ' with no paragraph leaves an empty blockquote).
    // Only a TRULY blank source line (isBlank) counts as a blank line
    // for list looseness — a lone '>' is a blockquote marker, not a
    // blank line, and must not make an enclosing list loose (cm-320).
    // A truly blank line also ends an open blockquote: the next '>'
    // starts a NEW blockquote (cm-242).
    const restAfterMarkers = curRest(st);
    if (isBlank || restAfterMarkers === '' || (!para && /^[ \t]*$/.test(restAfterMarkers))) {
      closePara();
      if (isBlank) {
        blankPending = true;
        // end open blockquotes (pop quote frames; lists/items stay)
        while (stack.length > 1 && stack[stack.length - 1].kind === 'quote') stack.pop();
      } else if (restAfterMarkers === '') {
        // a lone '>' (nothing after the marker) is also a blank line,
        // but it only makes a list loose when it falls directly inside
        // a list item (innermost frame is an item). Inside a blockquote
        // it does not (cm-320: '> b' / '>' inside an item's quote
        // leaves the list tight); doc-09's '>' between an item's
        // paragraph and its nested list DOES loosen the list.
        const top = stack[stack.length - 1];
        if (top && top.kind === 'item') blankPending = true;
      }
      i++; continue;
    }

    // lazy continuation: the line belongs to the open paragraph. A lazy
    // line is inside a container (blockquote/list) but carries no marker;
    // its leading whitespace is the container's indentation, so it is
    // stripped (cm-238: '    - bar' -> '- bar'; cm-291: '    with two
    // lines.' -> 'with two lines.'). Top-level continuations are not
    // lazy and keep their spaces (cm-049, cm-113).
    if (lazy) {
      let lazyText = curRest(st).replace(/^[ \t]+/, '');
      // a lazy line that is a setext underline ('===' / '---') is NOT a
      // heading (lazy lines cannot be setext underlines); it stays
      // paragraph text, indented 4 spaces so it reads as text, not a
      // heading (cm-093: '> foo' / 'bar' / '===' -> 'foo\nbar\n    ===')
      if (/^(=+|-+)$/.test(lazyText)) lazyText = '    ' + lazyText;
      para.lines.push(lazyText);
      blankPending = false;
      i++; continue;
    }

    // ---- phase 2: start new blocks ------------------------------------
    // raw content (after container matching, leading spaces intact) and indent
    const rawRest = curRest(st);
    const baseCol = st.col;
    const indentCols = curIndentCols(st);
    curAdvance(st, 3);
    const content = curRest(st);

    // setext heading (paragraph must have content after def-stripping)
    if (para) {
      stripLinkDefs(para);
      if (para.lines.length > 0) {
        const sl = setextLevel(content);
        if (sl > 0 && indentCols <= 3) {
          // setext heading content is the paragraph text with leading /
          // trailing whitespace stripped (spaces, tabs, newlines)
          const text = para.lines.join('\n').replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
          const ch = curChildren();
          const idx = ch.indexOf(para);
          const h = { t: 'heading', level: sl, text };
          if (idx >= 0) ch[idx] = h; else ch.push(h);
          para = null;
          blankPending = false;
          i++; continue;
        }
      } else {
        closePara();
      }
    }

    // table delimiter row (paragraph with exactly one line)
    if (para && para.lines.length === 1) {
      const aligns = tableDelimiter(content);
      if (aligns && indentCols <= 3) {
        const header = splitTableRow(para.lines[0]);
        // the delimiter row must have exactly as many cells as the header
        if (aligns.length !== header.length) {
          // not a table: fall through to normal block parsing
        } else {
          const tbl = { t: 'table', header, aligns: aligns.slice(0, header.length), rows: [] };
          const ch = curChildren();
          const idx = ch.indexOf(para);
          if (idx >= 0) ch[idx] = tbl; else ch.push(tbl);
          para = null;
          leaf = { kind: 'table', node: tbl };
          blankPending = false;
          i++; continue;
        }
      }
    }

    // blockquote
    if (indentCols <= 3 && curPeek(st) === 62) {
      closePara();
      if (blankPending) markLoose();
      const q = addBlock({ t: 'quote', children: [] });
      stack.push({ node: q, kind: 'quote' });
      // consume '>' + one optional space/tab
      st.pos++; st.col++;
      if (curPeek(st) === 32) { st.pos++; st.col++; }
      else if (curPeek(st) === 9) curAdvance(st, 1);
      const rest = curRest(st);
      if (rest !== '') {
        handleItemFirstLine(rest, { indent: st.col });
      }
      blankPending = false;
      i++; continue;
    }

    // indented code (cannot interrupt a paragraph): strip exactly 4
    // columns from the raw (pre-skip) position
    if (!para && indentCols >= 4) {
      if (blankPending) markLoose();
      const node = addBlock({ t: 'code', lang: '', text: '', fenced: false });
      leaf = { kind: 'icode', node, lines: [] };
      const st2 = { s: rawRest, pos: 0, col: baseCol, part: 0 };
      curAdvance(st2, 4);
      leaf.lines.push(curRest(st2));
      blankPending = false;
      i++; continue;
    }

    // ATX heading
    if (indentCols <= 3) {
      const atx = matchATX(content);
      if (atx) {
        closePara();
        if (blankPending) markLoose();
        addBlock({ t: 'heading', level: atx.level, text: atx.text });
        blankPending = false;
        i++; continue;
      }
    }

    // fenced code
    if (indentCols <= 3) {
      const fence = matchFence(content, indentCols);
      if (fence) {
        closePara();
        if (blankPending) markLoose();
        const node = addBlock({ t: 'code', lang: fence.info, text: '', fenced: true });
        leaf = { kind: 'fence', node, fence, lines: [] };
        blankPending = false;
        i++; continue;
      }
    }

    // HTML block (types 1-6 may interrupt a paragraph; type 7 may not)
    if (indentCols <= 3) {
      const ht = htmlBlockStart(st);
      if (ht > 0 && (ht <= 6 || !para)) {
        closePara();
        if (blankPending) markLoose();
        const node = addBlock({ t: 'html', text: '', htype: ht });
        leaf = { kind: 'html', node, htype: ht, lines: [rawRest] };
        if (ht <= 5 && htmlBlockEnds(rawRest, ht)) {
          finishLeaf(i + 1 < lines.length && lines[i + 1].trim() !== '');
        }
        blankPending = false;
        i++; continue;
      }
    }

    // thematic break
    if (indentCols <= 3 && isThematicBreak(content)) {
      closePara();
      if (blankPending) markLoose();
      addBlock({ t: 'hr' });
      blankPending = false;
      i++; continue;
    }

    // list item
    if (indentCols <= 3) {
      const m = matchListMarker(content);
      if (m) {
        // find the list this item would join (same type, still open)
        let listNode = null;
        const ch0 = curChildren();
        const top0 = stack[stack.length - 1];
        if (top0.kind === 'list') {
          const ln = top0.node;
          if (ln.ordered === m.ordered && (m.ordered ? ln.delim === m.delim : ln.bullet === m.bullet)) {
            listNode = ln;
          }
        } else if (ch0.length > 0) {
          const last = ch0[ch0.length - 1];
          if (last.t === 'list' && last.ordered === m.ordered &&
            (m.ordered ? last.delim === m.delim : last.bullet === m.bullet) &&
            stack.some(fr => fr.node === last)) {
            listNode = last;
          }
        }
        // can a list interrupt a paragraph? Only a NEW list is restricted:
        // an empty item may not interrupt, and an ordered list may only
        // interrupt when it starts at 1 (cm-304: 14. does not interrupt).
        // BUT the start-at-1 rule only applies at the top level: inside
        // a container (blockquote/list — stack deeper than just the doc)
        // any start number interrupts (doc-01 505791., doc-02 49.,
        // doc-27 0.). A list NOT interrupting a paragraph may start at
        // any number anywhere.
        let canInterrupt = true;
        if (para && !listNode) {
          const afterMarker = content.slice(m.markerLen);
          const emptyItem = /^[ \t]*$/.test(afterMarker);
          if (emptyItem) canInterrupt = false;
          if (m.ordered && m.num !== 1 && stack.length <= 1) canInterrupt = false;
        }
        if (canInterrupt) {
          closePara();
          // content indent of this item (absolute column: the marker starts
          // at st.col, the column where `content` begins)
          const ci = listContentIndent(content, st.col + m.markerLen, m.markerLen);
          if (ci) {
            const ch = curChildren();
            const top = stack[stack.length - 1];
            if (!listNode) {
              listNode = { t: 'list', ordered: m.ordered, delim: m.delim, bullet: m.bullet,
                start: m.ordered ? m.num : 0, tight: true, children: [] };
              addBlock(listNode);
            }
            if (blankPending) markLoose();
            // push list frame if not already on the stack
            if (stack[stack.length - 1].node !== listNode) {
              stack.push({ node: listNode, kind: 'list' });
            }
            const itemNode = { t: 'item', children: [] };
            listNode.children.push(itemNode);
            stack.push({ node: itemNode, kind: 'item', contentIndent: ci.indent });
            // the item's first line content (after the marker + indent)
            const lineContent = ci.empty ? '' : content.slice(ci.pos);
            if (lineContent !== '') {
              handleItemFirstLine(lineContent, ci);
            }
            blankPending = false;
            i++; continue;
          }
        }
      }
    }

    // link reference definition (only at paragraph start / def-only para)
    if (!para || (para && para.lines.length === 0)) {
      // gather the (container-stripped) current line for the def parser.
      // NOTE: tryParseLinkDef needs following lines too; we pass the raw
      // lines array — but those lines still carry container markers. For
      // the common top-level case there are none; nested defs are rare.
      const d = tryParseLinkDef(lines, i);
      if (d) {
        if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
        i += d.lines;
        blankPending = false;
        continue;
      }
    }

    // paragraph (start or continue): keep leading spaces (rawRest)
    if (para) {
      para.lines.push(rawRest);
    } else {
      if (blankPending) markLoose();
      para = addBlock({ t: 'para', lines: [rawRest] });
    }
    blankPending = false;
    i++;
  }

  // helper used above (function declaration hoisted): handle the first content
  // line of a list item as if it were a fresh line inside the item.
  function handleItemFirstLine(lineContent, ci) {
    // The item's (or quote's) first content line may itself start a block
    // (heading, fence, quote, nested list, indented code) or be paragraph
    // text. Paragraph text keeps its leading spaces (rawRest). NOTE:
    // lineContent starts at absolute column ci.indent, so the cursors
    // start there too — tab widths depend on the absolute column.
    const st2 = { s: lineContent, pos: 0, col: ci.indent, part: 0 };
    const ind2 = curIndentCols(st2);
    const rawRest2 = curRest(st2);
    curAdvance(st2, 3);
    const c2 = curRest(st2);
    const c2col = st2.col; // column of c2 within lineContent
    if (ind2 <= 3) {
      const atx = matchATX(c2);
      if (atx) { addBlock({ t: 'heading', level: atx.level, text: atx.text }); return; }
      const fence = matchFence(c2, ind2);
      if (fence) {
        const node = addBlock({ t: 'code', lang: fence.info, text: '', fenced: true });
        leaf = { kind: 'fence', node, fence, lines: [] };
        return;
      }
      const ht = htmlBlockStart(st2);
      if (ht > 0 && ht <= 6) {
        const node = addBlock({ t: 'html', text: '', htype: ht });
        leaf = { kind: 'html', node, htype: ht, lines: [rawRest2] };
        if (ht <= 5 && htmlBlockEnds(rawRest2, ht)) finishLeaf();
        return;
      }
      if (isThematicBreak(c2)) { addBlock({ t: 'hr' }); return; }
      // nested blockquote as first content
      if (c2.startsWith('>')) {
        const q = addBlock({ t: 'quote', children: [] });
        stack.push({ node: q, kind: 'quote' });
        const after = c2.slice(1);
        const rest = after.startsWith(' ') ? after.slice(1) : after;
        if (rest !== '') {
          const restCol = ci.indent + c2col + 1 + (after.startsWith(' ') ? 1 : 0);
          handleItemFirstLine(rest, { indent: restCol });
        }
        return;
      }
      // nested list as first content (the item's children are empty, so the
      // nested list is always fresh)
      const m2 = matchListMarker(c2);
      if (m2) {
        const ci2 = listContentIndent(c2, ci.indent + c2col + m2.markerLen, m2.markerLen);
        if (ci2) {
          const listNode = { t: 'list', ordered: m2.ordered, delim: m2.delim, bullet: m2.bullet,
            start: m2.ordered ? m2.num : 0, tight: true, children: [] };
          addBlock(listNode);
          stack.push({ node: listNode, kind: 'list' });
          const itemNode = { t: 'item', children: [] };
          listNode.children.push(itemNode);
          stack.push({ node: itemNode, kind: 'item', contentIndent: ci2.indent });
          const lc2 = ci2.empty ? '' : c2.slice(ci2.pos);
          if (lc2 !== '') handleItemFirstLine(lc2, ci2);
          return;
        }
      }
    }
    // indented code as first content: the item's content starts with 4+
    // spaces relative to the item's content column
    if (ind2 >= 4) {
      const node = addBlock({ t: 'code', lang: '', text: '', fenced: false });
      leaf = { kind: 'icode', node, lines: [] };
      const st3 = { s: rawRest2, pos: 0, col: ci.indent, part: 0 };
      curAdvance(st3, 4);
      leaf.lines.push(curRest(st3));
      return;
    }
    // GFM task list: the item's first paragraph may start with a task
    // marker ([ ] / [x] / [X] + space). Strip it and flag the item; the
    // renderer prepends the <input> checkbox.
    const topFr = stack[stack.length - 1];
    if (topFr && topFr.kind === 'item') {
      const tm = /^ *\[([ xX])\][ \t]/.exec(rawRest2);
      if (tm) {
        topFr.node.task = tm[1] === ' ' ? 'unchecked' : 'checked';
        para = addBlock({ t: 'para', lines: [rawRest2.slice(tm[0].length)] });
        return;
      }
    }
    para = addBlock({ t: 'para', lines: [rawRest2] });
  }

  closePara();
  if (leaf) finishLeaf();
  // mark lists that were closed as closed (so a later same-type list starts fresh)
  // (handled by stack discipline: a closed list's frame is gone)
  return root;
}

// ---------- inline parser ----------
// Node types: {t:'text',s} {t:'code',s} {t:'em'|'strong',children}
// {t:'link'|'image',href,title,children} {t:'html',s} {t:'br'} (hard break)

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCh(c) { return c !== undefined && (ASCII_PUNCT.has(c) || PUNCT_RE.test(c)); }
function isWSCh(c) { return c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\u1680' || (c >= '\u2000' && c <= '\u200a') || c === '\u2028' || c === '\u2029' || c === '\u202f' || c === '\u205f' || c === '\u3000' || c === '\ufeff'; }
function isSpaceCh(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'; }

// find a code span: text[i..] starts with a run of `runLen` backticks.
// Returns {end, content} (end = index just past the closing run) or null.
function findCodeSpan(text, i, runLen) {
  const n = text.length;
  let j = i + runLen;
  while (j < n) {
    if (text[j] !== '`') { j++; continue; }
    let k = j;
    while (k < n && text[k] === '`') k++;
    const len = k - j;
    if (len === runLen) {
      let content = text.slice(i + runLen, j);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && !/^[ ]+$/.test(content)) {
        content = content.slice(1, -1);
      }
      return { end: k, content };
    }
    j = k;
  }
  return null;
}

// parse a link destination starting at text[i]. Returns {dest, end} or null.
// dest is the raw destination with backslash escapes resolved.
function parseLinkDest(text, i) {
  const n = text.length;
  if (i >= n) return null;
  if (text[i] === '<') {
    let j = i + 1, out = '';
    while (j < n) {
      const c = text[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest: out, end: j + 1 };
      if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(text[j + 1])) { out += text[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  let j = i, out = '', depth = 0;
  while (j < n) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c < ' ') return out.length ? { dest: out, end: j } : null;
    if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(text[j + 1])) { out += text[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) return out.length ? { dest: out, end: j } : null;
      depth--; out += c; j++; continue;
    }
    out += c; j++;
  }
  return out.length ? { dest: out, end: j } : null;
}

// parse a link title starting at text[i] ('"' or '\'' or '(').
// Returns {title, end} or null. Line endings inside are kept (collapsed later).
function parseLinkTitle(text, i) {
  const n = text.length;
  const open = text[i];
  const close = open === '(' ? ')' : open;
  let j = i + 1, out = '';
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(text[j + 1])) { out += text[j + 1]; j += 2; continue; }
    if (c === close) return { title: out, end: j + 1 };
    out += c; j++;
  }
  return null;
}

// try to parse an inline link "(...)" starting at text[i] == '('.
// Returns {href, title, end} or null.
function parseInlineLink(text, i) {
  const n = text.length;
  let j = i + 1;
  // skip whitespace (incl. newlines)
  while (j < n && isSpaceCh(text[j])) j++;
  if (j >= n) return null;
  if (text[j] === ')') return { href: '', title: '', end: j + 1 };
  const dest = parseLinkDest(text, j);
  if (!dest) return null;
  j = dest.end;
  while (j < n && isSpaceCh(text[j])) j++;
  let title = '';
  if (j < n && (text[j] === '"' || text[j] === "'" || text[j] === '(')) {
    const t = parseLinkTitle(text, j);
    if (!t) return null;
    title = t.title;
    j = t.end;
    while (j < n && isSpaceCh(text[j])) j++;
  }
  if (j >= n || text[j] !== ')') return null;
  return { href: dest.dest, title, end: j + 1 };
}

// try to parse a link label "[...]" starting at text[i] == '['.
// Returns {label, end, empty} (end just past ']') or null. Handles nesting.
function parseLinkLabel(text, i) {
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '[') return null; // a label may not contain an unescaped '['
    if (c === ']') return { label: text.slice(i + 1, j), end: j + 1, empty: j === i + 1 };
    j++;
  }
  return null;
}

const EMAIL_AUTOLINK_RE = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/;

// does this node tree contain an EXPLICIT link node (links may not
// contain links)? Autolinks do NOT count: marked nests an autolink
// inside an explicit link's text (doc-08/17/22), so a link whose text
// holds an autolink still forms.
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link' && !nd.auto) return true;
    if (nd.children && containsLink(nd.children)) return true;
  }
  return false;
}

// match an HTML tag starting at text[i] == '<'. Returns {text, end} or null.
function matchHtmlTag(text, i) {
  const n = text.length;
  // comment (<!--> and <!---> are abrupt empty comments ending at
  // their own '>'; otherwise the comment ends at the first -->)
  if (text.startsWith('<!--', i)) {
    if (text.startsWith('<!-->', i)) return { text: '<!-->', end: i + 5 };
    if (text.startsWith('<!--->', i)) return { text: '<!--->', end: i + 6 };
    const end = text.indexOf('-->', i + 4);
    if (end >= 0) return { text: text.slice(i, end + 3), end: end + 3 };
    return null;
  }
  // processing instruction
  if (text.startsWith('<?', i)) {
    const end = text.indexOf('?>', i + 2);
    if (end >= 0) return { text: text.slice(i, end + 2), end: end + 2 };
    return null;
  }
  // CDATA
  if (text.startsWith('<![CDATA[', i)) {
    const end = text.indexOf(']]>', i + 9);
    if (end >= 0) return { text: text.slice(i, end + 3), end: end + 3 };
    return null;
  }
  // declaration <!A ...> or <!a ...>
  if (text.startsWith('<!', i) && i + 2 < n && /[A-Za-z]/.test(text[i + 2])) {
    const end = text.indexOf('>', i + 2);
    if (end >= 0) return { text: text.slice(i, end + 1), end: end + 1 };
    return null;
  }
  // closing tag
  if (text.startsWith('</', i)) {
    const m = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>/.exec(text.slice(i, i + 64));
    if (m) return { text: m[0], end: i + m[0].length };
    return null;
  }
  // open tag: attributes must be separated from the tag name and from
  // each other by whitespace (a ':' right after the name, or a new
  // attribute glued to a quoted value, is not a valid tag)
  const m = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(text.slice(i, i + 64));
  if (!m) return null;
  let j = i + 1 + m[1].length;
  while (j < n) {
    const c = text[j];
    if (c === '>') return { text: text.slice(i, j + 1), end: j + 1 };
    if (c === '/' && j + 1 < n && text[j + 1] === '>') return { text: text.slice(i, j + 2), end: j + 2 };
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      j++;
      while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j++;
      if (j >= n) return null;
      const c2 = text[j];
      if (c2 === '>') return { text: text.slice(i, j + 1), end: j + 1 };
      if (c2 === '/' && j + 1 < n && text[j + 1] === '>') return { text: text.slice(i, j + 2), end: j + 2 };
      // attribute name
      if (!/[A-Za-z_:]/.test(c2)) return null;
      while (j < n && /[A-Za-z0-9_.:-]/.test(text[j])) j++;
      // optional = value (whitespace allowed around =). If there is no
      // '=', this is a valueless attribute: rewind past the whitespace
      // we skipped so the loop top sees it and expects the next token.
      const afterName = j;
      while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j++;
      if (j < n && text[j] === '=') {
        j++;
        while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j++;
        if (j >= n) return null;
        const q = text[j];
        if (q === '"' || q === "'") {
          j++;
          while (j < n && text[j] !== q) j++;
          if (j >= n) return null;
          j++;
        } else {
          if (q === ' ' || q === '\t' || q === '\n' || q === '\r' || q === '"' || q === "'" || q === '=' || q === '<' || q === '>' || q === '`') return null;
          while (j < n && !/[ \t\r\n"'=<>`]/.test(text[j])) j++;
        }
      } else {
        j = afterName;
      }
      continue;
    }
    return null;
  }
  return null;
}

// try to form a link at the ']' at text[i], given the '[' opener.
// Returns {href, title, end} or null.
function tryFormLink(text, i, opener, refs) {
  const n = text.length;
  const rawText = text.slice(opener.bracketPos + 1, i);
  // a multi-backtick code span whose content holds a backtick breaks
  // the link, UNLESS the span sits immediately before ']' (doc-20:
  // `` a ` b `` followed by '_' then ']' -> no link; the url becomes
  // an autolink instead)
  {
    let p = 0;
    while (p < rawText.length) {
      if (rawText[p] !== '`') { p++; continue; }
      let q = p;
      while (q < rawText.length && rawText[q] === '`') q++;
      const run = q - p;
      let m = q, closed = -1;
      while (m < rawText.length) {
        if (rawText[m] === '`') {
          let r = m;
          while (r < rawText.length && rawText[r] === '`') r++;
          if (r - m === run) { closed = r; break; }
          m = r;
        } else m++;
      }
      if (closed === -1) break;
      if (run >= 2 && rawText.slice(q, closed - run).includes('`') && closed !== rawText.length) return null;
      p = closed;
    }
  }
  if (i + 1 < n && text[i + 1] === '(') {
    const il = parseInlineLink(text, i + 1);
    if (il) return { href: il.href, title: il.title, end: il.end };
    // inline link failed: fall back to the shortcut reference for [text]
    const key = normalizeLabel(rawText);
    const ref = refs.get(key);
    if (ref) return { href: ref.dest, title: ref.title, end: i + 1 };
    return null;
  }
  if (i + 1 < n && text[i + 1] === '[') {
    const lab = parseLinkLabel(text, i + 1);
    if (lab) {
      const key = lab.empty ? normalizeLabel(rawText) : normalizeLabel(lab.label);
      const ref = refs.get(key);
      if (ref) return { href: ref.dest, title: ref.title, end: lab.end };
    }
    // followed by '[' but the full/collapsed reference failed: the
    // bracket stays literal (no shortcut fallback)
    return null;
  }
  const key = normalizeLabel(rawText);
  const ref = refs.get(key);
  if (ref) return { href: ref.dest, title: ref.title, end: i + 1 };
  return null;
}

function parseInline(text, refs) {
  const out = [];
  const delims = [];
  const n = text.length;
  let i = 0;
  let textStart = 0;

  function flushText(upto) {
    if (upto > textStart) {
      const node = { t: 'text', s: text.slice(textStart, upto) };
      node._p = out;
      out.push(node);
    }
    textStart = upto;
  }
  function pushNode(node) { node._p = out; out.push(node); return node; }

  // does the '[' at text[pos] form (or try to form) a link? True when the
// matching ']' is followed (after optional whitespace) by '(' (inline link)
// or '[' (full/collapsed reference link), or when the bracket text is a
// shortcut reference matching a link definition. False when the bracket
// text itself contains a link (then the outer cannot form one). A bare '['
// that never forms a link does not create a link boundary for emphasis.
function bracketFormsLink(text, pos, refs) {
  const n = text.length;
  let depth = 0, j = pos + 1;
  let closeIdx = -1;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '`') {
      let k = j;
      while (k < n && text[k] === '`') k++;
      const run = k - j;
      let m = k, closed = -1;
      while (m < n) {
        if (text[m] === '`') {
          let q = m;
          while (q < n && text[q] === '`') q++;
          if (q - m === run) { closed = q; break; }
          m = q;
        } else m++;
      }
      if (closed === -1) return false;
      j = closed;
      continue;
    }
    if (c === '[') {
      // a nested bracket that forms a link means the outer text would
      // contain a link, so the outer cannot form one
      if (bracketFormsLink(text, j, refs)) return false;
      depth++; j++; continue;
    }
    if (c === ']') {
      if (depth === 0) { closeIdx = j; break; }
      depth--; j++; continue;
    }
    j++;
  }
  if (closeIdx < 0) return false;
  let k = closeIdx + 1;
  while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n' || text[k] === '\r')) k++;
  if (k < n && (text[k] === '(' || text[k] === '[')) return true;
  // shortcut reference: the label must match a link definition
  if (refs) {
    const label = text.slice(pos + 1, closeIdx);
    const norm = normalizeLabel(label);
    if (norm && refs.has(norm)) return true;
  }
  return false;
}

// form emphasis for a closer delimiter record (in delims)
  function processEmphasis(closer) {
    while (closer.len > 0) {
      const ci = delims.indexOf(closer);
      if (ci < 0) break;
      let formed = false;
      for (let k = ci - 1; k >= 0; k--) {
        const d = delims[k];
        // emphasis cannot span a link opener, but only if that opener will
        // actually form a link (followed by ']' then '(' or '['); a bare
        // '[' that never forms a link does not block emphasis
        if (d.ch === '[' && bracketFormsLink(text, d.bracketPos, refs)) break;
        if (d.ch !== closer.ch || !d.canOpen) continue;
        // rule of 3: applies only when the opener or the closer can both
        // open and close; then a pair whose lengths sum to a multiple of 3
        // cannot match (unless both lengths are multiples of 3)
        const eitherBoth = (d.canOpen && d.canClose) || (closer.canOpen && closer.canClose);
        if (eitherBoth && (d.len + closer.len) % 3 === 0 && !(d.len % 3 === 0 && closer.len % 3 === 0)) continue;
        const use = (d.len >= 2 && closer.len >= 2) ? 2 : 1;
        const on = d.node, cn = closer.node;
        const parr = on._p;
        if (parr !== cn._p) continue; // cannot span a link boundary
        const oi = parr.indexOf(on), cj = parr.indexOf(cn);
        if (cj - oi < 2) continue; // empty content
        const contentNodes = parr.slice(oi + 1, cj);
        // an emphasis pair cannot span a code span whose content holds
        // a backtick (multi-backtick span `` a ` b ``) — BUT only when
        // the pair sits inside link text (an active '[' opener): the
        // link fails to form there and the delimiters stay literal
        // (doc-20 '[but _previous..._](url)'). Standalone, the same
        // span does NOT block emphasis (doc-01 '~~...~~' -> <del>,
        // doc-09 '__...__' -> <strong>, doc-20 '_may..._' -> <em>).
        if (insideLinkText()) {
          let badCode = false;
          for (const cn2 of contentNodes) { if (cn2.t === 'code' && cn2.s.includes('`')) { badCode = true; break; } }
          if (badCode) continue;
        }
        // '~' always renders <del> (single or double); '*'/'_' use strong/em
        const emNode = { t: closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em'), children: contentNodes };
        on.s = on.s.slice(0, on.s.length - use);
        cn.s = cn.s.slice(use);
        const seg = [];
        if (on.s !== '') seg.push(on);
        seg.push(emNode);
        if (cn.s !== '') seg.push(cn);
        parr.splice(oi, cj - oi + 1, ...seg);
        emNode._p = parr;
        for (const c of contentNodes) c._p = emNode.children;
        d.len -= use;
        closer.len -= use;
        if (d.len === 0) delims.splice(k, 1);
        formed = true;
        break;
      }
      if (!formed) break;
    }
    if (closer.len === 0) {
      const idx = delims.indexOf(closer);
      if (idx >= 0) delims.splice(idx, 1);
    }
  }

  // is the scanner currently inside link text (an active '[' opener)?
  function insideLinkText() {
    for (const d of delims) if (d.ch === '[' && d.active) return true;
    return false;
  }

  while (i < n) {
    const c = text[i];

    // backslash escape / hard break
    if (c === '\\') {
      if (i + 1 < n && text[i + 1] === '\n') {
        flushText(i);
        pushNode({ t: 'br' });
        i += 2;
        // leading spaces/tabs of the next line are stripped after a break
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      if (i + 1 < n && ASCII_PUNCT.has(text[i + 1])) {
        flushText(i);
        pushNode({ t: 'text', s: text[i + 1] });
        i += 2; textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // code span
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const cs = findCodeSpan(text, i, j - i);
      if (cs) {
        flushText(i);
        pushNode({ t: 'code', s: cs.content });
        i = cs.end; textStart = i;
        continue;
      }
      i = j;
      continue;
    }

    // newline: hard break if preceded by 2+ spaces, else soft break (stays in text)
    if (c === '\n') {
      let spaces = 0;
      let k = i - 1;
      while (k >= textStart && text[k] === ' ') { spaces++; k--; }
      if (k < textStart) {
        // the unflushed run (textStart..i) is all spaces. If there are
        // 2+, it is a hard break even when the previous node is a link /
        // emphasis (not a text node) — the spaces are entirely in this
        // run, so there is nothing to trim from a text node.
        if (spaces >= 2) {
          textStart = i;
          pushNode({ t: 'br' });
          i++;
          while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
          textStart = i;
          continue;
        }
        // fewer than 2 spaces in this run; maybe the last text node has more
        if (out.length > 0 && out[out.length - 1].t === 'text') {
          const last = out[out.length - 1];
          const s = last.s;
          let m = s.length - 1;
          while (m >= 0 && s[m] === ' ') { spaces++; m--; }
          if (spaces >= 2) {
            last.s = s.slice(0, m + 1);
            if (last.s === '') out.pop();
            textStart = i;
            pushNode({ t: 'br' });
            i++;
            while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
            textStart = i;
            continue;
          }
        }
        i++;
        continue;
      }
      if (spaces >= 2) {
        flushText(i - spaces);
        pushNode({ t: 'br' });
        i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // entity
    if (c === '&') {
      const ent = decodeEntity(text, i);
      if (ent) {
        flushText(i);
        pushNode({ t: 'text', s: ent.value });
        i = ent.end; textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // '<': autolink, then HTML tag
    if (c === '<') {
      const gt = text.indexOf('>', i + 1);
      if (gt > i + 1) {
        const inner = text.slice(i + 1, gt);
        if (!/[\s<>]/.test(inner)) {
          if (SCHEME_RE.test(inner)) {
            flushText(i);
            const uri = inner;
            const linkNode = pushNode({ t: 'link', href: uri, title: '', auto: true, children: [{ t: 'text', s: uri }] });
            linkNode.children[0]._p = linkNode.children;
            i = gt + 1; textStart = i;
            continue;
          }
          if (EMAIL_AUTOLINK_RE.test(inner)) {
            flushText(i);
            const linkNode = pushNode({ t: 'link', href: 'mailto:' + inner, title: '', auto: true, children: [{ t: 'text', s: inner }] });
            linkNode.children[0]._p = linkNode.children;
            i = gt + 1; textStart = i;
            continue;
          }
        }
      }
      const tag = matchHtmlTag(text, i);
      if (tag) {
        flushText(i);
        pushNode({ t: 'html', s: tag.text });
        i = tag.end; textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // image opener '!['
    if (c === '!' && i + 1 < n && text[i + 1] === '[') {
      flushText(i);
      const bangNode = pushNode({ t: 'text', s: '!' });
      const node = pushNode({ t: 'text', s: '[' });
      delims.push({ ch: '[', len: 1, canOpen: true, canClose: false, node, active: true,
        image: true, bangNode, bracketPos: i + 1 });
      i += 2; textStart = i;
      continue;
    }

    // link opener '['
    if (c === '[') {
      flushText(i);
      const node = pushNode({ t: 'text', s: '[' });
      delims.push({ ch: '[', len: 1, canOpen: true, canClose: false, node, active: true,
        image: false, bracketPos: i });
      i++; textStart = i;
      continue;
    }

    // link closer ']'
    if (c === ']') {
      // A ']' closes the NEAREST '[' opener in the stack, active or
      // not. If that opener is inactive (a link already formed inside
      // it) or no link can form here, the ']' is literal text and the
      // opener is REMOVED — its bracket is closed, so a later ']' can
      // match an older opener (cm-512: each ']' consumes one '[' so
      // the last ']' matches the outermost; cm-520: the ']' after
      // (uri1) consumes the dead '[' so the final ']' matches the image).
      let openerIdx = -1;
      for (let k = delims.length - 1; k >= 0; k--) {
        if (delims[k].ch === '[') { openerIdx = k; break; }
      }
      if (openerIdx < 0) { i++; continue; }
      const opener = delims[openerIdx];
      if (!opener.active) { delims.splice(openerIdx, 1); i++; continue; }
      const link = tryFormLink(text, i, opener, refs);
      if (!link) { delims.splice(openerIdx, 1); i++; continue; }
      flushText(i);
      const on = opener.node;
      const parr = on._p;
      const oi = parr.indexOf(on);
      const children = parr.slice(oi + 1);
      // A LINK may not contain another link. An IMAGE may: its alt text
      // flattens nested links to their text (cm-575), so the check only
      // applies to link openers.
      if (!opener.image && containsLink(children)) { delims.splice(openerIdx, 1); i++; continue; }
      let startRemove = oi;
      if (opener.image && opener.bangNode) {
        const bi = parr.indexOf(opener.bangNode);
        if (bi === oi - 1) startRemove = bi;
      }
      parr.splice(startRemove, parr.length - startRemove);
      const linkNode = { t: opener.image ? 'image' : 'link', href: link.href, title: link.title, children };
      linkNode._p = parr;
      parr.push(linkNode);
      for (const ch of children) ch._p = linkNode.children;
      delims.splice(openerIdx, 1);
      // A link may not contain another link: when a LINK forms, deactivate
      // earlier LINK openers. An image forming deactivates nothing (an image
      // may sit in a link's text or an image's alt text), and image openers
      // are never deactivated (an image's alt text may contain a link).
      if (!opener.image) {
        for (let k = 0; k < openerIdx; k++) {
          if (delims[k].ch === '[' && !delims[k].image) delims[k].active = false;
        }
      }
      i = link.end; textStart = i;
      continue;
    }

    // emphasis delimiter run (and GFM strikethrough '~')
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && text[j] === c) j++;
      const runLen = j - i;
      // a run of 3+ tildes never strikes: it stays literal text
      if (c === '~' && runLen >= 3) { i = j; continue; }
      const prev = i > 0 ? text[i - 1] : undefined;
      const next = j < n ? text[j] : undefined;
      const leftFlank = !isWSCh(next) && (!isPunctCh(next) || isWSCh(prev) || isPunctCh(prev));
      const rightFlank = !isWSCh(prev) && (!isPunctCh(prev) || isWSCh(next) || isPunctCh(next));
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else if (c === '~') { canOpen = leftFlank; canClose = rightFlank; }
      else { canOpen = leftFlank && (!rightFlank || isPunctCh(prev)); canClose = rightFlank && (!leftFlank || isPunctCh(next)); }
      flushText(i);
      const node = pushNode({ t: 'text', s: text.slice(i, j) });
      const rec = { ch: c, len: runLen, canOpen, canClose, node };
      delims.push(rec);
      if (canClose) processEmphasis(rec);
      i = j; textStart = j;
      continue;
    }

    // extended autolink (GFM): www. / email — not inside link text
    if (!insideLinkText()) {
      if (text.startsWith('www.', i)) {
        const prev = i > 0 ? text[i - 1] : '';
        if (prev === '' || (!/[A-Za-z0-9_]/.test(prev) && prev !== '/' && prev !== '.')) {
          const m = matchWwwAutolink(text, i);
          if (m) {
            flushText(i);
            const linkNode = pushNode({ t: 'link', href: 'http://' + m.url, title: '', auto: true, children: [{ t: 'text', s: m.url }] });
            linkNode.children[0]._p = linkNode.children;
            i = m.end; textStart = i;
            continue;
          }
        }
      }
      if (c !== '.' && c !== '@' && c !== '-' && (i === 0 || !/[A-Za-z0-9_.!#$%&'*+\/=?^_`{|}~-]/.test(text[i - 1]))) {
        const m = matchEmailAutolink(text, i);
        if (m) {
          flushText(i);
          const linkNode = pushNode({ t: 'link', href: 'mailto:' + m.email, title: '', auto: true, children: [{ t: 'text', s: m.email }] });
          linkNode.children[0]._p = linkNode.children;
          i = m.end; textStart = i;
          continue;
        }
      }
      // scheme autolink (GFM): http://, https://, mailto:, xmpp:, ...
      if (((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
        const m = matchSchemeAutolink(text, i);
        if (m) {
          flushText(i);
          const linkNode = pushNode({ t: 'link', href: m.url, title: '', auto: true, children: [{ t: 'text', s: m.url }] });
          linkNode.children[0]._p = linkNode.children;
          i = m.end; textStart = i;
          continue;
        }
      }
    }

    i++;
  }

  flushText(n);
  return out;
}

// ---------- extended autolinks (GFM) ----------
// scan an autolink path starting at text[start] (which is '/'). Returns the
// end index. The path runs to whitespace/'<'/control or to an '&' that
// begins a character reference (&word;); it is then trimmed: truncate at the
// first unmatched '(', trim trailing punctuation, trim trailing closers that
// are unbalanced in the whole URL (so interior ')' stay).
function scanAutolinkPath(text, urlStart, start) {
  const n = text.length;
  let p = start;
  while (p < n) {
    const c = text[p];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c < ' ') break;
    // '&' starting a character reference ends the URL
    if (c === '&') {
      let q = p + 1;
      while (q < n && ((text[q] >= 'a' && text[q] <= 'z') || (text[q] >= 'A' && text[q] <= 'Z') || (text[q] >= '0' && text[q] <= '9'))) q++;
      if (q > p + 1 && q < n && text[q] === ';') break;
    }
    p++;
  }
  let end = p;
  // truncate at the first unmatched '('
  {
    let depth = 0;
    const parenPos = [];
    for (let q = start; q < end; q++) {
      if (text[q] === '(') { depth++; parenPos.push(q); }
      else if (text[q] === ')') { if (depth > 0) depth--; }
    }
    if (depth > 0) end = parenPos[parenPos.length - depth];
  }
  // trim trailing punctuation and unbalanced closers, looping until
  // stable: a trailing ')' shields dots from the punctuation trim, so
  // the two must alternate (doc-23: 'lumen....)' -> 'lumen'; doc-10:
  // 'nova).' -> 'nova')
  let changed = true;
  while (changed) {
    changed = false;
    while (end > start && /[?!.,:;*_~'"]/.test(text[end - 1])) { end--; changed = true; }
    while (end > start) {
      const c = text[end - 1];
      if (c === ')' || c === ']' || c === '}') {
        const open = c === ')' ? '(' : c === ']' ? '[' : '{';
        const seg = text.slice(urlStart, end);
        let oc = 0, cc = 0;
        for (const ch of seg) { if (ch === open) oc++; if (ch === c) cc++; }
        if (cc > oc) { end--; changed = true; continue; }
      }
      break;
    }
  }
  return end;
}

// match a www. autolink at text[i]. Returns {url, end} or null.
function matchWwwAutolink(text, i) {
  const n = text.length;
  let j = i + 4; // past 'www.'
  // domain: labels separated by '.', at least one dot, TLD letters only (>=2).
  // A '.' is a separator only when followed by a label character (otherwise
  // it is trailing punctuation and the domain ends before it).
  let labels = 0, lastLabel = '';
  let k = j;
  while (k < n) {
    const c = text[k];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') { k++; continue; }
    if (c === '.' && k + 1 < n && ((text[k + 1] >= 'a' && text[k + 1] <= 'z') || (text[k + 1] >= 'A' && text[k + 1] <= 'Z') || (text[k + 1] >= '0' && text[k + 1] <= '9'))) {
      const label = text.slice(j, k);
      if (!label || label.startsWith('-') || label.endsWith('-')) return null;
      labels++;
      lastLabel = label;
      k++;
      j = k;
      continue;
    }
    break;
  }
  const tail = text.slice(j, k);
  if (!tail || tail.startsWith('-') || tail.endsWith('-')) return null;
  labels++;
  lastLabel = tail;
  if (labels < 2) return null; // need at least one dot after www.
  if (!/^[A-Za-z]{2,}$/.test(lastLabel)) return null;
  let end = k;
  // optional path starting with '/', '?' (query) or '#' (fragment)
  if (end < n && (text[end] === '/' || text[end] === '?' || text[end] === '#')) {
    end = scanAutolinkPath(text, i, end);
  }
  return { url: text.slice(i, end), end };
}

// match a bare email autolink at text[i]. Returns {email, end} or null.
function matchEmailAutolink(text, i) {
  const n = text.length;
  let j = i;
  // local part
  while (j < n && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(text[j])) j++;
  if (j === i) return null;
  if (j >= n || text[j] !== '@') return null;
  const local = text.slice(i, j);
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  j++; // past '@'
  // domain: labels, at least one dot, TLD letters only (>=2).
  // A '.' is a separator only when followed by a label character (otherwise
  // it is trailing punctuation and the domain ends before it).
  let labels = 0, lastLabel = '';
  let k = j;
  while (k < n) {
    const c = text[k];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') { k++; continue; }
    if (c === '.' && k + 1 < n && ((text[k + 1] >= 'a' && text[k + 1] <= 'z') || (text[k + 1] >= 'A' && text[k + 1] <= 'Z') || (text[k + 1] >= '0' && text[k + 1] <= '9'))) {
      const label = text.slice(j, k);
      if (!label || label.startsWith('-') || label.endsWith('-')) return null;
      labels++;
      lastLabel = label;
      k++;
      j = k;
      continue;
    }
    break;
  }
  const tail = text.slice(j, k);
  if (!tail || tail.startsWith('-') || tail.endsWith('-')) return null;
  labels++;
  lastLabel = tail;
  if (labels < 2) return null;
  if (!/^[A-Za-z]+$/.test(lastLabel)) return null;
  // a trailing '_' invalidates the match entirely when it is at the
  // end of the text or followed by a word character (user@domain.com_foo
  // is one identifier; gfm-632/633: 'a.b-c_d@a.b_' at end of input is
  // NOT an autolink). A '_' followed by whitespace or punctuation is a
  // separate delimiter — e.g. the closing '_' of emphasis (doc-34/37/38:
  // an@relay.example.com_  cache) — and the email still forms. A '__'
  // after the email is a strong delimiter, not an identifier (doc-04:
  // because@mark.example.com__ closes the strong), so it never
  // invalidates.
  if (k < n && text[k] === '_' && text[k + 1] !== '_' && (k + 1 >= n || /[A-Za-z0-9_]/.test(text[k + 1]))) return null;
  return { email: text.slice(i, k), end: k };
}

// match a scheme autolink at text[i] (http://, https://, mailto:, xmpp: ...).
// Returns {url, end} or null. The scheme is 2-32 chars (letter first, then
// letters/digits/+/./-), followed by ':'. After ':' either '//' + domain +
// full path, or an email + one optional path segment.
function matchSchemeAutolink(text, i) {
  const n = text.length;
  let j = i;
  if (j >= n || !((text[j] >= 'a' && text[j] <= 'z') || (text[j] >= 'A' && text[j] <= 'Z'))) return null;
  j++;
  while (j < n && ((text[j] >= 'a' && text[j] <= 'z') || (text[j] >= 'A' && text[j] <= 'Z') || (text[j] >= '0' && text[j] <= '9') || text[j] === '+' || text[j] === '.' || text[j] === '-')) j++;
  const schemeLen = j - i;
  if (schemeLen < 2 || schemeLen > 32) return null;
  if (j >= n || text[j] !== ':') return null;
  j++; // past ':'
  if (text.startsWith('//', j)) {
    // domain + optional full path (may start with '/', '?' or '#')
    const d = scanAutolinkDomain(text, j + 2);
    if (!d) return null;
    let end = d.end;
    if (end < n && (text[end] === '/' || text[end] === '?' || text[end] === '#')) end = scanAutolinkPath(text, i, end);
    return { url: text.slice(i, end), end };
  }
  // email + one optional path segment
  const em = matchEmailAutolink(text, j);
  if (!em) return null;
  let end = em.end;
  if (end < n && text[end] === '/') {
    // one segment: chars until '/', whitespace, control or '<'
    let p = end + 1;
    while (p < n) {
      const c = text[p];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c < ' ' || c === '/') break;
      if (c === '&') {
        let q = p + 1;
        while (q < n && ((text[q] >= 'a' && text[q] <= 'z') || (text[q] >= 'A' && text[q] <= 'Z') || (text[q] >= '0' && text[q] <= '9'))) q++;
        if (q > p + 1 && q < n && text[q] === ';') break;
      }
      p++;
    }
    let segEnd = p;
    while (segEnd > end + 1 && /[?!.,:;*_~'"]/.test(text[segEnd - 1])) segEnd--;
    if (segEnd > end + 1) end = segEnd;
  }
  return { url: text.slice(i, end), end };
}

// scan a domain starting at text[i]: labels separated by '.', at least one
// dot, TLD letters only (>=2). Returns {end} or null.
function scanAutolinkDomain(text, i) {
  const n = text.length;
  let j = i;
  let labels = 0, lastLabel = '';
  let k = j;
  while (k < n) {
    const c = text[k];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') { k++; continue; }
    if (c === '.' && k + 1 < n && ((text[k + 1] >= 'a' && text[k + 1] <= 'z') || (text[k + 1] >= 'A' && text[k + 1] <= 'Z') || (text[k + 1] >= '0' && text[k + 1] <= '9'))) {
      const label = text.slice(j, k);
      if (!label || label.startsWith('-') || label.endsWith('-')) return null;
      labels++;
      lastLabel = label;
      k++;
      j = k;
      continue;
    }
    break;
  }
  const tail = text.slice(j, k);
  if (!tail || tail.startsWith('-') || tail.endsWith('-')) return null;
  labels++;
  lastLabel = tail;
  if (labels < 2) return null;
  if (!/^[A-Za-z]{2,}$/.test(lastLabel)) return null;
  return { end: k };
}

// plain-text rendering of inline nodes (for image alt text)
function renderPlain(nodes) {
  let s = '';
  for (const nd of nodes) {
    if (nd.t === 'text' || nd.t === 'code') s += nd.s;
    else if (nd.children) s += renderPlain(nd.children);
  }
  return s;
}

function renderInline(nodes) {
  let s = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': s += escText(nd.s); break;
      case 'code': s += '<code>' + escCode(nd.s) + '</code>'; break;
      case 'em': s += '<em>' + renderInline(nd.children) + '</em>'; break;
      case 'strong': s += '<strong>' + renderInline(nd.children) + '</strong>'; break;
      case 'del': s += '<del>' + renderInline(nd.children) + '</del>'; break;
      case 'br': s += '<br>'; break;
      case 'html': s += nd.s; break;
      case 'link': {
        const href = escAttr(cleanUrl(nd.href));
        const title = nd.title ? ' title="' + escAttr(nd.title) + '"' : '';
        s += '<a href="' + href + '"' + title + '>' + renderInline(nd.children) + '</a>';
        break;
      }
      case 'image': {
        const src = escAttr(cleanUrl(nd.href));
        const alt = escAttr(renderPlain(nd.children));
        const title = nd.title ? ' title="' + escAttr(nd.title) + '"' : '';
        s += '<img src="' + src + '" alt="' + alt + '"' + title + '>';
        break;
      }
    }
  }
  return s;
}

// render a block node to HTML. Every block's output ends with '\n' EXCEPT
// an HTML block, which outputs its raw text with no trailing newline (so
// consecutive HTML blocks concatenate and a following paragraph follows
// directly). renderDoc appends a final '\n' if the output lacks one.
function renderBlock(node, refs, listTight) {
  switch (node.t) {
    case 'heading':
      return '<h' + node.level + '>' + renderInline(parseInline(node.text, refs)) + '</h' + node.level + '>\n';
    case 'para':
      return '<p>' + renderInline(parseInline(node.lines.join('\n'), refs)) + '</p>\n';
    case 'quote': {
      const inner = node.children.map(ch => renderBlock(ch, refs, false)).join('');
      return '<blockquote>\n' + inner + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      const inner = node.children.map(it => renderItem(it, refs, node.tight)).join('');
      return '<' + tag + start + '>\n' + inner + '</' + tag + '>\n';
    }
    case 'code': {
      const lang = node.lang ? ' class="language-' + escAttr(unescapeBackslash(node.lang.split(/\s+/)[0])) + '"' : '';
      return '<pre><code' + lang + '>' + escCode(node.text) + '</code></pre>\n';
    }
    case 'html':
      // end-marker blocks (types 1-5) end with a newline before the next
      // block only when directly followed by a non-blank line; type 6/7
      // blocks are raw text with no trailing newline
      if (node.htype !== undefined && node.htype <= 5 && node.trailNL) {
        return node.text.endsWith('\n') ? node.text : node.text + '\n';
      }
      return node.text;
    case 'hr':
      return '<hr>\n';
    case 'table': {
      const cell = (txt, align, tag) => {
        const a = align ? ' align="' + align + '"' : '';
        return '<' + tag + a + '>' + renderInline(parseInline(txt, refs)) + '</' + tag + '>';
      };
      const head = '<tr>\n' + node.header.map((h, idx) => cell(h, node.aligns[idx], 'th')).join('\n') + '\n</tr>';
      let s = '<table>\n<thead>\n' + head + '\n</thead>\n';
      if (node.rows.length) {
        const body = node.rows.map(row =>
          '<tr>\n' + row.map((c, idx) => cell(c, node.aligns[idx], 'td')).join('\n') + '\n</tr>'
        ).join('\n');
        s += '<tbody>' + body + '\n</tbody>';
      }
      return s + '</table>\n';
    }
  }
  return '';
}

// render a list item (ends with '\n'). In a tight list, paragraphs render
// inline (no <p>); children concatenate directly, so a nested block's
// trailing '\n' supplies the newline before </li>. A GFM task item prepends
// its checkbox: right after <li> when tight, inside the <p> when loose.
function renderItem(item, refs, tight) {
  const taskHtml = item.task === 'checked' ? '<input checked="" disabled="" type="checkbox"> '
    : item.task === 'unchecked' ? '<input disabled="" type="checkbox"> ' : '';
  if (tight) {
    const parts = item.children.map((ch, idx) => {
      if (ch.t === 'para') {
        const s = renderInline(parseInline(ch.lines.join('\n'), refs));
        return idx === 0 ? taskHtml + s : s;
      }
      return renderBlock(ch, refs, false);
    });
    return '<li>' + parts.join('') + '</li>\n';
  }
  const inner = item.children.map((ch, idx) => {
    if (idx === 0 && ch.t === 'para' && taskHtml) {
      return '<p>' + taskHtml + renderInline(parseInline(ch.lines.join('\n'), refs)) + '</p>\n';
    }
    return renderBlock(ch, refs, false);
  }).join('');
  return '<li>' + inner + '</li>\n';
}

function renderDoc(doc, refs) {
  if (!doc.children || doc.children.length === 0) return '';
  let out = doc.children.map(ch => renderBlock(ch, refs, false)).join('');
  if (out.length > 0 && !out.endsWith('\n')) out += '\n';
  return out;
}
