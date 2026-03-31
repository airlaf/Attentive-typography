/**
 * Attention Type — generative 0/1 letterforms on a single ATTENTION axis (100 → 0).
 */

let attentionInput;
/** Raw typed text (newlines = manual line breaks; width-wrap still applies per block). */
const PLACEHOLDER_PHRASE = "pay attention to me!";
let phraseBuffer = PLACEHOLDER_PHRASE;
/** Until first click or key, show placeholder; then clear and show caret. */
let awaitingFirstEdit = true;
let stateEl;
let fontReady = false;
/** Canvas DOM node — focus checks and caret blink. */
let phraseCanvasElt = null;
let caretBlinkId = 0;
let caretBlinkOn = true;
/** Last wrapped lines + longest row length (mask space), for caret position). */
let lastLayout = { lines: [""], longestLen: 1 };

/**
 * Fixed mask resolution per character (like a tile grid / pixel font).
 * Phrase length only grows the canvas; each letter keeps the same sampling density.
 */
/** Per-character mask raster — CELL_W sets horizontal letter spacing (narrower = tighter). */
const CELL_W = 108;
const CELL_H = 156;
const MASK_CHAR_TEXT_SIZE = Math.min(CELL_H * 0.76, CELL_W * 0.78);

/**
 * Mask sampling stride in pixels. Lower = denser grid (heavier draw loop). 4 vs 3 ≈ 44% fewer glyphs.
 */
const MASK_STEP = 4;
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
  maxX: CELL_W,
  maxY: CELL_H,
  cx: CELL_W / 2,
  cy: CELL_H / 2,
  spanW: CELL_W,
  spanH: CELL_H,
};

/**
 * Fixed mask px → canvas px. Phrase length only grows the canvas; each letter + 0/1 grid stay the same size.
 */
/** Chosen with larger CELL_* so on-screen letter size stays similar to the old 112×cell @ 0.9 scale. */
const SCREEN_MASK_SCALE = 0.79;
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
/** Extra canvas height so glyphs aren’t hidden under the fixed bottom UI bar. */
const CANVAS_BOTTOM_UI_CLEAR = 120;

let phraseDebounceId = 0;
let redrawRafId = 0;
let resizeLayoutRafId = 0;

function getAttention() {
  return attentionInput ? Number(attentionInput.value) : 100;
}

function stateLabel(a) {
  if (a >= 65) return { name: "PRESENT", range: "100 — 65" };
  if (a >= 30) return { name: "DISTRACTED", range: "65 — 30" };
  return { name: "ABSENT", range: "30 — 0" };
}

function stopCaretBlink() {
  caretBlinkOn = true;
  if (caretBlinkId) {
    clearInterval(caretBlinkId);
    caretBlinkId = 0;
  }
}

function startCaretBlink() {
  if (caretBlinkId || awaitingFirstEdit) return;
  caretBlinkId = setInterval(() => {
    caretBlinkOn = !caretBlinkOn;
    if (!awaitingFirstEdit && phraseCanvasElt && document.activeElement === phraseCanvasElt) {
      redraw();
    }
  }, 530);
}

function schedulePhraseRebuild() {
  updateStateLabel();
  clearTimeout(phraseDebounceId);
  phraseDebounceId = setTimeout(() => {
    rebuildBits();
    resizeCanvasToContent();
    redraw();
    if (!awaitingFirstEdit) startCaretBlink();
  }, 140);
}

function dismissPlaceholder() {
  if (!awaitingFirstEdit) return;
  awaitingFirstEdit = false;
  phraseBuffer = "";
  stopCaretBlink();
  clearTimeout(phraseDebounceId);
  phraseDebounceId = 0;
  updateStateLabel();
  rebuildBits();
  resizeCanvasToContent();
  redraw();
  startCaretBlink();
}

function normalizePhraseBuffer(s) {
  return (s || "")
    .toUpperCase()
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[^A-Z0-9\s\n!]/g, "");
}

function onPhrasePaste(e) {
  const elt = e.target;
  if (!elt || elt.tagName !== "CANVAS") return;
  e.preventDefault();
  if (awaitingFirstEdit) {
    awaitingFirstEdit = false;
    phraseBuffer = "";
    stopCaretBlink();
  }
  const t = normalizePhraseBuffer(e.clipboardData.getData("text") || "");
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

  if (awaitingFirstEdit) {
    if (e.key === "Tab" || e.key === "Escape") return;
    const willEdit =
      e.key === "Backspace" ||
      e.key === "Enter" ||
      (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey);
    if (!willEdit) return;
    awaitingFirstEdit = false;
    phraseBuffer = "";
    stopCaretBlink();
  }

  if (e.key === "Backspace") {
    if (!phraseBuffer.length) {
      e.preventDefault();
      schedulePhraseRebuild();
      return;
    }
    phraseBuffer = phraseBuffer.slice(0, -1);
    schedulePhraseRebuild();
    e.preventDefault();
    return;
  }
  if (e.key === "Enter") {
    if (phraseBuffer.length < PHRASE_MAX_LEN) {
      phraseBuffer += "\n";
      schedulePhraseRebuild();
    }
    e.preventDefault();
    return;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (phraseBuffer.length >= PHRASE_MAX_LEN) return;
    const k = e.key;
    if (k === " ") {
      phraseBuffer += " ";
      schedulePhraseRebuild();
      e.preventDefault();
      return;
    }
    if (k === "!") {
      phraseBuffer += "!";
      schedulePhraseRebuild();
      e.preventDefault();
      return;
    }
    const u = k.toUpperCase();
    if (/[A-Z0-9]/.test(u)) {
      phraseBuffer += u;
      schedulePhraseRebuild();
      e.preventDefault();
    }
  }
}

function setup() {
  const canvas = createCanvas(max(100, windowWidth), max(100, windowHeight));
  canvas.parent("sketch-host");
  textFont("Geist Mono, monospace");

  const elt = canvas.elt;
  phraseCanvasElt = elt;
  elt.setAttribute("tabindex", "0");
  elt.setAttribute("role", "textbox");
  elt.setAttribute("aria-multiline", "true");
  elt.setAttribute(
    "aria-label",
    "Click to start typing. Placeholder: pay attention to me. Then letters, numbers, space, exclamation, Enter for new line."
  );
  elt.style.outline = "none";
  elt.addEventListener("pointerdown", () => {
    if (awaitingFirstEdit) {
      dismissPlaceholder();
    }
    elt.focus();
  });
  elt.addEventListener("keydown", onPhraseKeydown);
  elt.addEventListener("paste", onPhrasePaste);
  elt.addEventListener("blur", () => stopCaretBlink());
  elt.addEventListener("focus", () => {
    if (!awaitingFirstEdit) startCaretBlink();
  });

  attentionInput = document.getElementById("attention");
  stateEl = document.getElementById("state");

  attentionInput.addEventListener("input", () => {
    updateStateLabel();
    scheduleRedraw();
  });

  maskG = createGraphics(CELL_W, CELL_H);
  maskG.pixelDensity(1);
  rebuildBits();
  resizeCanvasToContent();
  updateStateLabel();
  fontReady = true;
  noLoop();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      rebuildBits();
      resizeCanvasToContent();
      redraw();
    });
  }
}

function updateStateLabel() {
  const a = getAttention();
  const s = stateLabel(a);
  stateEl.innerHTML = `<span class="name">${s.name}</span> <span class="val">· ${s.range} · ATTENTION ${a}</span>`;
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
 */
function wrapPhraseToLines(phrase, maxPerLine) {
  const lines = [];
  for (const block of phrase.split("\n")) {
    const cleaned = block.replace(/\s+/g, " ").trim();
    if (cleaned.length) lines.push(...wrapParagraphWords(cleaned, maxPerLine));
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

/** Map mask pixel (x,y) to line/col + position inside that character cell (stable across re-centering). */
function maskCellAt(x, y, lines, longestLen) {
  const row = floor(y / CELL_H);
  if (row < 0 || row >= lines.length) return null;
  const line = lines[row];
  const offsetX = ((longestLen - line.length) * CELL_W) / 2;
  const relX = x - offsetX;
  const col = floor(relX / CELL_W);
  if (col < 0 || col >= line.length) return null;
  if (line[col] === " ") return null;
  const lx = relX - col * CELL_W;
  const ly = y - row * CELL_H;
  return { row, col, lx, ly };
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
      maxX: CELL_W,
      maxY: CELL_H,
      cx: CELL_W / 2,
      cy: CELL_H / 2,
      spanW: CELL_W,
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
      maxX: CELL_W,
      maxY: CELL_H,
      cx: CELL_W / 2,
      cy: CELL_H / 2,
      spanW: CELL_W,
      spanH: CELL_H,
    };
    return;
  }

  const longestLen = Math.max(...lines.map((ln) => ln.length), 1);
  lastLayout = { lines: lines.slice(), longestLen };
  const maskW = longestLen * CELL_W;
  const maskH = lines.length * CELL_H;

  ensureMaskGraphics(maskW, maskH);
  maskG.pixelDensity(1);
  maskG.background(0);
  maskG.noStroke();
  maskG.fill(255);
  maskG.textAlign(CENTER, CENTER);
  maskG.textStyle(BOLD);
  maskG.textFont("Geist Mono, monospace");
  maskG.textSize(MASK_CHAR_TEXT_SIZE);

  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    const offsetX = ((longestLen - line.length) * CELL_W) / 2;
    for (let col = 0; col < line.length; col++) {
      const char = line[col];
      if (char === " ") continue;
      const cxCell = offsetX + col * CELL_W + CELL_W / 2;
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
    for (let x = step; x < w - step; x += step) {
      const i = 4 * ((y * d) * (w * d) + x * d);
      const lum = maskG.pixels[i] * 0.299 + maskG.pixels[i + 1] * 0.587 + maskG.pixels[i + 2] * 0.114;
      if (lum > MASK_LUM_THRESH) {
        const cell = maskCellAt(x, y, lines, longestLen);
        if (!cell) continue;
        const { row, col, lx, ly } = cell;
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

/** How many monospace cells fit in the current viewport width (recomputed on resize). */
function charsPerLineForViewport() {
  const tm = trackingMul();
  const charW = CELL_W * SCREEN_MASK_SCALE * tm;
  const avail = windowWidth - 2 * WRAP_H_PAD;
  const n = floor(avail / charW);
  return constrain(n, CHARS_PER_LINE_MIN, CHARS_PER_LINE_MAX);
}

/**
 * Canvas grows with mask bounds × fixed scale; page scrolls instead of shrinking the whole piece.
 */
function resizeCanvasToContent() {
  const tm = trackingMul();
  const { spanW, spanH } = maskBounds;
  const scale = SCREEN_MASK_SCALE;
  const m = layoutMargin();
  const contentW = spanW * scale * tm;
  const contentH = spanH * scale * tm;
  const w = max(max(100, windowWidth), ceil(contentW + 2 * m));
  const topBand = m;
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

/** Drift amount peaks in DISTRACTED, eases at ends. */
function driftAmount(att) {
  if (att >= 65) return map(att, 100, 65, 0.4, 2.2);
  if (att >= 30) return map(att, 65, 30, 2.2, 9);
  return map(att, 30, 0, 9, 22);
}

/** Worst-case screen-space offset from drift + scatter (matches draw loop). */
function maxDriftScreenPx(att) {
  const drift = driftAmount(att);
  const driftPx = drift * (6 + att * 0.05);
  let scatterPx = 0;
  if (att < 65) {
    const sc = map(att, 65, 0, 0, 1);
    scatterPx = 20 * sc * sc;
  }
  return driftPx + scatterPx + 52;
}

/**
 * Keeps the overall letterform (mask) at a stable scale on the canvas.
 * Tracking no longer widens with low attention — that was read as the "letter" changing size.
 */
function trackingMul() {
  return 1;
}

/** 0s fade before 1s; returns false if this bit should not be drawn. */
function bitSurvives(att, ch, seed) {
  if (att >= 34) return true;
  const u = (seed * 0.001) % 1;
  const t = constrain(att / 34, 0, 1);
  const p0 = t * t * t;
  const p1 = t * t * 0.72 + t * 0.28;
  const p = ch === "0" ? p0 : p1;
  return u < p;
}

/** Overall alpha for ghost layer. */
function layerAlpha(att) {
  if (att > 25) return 255;
  return map(att, 25, 0, 255, 35);
}

function caretMaskGxGy() {
  const { lines, longestLen } = lastLayout;
  if (!lines || lines.length === 0) {
    return { gx: CELL_W / 2, gy: CELL_H / 2 };
  }
  const row = lines.length - 1;
  const line = lines[row];
  const maskW = longestLen * CELL_W;
  const gy = row * CELL_H + CELL_H / 2;
  if (line.length === 0) {
    return { gx: maskW / 2, gy };
  }
  const offsetX = ((longestLen - line.length) * CELL_W) / 2;
  const ins = line.length;
  const gx = offsetX + ins * CELL_W + CELL_W / 2;
  return { gx, gy };
}

function drawTypingCaret(cx, cy, bx, by, scale, tm) {
  if (awaitingFirstEdit || !phraseCanvasElt) return;
  if (document.activeElement !== phraseCanvasElt) return;
  if (!caretBlinkOn) return;
  const { gx, gy } = caretMaskGxGy();
  const px = cx + (gx - bx) * scale * tm;
  const py = cy + (gy - by) * scale * tm;
  push();
  fill(20, 20, 22);
  noStroke();
  rectMode(CENTER);
  const barW = max(2, scale * 1.25);
  const barH = CELL_H * scale * tm * 0.62;
  rect(px, py, barW, barH);
  rectMode(CORNER);
  pop();
}

function draw() {
  if (!fontReady) return;
  if (!width || !height) return;

  const att = getAttention();
  background(255);

  const tm = trackingMul();
  const scale = SCREEN_MASK_SCALE;
  const m = layoutMargin();
  const top = m;
  const { minX, minY, maxX, cx: bx, cy: by } = maskBounds;
  /* When canvas is wider than the window, center in the viewport — not canvas width — so text isn't pushed off-screen right. */
  let cx = min(width, windowWidth) * 0.5;
  const leftCore = (bx - minX) * scale * tm;
  const rightCore = (maxX - bx) * scale * tm;
  cx = constrain(cx, m + leftCore, width - m - rightCore);
  const cy = top + (by - minY) * scale * tm;
  const drift = driftAmount(att);
  const alpha = layerAlpha(att);

  if (bits.length === 0) {
    if (!awaitingFirstEdit) {
      drawTypingCaret(cx, cy, bx, by, scale, tm);
    } else {
      fill(90, 90, 95);
      noStroke();
      textAlign(CENTER, CENTER);
      textSize(14);
      text("Click the canvas to start typing.", width * 0.5, height * 0.5);
    }
    return;
  }

  const ctx2d = drawingContext;
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "middle";
  ctx2d.imageSmoothingEnabled = false;
  const alphaNorm = alpha / 255;

  noStroke();
  for (const b of bits) {
    if (!bitSurvives(att, b.ch, b.seed)) continue;

    const nx = (b.seed % 97) / 97;
    const ny = (floor(b.seed / 97) % 97) / 97;
    const n1 = b.n1;
    const n2 = b.n2;
    const n3 = b.n3;

    let dx = (n1 - 0.5) * 2 * drift * (6 + att * 0.05);
    let dy = (n2 - 0.5) * 2 * drift * (6 + att * 0.05);

    if (att < 65) {
      const scatter = map(att, 65, 0, 0, 1);
      dx += (nx - 0.5) * 40 * scatter * scatter;
      dy += (ny - 0.5) * 40 * scatter * scatter;
    }

    const px = cx + (b.gx - bx) * scale * tm + dx;
    const py = cy + (b.gy - by) * scale * tm + dy;

    const grain = (n3 - 0.5) * 0.72 + (n2 - 0.5) * 0.35;
    let sz = 5.2 * scale * 2.1;
    sz *= 1 + grain;
    sz = constrain(sz, 3.6, 28);

    const sx = b.sx ?? 1;
    const sy = b.sy ?? 1;
    const wNorm = b.wNorm ?? 0.55;
    const rot = b.rot ?? 0;
    const rotAtt = rot * map(att, 0, 100, 1.35, 0.75);

    const isOne = b.ch === "1";
    const baseDark = isOne ? 10 : 26;
    const fade = att >= 42 ? 1 : smoothstep(4, 38, att);
    const light = isOne ? 132 : 142;
    const c = baseDark * fade + light * (1 - fade);
    const cr = c;
    const cg = c;
    const cb = min(255, c + (isOne ? 0 : 6));

    const fontPx = Math.max(4, Math.round(sz));
    const weight = wNorm > 0.52 ? 700 : 500;
    ctx2d.save();
    ctx2d.translate(px, py);
    ctx2d.rotate(rotAtt);
    ctx2d.scale(sx, sy);
    /* Must set font + fill every glyph: restore() resets them to p5 defaults (often white fill). */
    ctx2d.font = `${weight} ${fontPx}px "Geist Mono", monospace`;
    ctx2d.fillStyle = `rgba(${cr},${cg},${cb},${alphaNorm})`;
    ctx2d.fillText(b.ch, 0, 0);
    ctx2d.restore();
  }

  if (att < 45 && bits.length) {
    drawGhostTraces(cx, cy, bx, by, scale, tm, att, alpha);
  }

  drawTypingCaret(cx, cy, bx, by, scale, tm);
}

/** Faint residual strokes when nearly absent (independent of culled glyphs). */
function drawGhostTraces(cx, cy, bx, by, scale, tm, att, alpha) {
  const g = map(att, 0, 45, 0.28, 0);
  if (g < 0.02) return;
  stroke(40, 40, 45, alpha * g * 0.38);
  strokeWeight(0.55);
  const ghostStep = bits.length > 12000 ? 72 : 40;
  for (let i = 0; i < bits.length; i += ghostStep) {
    const b = bits[i];
    const px = cx + (b.gx - bx) * scale * tm;
    const py = cy + (b.gy - by) * scale * tm;
    const j = noise(b.seed * 0.02, i * 0.1) - 0.5;
    point(px + j * 2.4, py - j * 2.4);
  }
}
