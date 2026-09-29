const editor = document.getElementById('editor');
const editorBackdrop = document.getElementById('editor-backdrop');
const preview = document.getElementById('preview');
const previewPane = document.getElementById('preview-pane');
const editorPane = document.getElementById('editor-pane');
const charCountEl = document.getElementById('char-count');
const pageCountEl = document.getElementById('page-count');
const genkouCountEl = document.getElementById('genkou-count');
const statusFileEl = document.getElementById('status-file');

// 用紙サイズ定義 (mm)
const PAPER_SIZES = {
  B5P: { w: 182, h: 257, label: 'B5縦' },
  B5L: { w: 257, h: 182, label: 'B5横' },
  A5P: { w: 148, h: 210, label: 'A5縦' },
  A5L: { w: 210, h: 148, label: 'A5横' },
  A4P: { w: 210, h: 297, label: 'A4縦' },
  B6P: { w: 128, h: 182, label: 'B6縦' },
  SHIROKU: { w: 127, h: 188, label: '四六判縦' },
};
const MARGIN_MM = 15;
const COLUMN_GAP_MM = 6;
const LINE_HEIGHT = 1.75;

const state = {
  filePath: null,
  savedContent: '',
  // ドライブ上のファイルを開いている時は source='drive'
  source: 'local',
  driveFileId: null,
  driveName: null,
  driveModifiedTime: null,
  driveIgnoredTime: null, // 「あとで」と答えたリモート更新（同じ更新で何度も聞かない）
  dirty: false,
  paperKey: 'B5P',
  zoom: 1.0,
  fontFamily: '"Yu Mincho","游明朝","MS Mincho",serif',
  color: '#1a1a1a',
  charsPerColumn: 31,
  linesPerColumn: 27,
  columns: 2,
  genkou: false,
  autoIndent: true,
  indentChar: '　',
};

function charsPerPage() {
  // 原稿用紙表示は1枚1段
  return state.charsPerColumn * state.linesPerColumn * (state.genkou ? 1 : state.columns);
}

const fontSelect = document.getElementById('font-select');
const colorInput = document.getElementById('color-input');
const zoomSlider = document.getElementById('zoom-slider');
const zoomValue = document.getElementById('zoom-value');
const previewScroll = document.getElementById('preview-scroll');
const charsInput = document.getElementById('chars-input');
const linesInput = document.getElementById('lines-input');
const colsInput = document.getElementById('cols-input');
const charsPerPageLabel = document.getElementById('chars-per-page-label');
const genkouInput = document.getElementById('genkou-input');

function updateTitle() {
  const name = state.source === 'drive'
    ? `ドライブ: ${state.driveName}`
    : state.filePath ? state.filePath.split(/[\\/]/).pop() : '無題';
  statusFileEl.textContent = (state.dirty ? '* ' : '') + name;
  document.title = `${state.dirty ? '* ' : ''}${name} - 小説エディタ`;
}

function countChars(text) {
  // 改行と半角空白は数えない（原稿用紙慣習に近い簡易カウント）
  return Array.from(text.replace(/\r?\n/g, '')).length;
}

function updateStatus() {
  const text = editor.value;
  const n = countChars(text);
  const cpp = charsPerPage();
  charCountEl.textContent = n.toLocaleString();
  pageCountEl.textContent = Math.ceil(n / cpp).toLocaleString();
  genkouCountEl.textContent = (Math.ceil(n / 400)).toLocaleString() + '枚';
  charsPerPageLabel.textContent = cpp.toLocaleString();
  state.dirty = text !== state.savedContent;
  updateTitle();
}

// ---- 空白の可視化 ----
// 空白を span で包み、印の描画は CSS（body.show-spaces）に任せる
const SPACE_RE = /[ 　]/g;

function spaceClass(ch) {
  return ch === ' ' ? 'ws-half' : 'ws-full';
}

function appendMarkedText(el, text) {
  let last = 0;
  for (const m of text.matchAll(SPACE_RE)) {
    if (m.index > last) el.append(text.slice(last, m.index));
    const span = document.createElement('span');
    span.className = spaceClass(m[0]);
    span.textContent = m[0];
    el.append(span);
    last = m.index + 1;
  }
  if (last < text.length) el.append(text.slice(last));
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markSpacesHtml(text) {
  return escapeHtml(text)
    .replace(SPACE_RE, (ch) => `<span class="${spaceClass(ch)}">${ch}</span>`);
}

// 検索バーの状態。matches は本文中の一致範囲、index は現在の一致
const find = { open: false, matches: [], index: -1, error: false };

// textarea の背後に同じ文字列を透明で敷き、空白の位置と検索結果に印を出す
function renderBackdrop() {
  const text = editor.value;
  let html = '';
  let pos = 0;
  find.matches.forEach((m, i) => {
    const cls = i === find.index ? 'find-hit find-current' : 'find-hit';
    html += markSpacesHtml(text.slice(pos, m.start));
    html += `<mark class="${cls}">${markSpacesHtml(text.slice(m.start, m.end))}</mark>`;
    pos = m.end;
  });
  html += markSpacesHtml(text.slice(pos));
  // 末尾が改行の時も textarea と同じく空行ができるよう、印のない空白を足す
  editorBackdrop.innerHTML = html + ' ';
  syncBackdropScroll();
}

function syncBackdropScroll() {
  editorBackdrop.scrollTop = editor.scrollTop;
}

editor.addEventListener('scroll', syncBackdropScroll);

let renderTimer = null;
let preserveScroll = false;
function schedulePreview(opts) {
  if (opts && opts.preserveScroll) preserveScroll = true;
  if (renderTimer) cancelAnimationFrame(renderTimer);
  renderTimer = requestAnimationFrame(renderPreview);
}

function splitIntoColumns(text) {
  // 1段 = linesPerColumn 行 (1行 = charsPerColumn 字 or \n)
  const maxCharsPerLine = state.charsPerColumn;
  const maxLinesPerCol = state.linesPerColumn;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const cols = [];
  let buf = '';
  let charsInLine = 0;
  let linesInCol = 0;

  const flush = () => {
    cols.push(buf);
    buf = '';
    charsInLine = 0;
    linesInCol = 0;
  };

  for (const ch of normalized) {
    buf += ch;
    if (ch === '\n') {
      linesInCol++;
      charsInLine = 0;
    } else {
      charsInLine++;
      if (charsInLine >= maxCharsPerLine) {
        linesInCol++;
        charsInLine = 0;
      }
    }
    if (linesInCol >= maxLinesPerCol) flush();
  }
  if (buf.length > 0 || cols.length === 0) cols.push(buf);
  return cols;
}

function splitIntoPages(text) {
  // 段を charged して columns 個ずつまとめ、1ページとする
  const allCols = splitIntoColumns(text);
  const pages = [];
  for (let i = 0; i < allCols.length; i += state.columns) {
    pages.push(allCols.slice(i, i + state.columns));
  }
  if (pages.length === 0) pages.push(['']);
  return pages;
}

// Chromium の CJK 最小フォント制約に引っかからないように、
// 実描画サイズが最低 minPx になるよう表示スケールを掛ける
const MIN_FONT_PX = 14;
const CSS_PX_PER_MM = 96 / 25.4; // ≈ 3.7795

function computePaperStyle() {
  const p = PAPER_SIZES[state.paperKey] || PAPER_SIZES.B5P;
  const availH = p.h - MARGIN_MM * 2;
  const availW = p.w - MARGIN_MM * 2;
  // 段組は上下に積む: 高さ方向に 段数×字数 + 段間、幅方向に 行数
  const totalGap = COLUMN_GAP_MM * (state.columns - 1);
  const fontFromH = (availH - totalGap) / (state.columns * state.charsPerColumn);
  const fontFromW = availW / (state.linesPerColumn * LINE_HEIGHT);
  const fontMm = Math.min(fontFromH, fontFromW);
  const fontPx = fontMm * CSS_PX_PER_MM;
  const displayScale = fontPx < MIN_FONT_PX ? MIN_FONT_PX / fontPx : 1;
  return { paper: p, fontMm, availH, availW, displayScale };
}

function renderPreview() {
  const frag = state.genkou ? buildGenkouPages() : buildPaperPages();

  const wasPreserving = preserveScroll;
  preserveScroll = false;
  const prevRightOffset =
    previewScroll.scrollWidth - previewScroll.clientWidth - previewScroll.scrollLeft;

  preview.replaceChildren(frag);

  requestAnimationFrame(() => {
    if (wasPreserving) {
      const maxScroll = previewScroll.scrollWidth - previewScroll.clientWidth;
      previewScroll.scrollLeft = Math.max(0, maxScroll - prevRightOffset);
    } else {
      // 縦書きは右→左に読むので、初期表示は右端(1段目)から
      previewScroll.scrollLeft = previewScroll.scrollWidth;
    }
  });
}

function buildPaperPages() {
  const { paper, fontMm, displayScale } = computePaperStyle();
  const s = displayScale;
  const colH = state.charsPerColumn * fontMm * s;             // 1段の高さ (縦書きの縦方向)
  const colW = state.linesPerColumn * fontMm * LINE_HEIGHT * s; // 1段の幅   (縦書きの横方向)
  const gap = COLUMN_GAP_MM * s;

  const pages = splitIntoPages(editor.value);
  const frag = document.createDocumentFragment();
  pages.forEach((cols, i) => {
    const wrap = document.createElement('div');
    const page = document.createElement('div');
    page.className = 'preview-page';
    page.style.width = `${paper.w * s}mm`;
    page.style.height = `${paper.h * s}mm`;
    page.style.padding = `${MARGIN_MM * s}mm`;
    page.style.zoom = String(state.zoom);

    const innerH = state.columns * colH + gap * (state.columns - 1);
    const inner = document.createElement('div');
    inner.className = 'preview-inner';
    inner.style.position = 'relative';
    inner.style.height = `${innerH}mm`;
    inner.style.width = `${colW}mm`;
    inner.style.marginLeft = 'auto';
    inner.style.marginRight = 'auto';

    for (let c = 0; c < state.columns; c++) {
      const colDiv = document.createElement('div');
      colDiv.className = 'preview-column preview-text';
      colDiv.style.position = 'absolute';
      colDiv.style.top = `${c * (colH + gap)}mm`;
      colDiv.style.right = '0';
      colDiv.style.writingMode = 'vertical-rl';
      colDiv.style.width = `${colW}mm`;
      colDiv.style.height = `${colH}mm`;
      colDiv.style.fontSize = `${fontMm * s}mm`;
      colDiv.style.lineHeight = String(LINE_HEIGHT);
      colDiv.style.fontFamily = state.fontFamily;
      colDiv.style.color = state.color;
      appendMarkedText(colDiv, cols[c] || '');
      inner.appendChild(colDiv);
    }
    page.appendChild(inner);

    const num = document.createElement('div');
    num.className = 'page-number';
    num.textContent = `— ${i + 1} — (${paper.label})`;
    wrap.appendChild(page);
    wrap.appendChild(num);
    frag.appendChild(wrap);
  });
  return frag;
}

// ---- 原稿用紙表示 ----
// 字数×行数マスの縦書き原稿用紙（段数は使わない）。1文字を1マスに置く
const GENKOU = { cellMm: 8, gapMm: 2, centerMm: 12, marginMm: 12 };
// 行頭に来る句読点・閉じ括弧は、前の行の最後のマスの下にぶら下げる
const HANGING_CHARS = '、。，．,.）)」』】〉》〕］｝〟”’';

function splitGenkouLines(text) {
  const perLine = state.charsPerColumn;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = [];
  let cur = [];
  for (const ch of normalized) {
    if (ch === '\n') {
      lines.push(cur);
      cur = [];
    } else if (cur.length < perLine) {
      cur.push(ch);
    } else if (cur.length === perLine && HANGING_CHARS.includes(ch)) {
      cur.push(ch);
    } else {
      lines.push(cur);
      cur = [ch];
    }
  }
  lines.push(cur);
  return lines;
}

function buildGenkouLine(chars) {
  const line = document.createElement('div');
  line.className = 'genkou-line';
  for (const ch of chars) {
    const cell = document.createElement('span');
    cell.className = 'genkou-cell';
    if (ch === ' ' || ch === '　') cell.classList.add(spaceClass(ch));
    else if (/^[\x21-\x7e]$/.test(ch)) cell.classList.add('genkou-upright');
    cell.textContent = ch;
    line.appendChild(cell);
  }
  return line;
}

function buildGenkouPages() {
  const lines = splitGenkouLines(editor.value);
  const perLine = state.charsPerColumn;
  const perPage = state.linesPerColumn;
  const frag = document.createDocumentFragment();
  for (let p = 0; p * perPage < lines.length; p++) {
    const wrap = document.createElement('div');
    const page = document.createElement('div');
    page.className = 'preview-page genkou-page';
    page.style.padding = `${GENKOU.marginMm}mm`;
    page.style.zoom = String(state.zoom);
    page.style.setProperty('--cell', `${GENKOU.cellMm}mm`);
    page.style.setProperty('--rows', String(perLine));

    const grid = document.createElement('div');
    grid.className = 'genkou-grid preview-text';
    grid.style.gap = `${GENKOU.gapMm}mm`;
    grid.style.padding = `0 ${GENKOU.gapMm}mm`;
    grid.style.fontFamily = state.fontFamily;
    grid.style.color = state.color;

    // 行数が偶数の時だけ、中央に折り目（柱）を入れる
    const half = perPage % 2 === 0 ? perPage / 2 : -1;
    for (let l = 0; l < perPage; l++) {
      if (l === half) {
        const center = document.createElement('div');
        center.className = 'genkou-center';
        center.style.width = `${GENKOU.centerMm}mm`;
        grid.appendChild(center);
      }
      grid.appendChild(buildGenkouLine(lines[p * perPage + l] || []));
    }
    page.appendChild(grid);

    const num = document.createElement('div');
    num.className = 'page-number';
    num.textContent = `— ${p + 1} — (${perLine}×${perPage})`;
    wrap.appendChild(page);
    wrap.appendChild(num);
    frag.appendChild(wrap);
  }
  return frag;
}

// ---- 自動字下げ ----
// 会話文など、括弧で始まる行は字下げしない
const OPEN_BRACKETS = '「『（(【〈《〔［｛〝“‘';
const LEADING_SPACE_RE = /^[ 　\t]/;
const CARET_MOVE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
let autoIndentAt = null; // 直前に自動字下げした行の行頭位置

function lineStartOf(value, pos) {
  return value.lastIndexOf('\n', pos - 1) + 1;
}

function lineEndOf(value, pos) {
  const i = value.indexOf('\n', pos);
  return i < 0 ? value.length : i;
}

function needsIndent(line) {
  return line !== '' && !LEADING_SPACE_RE.test(line) && !OPEN_BRACKETS.includes(line[0]);
}

// execCommand 経由で置換し、Ctrl+Z で元に戻せるようにする
function replaceRange(start, end, text) {
  editor.focus();
  editor.setSelectionRange(start, end);
  document.execCommand(text ? 'insertText' : 'delete', false, text);
}

// 全文を newValue にするが、実際に変わった範囲だけを置換する
// （元に戻した時に全文が選択されないように）
function replaceChanged(newValue) {
  const old = editor.value;
  const max = Math.min(old.length, newValue.length);
  let s = 0;
  while (s < max && old[s] === newValue[s]) s++;
  let e = 0;
  while (e < max - s && old[old.length - 1 - e] === newValue[newValue.length - 1 - e]) e++;
  // サロゲートペアの途中で切らない
  if (s > 0 && /[\uD800-\uDBFF]/.test(old[s - 1])) s--;
  if (e > 0 && /[\uDC00-\uDFFF]/.test(old[old.length - e])) e--;
  replaceRange(s, old.length - e, newValue.slice(s, newValue.length - e));
}

editor.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') {
    if (CARET_MOVE_KEYS.includes(e.key)) autoIndentAt = null;
    return;
  }
  if (!state.autoIndent || e.isComposing || e.keyCode === 229) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

  const { value, selectionStart: start, selectionEnd: end } = editor;
  const rest = value.slice(end, lineEndOf(value, end));
  if (rest !== '' && !needsIndent(rest)) {
    autoIndentAt = null;
    return;
  }
  e.preventDefault();

  // 自動で入れた空白だけの行で改行したら、その空白は残さない
  const lineStart = lineStartOf(value, start);
  let from = start;
  if (start === end && rest === '' && autoIndentAt === lineStart &&
      start === lineStart + 1 && value[lineStart] === state.indentChar) {
    from = lineStart;
  }
  replaceRange(from, end, '\n' + state.indentChar);
  autoIndentAt = editor.selectionStart - 1;
});

// 自動字下げ直後に括弧を入力したら、字下げを取り消す
function checkBracketAfterIndent() {
  if (autoIndentAt == null) return;
  const at = autoIndentAt;
  const { value, selectionStart: pos, selectionEnd } = editor;
  if (pos !== selectionEnd || lineStartOf(value, pos) !== at || !LEADING_SPACE_RE.test(value[at] || '')) {
    autoIndentAt = null;
    return;
  }
  if (pos === at + 1) return; // まだ何も入力していない
  autoIndentAt = null;
  if (!OPEN_BRACKETS.includes(value[at + 1])) return;
  replaceRange(at, at + 1, '');
  editor.setSelectionRange(pos - 1, pos - 1);
}

editor.addEventListener('input', (e) => {
  if (!e.isComposing) checkBracketAfterIndent();
});
editor.addEventListener('compositionend', () => {
  setTimeout(checkBracketAfterIndent, 0);
});
editor.addEventListener('mousedown', () => {
  autoIndentAt = null;
});

// 選択範囲を含む行全体（選択がなければ全文）の範囲
function targetLineRange() {
  const { value, selectionStart, selectionEnd } = editor;
  const hasSel = selectionStart !== selectionEnd;
  const start = hasSel ? lineStartOf(value, selectionStart) : 0;
  // 選択が次の行頭で終わっている場合、その行は含めない
  const endRef = hasSel && value[selectionEnd - 1] === '\n' ? selectionEnd - 1 : selectionEnd;
  const end = hasSel ? lineEndOf(value, endRef) : value.length;
  return { value, selectionStart, selectionEnd, hasSel, start, end };
}

// 選択範囲（なければ全文）の、字下げされていない段落に字下げを入れる
function indentAll() {
  const { value, selectionStart, hasSel, start, end } = targetLineRange();

  let caret = selectionStart;
  let offset = start;
  const lines = value.slice(start, end).split('\n').map((line) => {
    const lineOffset = offset;
    offset += line.length + 1;
    if (!needsIndent(line)) return line;
    if (lineOffset <= selectionStart) caret += state.indentChar.length;
    return state.indentChar + line;
  });
  const newText = lines.join('\n');
  if (newText === value.slice(start, end)) return;

  autoIndentAt = null;
  replaceRange(start, end, newText);
  if (hasSel) editor.setSelectionRange(start, start + newText.length);
  else editor.setSelectionRange(caret, caret);
}

// 選択範囲（なければ全文）の行頭の空白を、半角→全角 / 全角→半角 に変換する
// 1文字ずつの置き換えなので文字位置は変わらない
function convertIndent(to) {
  const { value, selectionStart, selectionEnd, start, end } = targetLineRange();
  const [fromCh, toCh] = to === 'full' ? [' ', '　'] : ['　', ' '];
  const oldText = value.slice(start, end);
  const newText = oldText.replace(/^[ 　]+/gm, (lead) => lead.replaceAll(fromCh, toCh));
  if (newText === oldText) return;

  const scrollTop = editor.scrollTop;
  autoIndentAt = null;
  replaceChanged(value.slice(0, start) + newText + value.slice(end));
  editor.setSelectionRange(selectionStart, selectionEnd);
  editor.scrollTop = scrollTop;
}

// ---- 検索・置換 ----
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const findRegex = document.getElementById('find-regex');
const findCount = document.getElementById('find-count');

function buildFindRegex(flags) {
  const q = findInput.value;
  if (!q) return null;
  const src = findRegex.checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(src, flags);
}

// 本文から一致箇所を集め直す。find.index は範囲内に収める
function updateFindMatches() {
  find.matches = [];
  find.error = false;
  let re;
  try {
    re = buildFindRegex('gm');
  } catch {
    find.error = true;
  }
  if (re) {
    for (const m of editor.value.matchAll(re)) {
      find.matches.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  if (find.index >= find.matches.length) find.index = find.matches.length - 1;
  if (find.index < 0 && find.matches.length) find.index = 0;
  updateFindCount();
}

function updateFindCount(message) {
  findCount.classList.toggle('error', find.error);
  if (message) findCount.textContent = message;
  else if (find.error) findCount.textContent = '正規表現が不正';
  else if (!findInput.value) findCount.textContent = '';
  else if (!find.matches.length) findCount.textContent = '見つかりません';
  else findCount.textContent = `${find.index + 1} / ${find.matches.length}`;
}

// 現在の一致を選択し、検索バーに隠れない位置までスクロールする
function revealCurrentMatch() {
  const m = find.matches[find.index];
  if (!m) return;
  editor.setSelectionRange(m.start, m.end);
  const el = editorBackdrop.querySelector('.find-current');
  if (!el) return;
  const top = el.offsetTop;
  const view = editor.clientHeight;
  if (top < editor.scrollTop + findBar.offsetHeight + 16 || top + el.offsetHeight > editor.scrollTop + view - 16) {
    editor.scrollTop = Math.max(0, top - view / 3);
    syncBackdropScroll();
  }
}

// pos 以降で最初の一致を現在の一致にする（なければ先頭に戻る）
function selectMatchFrom(pos) {
  updateFindMatches();
  const i = find.matches.findIndex((m) => m.start >= pos);
  find.index = i >= 0 ? i : find.matches.length ? 0 : -1;
  updateFindCount();
  renderBackdrop();
  revealCurrentMatch();
}

function openFind(mode) {
  const { value, selectionStart, selectionEnd } = editor;
  const sel = value.slice(selectionStart, selectionEnd);
  if (sel && !sel.includes('\n')) findInput.value = sel;
  find.open = true;
  findBar.classList.remove('hidden');
  const target = mode === 'replace' ? replaceInput : findInput;
  target.focus();
  target.select();
  selectMatchFrom(selectionStart);
}

function closeFind() {
  if (!find.open) return;
  find.open = false;
  find.matches = [];
  find.index = -1;
  findBar.classList.add('hidden');
  renderBackdrop();
  editor.focus();
}

function stepFind(dir) {
  if (!find.open) return openFind('find');
  const n = find.matches.length;
  if (!n) return;
  find.index = (find.index + dir + n) % n;
  updateFindCount();
  renderBackdrop();
  revealCurrentMatch();
}

// 置換後の文字列。正規表現モードでは $1 などの参照を展開する
function replacementFor(m) {
  if (!findRegex.checked) return replaceInput.value;
  const value = editor.value;
  const re = buildFindRegex('my');
  re.lastIndex = m.start;
  const replaced = value.replace(re, replaceInput.value);
  return replaced.slice(m.start, replaced.length - (value.length - m.end));
}

// replaceRange は editor にフォーカスを移すので、操作していた欄に戻す
function withFocusKept(fn) {
  const active = document.activeElement;
  fn();
  if (active && active !== editor) active.focus();
}

function replaceCurrent() {
  const m = find.matches[find.index];
  if (!m) return;
  const text = replacementFor(m);
  autoIndentAt = null;
  withFocusKept(() => replaceRange(m.start, m.end, text));
  // 置換した文字列の中は再検索しない
  selectMatchFrom(m.start + text.length);
}

function replaceAll() {
  let re;
  try {
    re = buildFindRegex('gm');
  } catch {
    return;
  }
  const count = find.matches.length;
  if (!re || !count) return;
  const value = editor.value;
  const newValue = findRegex.checked
    ? value.replace(re, replaceInput.value)
    : value.replace(re, () => replaceInput.value);
  if (newValue === value) return;

  // Ctrl+Z で一度に戻せるよう、1回の編集として置き換える
  const scrollTop = editor.scrollTop;
  const caret = Math.min(editor.selectionStart, newValue.length);
  autoIndentAt = null;
  withFocusKept(() => replaceChanged(newValue));
  editor.setSelectionRange(caret, caret);
  editor.scrollTop = scrollTop;
  syncBackdropScroll();
  updateFindCount(`${count}件置換`);
}

findInput.addEventListener('input', () => selectMatchFrom(editor.selectionStart));
findRegex.addEventListener('change', () => selectMatchFrom(editor.selectionStart));
document.getElementById('find-prev').addEventListener('click', () => stepFind(-1));
document.getElementById('find-next').addEventListener('click', () => stepFind(1));
document.getElementById('find-close').addEventListener('click', closeFind);
document.getElementById('replace-one').addEventListener('click', replaceCurrent);
document.getElementById('replace-all').addEventListener('click', replaceAll);

findBar.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  } else if (e.key === 'Enter' && e.target === findInput) {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Enter' && e.target === replaceInput) {
    e.preventDefault();
    replaceCurrent();
  }
});

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && find.open) closeFind();
});

editor.addEventListener('input', () => {
  if (find.open) updateFindMatches();
  renderBackdrop();
  updateStatus();
  if (!previewPane.classList.contains('collapsed')) schedulePreview({ preserveScroll: true });
});

// ---- ファイル操作 ----
async function doOpen() {
  if (!(await confirmDiscardIfDirty())) return;
  const res = await window.api.openFile();
  if (!res) return;
  clearDriveState();
  state.filePath = res.path;
  loadContent(res.content);
}

async function doSave() {
  if (state.source === 'drive') return doDriveSave();
  const saved = await window.api.saveFile({ path: state.filePath, content: editor.value });
  if (!saved) return false;
  state.filePath = saved;
  state.savedContent = editor.value;
  updateStatus();
  return true;
}

async function doSaveAs() {
  const saved = await window.api.saveFileAs({ content: editor.value });
  if (!saved) return false;
  clearDriveState();
  state.filePath = saved;
  state.savedContent = editor.value;
  updateStatus();
  return true;
}

async function doNew() {
  if (!(await confirmDiscardIfDirty())) return;
  clearDriveState();
  state.filePath = null;
  loadContent('');
}

function loadContent(content) {
  editor.value = content;
  if (find.open) updateFindMatches();
  renderBackdrop();
  state.savedContent = content;
  updateStatus();
  schedulePreview();
}

// ---- Googleドライブ ----
function clearDriveState() {
  state.source = 'local';
  state.driveFileId = null;
  state.driveName = null;
  state.driveModifiedTime = null;
  state.driveIgnoredTime = null;
}

function setDriveFile(meta, content) {
  state.source = 'drive';
  state.filePath = null;
  state.driveFileId = meta.id;
  state.driveName = meta.name;
  state.driveModifiedTime = meta.modifiedTime;
  state.driveIgnoredTime = null;
  if (content !== undefined) loadContent(content);
  else updateStatus();
}

async function doDriveOpen() {
  if (!(await confirmDiscardIfDirty())) return;
  const files = await window.api.driveList();
  if (!files) return;
  const id = await showDriveModal({ title: 'ドライブから開く', files });
  if (!id) return;
  const res = await window.api.driveOpen(id);
  if (!res) return;
  setDriveFile(res.meta, res.content);
}

async function doDriveSave() {
  if (state.source !== 'drive') return doDriveSaveAs();
  const content = editor.value;
  const res = await window.api.driveSave({
    id: state.driveFileId,
    content,
    baseModifiedTime: state.driveModifiedTime,
    baseContent: state.savedContent,
  });
  if (!res || res.status === 'canceled') return false;
  if (res.status === 'reload') {
    setDriveFile(res.meta, res.content);
    return false;
  }
  state.savedContent = content;
  setDriveFile(res.meta);
  return true;
}

async function doDriveSaveAs() {
  const base = state.source === 'drive' ? state.driveName
    : state.filePath ? state.filePath.split(/[\\/]/).pop().replace(/\.txt$/i, '') : '無題';
  const name = await showDriveModal({ title: 'ドライブに名前を付けて保存', name: base });
  if (!name) return false;
  const content = editor.value;
  const res = await window.api.driveSave({ id: null, name, content });
  if (!res || res.status !== 'saved') return false;
  state.savedContent = content;
  setDriveFile(res.meta);
  return true;
}

// フォーカス復帰時に、スマホ等での更新を確認する
let driveChecking = false;
async function checkDriveRemote() {
  if (state.source !== 'drive' || driveChecking || !driveModal.classList.contains('hidden')) return;
  driveChecking = true;
  try {
    const id = state.driveFileId;
    const res = await window.api.driveCheck({
      id,
      baseModifiedTime: state.driveModifiedTime,
      baseContent: state.savedContent,
    });
    if (!res || id !== state.driveFileId) return;
    if (!res.changed) {
      state.driveModifiedTime = res.meta.modifiedTime;
      return;
    }
    if (res.meta.modifiedTime === state.driveIgnoredTime) return;
    if (await window.api.driveConfirmReload({ dirty: state.dirty })) {
      setDriveFile(res.meta, res.content);
    } else {
      state.driveIgnoredTime = res.meta.modifiedTime;
    }
  } finally {
    driveChecking = false;
  }
}

// ファイル選択（files を渡す）または名前入力（name を渡す）の簡易モーダル
const driveModal = document.getElementById('drive-modal');
const driveModalTitle = document.getElementById('drive-modal-title');
const driveFileList = document.getElementById('drive-file-list');
const driveNameInput = document.getElementById('drive-name-input');
const driveOk = document.getElementById('drive-ok');
const driveCancel = document.getElementById('drive-cancel');

function showDriveModal({ title, files, name }) {
  return new Promise((resolve) => {
    const pickMode = !!files;
    let selectedId = null;
    driveModalTitle.textContent = title;
    driveFileList.classList.toggle('hidden', !pickMode);
    driveNameInput.classList.toggle('hidden', pickMode);
    driveFileList.replaceChildren();

    const finish = (value) => {
      driveModal.classList.add('hidden');
      driveOk.onclick = driveCancel.onclick = driveModal.onkeydown = driveNameInput.oninput = null;
      editor.focus();
      resolve(value);
    };
    const updateOk = () => {
      driveOk.disabled = pickMode ? !selectedId : !driveNameInput.value.trim();
    };

    if (pickMode) {
      if (files.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'ドライブの「小説エディタ」フォルダにファイルがありません。';
        driveFileList.append(li);
      }
      for (const f of files) {
        const li = document.createElement('li');
        const nameEl = document.createElement('span');
        nameEl.textContent = f.name;
        const timeEl = document.createElement('span');
        timeEl.className = 'time';
        timeEl.textContent = new Date(f.modifiedTime).toLocaleString();
        li.append(nameEl, timeEl);
        li.onclick = () => {
          driveFileList.querySelectorAll('li').forEach((el) => el.classList.remove('selected'));
          li.classList.add('selected');
          selectedId = f.id;
          updateOk();
        };
        li.ondblclick = () => finish(f.id);
        driveFileList.append(li);
      }
    } else {
      driveNameInput.value = name || '';
      driveNameInput.oninput = updateOk;
    }

    driveOk.onclick = () => finish(pickMode ? selectedId : driveNameInput.value.trim());
    driveCancel.onclick = () => finish(null);
    driveModal.onkeydown = (e) => {
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'Enter' && !driveOk.disabled) driveOk.click();
    };
    updateOk();
    driveModal.classList.remove('hidden');
    if (pickMode) driveOk.focus();
    else {
      driveNameInput.focus();
      driveNameInput.select();
    }
  });
}

async function confirmDiscardIfDirty() {
  if (!state.dirty) return true;
  return await window.api.confirmDiscard();
}

window.__confirmClose = confirmDiscardIfDirty;

// ---- メニュー受信 ----
window.api.onMenu('menu:new', doNew);
window.api.onMenu('menu:open', doOpen);
window.api.onMenu('menu:save', doSave);
window.api.onMenu('menu:save-as', doSaveAs);
window.api.onMenu('menu:drive-open', doDriveOpen);
window.api.onMenu('menu:drive-save', doDriveSave);
window.api.onMenu('menu:drive-save-as', doDriveSaveAs);
window.api.onMenu('drive:focus', checkDriveRemote);
window.api.onMenu('menu:toggle-preview', () => {
  const hidden = previewPane.classList.toggle('collapsed');
  editorPane.classList.toggle('expanded', hidden);
  if (!hidden) schedulePreview();
});
window.api.onMenu('menu:auto-indent', (_e, on) => {
  state.autoIndent = !!on;
  autoIndentAt = null;
});
window.api.onMenu('menu:indent-char', (_e, kind) => {
  state.indentChar = kind === 'half' ? ' ' : '　';
});
window.api.onMenu('menu:indent-all', indentAll);
window.api.onMenu('menu:convert-indent', (_e, to) => convertIndent(to));
window.api.onMenu('menu:find', (_e, mode) => openFind(mode));
window.api.onMenu('menu:find-step', (_e, dir) => stepFind(dir));
window.api.onMenu('menu:show-spaces', (_e, on) => {
  document.body.classList.toggle('show-spaces', !!on);
});
window.api.onMenu('menu:paper-size', (_e, key) => {
  if (PAPER_SIZES[key]) {
    state.paperKey = key;
    schedulePreview();
  }
});

// ---- プレビュー装飾コントロール ----
function setZoom(z) {
  state.zoom = Math.max(0.3, Math.min(3, z));
  zoomSlider.value = String(Math.round(state.zoom * 100));
  zoomValue.textContent = Math.round(state.zoom * 100) + '%';
  // 全ページのzoomを直接更新（再レイアウトを避けて軽く）
  document.querySelectorAll('.preview-page').forEach((el) => {
    el.style.zoom = String(state.zoom);
  });
}

fontSelect.addEventListener('change', () => {
  state.fontFamily = fontSelect.value;
  document.querySelectorAll('.preview-text').forEach((el) => {
    el.style.fontFamily = state.fontFamily;
  });
});

colorInput.addEventListener('input', () => {
  state.color = colorInput.value;
  document.querySelectorAll('.preview-text').forEach((el) => {
    el.style.color = state.color;
  });
});

// 原稿用紙表示は字数×行数のマスで1段なので、段数だけ触れないようにする
genkouInput.addEventListener('change', () => {
  state.genkou = genkouInput.checked;
  colsInput.disabled = state.genkou;
  updateStatus();
  schedulePreview();
});

zoomSlider.addEventListener('input', () => {
  setZoom(Number(zoomSlider.value) / 100);
});

function bindLayoutInput(el, key, min, max) {
  el.addEventListener('change', () => {
    let v = parseInt(el.value, 10);
    if (!Number.isFinite(v)) v = state[key];
    v = Math.max(min, Math.min(max, v));
    el.value = String(v);
    state[key] = v;
    updateStatus();
    schedulePreview();
  });
}
bindLayoutInput(charsInput, 'charsPerColumn', 1, 80);
bindLayoutInput(linesInput, 'linesPerColumn', 1, 80);
bindLayoutInput(colsInput,  'columns',        1, 4);

// Ctrl+ホイールでプレビューをズーム
previewScroll.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.1 : 0.1;
  setZoom(state.zoom + delta);
}, { passive: false });

// ---- 初期化 ----
renderBackdrop();
updateStatus();
renderPreview();
setZoom(state.zoom);
