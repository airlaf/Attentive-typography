/**
 * Attention Type — generative 0/1 letterforms on a single ATTENTION axis (100 → 0).
 */
/* global webgazer */

/** SF Mono on Apple; ui-monospace / Menlo / Monaco / Consolas elsewhere (not web-hosted). */
const MONO_FONT_P5 = "SF Mono, Menlo, Monaco, Consolas, monospace";
const MONO_FONT_CANVAS = '"SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace';

let attentionInput;

/** Preset + gaze status bands on 0–100 (skewed: distracted sits lower, not even thirds). */
const ATTENTION_DISTRACTED_MIN = 26;
const ATTENTION_PRESENT_MIN = 60;

/** WebGazer: gaze drives attention when calibrated; manual slider otherwise. */
let eyeTrackingActive = false;
let eyeTrackingCalibrated = false;
let gazeAttentionT = 1;
let gazeTargetT = 1;
/** Latest WebGazer sample in viewport px; null = no face / no prediction. */
let lastGazeSample = null;
/** performance.now() when sample arrived; used to treat stale predictions as absent. */
let lastGazeAt = 0;
const focusZone = { centerX: 0, centerY: 0, width: 1, height: 1 };
/** Raw typed text (newlines = manual line breaks; width-wrap still applies per block). */
const PLACEHOLDER_PHRASE = "We scroll more than we read. Try to pay attention to me?";
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
/** Slightly under the cell so bold caps / wide glyphs + AA don’t hit the raster edge. */
const MASK_CHAR_TEXT_SIZE = Math.min(CELL_H * 0.76, MASK_CELL_W * 0.88);
/**
 * Horizontal inset on the mask bitmap so centered text isn’t clipped at the canvas edge
 * (bold SF Mono caps often draw past the nominal cell; inserting a space changes line width and exposes it).
 */
const MASK_X_PAD = 16;

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

/** Skip redundant gaze chip DOM writes. */
let lastGazeStatusKey = "";
/** Cache panel colors between UI edits (draw hot path). */
let drawStyleCacheValid = false;
let cachedPalettesDraw = null;
let cachedBgRgbDraw = null;

function invalidateDrawStyleCache() {
  drawStyleCacheValid = false;
}

function refreshDrawStyleCache() {
  cachedPalettesDraw = getBitPalettesFromUI();
  cachedBgRgbDraw = parseHexColor(getBackgroundHex());
  drawStyleCacheValid = true;
}

function getCachedPalettesForDraw() {
  if (!drawStyleCacheValid) refreshDrawStyleCache();
  return cachedPalettesDraw;
}

function getCachedBgRgbForDraw() {
  if (!drawStyleCacheValid) refreshDrawStyleCache();
  return cachedBgRgbDraw;
}

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

/** Up to three { zero, one } pairs from the panel (primary + two optional rows). */
function getBitPalettesFromUI() {
  const stack = document.getElementById("bit-palette-rows");
  const rows = stack ? stack.querySelectorAll(".bit-palette-row") : [];
  const palettes = [];
  for (const row of rows) {
    const el0 = row.querySelector(".bit-color-0");
    const el1 = row.querySelector(".bit-color-1");
    palettes.push({
      zero: parseHexColor(el0 && el0.value ? el0.value : "#1a1a22"),
      one: parseHexColor(el1 && el1.value ? el1.value : "#12121a"),
    });
  }
  if (palettes.length === 0) {
    return [{ zero: parseHexColor("#1a1a22"), one: parseHexColor("#12121a") }];
  }
  return palettes;
}

/** Stable palette slot 0..count-1 from bit identity (phrase edits keep local coloring). */
function paletteIndexForBit(b, paletteCount) {
  if (paletteCount <= 1) return 0;
  let h = (b.seed ^ (floor(b.gx) * 73856093) ^ (floor(b.gy) * 19349663)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb792d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h >>> 0) % paletteCount;
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
  if (!drawStyleCacheValid) refreshDrawStyleCache();
  const { r, g, b } = cachedBgRgbDraw;
  return constrain((0.299 * r + 0.587 * g + 0.114 * b) / 255, 0, 1);
}

/**
 * Shared 0/1 screen state for canvas draw and SVG export (same math as the live view).
 */
function computeBitDrawState(b, att, cx, cy, bx, by, scale, tm, alphaNorm, palettes) {
  const colors = palettes[paletteIndexForBit(b, palettes.length)];
  const nx = (b.seed % 97) / 97;
  const ny = (floor(b.seed / 97) % 97) / 97;
  const n1 = b.n1;
  const n2 = b.n2;
  const n3 = b.n3;

  const attC = constrain(att, 0, 100);
  const drift = driftAmount(att);
  const scat = scatterFactor(att);
  const invChaos = 1 - smoothstep(0, 100, attC);
  const chaos = invChaos * invChaos;
  const driftChaosBoost = 1 + 0.5 * chaos;
  const driftMul = 5.2 + attC * 0.04;
  let dx = (n1 - 0.5) * 2 * drift * driftMul * driftChaosBoost;
  let dy = (n2 - 0.5) * 2 * drift * driftMul * driftChaosBoost;
  const scatterAmp = 18 * (1 + 1 * chaos);
  dx += (nx - 0.5) * scatterAmp * scat;
  dy += (ny - 0.5) * scatterAmp * scat;
  const n4 = ((b.seed * 17) % 97) / 97;
  const n5 = ((b.seed * 31) % 97) / 97;
  const jitterAmp = 12 * chaos * scat;
  dx += (n4 - 0.5) * jitterAmp;
  dy += (n5 - 0.5) * jitterAmp;

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
  const rotAtt = rot * map(rotEase, 0, 1, 0.95, 0.78) * (1 + 0.12 * chaos);

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
  const attGlyphs = getGlyphAttention(att);
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
  const alphaNorm = layerAlphaForGlyphs(attGlyphs) / 255;
  const palettes = getBitPalettesFromUI();
  const deg = 180 / PI;
  const pieces = [];
  for (const b of bits) {
    const st = computeBitDrawState(b, attGlyphs, cx, cy, bx, by, scale, tm, alphaNorm, palettes);
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
  if (eyeTrackingActive && eyeTrackingCalibrated) {
    return constrain(gazeAttentionT * 100, 0, 100);
  }
  return attentionInput ? Number(attentionInput.value) : 100;
}

/**
 * Eye-tracking only: pull effective attention down vs raw gaze so drift/opacity react harder when distracted.
 * Manual slider unchanged (caller passes att through unchanged when not eye mode).
 */
function getGlyphAttention(att) {
  if (!eyeTrackingActive || !eyeTrackingCalibrated) return att;
  const a = constrain(att, 0, 100);
  return 100 * pow(a / 100, 1.35);
}

/** Layer alpha for bits — wider fade range when gaze-driven so “away” reads clearly. */
function layerAlphaForGlyphs(att) {
  const a = constrain(att, 0, 100);
  const t = smoothstep(0, 100, a);
  if (eyeTrackingActive && eyeTrackingCalibrated) {
    return map(t, 0, 1, 118, 255);
  }
  return map(t, 0, 1, 228, 255);
}

function updateFocusZoneScreen(cx, cy, bx, by, scale, tm) {
  const canvas = phraseCanvasElt;
  if (!canvas || !width || !height) {
    focusZone.centerX = window.innerWidth * 0.5;
    focusZone.centerY = window.innerHeight * 0.5;
    focusZone.width = 200;
    focusZone.height = 120;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  if (!bits.length) {
    focusZone.centerX = rect.left + rect.width * 0.5;
    focusZone.centerY = rect.top + rect.height * 0.5;
    focusZone.width = rect.width * 0.25;
    focusZone.height = rect.height * 0.2;
    return;
  }
  const { minX, minY, maxX, maxY } = maskBounds;
  const leftC = cx + (minX - bx) * scale * tm;
  const rightC = cx + (maxX - bx) * scale * tm;
  const topC = cy + (minY - by) * scale * tm;
  const bottomC = cy + (maxY - by) * scale * tm;
  const midX = (leftC + rightC) * 0.5;
  const midY = (topC + bottomC) * 0.5;
  focusZone.centerX = rect.left + (midX / width) * rect.width;
  focusZone.centerY = rect.top + (midY / height) * rect.height;
  focusZone.width = (abs(rightC - leftC) / width) * rect.width;
  focusZone.height = (abs(bottomC - topC) / height) * rect.height;
}

/**
 * Map gaze → attention 0…1: generous padded box on 0/1 text = present (1); rest of viewport = softer distracted;
 * stale tracking, bezel band, or off-window = absent (~0). Tuned forgivingly so small gaze error still reads as on-type.
 */
function computeGazeAttentionTarget(sample, zone) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const now = performance.now();
  const staleMs = 400;

  if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) {
    return 0;
  }
  if (lastGazeAt <= 0 || now - lastGazeAt > staleMs) {
    return 0;
  }

  const x = sample.x;
  const y = sample.y;

  const offMargin = 40;
  if (x < -offMargin || y < -offMargin || x > vw + offMargin || y > vh + offMargin) {
    return 0;
  }

  const canvas = phraseCanvasElt;
  const screenScale = canvas && width > 0 ? canvas.getBoundingClientRect().width / width : 1;
  const halfW = max(zone.width * 0.5, 52);
  const halfH = max(zone.height * 0.5, 40);
  const driftPad = maxDriftScreenPx(100) * screenScale * 0.16 + 14;
  const fracPadX = max(halfW * 0.12, 18);
  const fracPadY = max(halfH * 0.12, 14);
  const padX = fracPadX + driftPad;
  const padY = fracPadY + driftPad;

  const left = zone.centerX - halfW - padX;
  const right = zone.centerX + halfW + padX;
  const top = zone.centerY - halfH - padY;
  const bottom = zone.centerY + halfH + padY;

  const onTypography = x >= left && x <= right && y >= top && y <= bottom;
  if (onTypography) {
    return 1;
  }

  const edgeBand = 56;
  const inViewport = x >= 0 && x <= vw && y >= 0 && y <= vh;
  if (inViewport) {
    const nearPerimeter =
      x < edgeBand || x > vw - edgeBand || y < edgeBand || y > vh - edgeBand;
    if (nearPerimeter) {
      return 0.22;
    }
    return 0.68;
  }

  return 0.06;
}

function setAttentionControlsDisabled(disabled) {
  const sliderBlock = document.getElementById("attention-slider-block");
  const presets = document.getElementById("attention-preset-row");
  if (attentionInput) attentionInput.disabled = disabled;
  if (sliderBlock) sliderBlock.classList.toggle("is-disabled", disabled);
  if (presets) presets.classList.toggle("is-disabled", disabled);
}

function showEyeTrackingError() {
  const el = document.getElementById("eye-tracking-error");
  if (el) el.classList.add("is-visible");
}

function hideEyeTrackingError() {
  const el = document.getElementById("eye-tracking-error");
  if (el) el.classList.remove("is-visible");
}

function updateGazeStatusDisplay() {
  const el = document.getElementById("gaze-attention-status");
  if (!el) return;
  if (!eyeTrackingActive || !eyeTrackingCalibrated) {
    lastGazeStatusKey = "";
    el.textContent = "";
    el.classList.remove("gaze-st-present", "gaze-st-distracted", "gaze-st-absent", "is-visible");
    return;
  }
  const a = gazeAttentionT * 100;
  const key =
    a >= ATTENTION_PRESENT_MIN ? "present" : a >= ATTENTION_DISTRACTED_MIN ? "distracted" : "absent";
  if (key === lastGazeStatusKey) return;
  lastGazeStatusKey = key;
  el.classList.remove("gaze-st-present", "gaze-st-distracted", "gaze-st-absent");
  el.classList.add("is-visible");
  if (key === "present") {
    el.textContent = "● PRESENT";
    el.classList.add("gaze-st-present");
  } else if (key === "distracted") {
    el.textContent = "● DISTRACTED";
    el.classList.add("gaze-st-distracted");
  } else {
    el.textContent = "● ABSENT";
    el.classList.add("gaze-st-absent");
  }
}

function cleanupWebGazerResources() {
  try {
    if (typeof webgazer !== "undefined") {
      webgazer.clearGazeListener();
      webgazer.pause();
    }
    const v = document.getElementById("webgazerVideoFeed");
    if (v && v.srcObject) {
      v.srcObject.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    }
    ["webgazerVideoContainer", "webgazerGazeDot"].forEach((id) => {
      const node = document.getElementById(id);
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
  } catch (e) {
    /* ignore teardown errors */
  }
}

function closeCalibrationOverlay() {
  const overlay = document.getElementById("webgazer-calibration-overlay");
  if (!overlay) return;
  overlay.classList.remove("is-open");
  overlay.setAttribute("aria-hidden", "true");
}

function openCalibrationOverlay() {
  const overlay = document.getElementById("webgazer-calibration-overlay");
  if (!overlay) return;
  overlay.querySelectorAll(".wg-cal-dot").forEach((d) => d.classList.remove("is-done"));
  overlay.classList.add("is-open");
  overlay.setAttribute("aria-hidden", "false");
}

function finishEyeCalibration() {
  closeCalibrationOverlay();
  eyeTrackingCalibrated = true;
  const v = attentionInput ? Number(attentionInput.value) : 100;
  const t0 = constrain(Number.isFinite(v) ? v / 100 : 1, 0, 1);
  gazeAttentionT = t0;
  gazeTargetT = t0;
  lastGazeSample = null;
  lastGazeAt = 0;
  if (typeof webgazer !== "undefined" && webgazer.setGazeListener) {
    webgazer.setGazeListener((data, _timestamp) => {
      if (!eyeTrackingActive || !eyeTrackingCalibrated) return;
      if (!data) {
        lastGazeSample = null;
        lastGazeAt = 0;
        return;
      }
      lastGazeSample = { x: data.x, y: data.y };
      lastGazeAt = performance.now();
    });
  }
  if (typeof webgazer !== "undefined" && webgazer.showPredictionPoints) {
    webgazer.showPredictionPoints(true);
  }
  if (typeof webgazer !== "undefined" && webgazer.showVideoPreview) {
    disableWebGazerFaceUi();
    webgazer.showVideoPreview(true);
    disableWebGazerFaceUi();
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => layoutWebGazerVideoCorner());
  });
  setTimeout(layoutWebGazerVideoCorner, 400);
  updateGazeStatusDisplay();
  /* Gaze smoothing runs inside draw(); must loop at display rate or attention feels ~2× sluggish vs ~30fps cap. */
  loop();
  redraw();
}

function onCalibrationDotClick(evt) {
  const btn = evt.currentTarget;
  if (!btn || btn.classList.contains("is-done")) return;
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width * 0.5;
  const cy = r.top + r.height * 0.5;
  if (typeof webgazer !== "undefined" && webgazer.recordScreenPosition) {
    webgazer.recordScreenPosition(cx, cy, "click");
  }
  btn.classList.add("is-done");
  const grid = document.getElementById("wg-cal-grid");
  const total = grid ? grid.querySelectorAll(".wg-cal-dot").length : 9;
  const done = grid ? grid.querySelectorAll(".wg-cal-dot.is-done").length : 0;
  if (done >= total) finishEyeCalibration();
}

function resetEyeTrackingUiOff() {
  eyeTrackingActive = false;
  eyeTrackingCalibrated = false;
  lastGazeSample = null;
  lastGazeAt = 0;
  lastGazeStatusKey = "";
  cleanupWebGazerResources();
  closeCalibrationOverlay();
  hideEyeTrackingError();
  setAttentionControlsDisabled(false);
  const toggleBtn = document.getElementById("toggle-eye-tracking");
  if (toggleBtn) {
    toggleBtn.classList.remove("is-active");
    toggleBtn.textContent = toggleBtn.dataset.labelOff || "Start eye tracking";
    toggleBtn.setAttribute("aria-pressed", "false");
  }
  updateGazeStatusDisplay();
  noLoop();
  updatePresetButtons();
  redraw();
}

const WEBGAZER_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/webgazer@2.1.0/dist/webgazer.min.js";
let webgazerLoadPromise = null;

/**
 * WebGazer’s showVideoPreview(true) calls showFaceOverlay(val && params.showFaceOverlay).
 * Default params leave showFaceOverlay true, so the preview briefly (or persistently if order races)
 * turns the CLM wire mesh back on — set params false *before* showVideoPreview every time.
 */
function disableWebGazerFaceUi() {
  if (typeof webgazer === "undefined") return;
  try {
    if (webgazer.params) {
      webgazer.params.showFaceOverlay = false;
      webgazer.params.showFaceFeedbackBox = false;
    }
    if (typeof webgazer.showFaceOverlay === "function") webgazer.showFaceOverlay(false);
    if (typeof webgazer.showFaceFeedbackBox === "function") webgazer.showFaceFeedbackBox(false);
  } catch (e) {
    /* ignore */
  }
  const fo = document.getElementById("webgazerFaceOverlay");
  if (fo) {
    fo.style.setProperty("display", "none", "important");
    fo.style.setProperty("visibility", "hidden", "important");
    fo.style.setProperty("opacity", "0", "important");
    fo.style.setProperty("pointer-events", "none", "important");
    const ctx = typeof fo.getContext === "function" ? fo.getContext("2d") : null;
    if (ctx) {
      const w = fo.width || 300;
      const h = fo.height || 225;
      ctx.clearRect(0, 0, w, h);
    }
  }
  const fb = document.getElementById("webgazerFaceFeedbackBox");
  if (fb) {
    fb.style.setProperty("display", "none", "important");
    fb.style.setProperty("visibility", "hidden", "important");
    fb.style.setProperty("pointer-events", "none", "important");
  }
}

/**
 * WebGazer uses position:absolute on the video/overlay but never sets top/left/right/bottom,
 * so the static position + px width/height can leave empty space on the right/bottom of the box.
 * Force full-bleed after every layout/size sync (beats setVideoViewerSize’s inline px on the video).
 */
function applyWebGazerPreviewFill() {
  const pin = (el) => {
    if (!el) return;
    el.style.setProperty("position", "absolute", "important");
    el.style.setProperty("left", "0", "important");
    el.style.setProperty("top", "0", "important");
    el.style.setProperty("right", "0", "important");
    el.style.setProperty("bottom", "0", "important");
    el.style.setProperty("width", "100%", "important");
    el.style.setProperty("height", "100%", "important");
    el.style.setProperty("min-width", "100%", "important");
    el.style.setProperty("min-height", "100%", "important");
    el.style.setProperty("max-width", "none", "important");
    el.style.setProperty("max-height", "none", "important");
    el.style.setProperty("margin", "0", "important");
    el.style.setProperty("padding", "0", "important");
    el.style.setProperty("box-sizing", "border-box", "important");
    el.style.setProperty("display", "block", "important");
    el.style.setProperty("object-fit", "cover", "important");
    el.style.setProperty("object-position", "center center", "important");
    el.style.setProperty("transform-origin", "center center", "important");
  };
  pin(document.getElementById("webgazerVideoFeed"));
}

/** Pin WebGazer’s webcam to the top-right preview box (face mesh overlay stays off). */
function layoutWebGazerVideoCorner() {
  let s = document.getElementById("webgazer-preview-corner-style");
  if (!s) {
    s = document.createElement("style");
    s.id = "webgazer-preview-corner-style";
    document.head.appendChild(s);
  }
  s.textContent = `
#webgazerVideoContainer {
  position: fixed !important;
  top: 12px !important;
  right: 12px !important;
  left: auto !important;
  bottom: auto !important;
  z-index: 150000 !important;
  width: 300px !important;
  height: 225px !important;
  box-sizing: border-box !important;
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
  line-height: 0 !important;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28);
  background: #0a0a0c;
}
#webgazerVideoFeed {
  position: absolute !important;
  left: 0 !important;
  top: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100% !important;
  height: 100% !important;
  min-width: 100% !important;
  min-height: 100% !important;
  max-width: none !important;
  max-height: none !important;
  margin: 0 !important;
  padding: 0 !important;
  box-sizing: border-box !important;
  display: block !important;
  object-fit: cover !important;
  object-position: center center !important;
  transform-origin: center center !important;
  z-index: 0 !important;
}
/* CLM wire mesh — hidden (tracking still runs on the video stream). */
#webgazerFaceOverlay {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
#webgazerFaceFeedbackBox {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;
  const c = document.getElementById("webgazerVideoContainer");
  if (c) {
    c.style.top = "12px";
    c.style.right = "12px";
    c.style.left = "auto";
    c.style.bottom = "auto";
    c.style.boxSizing = "border-box";
    c.style.padding = "0";
    c.style.margin = "0";
  }
  if (typeof webgazer !== "undefined" && typeof webgazer.setVideoViewerSize === "function") {
    webgazer.setVideoViewerSize(300, 225);
  }
  disableWebGazerFaceUi();
  applyWebGazerPreviewFill();
  requestAnimationFrame(() => {
    disableWebGazerFaceUi();
    applyWebGazerPreviewFill();
  });
  setTimeout(() => {
    disableWebGazerFaceUi();
    applyWebGazerPreviewFill();
  }, 120);
  setTimeout(() => {
    disableWebGazerFaceUi();
    applyWebGazerPreviewFill();
  }, 600);
}

/** Kalman + frequent samples; no CSS transform easing so the dot stays close to WebGazer’s estimate. */
function applyWebGazerStabilityTuning() {
  if (typeof webgazer === "undefined") return;
  try {
    if (typeof webgazer.applyKalmanFilter === "function") {
      webgazer.applyKalmanFilter(true);
    }
    if (webgazer.params) {
      webgazer.params.applyKalmanFilter = true;
      /* Slightly snappier internal cadence; pairs better with continuous draw loop while tracking. */
      webgazer.params.dataTimestep = 28;
      webgazer.params.showFaceOverlay = false;
      webgazer.params.showFaceFeedbackBox = false;
    }
  } catch (e) {
    /* ignore */
  }
  let s = document.getElementById("webgazer-dot-smooth-style");
  if (!s) {
    s = document.createElement("style");
    s.id = "webgazer-dot-smooth-style";
    document.head.appendChild(s);
  }
  s.textContent = "#webgazerGazeDot{transition:none!important;will-change:transform;}";
}

/** Load WebGazer only on demand so a CDN/parse failure never blocks the main sketch. */
function loadWebGazerScript() {
  if (typeof webgazer !== "undefined") return Promise.resolve();
  if (webgazerLoadPromise) return webgazerLoadPromise;
  webgazerLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = WEBGAZER_SCRIPT_URL;
    s.async = true;
    s.dataset.attentionWebgazer = "1";
    s.onload = () => {
      if (typeof webgazer !== "undefined") resolve();
      else {
        webgazerLoadPromise = null;
        reject(new Error("WebGazer global missing after load"));
      }
    };
    s.onerror = () => {
      webgazerLoadPromise = null;
      reject(new Error("Could not load WebGazer script"));
    };
    document.head.appendChild(s);
  });
  return webgazerLoadPromise;
}

async function startEyeTrackingFlow() {
  hideEyeTrackingError();
  const toggleBtn = document.getElementById("toggle-eye-tracking");
  if (toggleBtn) toggleBtn.disabled = true;
  if (toggleBtn) toggleBtn.textContent = "Loading WebGazer…";
  try {
    await loadWebGazerScript();
  } catch (e) {
    console.warn(e);
    showEyeTrackingError();
    if (toggleBtn) {
      toggleBtn.disabled = false;
      toggleBtn.textContent = toggleBtn.dataset.labelOff || "Start eye tracking";
    }
    return;
  }
  eyeTrackingActive = true;
  eyeTrackingCalibrated = false;
  setAttentionControlsDisabled(true);
  if (toggleBtn) {
    toggleBtn.classList.add("is-active");
    toggleBtn.textContent = toggleBtn.dataset.labelOn || "Stop eye tracking";
    toggleBtn.setAttribute("aria-pressed", "true");
  }
  try {
    applyWebGazerStabilityTuning();
    const begun = webgazer.begin();
    if (begun && typeof begun.then === "function") await begun;
    applyWebGazerStabilityTuning();
    disableWebGazerFaceUi();
    webgazer.showVideoPreview(true);
    disableWebGazerFaceUi();
    webgazer.showPredictionPoints(true);
    if (webgazer.removeMouseEventListeners) webgazer.removeMouseEventListeners();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => layoutWebGazerVideoCorner());
    });
    setTimeout(layoutWebGazerVideoCorner, 500);
    openCalibrationOverlay();
  } catch (e) {
    console.warn(e);
    resetEyeTrackingUiOff();
    showEyeTrackingError();
  } finally {
    if (toggleBtn) toggleBtn.disabled = false;
  }
}

function setupEyeTrackingUi() {
  if (setupEyeTrackingUi._didBind) return;
  setupEyeTrackingUi._didBind = true;
  const grid = document.getElementById("wg-cal-grid");
  if (grid && !grid.querySelector(".wg-cal-dot")) {
    for (let i = 0; i < 9; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wg-cal-dot";
      b.setAttribute("aria-label", `Calibration point ${i + 1} of 9`);
      b.addEventListener("click", onCalibrationDotClick);
      grid.appendChild(b);
    }
  }
  const toggleBtn = document.getElementById("toggle-eye-tracking");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      if (eyeTrackingActive) resetEyeTrackingUiOff();
      else startEyeTrackingFlow();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const overlay = document.getElementById("webgazer-calibration-overlay");
    if (!overlay || !overlay.classList.contains("is-open")) return;
    resetEyeTrackingUiOff();
  });
  window.addEventListener("beforeunload", () => {
    try {
      if (typeof webgazer !== "undefined" && webgazer.end) webgazer.end();
    } catch (err) {
      /* ignore */
    }
    cleanupWebGazerResources();
  });
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
    "Click to start typing. Placeholder: We scroll more than we read. Try to pay attention to me? Then type letters, numbers, punctuation, symbols, or Enter for a new line."
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

  if (attentionInput) {
    attentionInput.addEventListener("input", () => {
      updatePresetButtons();
      scheduleRedraw();
    });
  }

  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!attentionInput || attentionInput.disabled) return;
      const v = Number(btn.getAttribute("data-attention"));
      if (!Number.isFinite(v)) return;
      attentionInput.value = String(constrain(v, 0, 100));
      attentionInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  const bitPaletteStack = document.getElementById("bit-palette-rows");
  if (bitPaletteStack) {
    bitPaletteStack.addEventListener("input", (e) => {
      const t = e.target;
      if (t && t.matches && t.matches("input.bit-color-0, input.bit-color-1")) {
        invalidateDrawStyleCache();
        scheduleRedraw();
      }
    });
  }
  const EXTRA_PALETTE_DEFAULTS = [
    { zero: "#333d4a", one: "#2a3540" },
    { zero: "#4a3d33", one: "#40352a" },
  ];
  const addBitPaletteBtn = document.getElementById("add-bit-palette");
  function syncBitPaletteAddButton() {
    if (!addBitPaletteBtn || !bitPaletteStack) return;
    const n = bitPaletteStack.querySelectorAll(".bit-palette-row").length;
    addBitPaletteBtn.disabled = n >= 3;
  }
  function appendBitPaletteRow() {
    if (!bitPaletteStack || !addBitPaletteBtn) return;
    const existing = bitPaletteStack.querySelectorAll(".bit-palette-row").length;
    if (existing >= 3) return;
    const idx = existing - 1;
    const defs = EXTRA_PALETTE_DEFAULTS[idx] || EXTRA_PALETTE_DEFAULTS[EXTRA_PALETTE_DEFAULTS.length - 1];
    const row = document.createElement("div");
    row.className = "bit-palette-row bit-palette-row--extra";
    row.innerHTML = `<span class="bit-swatch-label">0</span><input type="color" class="bit-color-0" value="${defs.zero}" aria-label="Extra color for zero bits" /><span class="bit-swatch-label">1</span><input type="color" class="bit-color-1" value="${defs.one}" aria-label="Extra color for one bits" /><button type="button" class="palette-remove-btn" title="Remove this color pair" aria-label="Remove this 0 and 1 color pair">−</button>`;
    bitPaletteStack.appendChild(row);
    row.querySelector(".palette-remove-btn").addEventListener("click", () => {
      row.remove();
      syncBitPaletteAddButton();
      invalidateDrawStyleCache();
      scheduleRedraw();
    });
    syncBitPaletteAddButton();
    invalidateDrawStyleCache();
    scheduleRedraw();
  }
  if (addBitPaletteBtn && bitPaletteStack) {
    addBitPaletteBtn.addEventListener("click", appendBitPaletteRow);
    syncBitPaletteAddButton();
  }
  const colorBg = document.getElementById("color-background");
  if (colorBg) {
    colorBg.addEventListener("input", () => {
      invalidateDrawStyleCache();
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

  redraw();
}

function updatePresetButtons() {
  const a = getAttention();
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    const band = btn.getAttribute("data-band");
    let on = false;
    if (band === "present") on = a >= ATTENTION_PRESENT_MIN;
    else if (band === "distracted") on = a >= ATTENTION_DISTRACTED_MIN && a < ATTENTION_PRESENT_MIN;
    else if (band === "absent") on = a < ATTENTION_DISTRACTED_MIN;
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
  const maskW = (longestLen - 1) * CELL_ADVANCE_X + MASK_CELL_W + 2 * MASK_X_PAD;
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
      const cxCell = MASK_X_PAD + offsetX + col * CELL_ADVANCE_X + MASK_CELL_W / 2;
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
        const relX = x - offsetXRow - MASK_X_PAD;
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
 * Drift scales smoothly with attention (no kinks at preset band edges).
 * Caps a bit higher so “absent” scatters more; layout padding via maxDriftScreenPx.
 */
function driftAmount(att) {
  const a = constrain(att, 0, 100);
  const inv = 1 - smoothstep(0, 100, a);
  const invEase = inv * inv * inv;
  const cap = eyeTrackingActive && eyeTrackingCalibrated ? 2.85 : 2.2;
  return map(invEase, 0, 1, 0.06, cap);
}

/** Scatter factor 0 = calm, 1 = max offset (scaled down in draw). */
function scatterFactor(att) {
  const a = constrain(att, 0, 100);
  const inv = 1 - smoothstep(0, 100, a);
  if (eyeTrackingActive && eyeTrackingCalibrated) {
    return inv * inv * inv;
  }
  return inv * inv * inv * inv;
}

/** Worst-case screen-space offset from drift + scatter (matches draw loop). */
function maxDriftScreenPx(att) {
  const drift = driftAmount(att);
  const attC = constrain(att, 0, 100);
  const invChaos = 1 - smoothstep(0, 100, attC);
  const chaos = invChaos * invChaos;
  const driftChaosBoost = 1 + 0.5 * chaos;
  const driftPx = drift * (6 + attC * 0.05) * driftChaosBoost;
  const sc = scatterFactor(att);
  const scatterAmp = 18 * (1 + 1 * chaos);
  const scatterPx = 0.5 * scatterAmp * sc + 6 * chaos * sc;
  return driftPx + scatterPx + 58;
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
  const floor = eyeTrackingActive && eyeTrackingCalibrated ? 0.44 : BIT_OPACITY_FLOOR;
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
  const maskW = (longestLen - 1) * CELL_ADVANCE_X + MASK_CELL_W + 2 * MASK_X_PAD;
  const gy = row * CELL_H + CELL_H / 2;
  if (line.length === 0) {
    return { gx: maskW / 2, gy };
  }
  const offsetX = ((longestLen - line.length) * CELL_ADVANCE_X) / 2;
  const ins = line.length;
  const gx = MASK_X_PAD + offsetX + ins * CELL_ADVANCE_X + MASK_CELL_W / 2;
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
      const gx0 = MASK_X_PAD + offsetX + runS * CELL_ADVANCE_X;
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

  updateFocusZoneScreen(cx, cy, bx, by, scale, tm);
  if (eyeTrackingActive && eyeTrackingCalibrated) {
    gazeTargetT = computeGazeAttentionTarget(lastGazeSample, focusZone);
    const d = gazeTargetT - gazeAttentionT;
    const rateUp = 0.055;
    const rateDown = 0.14;
    const maxStepUp = 0.018;
    if (d > 0) {
      gazeAttentionT += min(d * rateUp, maxStepUp);
    } else {
      gazeAttentionT += d * rateDown;
    }
    gazeAttentionT = constrain(gazeAttentionT, 0, 1);
    const gazeStr = String(round(gazeAttentionT * 100));
    if (attentionInput && attentionInput.value !== gazeStr) {
      attentionInput.value = gazeStr;
      updatePresetButtons();
    }
  }
  updateGazeStatusDisplay();

  /* WebGazer can re-sync preview DOM after internal ticks; keep mesh off and video pinned. */
  if (eyeTrackingActive && frameCount % 45 === 0) {
    disableWebGazerFaceUi();
    applyWebGazerPreviewFill();
  }

  const att = getAttention();
  const attGlyphs = getGlyphAttention(att);
  const bgRgb = getCachedBgRgbForDraw();
  background(bgRgb.r, bgRgb.g, bgRgb.b);
  const alpha = layerAlphaForGlyphs(attGlyphs);

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

  const palettes = getCachedPalettesForDraw();
  const ctx2d = drawingContext;
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "middle";
  ctx2d.imageSmoothingEnabled = false;
  const alphaNorm = alpha / 255;
  noStroke();
  for (const b of bits) {
    const st = computeBitDrawState(b, attGlyphs, cx, cy, bx, by, scale, tm, alphaNorm, palettes);
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
    drawGhostTraces(cx, cy, bx, by, scale, tm, attGlyphs, alpha, palettes);
  }

  drawTypingCaret(cx, cy, bx, by, scale, tm);
}

/** Faint residual strokes — ramps in softly as attention drops. */
function drawGhostTraces(cx, cy, bx, by, scale, tm, att, alpha, bitPalettes) {
  const a = constrain(att, 0, 100);
  const exp = eyeTrackingActive && eyeTrackingCalibrated ? 2.1 : 3;
  const ghostAmt = (1 - smoothstep(0, 100, a)) ** exp;
  if (ghostAmt < 0.002) return;
  let r = 0;
  let gc = 0;
  let bb = 0;
  const n = bitPalettes.length;
  const scaleGhost = 0.22 / n;
  for (const p of bitPalettes) {
    r += (p.zero.r + p.one.r) * scaleGhost;
    gc += (p.zero.g + p.one.g) * scaleGhost;
    bb += (p.zero.b + p.one.b) * scaleGhost;
  }
  const b = bb;
  stroke(r, gc, b, alpha * ghostAmt * 0.14);
  strokeWeight(0.55);
  const ghostStep = bits.length > 12000 ? 72 : bits.length > 7000 ? 56 : 40;
  for (let i = 0; i < bits.length; i += ghostStep) {
    const bit = bits[i];
    const px = cx + (bit.gx - bx) * scale * tm;
    const py = cy + (bit.gy - by) * scale * tm;
    const j = noise(bit.seed * 0.02, i * 0.1) - 0.5;
    point(px + j * 2.4, py - j * 2.4);
  }
}

(function bindEyeTrackingWhenDomReady() {
  function go() {
    setupEyeTrackingUi();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", go);
  } else {
    go();
  }
})();
