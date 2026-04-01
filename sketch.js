/**
 * Attention Type — generative 0/1 letterforms on a single ATTENTION axis (100 → 0).
 */

/** SF Mono on Apple; ui-monospace / Menlo / Monaco / Consolas elsewhere (not web-hosted). */
const MONO_FONT_P5 = "SF Mono, Menlo, Monaco, Consolas, monospace";
const MONO_FONT_CANVAS = '"SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace';

let attentionInput;
/** Raw typed text (newlines = manual line breaks; width-wrap still applies per block). */
const PLACEHOLDER_PHRASE = "Pay Attention to Me!";
let phraseBuffer = PLACEHOLDER_PHRASE;
/** Until first click or key, show placeholder; then clear and show caret. */
let awaitingFirstEdit = true;
let fontReady = false;
/** Canvas DOM node — focus checks and caret blink. */
let phraseCanvasElt = null;
let caretBlinkId = 0;
let caretBlinkOn = true;
/** Last wrapped lines + longest row length (mask space), for caret position). */
let lastLayout = { lines: [""], longestLen: 1 };
/** Text selection in phraseBuffer: [start, end) indices; null when collapsed. */
let phraseSelection = null;

/**
 * Fixed mask resolution per character (like a tile grid / pixel font).
 * Phrase length only grows the canvas; each letter keeps the same sampling density.
 */
/** Width of each character’s mask tile — sets drawn glyph size (independent of spacing). */
const MASK_CELL_W = 80;
/**
 * Horizontal advance between character origins (left edges) in mask space.
 * Smaller than MASK_CELL_W tightens letter gaps without shrinking the glyph.
 */
const CELL_ADVANCE_X = 60;
const CELL_H = 100;
const MASK_CHAR_TEXT_SIZE = Math.min(CELL_H * 0.76, MASK_CELL_W * 0.95);

/**
 * Mask sampling stride in pixels. Lower = denser grid (heavier draw loop).
 * Slightly finer than 4 so smaller on-screen glyphs still read as a rich letterform.
 */
const MASK_STEP = 3;
/** Include antialiased fringe so letters read solid; lower = denser bits (slightly more draw work). */
const MASK_LUM_THRESH = 58;

/** Cached mask graphics + bit positions (rebuilt when phrase changes). */
let maskG;
let bits = [];
/**
 * Bounds of filled mask pixels (mask space).
 * minX/minY anchor top-left for scroll layout; cx/cy are centroid; span* is tight extent.
 */
let maskBounds = {
  minX: 0,
  minY: 0,
  maxX: MASK_CELL_W,
  maxY: CELL_H,
  cx: MASK_CELL_W / 2,
  cy: CELL_H / 2,
  spanW: MASK_CELL_W,
  spanH: CELL_H,
};

/**
 * Fixed mask px → canvas px. Phrase length only grows the canvas; each letter + 0/1 grid stay the same size.
 */
/** Chosen with larger CELL_* so on-screen letter size stays similar to the old 112×cell @ 0.9 scale. */
const SCREEN_MASK_SCALE = 0.79;

/** UI slider 50–150% as multiplier on SCREEN_MASK_SCALE (mask rebuild refreshes wrap). */
function typeSizeMul() {
  const el = document.getElementById("type-size");
  let v = el ? Number(el.value) : 100;
  if (!Number.isFinite(v)) v = 100;
  return constrain(v, 50, 150) / 100;
}

function screenMaskScaleEffective() {
  return SCREEN_MASK_SCALE * typeSizeMul();
}
const LAYOUT_PAD = 28;
/**
 * Horizontal inset from viewport edges when deciding how many characters fit on one line.
 * Smaller than full drift margin so lines stay readable on typical desktop widths.
 */
const WRAP_H_PAD = LAYOUT_PAD + 80;
/** Clamp dynamic chars-per-line (hard-wrap still splits longer tokens). */
const CHARS_PER_LINE_MIN = 4;
const CHARS_PER_LINE_MAX = 100;
/** Max characters stored in phraseBuffer (including newlines). */
const PHRASE_MAX_LEN = 120;
/** Extra canvas height below the glyph (no bottom bar; small breathing room). */
const CANVAS_BOTTOM_UI_CLEAR = 48;

/** On-screen 0/1 size (smaller = more bits, busier letterform). */
const GLYPH_SIZE_SCALE = 0.58;
/** Minimum per-glyph opacity at attention 0 (never fully erase the field). */
const BIT_OPACITY_FLOOR = 0.58;

let phraseDebounceId = 0;
let redrawRafId = 0;
let resizeLayoutRafId = 0;

/** Width of the main canvas column (right of the control panel). */
function layoutContentWidth() {
  const host = document.getElementById("sketch-host");
  if (host && host.clientWidth > 0) return host.clientWidth;
  return max(100, windowWidth - 300);
}

function parseHexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return { r: 26, g: 26, b: 34 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function getBitColorsFromUI() {
  const el0 = document.getElementById("color-bit-0");
  const el1 = document.getElementById("color-bit-1");
  return {
    zero: parseHexColor(el0 && el0.value ? el0.value : "#1a1a22"),
    one: parseHexColor(el1 && el1.value ? el1.value : "#12121a"),
  };
}

function getBackgroundHex() {
  const el = document.getElementById("color-background");
  const v = el && el.value ? el.value.trim() : "#ffffff";
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : "#ffffff";
}

function syncSketchHostBackground() {
  const host = document.getElementById("sketch-host");
  if (host) host.style.backgroundColor = getBackgroundHex();
}

/** 0 = black, 1 = white — for caret / hint / selection contrast. */
function backgroundLuminance01() {
  const { r, g, b } = parseHexColor(getBackgroundHex());
  return constrain((0.299 * r + 0.587 * g + 0.114 * b) / 255, 0, 1);
}

/**
 * Shared 0/1 screen state for canvas draw and SVG export (same math as the live view).
 */
function computeBitDrawState(b, att, cx, cy, bx, by, scale, tm, alphaNorm, colors) {
  const nx = (b.seed % 97) / 97;
  const ny = (floor(b.seed / 97) % 97) / 97;
  const n1 = b.n1;
  const n2 = b.n2;
  const n3 = b.n3;

  const attC = constrain(att, 0, 100);
  const drift = driftAmount(att);
  const scat = scatterFactor(att);
  const driftMul = 5.2 + attC * 0.04;
  let dx = (n1 - 0.5) * 2 * drift * driftMul;
  let dy = (n2 - 0.5) * 2 * drift * driftMul;
  dx += (nx - 0.5) * 18 * scat;
  dy += (ny - 0.5) * 18 * scat;

  const px = cx + (b.gx - bx) * scale * tm + dx;
  const py = cy + (b.gy - by) * scale * tm + dy;

  const grain = (n3 - 0.5) * 0.72 + (n2 - 0.5) * 0.35;
  let sz = 5.2 * scale * 2.1 * GLYPH_SIZE_SCALE;
  sz *= 1 + grain;
  sz = constrain(sz, 2.4, 17);

  const sx = b.sx ?? 1;
  const sy = b.sy ?? 1;
  const wNorm = b.wNorm ?? 0.55;
  const rot = b.rot ?? 0;
  const rotEase = smoothstep(0, 100, attC);
  const rotAtt = rot * map(rotEase, 0, 1, 0.95, 0.78);

  const isOne = b.ch === "1";
  const rgb = isOne ? colors.one : colors.zero;
  const fade = 0.58 + 0.42 * smoothstep(0, 100, attC);
  /* Dark pole: strong tint of the picker (was ~12% → read as black). */
  const dMul = 0.62;
  const dr = rgb.r * dMul;
  const dg = rgb.g * dMul;
  const db = rgb.b * dMul;
  /* Bright pole: nudge toward white without the old +95 gray wash that killed hue. */
  const lift = 0.32;
  const lr = min(255, rgb.r + (255 - rgb.r) * lift);
  const lg = min(255, rgb.g + (255 - rgb.g) * lift);
  const lb = min(255, rgb.b + (255 - rgb.b) * lift);
  let cr = dr * fade + lr * (1 - fade);
  let cg = dg * fade + lg * (1 - fade);
  let cb = db * fade + lb * (1 - fade);
  cb = min(255, cb + (isOne ? 0 : 5));

  const bitOp = bitGlyphOpacity(att, b.ch, b.seed);
  const fillA = alphaNorm * bitOp;
  const fontPx = Math.max(3, Math.round(sz));
  const weight = wNorm > 0.52 ? 700 : 500;

  return { px, py, rotAtt, sx, sy, fontPx, weight, cr, cg, cb, fillA, ch: b.ch };
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildExportSvgDocument() {
  if (!width || !height) return "";
  if (!bits.length) {
    const bg = getBackgroundHex();
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n<rect width="100%" height="100%" fill="${bg}"/>\n</svg>`;
  }
  const att = getAttention();
  const tm = trackingMul();
  const scale = screenMaskScaleEffective();
  const m = layoutMargin();
  const top = topBandForLayout();
  const { minX, minY, maxX, cx: bx, cy: by } = maskBounds;
  const vw = layoutContentWidth();
  let cx = min(width, vw) * 0.5;
  const leftCore = (bx - minX) * scale * tm;
  const rightCore = (maxX - bx) * scale * tm;
  cx = constrain(cx, m + leftCore, width - m - rightCore);
  const cy = top + (by - minY) * scale * tm;
  const alphaNorm = layerAlpha(att) / 255;
  const colors = getBitColorsFromUI();
  const deg = 180 / PI;
  const pieces = [];
  for (const b of bits) {
    const st = computeBitDrawState(b, att, cx, cy, bx, by, scale, tm, alphaNorm, colors);
    const tr = `translate(${st.px.toFixed(2)},${st.py.toFixed(2)}) rotate(${(st.rotAtt * deg).toFixed(4)}) scale(${st.sx.toFixed(4)},${st.sy.toFixed(4)})`;
    pieces.push(
      `<g transform="${tr}"><text text-anchor="middle" dominant-baseline="central" font-weight="${st.weight}" font-size="${st.fontPx}" font-family="SF Mono, ui-monospace, Menlo, Monaco, Consolas, monospace" fill="rgba(${st.cr.toFixed(2)},${st.cg.toFixed(2)},${st.cb.toFixed(2)},${st.fillA.toFixed(4)})">${escapeXml(st.ch)}</text></g>`
    );
  }
  const bgHex = getBackgroundHex();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n<rect width="100%" height="100%" fill="${bgHex}"/>\n${pieces.join("\n")}\n</svg>`;
}

function downloadPng() {
  const c = document.querySelector("#sketch-host canvas");
  if (!c) return;
  const a = document.createElement("a");
  a.href = c.toDataURL("image/png");
  a.download = "attention-type.png";
  a.rel = "noopener";
  a.click();
}

function downloadSvg() {
  const svg = buildExportSvgDocument();
  if (!svg) return;
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "attention-type.svg";
  a.rel = "noopener";
  a.click();
  URL.revokeObjectURL(url);
}

function getAttention() {
  return attentionInput ? Number(attentionInput.value) : 100;
}

function stopCaretBlink() {
  caretBlinkOn = true;
  if (caretBlinkId) {
    clearInterval(caretBlinkId);
    caretBlinkId = 0;
  }
}

function startCaretBlink() {
  if (caretBlinkId) return;
  caretBlinkId = setInterval(() => {
    caretBlinkOn = !caretBlinkOn;
    if (!phraseCanvasElt) return;
    const showPlaceholder = awaitingFirstEdit && bits.length > 0;
    const showEditCaret = !awaitingFirstEdit && document.activeElement === phraseCanvasElt;
    if (showPlaceholder || showEditCaret) {
      redraw();
    }
  }, 530);
}

function schedulePhraseRebuild() {
  updatePresetButtons();
  clearTimeout(phraseDebounceId);
  phraseDebounceId = setTimeout(() => {
    rebuildBits();
    resizeCanvasToContent();
    redraw();
    startCaretBlink();
  }, 140);
}

function dismissPlaceholder() {
  if (!awaitingFirstEdit) return;
  awaitingFirstEdit = false;
  phraseSelection = null;
  phraseBuffer = "";
  stopCaretBlink();
  clearTimeout(phraseDebounceId);
  phraseDebounceId = 0;
  updatePresetButtons();
  rebuildBits();
  resizeCanvasToContent();
  redraw();
  startCaretBlink();
}

/**
 * Keep case, letters, numbers, punctuation, symbols; drop control chars (newlines kept).
 * Tabs / NBSP normalized to spaces so wrapping and the mask stay consistent.
 */
function normalizePhraseBuffer(s) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** True for a single typed character (incl. tab) or one BMP/astral glyph from key events. */
function isTypedCharacterKey(key) {
  if (key.length === 1) {
    const cp = key.codePointAt(0);
    if (cp === 0x09) return true;
    if (cp < 0x20 || cp === 0x7f) return false;
    return true;
  }
  if (key.length === 2) {
    const a = key.charCodeAt(0);
    const b = key.charCodeAt(1);
    return a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff;
  }
  return false;
}

function onPhrasePaste(e) {
  const elt = e.target;
  if (!elt || elt.tagName !== "CANVAS") return;
  e.preventDefault();
  const t = normalizePhraseBuffer(e.clipboardData.getData("text") || "");
  if (phraseSelection && phraseSelection.end > phraseSelection.start) {
    const { start, end } = phraseSelection;
    const before = phraseBuffer.slice(0, start);
    const after = phraseBuffer.slice(end);
    const maxInsert = PHRASE_MAX_LEN - before.length - after.length;
    phraseBuffer = before + (t.length ? t.slice(0, max(0, maxInsert)) : "") + after;
    phraseSelection = null;
    if (awaitingFirstEdit) awaitingFirstEdit = false;
    stopCaretBlink();
    schedulePhraseRebuild();
    return;
  }
  if (awaitingFirstEdit) {
    awaitingFirstEdit = false;
    phraseBuffer = "";
    stopCaretBlink();
  }
  if (!t.length) {
    schedulePhraseRebuild();
    return;
  }
  const room = PHRASE_MAX_LEN - phraseBuffer.length;
  phraseBuffer += room <= 0 ? "" : t.slice(0, room);
  schedulePhraseRebuild();
}

function onPhraseKeydown(e) {
  const elt = e.target;
  if (!elt || elt.tagName !== "CANVAS") return;

  if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    e.stopPropagation();
    phraseSelection = { start: 0, end: phraseBuffer.length };
    redraw();
    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    if (phraseSelection && phraseSelection.end > phraseSelection.start) {
      phraseBuffer = phraseBuffer.slice(0, phraseSelection.start) + phraseBuffer.slice(phraseSelection.end);
      phraseSelection = null;
      if (awaitingFirstEdit && !phraseBuffer.length) {
        awaitingFirstEdit = false;
        stopCaretBlink();
      }
      schedulePhraseRebuild();
      return;
    }
    phraseSelection = null;
    if (awaitingFirstEdit) {
      awaitingFirstEdit = false;
      phraseBuffer = "";
      stopCaretBlink();
    }
    if (!phraseBuffer.length) {
      schedulePhraseRebuild();
      return;
    }
    phraseBuffer = phraseBuffer.slice(0, -1);
    schedulePhraseRebuild();
    return;
  }

  if (awaitingFirstEdit) {
    if (e.key === "Tab" || e.key === "Escape") return;
    const willEdit =
      e.key === "Enter" ||
      (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey);
    if (!willEdit) return;
    awaitingFirstEdit = false;
    if (phraseSelection && phraseSelection.end > phraseSelection.start) {
      const { start, end } = phraseSelection;
      phraseBuffer = phraseBuffer.slice(0, start) + phraseBuffer.slice(end);
      phraseSelection = null;
    } else {
      phraseBuffer = "";
    }
    stopCaretBlink();
  }

  if (e.key === "Enter") {
    if (phraseSelection && phraseSelection.end > phraseSelection.start) {
      const { start, end } = phraseSelection;
      phraseBuffer = phraseBuffer.slice(0, start) + phraseBuffer.slice(end);
      phraseSelection = null;
    }
    if (phraseBuffer.length < PHRASE_MAX_LEN) {
      phraseBuffer += "\n";
      schedulePhraseRebuild();
    }
    e.preventDefault();
    return;
  }
  if (e.key === "Delete") {
    if (phraseSelection && phraseSelection.end > phraseSelection.start) {
      e.preventDefault();
      phraseBuffer = phraseBuffer.slice(0, phraseSelection.start) + phraseBuffer.slice(phraseSelection.end);
      phraseSelection = null;
      if (awaitingFirstEdit && !phraseBuffer.length) {
        awaitingFirstEdit = false;
        stopCaretBlink();
      }
      schedulePhraseRebuild();
    }
    e.preventDefault();
    return;
  }
  if (e.key === "Dead" || e.key === "Process") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!isTypedCharacterKey(e.key)) return;
  const chunk = normalizePhraseBuffer(e.key);
  if (!chunk.length) return;

  if (phraseSelection && phraseSelection.end > phraseSelection.start) {
    const { start, end } = phraseSelection;
    const before = phraseBuffer.slice(0, start);
    const after = phraseBuffer.slice(end);
    const maxInsert = PHRASE_MAX_LEN - before.length - after.length;
    phraseBuffer = before + chunk.slice(0, max(0, maxInsert)) + after;
    phraseSelection = null;
    schedulePhraseRebuild();
    e.preventDefault();
    return;
  }

  if (phraseBuffer.length >= PHRASE_MAX_LEN) return;
  const room = PHRASE_MAX_LEN - phraseBuffer.length;
  phraseBuffer += chunk.slice(0, room);
  schedulePhraseRebuild();
  e.preventDefault();
}

function setup() {
  const canvas = createCanvas(max(100, layoutContentWidth()), max(100, windowHeight));
  canvas.parent("sketch-host");
  textFont(MONO_FONT_P5);

  const elt = canvas.elt;
  phraseCanvasElt = elt;
  elt.setAttribute("tabindex", "0");
  elt.setAttribute("role", "textbox");
  elt.setAttribute("aria-multiline", "true");
  elt.setAttribute(
    "aria-label",
    "Click to start typing. Placeholder: Pay Attention to Me. Then type letters, numbers, punctuation, symbols, or Enter for a new line."
  );
  elt.style.outline = "none";
  elt.addEventListener("pointerdown", () => {
    phraseSelection = null;
    if (awaitingFirstEdit) {
      dismissPlaceholder();
    }
    elt.focus();
  });
  elt.addEventListener("keydown", onPhraseKeydown, true);
  elt.addEventListener("paste", onPhrasePaste);
  elt.addEventListener("blur", () => {
    phraseSelection = null;
    if (!awaitingFirstEdit) stopCaretBlink();
  });
  elt.addEventListener("focus", () => {
    startCaretBlink();
  });

  attentionInput = document.getElementById("attention");

  attentionInput.addEventListener("input", () => {
    updatePresetButtons();
    scheduleRedraw();
  });

  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = Number(btn.getAttribute("data-attention"));
      if (!Number.isFinite(v)) return;
      attentionInput.value = String(constrain(v, 0, 100));
      attentionInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  const colorBit0 = document.getElementById("color-bit-0");
  const colorBit1 = document.getElementById("color-bit-1");
  const colorBg = document.getElementById("color-background");
  if (colorBit0) colorBit0.addEventListener("input", scheduleRedraw);
  if (colorBit1) colorBit1.addEventListener("input", scheduleRedraw);
  if (colorBg) {
    colorBg.addEventListener("input", () => {
      syncSketchHostBackground();
      scheduleRedraw();
    });
  }
  syncSketchHostBackground();

  function updateTypeSizeLabel() {
    const el = document.getElementById("type-size");
    const lab = document.getElementById("type-size-label");
    if (!el || !lab) return;
    lab.textContent = `${el.value}%`;
    el.setAttribute("aria-valuenow", el.value);
  }
  const typeSizeEl = document.getElementById("type-size");
  if (typeSizeEl) {
    let typeSizeRaf = 0;
    typeSizeEl.addEventListener("input", () => {
      updateTypeSizeLabel();
      cancelAnimationFrame(typeSizeRaf);
      typeSizeRaf = requestAnimationFrame(() => {
        rebuildBits();
        resizeCanvasToContent();
        redraw();
      });
    });
    updateTypeSizeLabel();
  }

  const pngBtn = document.getElementById("download-png");
  const svgBtn = document.getElementById("download-svg");
  if (pngBtn) pngBtn.addEventListener("click", downloadPng);
  if (svgBtn) svgBtn.addEventListener("click", downloadSvg);

  const sketchHost = document.getElementById("sketch-host");
  if (sketchHost && typeof ResizeObserver !== "undefined") {
    let roRaf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(roRaf);
      roRaf = requestAnimationFrame(() => {
        rebuildBits();
        resizeCanvasToContent();
        redraw();
      });
    }).observe(sketchHost);
  }

  maskG = createGraphics(MASK_CELL_W, CELL_H);
  maskG.pixelDensity(1);
  rebuildBits();
  resizeCanvasToContent();
  updatePresetButtons();
  fontReady = true;
  noLoop();
  startCaretBlink();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      rebuildBits();
      resizeCanvasToContent();
      redraw();
    });
  }
}

function updatePresetButtons() {
  const a = getAttention();
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    const band = btn.getAttribute("data-band");
    let on = false;
    if (band === "present") on = a >= 65;
    else if (band === "distracted") on = a >= 30 && a < 65;
    else if (band === "absent") on = a < 30;
    btn.classList.toggle("is-active", on);
  });
}

/**
 * Word-wrap one paragraph (no newlines inside `cleaned`). Breaks on spaces; long tokens hard-wrapped.
 */
function wrapParagraphWords(cleaned, maxPerLine) {
  if (!cleaned.length) return [];
  const words = cleaned.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxPerLine) {
      if (current.length) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += maxPerLine) {
        lines.push(word.slice(i, i + maxPerLine));
      }
      continue;
    }
    const candidate = current.length ? `${current} ${word}` : word;
    if (candidate.length <= maxPerLine) {
      current = candidate;
    } else {
      if (current.length) lines.push(current);
      current = word;
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

/**
 * Split on Enter first, then wrap each block to viewport width (`maxPerLine`).
 * Leading whitespace is trimmed per block; trailing spaces are kept so the caret advances after a space.
 */
function wrapPhraseToLines(phrase, maxPerLine) {
  const lines = [];
  for (const block of phrase.split("\n")) {
    let cleaned = block.replace(/\s+/g, " ").trimStart();
    if (!cleaned.length) {
      if (/\s/.test(block)) cleaned = " ";
      else continue;
    }
    lines.push(...wrapParagraphWords(cleaned, maxPerLine));
  }
  return lines;
}

/** Recreate mask buffer when phrase dimensions change. */
function ensureMaskGraphics(w, h) {
  if (!maskG || maskG.width !== w || maskG.height !== h) {
    maskG = createGraphics(w, h);
    maskG.pixelDensity(1);
  }
}

/** Deterministic mix — same (row, col, lx, ly) always yields same 0/1 and traits when phrase edits. */
function stableBitKey(row, col, lx, ly) {
  let h = (row | 0) * 0x9e3779b1;
  h ^= (col | 0) * 0x85ebca6b;
  h ^= (floor(lx) | 0) * 0xc2b2ae35;
  h ^= (floor(ly) | 0) * 0x27d4eb2d;
  h = Math.imul(h ^ (h >>> 16), 0x7feb792d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return h >>> 0;
}

/**
 * Map mask x (relative to line’s left padding) to column. Overlap only checks ~ceil(W/A) candidates, not full line length.
 * When multiple tiles cover relX, keep the rightmost (matches draw order).
 */
function maskColFromRelX(relX, lineLen) {
  const A = CELL_ADVANCE_X;
  const W = MASK_CELL_W;
  if (lineLen <= 0 || relX < 0) return -1;
  if (A >= W) {
    const c = floor(relX / A);
    if (c < 0 || c >= lineLen) return -1;
    if (relX >= c * A + W) return -1;
    return c;
  }
  const cLow = max(0, Math.ceil((relX - W) / A));
  const cHigh = min(lineLen - 1, floor(relX / A));
  let col = -1;
  for (let c = cLow; c <= cHigh; c++) {
    if (relX >= c * A && relX < c * A + W) col = c;
  }
  return col;
}

/**
 * Build list of { gx, gy, ch } for letter interior from rasterized text mask.
 */
function rebuildBits() {
  bits = [];
  const phrase = normalizePhraseBuffer(phraseBuffer);
  if (!phrase.length) {
    lastLayout = { lines: [""], longestLen: 1 };
    maskBounds = {
      minX: 0,
      minY: 0,
      maxX: MASK_CELL_W,
      maxY: CELL_H,
      cx: MASK_CELL_W / 2,
      cy: CELL_H / 2,
      spanW: MASK_CELL_W,
      spanH: CELL_H,
    };
    return;
  }

  const lines = wrapPhraseToLines(phrase, charsPerLineForViewport());
  if (!lines.length) {
    lastLayout = { lines: [""], longestLen: 1 };
    maskBounds = {
      minX: 0,
      minY: 0,
      maxX: MASK_CELL_W,
      maxY: CELL_H,
      cx: MASK_CELL_W / 2,
      cy: CELL_H / 2,
      spanW: MASK_CELL_W,
      spanH: CELL_H,
    };
    return;
  }

  const longestLen = Math.max(...lines.map((ln) => ln.length), 1);
  lastLayout = { lines: lines.slice(), longestLen };
  const maskW = (longestLen - 1) * CELL_ADVANCE_X + MASK_CELL_W;
  const maskH = lines.length * CELL_H;

  ensureMaskGraphics(maskW, maskH);
  maskG.pixelDensity(1);
  maskG.background(0);
  maskG.noStroke();
  maskG.fill(255);
  maskG.textAlign(CENTER, CENTER);
  maskG.textStyle(BOLD);
  maskG.textFont(MONO_FONT_P5);
  maskG.textSize(MASK_CHAR_TEXT_SIZE);

  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    const offsetX = ((longestLen - line.length) * CELL_ADVANCE_X) / 2;
    for (let col = 0; col < line.length; col++) {
      const char = line[col];
      if (/\s/u.test(char)) continue;
      const cxCell = offsetX + col * CELL_ADVANCE_X + MASK_CELL_W / 2;
      const cyCell = row * CELL_H + CELL_H / 2;
      maskG.text(char, cxCell, cyCell);
    }
  }

  maskG.loadPixels();
  const w = maskG.width;
  const h = maskG.height;
  const d = maskG.pixelDensity();
  const step = MASK_STEP;

  for (let y = step; y < h - step; y += step) {
    const row = floor(y / CELL_H);
    if (row < 0 || row >= lines.length) continue;
    const line = lines[row];
    const offsetXRow = ((longestLen - line.length) * CELL_ADVANCE_X) / 2;
    for (let x = step; x < w - step; x += step) {
      const i = 4 * ((y * d) * (w * d) + x * d);
      const lum = maskG.pixels[i] * 0.299 + maskG.pixels[i + 1] * 0.587 + maskG.pixels[i + 2] * 0.114;
      if (lum > MASK_LUM_THRESH) {
        const relX = x - offsetXRow;
        const col = maskColFromRelX(relX, line.length);
        if (col < 0 || /\s/u.test(line[col])) continue;
        const lx = relX - col * CELL_ADVANCE_X;
        const ly = y - row * CELL_H;
        const key = stableBitKey(row, col, lx, ly);
        const ch = (key & 1) === 0 ? "0" : "1";
        const seed = key % 100000;
        const traits = glyphTraits(lx, ly, row, col, ch, seed);
        const zCell = row * 0.17 + col * 0.23;
        const n1 = noise(lx * 0.04, ly * 0.04, seed * 0.01 + zCell);
        const n2 = noise(ly * 0.05, seed * 0.02 + zCell);
        const n3 = noise(seed * 0.1 + zCell, lx * 0.02, ly * 0.02);
        bits.push({
          gx: x,
          gy: y,
          ch,
          seed,
          n1,
          n2,
          n3,
          ...traits,
        });
      }
    }
  }

  if (bits.length === 0) {
    maskBounds = {
      minX: 0,
      minY: 0,
      maxX: maskW,
      maxY: maskH,
      cx: maskW / 2,
      cy: maskH / 2,
      spanW: maskW,
      spanH: maskH,
    };
    return;
  }

  let minX = maskW;
  let maxX = 0;
  let minY = maskH;
  let maxY = 0;
  for (const b of bits) {
    minX = min(minX, b.gx);
    maxX = max(maxX, b.gx);
    minY = min(minY, b.gy);
    maxY = max(maxY, b.gy);
  }
  const spanW = max(MASK_STEP * 3, maxX - minX + MASK_STEP * 2);
  const spanH = max(MASK_STEP * 3, maxY - minY + MASK_STEP * 2);
  maskBounds = {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    spanW,
    spanH,
  };
}

function scheduleRedraw() {
  if (redrawRafId) return;
  redrawRafId = requestAnimationFrame(() => {
    redrawRafId = 0;
    redraw();
  });
}

function windowResized() {
  if (resizeLayoutRafId) cancelAnimationFrame(resizeLayoutRafId);
  resizeLayoutRafId = requestAnimationFrame(() => {
    resizeLayoutRafId = 0;
    rebuildBits();
    resizeCanvasToContent();
    redraw();
  });
}

/** Worst-case drift padding so low-attention motion never clips. */
function layoutMargin() {
  return LAYOUT_PAD + maxDriftScreenPx(0);
}

/**
 * Padding above the glyph bbox. Keeps the mask centroid near the viewport vertical center
 * so placeholder and typed text stay in the middle instead of snapping to the top.
 */
function topBandForLayout() {
  const m = layoutMargin();
  const tm = trackingMul();
  const scale = screenMaskScaleEffective();
  const { minY, cy: by } = maskBounds;
  const centroidOff = (by - minY) * scale * tm;
  const targetTop = windowHeight * 0.5 - centroidOff;
  return max(m, targetTop);
}

/** How many monospace cells fit in the current viewport width (recomputed on resize). */
function charsPerLineForViewport() {
  const tm = trackingMul();
  const charW = CELL_ADVANCE_X * screenMaskScaleEffective() * tm;
  const avail = layoutContentWidth() - 2 * WRAP_H_PAD;
  const n = floor(avail / charW);
  return constrain(n, CHARS_PER_LINE_MIN, CHARS_PER_LINE_MAX);
}

/**
 * Canvas grows with mask bounds × fixed scale; page scrolls instead of shrinking the whole piece.
 */
function resizeCanvasToContent() {
  const tm = trackingMul();
  const { spanW, spanH } = maskBounds;
  const scale = screenMaskScaleEffective();
  const m = layoutMargin();
  const contentW = spanW * scale * tm;
  const contentH = spanH * scale * tm;
  const hostW = layoutContentWidth();
  const w = max(hostW, ceil(contentW + 2 * m));
  const topBand = topBandForLayout();
  const h = ceil(topBand + contentH + m + CANVAS_BOTTOM_UI_CLEAR);
  if (width !== w || height !== h) {
    resizeCanvas(w, h);
  }
  pixelDensity(min(2, max(1, floor(displayDensity()))));
}

/**
 * Per-cell stretch (sx/sy), weight (wNorm), rotation — uses cell-local (lx,ly) + row/col so traits
 * stay stable when the mask re-centers but the character grid slot is unchanged.
 */
function glyphTraits(lx, ly, row, col, ch, seed) {
  const u = (seed * 0.001) % 1;
  const v = (seed * 0.0037) % 1;
  const z = seed * 0.0001 + row * 0.07 + col * 0.11;
  const nS = noise(lx * 0.055, ly * 0.055, z);
  const nT = noise(ly * 0.048 + 40, lx * 0.048 + 12, z + 0.02);
  const nW = noise(lx * 0.09, ly * 0.09 + 80, z + 0.03);

  let sx = map(nS, 0, 1, 0.76, 1.32);
  let sy = map(nT, 0, 1, 0.68, 1.38);
  const grain = 0.85 + u * 0.32;
  sx *= grain + (v - 0.5) * 0.22;
  sy *= grain + ((1 - v) - 0.5) * 0.22;

  if (ch === "0") {
    sx *= 1.06 + (nW - 0.5) * 0.18;
    sy *= 0.88 + (nW - 0.5) * 0.12;
  } else {
    sx *= 0.82 + (nW - 0.5) * 0.14;
    sy *= 1.12 + (nW - 0.5) * 0.2;
  }

  sx = constrain(sx, 0.62, 1.45);
  sy = constrain(sy, 0.58, 1.52);

  const wNorm = constrain(nW * 0.62 + noise(seed * 0.02, lx * 0.01 + col * 0.02) * 0.38, 0, 1);
  const rot = (noise(lx * 0.1, ly * 0.1, seed + row * 0.31 + col * 0.29) - 0.5) * 0.14;

  return { sx, sy, wNorm, rot };
}

/** Smooth Hermite 0..1 */
function smoothstep(edge0, edge1, x) {
  const t = constrain((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Drift scales smoothly with attention (no kinks at 65/30).
 * Kept modest so “absent” still feels like the same letter, not a cloud.
 */
function driftAmount(att) {
  const a = constrain(att, 0, 100);
  const inv = 1 - smoothstep(0, 100, a);
  const invEase = inv * inv * inv;
  return map(invEase, 0, 1, 0.06, 1.85);
}

/** Scatter factor 0 = calm, 1 = max offset (scaled down in draw). */
function scatterFactor(att) {
  const a = constrain(att, 0, 100);
  const inv = 1 - smoothstep(0, 100, a);
  return inv * inv * inv * inv;
}

/** Worst-case screen-space offset from drift + scatter (matches draw loop). */
function maxDriftScreenPx(att) {
  const drift = driftAmount(att);
  const attC = constrain(att, 0, 100);
  const driftPx = drift * (6 + attC * 0.05);
  const sc = scatterFactor(att);
  const scatterPx = 17 * sc;
  return driftPx + scatterPx + 52;
}

/**
 * Keeps the overall letterform (mask) at a stable scale on the canvas.
 * Tracking no longer widens with low attention — that was read as the "letter" changing size.
 */
function trackingMul() {
  return 1;
}

/**
 * Per-bit opacity vs attention — always leaves some signal at 0; 0s ease down slightly earlier than 1s.
 */
function bitGlyphOpacity(att, ch, seed) {
  const u = (seed * 0.001) % 1;
  const a = constrain(att, 0, 100);
  const t = smoothstep(0, 100, a);
  const floor = BIT_OPACITY_FLOOR;
  const span = 1 - floor;
  let o = floor + span * t;
  const zeroEase = ch === "0" ? 0.94 + 0.06 * t : 1;
  o *= zeroEase;
  o *= 0.97 + 0.06 * u;
  return constrain(o, BIT_OPACITY_FLOOR, 1);
}

/** Overall layer alpha — little falloff so absent doesn’t read as a big fade. */
function layerAlpha(att) {
  const a = constrain(att, 0, 100);
  const t = smoothstep(0, 100, a);
  return map(t, 0, 1, 228, 255);
}

function caretMaskGxGy() {
  const { lines, longestLen } = lastLayout;
  if (!lines || lines.length === 0) {
    return { gx: MASK_CELL_W / 2, gy: CELL_H / 2 };
  }
  const row = lines.length - 1;
  const line = lines[row];
  const maskW = (longestLen - 1) * CELL_ADVANCE_X + MASK_CELL_W;
  const gy = row * CELL_H + CELL_H / 2;
  if (line.length === 0) {
    return { gx: maskW / 2, gy };
  }
  const offsetX = ((longestLen - line.length) * CELL_ADVANCE_X) / 2;
  const ins = line.length;
  const gx = offsetX + ins * CELL_ADVANCE_X + MASK_CELL_W / 2;
  return { gx, gy };
}

/**
 * Map each phraseBuffer index to mask grid { row, col } (null for newlines). Requires
 * phraseBuffer.length === normalizePhraseBuffer(phraseBuffer).length for a valid map.
 */
function buildBufferIndexToCellMap(phraseBuffer) {
  const phrase = normalizePhraseBuffer(phraseBuffer);
  if (phraseBuffer.length !== phrase.length) return null;
  const { lines, longestLen } = lastLayout;
  if (!lines || lines.length === 0) return null;
  const flat = [];
  for (let r = 0; r < lines.length; r++) {
    for (let c = 0; c < lines[r].length; c++) {
      flat.push({ row: r, col: c });
    }
  }
  const map = new Array(phraseBuffer.length).fill(null);
  let j = 0;
  for (let i = 0; i < phrase.length; i++) {
    if (phrase[i] === "\n") {
      map[i] = null;
      continue;
    }
    if (j < flat.length) {
      map[i] = flat[j];
      j++;
    }
  }
  if (j !== flat.length) return null;
  return map;
}

/** Native-style blue selection behind the 0/1 field (merged per row for clean edges). */
function drawSelectionHighlight(cx, cy, bx, by, scale, tm) {
  if (!phraseSelection || phraseSelection.end <= phraseSelection.start) return;
  const phrase = normalizePhraseBuffer(phraseBuffer);
  if (phraseBuffer.length !== phrase.length) return;
  const start = constrain(phraseSelection.start, 0, phrase.length);
  const end = constrain(phraseSelection.end, start, phrase.length);
  const map = buildBufferIndexToCellMap(phraseBuffer);
  if (!map) return;
  const { lines, longestLen } = lastLayout;
  const byRow = new Map();
  for (let i = start; i < end; i++) {
    const cell = map[i];
    if (!cell) continue;
    if (!byRow.has(cell.row)) byRow.set(cell.row, []);
    byRow.get(cell.row).push(cell.col);
  }
  const ctx2d = drawingContext;
  ctx2d.save();
  const lum = backgroundLuminance01();
  ctx2d.fillStyle = lum > 0.5 ? "rgba(0, 120, 255, 0.28)" : "rgba(130, 200, 255, 0.36)";
  const sortedRows = Array.from(byRow.keys()).sort((a, b) => a - b);
  for (const row of sortedRows) {
    const cols = byRow.get(row);
    cols.sort((a, b) => a - b);
    let runS = cols[0];
    let runE = cols[0];
    const flushRun = () => {
      const offsetX = ((longestLen - lines[row].length) * CELL_ADVANCE_X) / 2;
      const gx0 = offsetX + runS * CELL_ADVANCE_X;
      const gw = (runE - runS) * CELL_ADVANCE_X + MASK_CELL_W;
      const gy0 = row * CELL_H;
      const px0 = cx + (gx0 - bx) * scale * tm;
      const py0 = cy + (gy0 - by) * scale * tm;
      ctx2d.fillRect(px0, py0, gw * scale * tm, CELL_H * scale * tm);
    };
    for (let k = 1; k < cols.length; k++) {
      if (cols[k] === runE + 1) {
        runE = cols[k];
      } else {
        flushRun();
        runS = runE = cols[k];
      }
    }
    flushRun();
  }
  ctx2d.restore();
}

function drawTypingCaret(cx, cy, bx, by, scale, tm) {
  if (!phraseCanvasElt) return;
  if (phraseSelection && phraseSelection.end > phraseSelection.start) return;
  const showPlaceholderCaret = awaitingFirstEdit && bits.length > 0;
  const showEditCaret = !awaitingFirstEdit && document.activeElement === phraseCanvasElt;
  if (!showPlaceholderCaret && !showEditCaret) return;
  if (!caretBlinkOn) return;
  const { gx, gy } = caretMaskGxGy();
  const px = cx + (gx - bx) * scale * tm;
  const py = cy + (gy - by) * scale * tm;
  const lineH = CELL_H * scale * tm * 0.52;
  const ctx2d = drawingContext;
  ctx2d.save();
  const lum = backgroundLuminance01();
  const [cr, cg, cb] = lum > 0.5 ? [20, 20, 22] : [248, 248, 252];
  ctx2d.fillStyle = `rgb(${cr},${cg},${cb})`;
  const barW = max(1 / pixelDensity(), 0.75);
  const x0 = px - barW * 0.5;
  ctx2d.fillRect(x0, py - lineH * 0.5, barW, lineH);
  ctx2d.restore();
}

function draw() {
  if (!fontReady) return;
  if (!width || !height) return;

  const att = getAttention();
  const bgRgb = parseHexColor(getBackgroundHex());
  background(bgRgb.r, bgRgb.g, bgRgb.b);

  const tm = trackingMul();
  const scale = screenMaskScaleEffective();
  const m = layoutMargin();
  const top = topBandForLayout();
  const { minX, minY, maxX, cx: bx, cy: by } = maskBounds;
  /* When canvas is wider than the visible column, center in that column — not full canvas width — so text isn't pushed off-screen right. */
  const vw = layoutContentWidth();
  let cx = min(width, vw) * 0.5;
  const leftCore = (bx - minX) * scale * tm;
  const rightCore = (maxX - bx) * scale * tm;
  cx = constrain(cx, m + leftCore, width - m - rightCore);
  const cy = top + (by - minY) * scale * tm;
  const alpha = layerAlpha(att);

  if (bits.length === 0) {
    if (!awaitingFirstEdit) {
      drawTypingCaret(cx, cy, bx, by, scale, tm);
    } else {
      const lum = backgroundLuminance01();
      const hr = lum > 0.5 ? 88 : 210;
      const hg = lum > 0.5 ? 88 : 210;
      const hb = lum > 0.5 ? 94 : 220;
      fill(hr, hg, hb);
      noStroke();
      textAlign(CENTER, CENTER);
      textSize(14);
      text("Click the canvas to start typing.", width * 0.5, height * 0.5);
    }
    return;
  }

  drawSelectionHighlight(cx, cy, bx, by, scale, tm);

  const colors = getBitColorsFromUI();
  const ctx2d = drawingContext;
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "middle";
  ctx2d.imageSmoothingEnabled = false;
  const alphaNorm = alpha / 255;
  noStroke();
  for (const b of bits) {
    const st = computeBitDrawState(b, att, cx, cy, bx, by, scale, tm, alphaNorm, colors);
    ctx2d.save();
    ctx2d.translate(st.px, st.py);
    ctx2d.rotate(st.rotAtt);
    ctx2d.scale(st.sx, st.sy);
    /* Must set font + fill every glyph: restore() resets them to p5 defaults (often white fill). */
    ctx2d.font = `${st.weight} ${st.fontPx}px ${MONO_FONT_CANVAS}`;
    ctx2d.fillStyle = `rgba(${st.cr},${st.cg},${st.cb},${st.fillA})`;
    ctx2d.fillText(st.ch, 0, 0);
    ctx2d.restore();
  }

  if (bits.length) {
    drawGhostTraces(cx, cy, bx, by, scale, tm, att, alpha, colors);
  }

  drawTypingCaret(cx, cy, bx, by, scale, tm);
}

/** Faint residual strokes — ramps in softly as attention drops. */
function drawGhostTraces(cx, cy, bx, by, scale, tm, att, alpha, bitColors) {
  const a = constrain(att, 0, 100);
  const ghostAmt = (1 - smoothstep(0, 100, a)) ** 3;
  if (ghostAmt < 0.002) return;
  const r = (bitColors.zero.r + bitColors.one.r) * 0.22;
  const gc = (bitColors.zero.g + bitColors.one.g) * 0.22;
  const b = (bitColors.zero.b + bitColors.one.b) * 0.22;
  stroke(r, gc, b, alpha * ghostAmt * 0.14);
  strokeWeight(0.55);
  const ghostStep = bits.length > 12000 ? 72 : 40;
  for (let i = 0; i < bits.length; i += ghostStep) {
    const bit = bits[i];
    const px = cx + (bit.gx - bx) * scale * tm;
    const py = cy + (bit.gy - by) * scale * tm;
    const j = noise(bit.seed * 0.02, i * 0.1) - 0.5;
    point(px + j * 2.4, py - j * 2.4);
  }
}
