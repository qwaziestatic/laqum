#!/usr/bin/env node
/**
 * THE BRAND ASSETS, GENERATED FROM ONE SOURCE.
 *
 *   node scripts/brand/build.mjs              regenerate every asset
 *   node scripts/brand/build.mjs --check      fail if a committed asset differs
 *   node scripts/brand/build.mjs --previews   also write docs/brand-previews/
 *
 * Everything starts from assets/brand/source/laqum-illustration.jpg, which is
 * never modified (its SHA-256 is checked first). From it this script:
 *
 *   1. samples the brand colours (the wordmark's navy, the attendant's
 *      orange, and the car's red, which is recorded only to be FORBIDDEN);
 *   2. traces the "ላቁም?" wordmark into a vector: the one master every icon,
 *      splash and favicon is drawn from;
 *   3. cuts the wordmark out of the illustration, so the intros can animate
 *      the two separately and still land on the original composition.
 *
 * No output is edited by hand. docs/BRAND.md has the rules these serve.
 *
 * --check compares text outputs byte for byte, and images by their decoded
 * pixels with a small tolerance: PNG and JPEG encoders are not guaranteed to
 * produce identical bytes on every platform, but the picture must not change.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
/** Public domain (Unlicense), pure JavaScript; no native code. */
const ImageTracer = require('imagetracerjs');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const at = (path) => join(ROOT, path);

export const SOURCE = 'assets/brand/source/laqum-illustration.jpg';
/** The file as the product owner supplied it. Any change to it is refused. */
export const SOURCE_SHA256 = '615646dc66439b7a816ffb2915bf9aacaba730ad310773419b5430e1e4a05774';

const CHECK = process.argv.includes('--check');
const PREVIEWS = process.argv.includes('--previews');

// ─── Geometry of the source image (1456 × 736) ─────────────────────────────

/** Where the wordmark sits, with a margin. Measured, then fixed here. */
const WORDMARK_BOX = { left: 872, top: 246, width: 518, height: 186 };
/** The wordmark is traced at this multiple of the source resolution. */
const TRACE_SCALE = 4;
/**
 * The checkered band's lower-right corner. Its squares end at y 253, the ink
 * below starts at y 287 (only the "?" reaches higher, right of the band), so
 * nothing at or above-left of this point is ever erased.
 */
const BAND_CORNER = { x: 1045, y: 255 };
/** The attendant's vest: where the orange is sampled. */
const VEST_BOX = { left: 690, top: 250, width: 155, height: 180 };
/** The car's bonnet and bumper: where the red is sampled. */
const CAR_BOX = { left: 150, top: 300, width: 500, height: 150 };

/** Android adaptive icons: a 108 dp canvas whose central 66 dp circle is never masked. */
const ADAPTIVE_SAFE_DIAMETER = 66 / 108;
/** Android 12+ splash: the icon sits in a 288 dp box, shown through a 192 dp circle. */
const SPLASH_IMAGE_DP = 192;
/** Slack inside every circle the mark must fit, so antialiasing never touches it. */
const FIT_MARGIN = 0.96;

// ─── Small helpers ─────────────────────────────────────────────────────────

const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const medianColour = (pixels) => [0, 1, 2].map((k) => median(pixels.map((p) => p[k])));
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function hsv([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

/** The wordmark's ink: blue clearly above red and green, and dark. */
const isNavy = ([r, g, b]) => b > r + 40 && b > g + 20 && r < 90;
/** The checkered band: neutral grey. Never part of the wordmark. */
const isNeutralGrey = ([r, g, b]) => Math.abs(r - g) < 10 && Math.abs(g - b) < 10;

async function loadSource() {
  const bytes = await readFile(at(SOURCE));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== SOURCE_SHA256) {
    throw new Error(
      `${SOURCE} has changed (sha256 ${digest}). The source is never edited; ` +
        'a new illustration is a new decision, recorded in docs/BRAND.md.',
    );
  }
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const at3 = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return {
    bytes,
    width: info.width,
    height: info.height,
    pixel: at3,
    data,
    channels: info.channels,
  };
}

// ─── 1. Colours ────────────────────────────────────────────────────────────

function sampleColours(src) {
  // Navy: the wordmark's ink, eroded by 2 px so no antialiased edge counts.
  const ink = new Set();
  for (let y = WORDMARK_BOX.top; y < WORDMARK_BOX.top + WORDMARK_BOX.height; y++) {
    for (let x = WORDMARK_BOX.left; x < WORDMARK_BOX.left + WORDMARK_BOX.width; x++) {
      if (isNavy(src.pixel(x, y))) ink.add(y * src.width + x);
    }
  }
  const interior = [];
  for (const key of ink) {
    const x = key % src.width;
    const y = Math.floor(key / src.width);
    let inside = true;
    for (let dy = -2; dy <= 2 && inside; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!ink.has((y + dy) * src.width + x + dx)) {
          inside = false;
          break;
        }
      }
    }
    if (inside) interior.push(src.pixel(x, y));
  }

  const inBox = (box, keep) => {
    const out = [];
    for (let y = box.top; y < box.top + box.height; y++) {
      for (let x = box.left; x < box.left + box.width; x++) {
        const p = src.pixel(x, y);
        if (keep(hsv(p))) out.push(p);
      }
    }
    return out;
  };
  const vest = inBox(VEST_BOX, ([h, s, v]) => h >= 15 && h <= 40 && s > 0.55 && v > 0.6);
  const car = inBox(CAR_BOX, ([h, s, v]) => (h <= 10 || h >= 350) && s > 0.6 && v > 0.45);

  const corners = [];
  for (const [cx, cy] of [
    [0, 0],
    [src.width - 20, 0],
    [0, src.height - 20],
    [src.width - 20, src.height - 20],
  ]) {
    for (let y = cy; y < cy + 20; y++)
      for (let x = cx; x < cx + 20; x++) corners.push(src.pixel(x, y));
  }

  return {
    navy: { hex: hex(medianColour(interior)), pixels: interior.length },
    orange: { hex: hex(medianColour(vest)), pixels: vest.length },
    carRed: { hex: hex(medianColour(car)), pixels: car.length },
    paper: { hex: hex(medianColour(corners)), pixels: corners.length },
  };
}

// ─── 2. The wordmark, traced ───────────────────────────────────────────────

/**
 * Coverage of the wordmark per source pixel (0..255): how much of the pixel
 * is navy ink rather than paper, judged by lightness, but only next to
 * pixels that are unmistakably navy. The grey band above the wordmark is
 * excluded explicitly, so no square of it can ever be read as ink.
 */
function wordmarkCoverage(src, colours) {
  const { left, top, width, height } = WORDMARK_BOX;
  const strong = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      strong[y * width + x] = isNavy(src.pixel(left + x, top + y)) ? 1 : 0;
  }
  const nearInk = (x, y, radius) => {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < width && yy < height && strong[yy * width + xx]) return true;
      }
    }
    return false;
  };
  const navy = hexToRgb(colours.navy.hex);
  const paper = hexToRgb(colours.paper.hex);
  const yInk = luminance(navy);
  const yPaper = luminance(paper);
  const coverage = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = src.pixel(left + x, top + y);
      if (!nearInk(x, y, 2)) continue;
      if (isNeutralGrey(p) && !strong[y * width + x] && p[2] - p[0] < 6) continue;
      const a = Math.max(0, Math.min(1, (yPaper - luminance(p)) / (yPaper - yInk)));
      coverage[y * width + x] = Math.round(a * 255);
    }
  }
  return { coverage, width, height, nearInk };
}

function hexToRgb(value) {
  return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
}

/** Numbers in a path, as [x, y] points (control points included). */
function pathPoints(d) {
  const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const points = [];
  for (let i = 0; i + 1 < n.length; i += 2) points.push([n[i], n[i + 1]]);
  return points;
}

async function traceWordmark(src, colours) {
  const { coverage, width, height } = wordmarkCoverage(src, colours);
  const W = width * TRACE_SCALE;
  const H = height * TRACE_SCALE;
  // Upscale, then smooth before thresholding: the JPEG's blocky edges become
  // curves the tracer can follow, instead of stairs it faithfully copies.
  const { data: up } = await sharp(coverage, { raw: { width, height, channels: 1 } })
    .resize({ width: W, height: H, kernel: 'lanczos3' })
    .blur(3.5)
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = up[i] >= 128 ? 0 : 255;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const svg = ImageTracer.imagedataToSVG(
    { width: W, height: H, data: rgba },
    {
      ltres: 2,
      qtres: 2,
      pathomit: 64,
      colorsampling: 0,
      numberofcolors: 2,
      pal: [
        { r: 255, g: 255, b: 255, a: 255 },
        { r: 0, g: 0, b: 0, a: 255 },
      ],
      blurradius: 0,
      strokewidth: 0,
      linefilter: false,
      roundcoords: 1,
      viewbox: true,
      desc: false,
    },
  );
  // The black layer is the ink; each path carries its own counters.
  const glyphs = [...svg.matchAll(/<path fill="rgb\((\d+),\d+,\d+\)"[^>]*\sd="([^"]+)"/g)]
    .filter((m) => m[1] === '0')
    .map((m) => m[2].trim())
    .map((d) => {
      const points = pathPoints(d);
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      return {
        d,
        x0: Math.min(...xs),
        x1: Math.max(...xs),
        y0: Math.min(...ys),
        y1: Math.max(...ys),
      };
    })
    .sort((a, b) => a.x0 - b.x0);
  if (glyphs.length !== 5) {
    throw new Error(`expected 5 ink paths (ላ ቁ ም and the two parts of ?), traced ${glyphs.length}`);
  }
  const bounds = {
    x0: Math.floor(Math.min(...glyphs.map((g) => g.x0))),
    y0: Math.floor(Math.min(...glyphs.map((g) => g.y0))),
    x1: Math.ceil(Math.max(...glyphs.map((g) => g.x1))),
    y1: Math.ceil(Math.max(...glyphs.map((g) => g.y1))),
  };
  const d = glyphs.map((g) => g.d).join(' ');
  // The smallest circle around every point of the ink, for fitting the mark
  // inside Android's circular masks without clipping a glyph.
  const points = glyphs.flatMap((g) => pathPoints(g.d));
  let enclosing = null;
  const cx0 = (bounds.x0 + bounds.x1) / 2;
  const cy0 = (bounds.y0 + bounds.y1) / 2;
  for (let cx = cx0 - 60; cx <= cx0 + 60; cx += 2) {
    for (let cy = cy0 - 60; cy <= cy0 + 60; cy += 2) {
      let r = 0;
      for (const [x, y] of points) r = Math.max(r, Math.hypot(x - cx, y - cy));
      if (enclosing === null || r < enclosing.r) enclosing = { cx, cy, r };
    }
  }
  return { d, glyphs, bounds, enclosing };
}

// ─── SVG builders (every icon comes from the one path) ─────────────────────

const fmt = (n) => Number(n.toFixed(3)).toString();

/** The wordmark alone, tight: the vector master. */
function wordmarkSvg(mark, fill) {
  const { x0, y0, x1, y1 } = mark.bounds;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" ` +
    `role="img" aria-label="ላቁም?"><path fill="${fill}" d="${mark.d}"/></svg>\n`
  );
}

/**
 * A square canvas with the mark centred on the ink's enclosing circle, scaled
 * so that circle has the given diameter (a fraction of the canvas).
 */
function markOnSquare(mark, { size, diameter, fill, background, cornerRadius = 0 }) {
  const k = (diameter * size) / 2 / mark.enclosing.r;
  const tx = size / 2 - mark.enclosing.cx * k;
  const ty = size / 2 - mark.enclosing.cy * k;
  const bg = background
    ? `<rect width="${size}" height="${size}" rx="${fmt(cornerRadius * size)}" fill="${background}"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `${bg}<path fill="${fill}" transform="translate(${fmt(tx)} ${fmt(ty)}) scale(${fmt(k)})" d="${mark.d}"/></svg>\n`
  );
}

// ─── 3. The illustration without its wordmark ─────────────────────────────

async function illustrationLayers(src, colours, mark) {
  const { coverage, width, height, nearInk } = wordmarkCoverage(src, colours);
  // Paint the wordmark and its antialiased halo with the paper it sits on.
  const out = Buffer.from(src.data);
  const paperNear = medianColour(
    (() => {
      const ring = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = src.pixel(WORDMARK_BOX.left + x, WORDMARK_BOX.top + y);
          if (!nearInk(x, y, 6) && luminance(p) > 230) ring.push(p);
        }
      }
      return ring;
    })(),
  );
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBand =
        WORDMARK_BOX.left + x <= BAND_CORNER.x && WORDMARK_BOX.top + y <= BAND_CORNER.y;
      // 8 px: the JPEG's ringing leaves a visible ghost of the letters at 3.
      const halo = nearInk(x, y, 8) && !inBand;
      if (!halo && coverage[y * width + x] === 0) continue;
      const i = ((WORDMARK_BOX.top + y) * src.width + WORDMARK_BOX.left + x) * src.channels;
      out[i] = paperNear[0];
      out[i + 1] = paperNear[1];
      out[i + 2] = paperNear[2];
    }
  }

  // Crop to the drawing plus the wordmark, with a margin: the source's wide
  // white borders would only shrink the picture on a phone.
  let x0 = src.width;
  let y0 = src.height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * src.channels;
      if (Math.min(out[i], out[i + 1], out[i + 2]) < 236) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  // The wordmark in source pixels (the trace is TRACE_SCALE times larger).
  const wm = {
    x: WORDMARK_BOX.left + mark.bounds.x0 / TRACE_SCALE,
    y: WORDMARK_BOX.top + mark.bounds.y0 / TRACE_SCALE,
    width: (mark.bounds.x1 - mark.bounds.x0) / TRACE_SCALE,
    height: (mark.bounds.y1 - mark.bounds.y0) / TRACE_SCALE,
  };
  const MARGIN = 24;
  const crop = {
    left: Math.max(0, Math.min(x0, Math.floor(wm.x)) - MARGIN),
    top: Math.max(0, Math.min(y0, Math.floor(wm.y)) - MARGIN),
  };
  crop.width = Math.min(src.width, Math.max(x1, Math.ceil(wm.x + wm.width)) + MARGIN) - crop.left;
  crop.height = Math.min(src.height, Math.max(y1, Math.ceil(wm.y + wm.height)) + MARGIN) - crop.top;

  const erased = sharp(out, {
    raw: { width: src.width, height: src.height, channels: src.channels },
  })
    .extract(crop)
    .png();
  const layout = {
    crop,
    aspect: Number((crop.width / crop.height).toFixed(5)),
    // Fractions of the cropped illustration, so any rendered size lines up.
    wordmark: {
      left: Number(((wm.x - crop.left) / crop.width).toFixed(5)),
      top: Number(((wm.y - crop.top) / crop.height).toFixed(5)),
      width: Number((wm.width / crop.width).toFixed(5)),
      height: Number((wm.height / crop.height).toFixed(5)),
    },
  };
  return { erased: await erased.toBuffer(), layout };
}

// ─── Output plumbing ───────────────────────────────────────────────────────

const written = [];
const mismatched = [];

async function sameImage(a, b) {
  const [ia, ib] = await Promise.all(
    [a, b].map((buf) => sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })),
  );
  if (ia.info.width !== ib.info.width || ia.info.height !== ib.info.height) return false;
  let worst = 0;
  for (let i = 0; i < ia.data.length; i++)
    worst = Math.max(worst, Math.abs(ia.data[i] - ib.data[i]));
  // JPEG decoders and encoders differ slightly by platform; a changed
  // picture differs by far more than this.
  return worst <= 8;
}

async function emit(path, content) {
  const full = at(path);
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (CHECK) {
    let existing;
    try {
      existing = await readFile(full);
    } catch {
      mismatched.push(`${path} (missing)`);
      return;
    }
    const same =
      typeof content === 'string' ? existing.equals(buffer) : await sameImage(existing, buffer);
    if (!same) mismatched.push(path);
    return;
  }
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, buffer);
  written.push(`${relative(ROOT, full).split('\\').join('/')} (${String(buffer.length)} B)`);
}

/**
 * Refuse a mark that leaves its circle: Android masks everything outside the
 * adaptive icon's 66 dp safe zone, and the splash outside its 192 dp circle.
 */
async function assertInkInside(buffer, radius, label) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const c = info.width / 2;
  let worst = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 0)
        worst = Math.max(worst, Math.hypot(x + 0.5 - c, y + 0.5 - c));
    }
  }
  if (worst > radius)
    throw new Error(
      `${label}: ink reaches ${worst.toFixed(1)} px from the centre; the limit is ${radius}`,
    );
}

const png = (svg, size) =>
  sharp(Buffer.from(svg), { density: 72 })
    .resize(size, size)
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();

// ─── Main ──────────────────────────────────────────────────────────────────

const src = await loadSource();
const colours = sampleColours(src);
const mark = await traceWordmark(src, colours);
const NAVY = colours.navy.hex;
const WHITE = '#ffffff';

// The vector master, and the numbers everything else is checked against.
await emit('assets/brand/generated/wordmark.svg', wordmarkSvg(mark, NAVY));

const { erased, layout } = await illustrationLayers(src, colours, mark);
await emit(
  'assets/brand/generated/brand.json',
  `${JSON.stringify(
    {
      generatedBy: 'scripts/brand/build.mjs',
      source: { file: SOURCE, sha256: SOURCE_SHA256, width: src.width, height: src.height },
      colours: {
        navy: { ...colours.navy, method: 'median of the wordmark ink, eroded 2 px' },
        orange: { ...colours.orange, method: "median of the attendant's vest orange" },
        carRed: {
          ...colours.carRed,
          method: 'median of the car body red; FORBIDDEN as a UI colour',
        },
        paper: { ...colours.paper, method: 'median of the four 20 px corners' },
      },
      intro: layout,
    },
    null,
    2,
  )}\n`,
);

// ── Mobile: icon, adaptive icon, monochrome, splash ──
const MOBILE = 'apps/mobile/assets/brand';
// iOS and legacy Android: opaque, the mark across ~80% of the width.
const legacyDiameter = (0.8 * (2 * mark.enclosing.r)) / (mark.bounds.x1 - mark.bounds.x0);
await emit(
  `${MOBILE}/icon.png`,
  await png(
    markOnSquare(mark, { size: 1024, diameter: legacyDiameter, fill: NAVY, background: WHITE }),
    1024,
  ),
);
const adaptive = ADAPTIVE_SAFE_DIAMETER * FIT_MARGIN;
const foreground = await png(
  markOnSquare(mark, { size: 1024, diameter: adaptive, fill: NAVY }),
  1024,
);
await assertInkInside(foreground, (1024 * ADAPTIVE_SAFE_DIAMETER) / 2, 'adaptive foreground');
await emit(`${MOBILE}/adaptive-foreground.png`, foreground);
// Android 13+ themed icons use only the alpha channel; the colour is the system's.
await emit(
  `${MOBILE}/adaptive-monochrome.png`,
  await png(markOnSquare(mark, { size: 1024, diameter: adaptive, fill: WHITE }), 1024),
);
// White on the navy splash background, inside the circle Android shows.
const splashIcon = await png(
  markOnSquare(mark, { size: 1024, diameter: FIT_MARGIN, fill: WHITE }),
  1024,
);
// The plugin draws this square at SPLASH_IMAGE_DP inside a 288 dp box, and
// Android shows a 192 dp circle of it: the whole inscribed circle.
await assertInkInside(splashIcon, (1024 * (SPLASH_IMAGE_DP / 192)) / 2, 'splash icon');
await emit(`${MOBILE}/splash-icon.png`, splashIcon);

// ── Mobile intro: the illustration and the wordmark, per density ──
const MOBILE_INTRO_WIDTH = 360;
for (const [suffix, factor] of [
  ['', 1],
  ['@2x', 2],
  ['@3x', 3],
]) {
  const w = MOBILE_INTRO_WIDTH * factor;
  await emit(
    `${MOBILE}/intro-illustration${suffix}.jpg`,
    await sharp(erased).resize({ width: w }).jpeg({ quality: 82, mozjpeg: true }).toBuffer(),
  );
  const ww = Math.round(w * layout.wordmark.width);
  const wh = Math.round(
    ww * ((mark.bounds.y1 - mark.bounds.y0) / (mark.bounds.x1 - mark.bounds.x0)),
  );
  await emit(
    `${MOBILE}/intro-wordmark${suffix}.png`,
    await sharp(Buffer.from(wordmarkSvg(mark, NAVY)))
      .resize(ww, wh)
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );
}

// ── Dashboard: favicons and the intro ──
const FAVICON_RADIUS = 0.18;
const faviconSvg = markOnSquare(mark, {
  size: 64,
  diameter: 0.94,
  fill: NAVY,
  background: WHITE,
  cornerRadius: FAVICON_RADIUS,
});
await emit('apps/dashboard/public/favicon.svg', faviconSvg);
for (const size of [16, 32])
  await emit(`apps/dashboard/public/favicon-${size}.png`, await png(faviconSvg, size));
// iOS masks and rounds this itself, so it is square and opaque.
await emit(
  'apps/dashboard/public/apple-touch-icon.png',
  await png(
    markOnSquare(mark, { size: 180, diameter: legacyDiameter, fill: NAVY, background: WHITE }),
    180,
  ),
);
const WEB_INTRO_WIDTH = 480;
for (const [suffix, factor] of [
  ['', 1],
  ['@2x', 2],
]) {
  await emit(
    `apps/dashboard/src/brand/intro-illustration${suffix}.jpg`,
    await sharp(erased)
      .resize({ width: WEB_INTRO_WIDTH * factor })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer(),
  );
}
await emit('apps/dashboard/src/brand/intro-wordmark.svg', wordmarkSvg(mark, NAVY));

if (PREVIEWS) {
  const { writePreviews } = await import('./previews.mjs');
  await writePreviews({ mark, layout, colours, erased, markOnSquare, wordmarkSvg, emit, png });
}

if (CHECK) {
  if (mismatched.length > 0) {
    console.error(`Brand assets differ from what ${SOURCE} produces:`);
    for (const path of mismatched) console.error(`  ${path}`);
    console.error('Run `pnpm brand` and commit the result.');
    process.exit(1);
  }
  console.warn('Brand assets are up to date.');
} else {
  console.warn(
    `Colours: ${JSON.stringify(Object.fromEntries(Object.entries(colours).map(([k, v]) => [k, v.hex])))}`,
  );
  for (const line of written) console.warn(`  wrote ${line}`);
}
