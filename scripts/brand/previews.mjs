/**
 * REVIEW IMAGES for docs/brand-previews/, so the brand can be judged without
 * running anything. Written by `pnpm brand:previews` (build.mjs --previews).
 *
 * The icon, favicon and splash are drawn from the generated files themselves,
 * through the masks a launcher applies. The mobile intro cannot be captured
 * without a phone, so its frames are COMPOSITED here from the same images and
 * the same numbers the app uses (apps/mobile/src/intro/timeline.ts, imported
 * directly, and the artwork geometry in brand.json). Each such image says so
 * in its caption; the phone check is DEVICE-TEST.md step 22.
 *
 * The dashboard intro and the development checkout page are real browser
 * screenshots, taken by Playwright (BRAND_PREVIEWS=1 pnpm e2e).
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'docs/brand-previews');
const MOBILE = join(ROOT, 'apps/mobile/assets/brand');
const FONT = "'Segoe UI', 'Noto Sans', 'Noto Sans Ethiopic', Nyala, sans-serif";

const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A caption, as an image, `width` wide. */
function caption(
  text,
  width,
  { size = 22, colour = '#1e293b', background = '#ffffff', height = 44 } = {},
) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="${background}"/>` +
      `<text x="12" y="${height / 2 + size / 3}" font-family="${FONT}" font-size="${size}" fill="${colour}">${escape(text)}</text></svg>`,
  );
}

function squircle(size, n = 5) {
  const points = [];
  for (let i = 0; i < 360; i++) {
    const t = (i / 360) * 2 * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = size / 2 + (Math.sign(c) * Math.abs(c) ** (2 / n) * size) / 2;
    const y = size / 2 + (Math.sign(s) * Math.abs(s) ** (2 / n) * size) / 2;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return `M${points.join('L')}Z`;
}

const MASKS = {
  circle: (s) => `<circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}" fill="#fff"/>`,
  squircle: (s) => `<path d="${squircle(s)}" fill="#fff"/>`,
  'rounded square': (s) => `<rect width="${s}" height="${s}" rx="${s * 0.22}" fill="#fff"/>`,
};

/**
 * An adaptive icon as a launcher shows it: background and foreground layered,
 * the visible 72 dp of the 108 dp canvas cropped out, then masked.
 */
async function launcherIcon({ foreground, background, tint }, mask, px) {
  const canvas = 1024;
  let fg = await sharp(foreground).resize(canvas, canvas).png().toBuffer();
  if (tint) {
    // Android 13 themed icons: only the alpha is used, in the system's colour.
    const alpha = await sharp(fg).extractChannel(3).toBuffer();
    fg = await sharp({
      create: { width: canvas, height: canvas, channels: 3, background: tint.fg },
    })
      .joinChannel(alpha)
      .png()
      .toBuffer();
  }
  const layered = await sharp({
    create: { width: canvas, height: canvas, channels: 4, background: tint ? tint.bg : background },
  })
    .composite([{ input: fg }])
    .png()
    .toBuffer();
  const visible = Math.round((canvas * 72) / 108);
  const offset = Math.round((canvas - visible) / 2);
  const cropped = await sharp(layered)
    .extract({ left: offset, top: offset, width: visible, height: visible })
    .resize(512, 512)
    .png()
    .toBuffer();
  const maskSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">${MASKS[mask](512)}</svg>`,
  );
  const masked = await sharp(cropped)
    .composite([{ input: maskSvg, blend: 'dest-in' }])
    .png()
    .toBuffer();
  return sharp(masked).resize(px, px, { kernel: 'lanczos3' }).png().toBuffer();
}

/** The legacy / iOS icon: the opaque square, rounded as iOS does. */
async function roundedIcon(icon, px) {
  const maskSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">${MASKS['rounded square'](1024)}</svg>`,
  );
  const masked = await sharp(icon)
    .resize(1024, 1024)
    .composite([{ input: maskSvg, blend: 'dest-in' }])
    .png()
    .toBuffer();
  return sharp(masked).resize(px, px, { kernel: 'lanczos3' }).png().toBuffer();
}

/** A row of tiles on a wallpaper, each with a label, at 1× (and zoomed). */
async function sheet(file, title, tiles, { px, zoom = 1, wallpaper = '#5b6472' }) {
  const cell = Math.max(px * zoom, 150) + 24;
  const width = 24 + tiles.length * cell;
  const height = 60 + px + (zoom > 1 ? px * zoom + 24 : 0) + 60;
  const layers = [{ input: caption(title, width, { background: '#f1f5f9' }), left: 0, top: 0 }];
  for (const [i, tile] of tiles.entries()) {
    const x = 24 + i * cell;
    layers.push({ input: tile.image, left: x, top: 60 });
    if (zoom > 1) {
      const big = await sharp(tile.image)
        .resize(px * zoom, px * zoom, { kernel: 'nearest' })
        .png()
        .toBuffer();
      layers.push({ input: big, left: x, top: 60 + px + 12 });
    }
    layers.push({
      input: caption(tile.label, cell - 8, {
        size: 15,
        colour: '#f8fafc',
        background: wallpaper,
        height: 40,
      }),
      left: x - 12,
      top: height - 52,
    });
  }
  await sharp({ create: { width, height, channels: 4, background: wallpaper } })
    .composite(layers)
    .png()
    .toFile(join(OUT, file));
}

// ─── The mobile intro, composited ──────────────────────────────────────────

async function introFrame({ timeline, artwork, colours, ms, theme, scale = 2 }) {
  const { INTRO_TRACKS, INTRO_EXIT, INTRO_SETTLED_MS, introCard, trackValueAt } = timeline;
  const W = 412;
  const H = 915;
  const value = (target, property) => {
    const track = INTRO_TRACKS.find((t) => t.target === target && t.property === property);
    return trackValueAt(track, ms);
  };
  const exit = ms > INTRO_SETTLED_MS ? trackValueAt(INTRO_EXIT, ms - INTRO_SETTLED_MS) : 1;

  const card = introCard(W);
  const pictureW = card.width - 2 * card.padding;
  const pictureH = pictureW / artwork.aspect;
  const cardH = pictureH + 2 * card.padding;
  const columnH = cardH + 24 + 48;
  const cardTop = (H - columnH) / 2;
  const cardLeft = (W - card.width) / 2;
  const px = (dp) => Math.round(dp * scale);

  // The card, with the picture and the wordmark at this moment.
  const cardBg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px(card.width)}" height="${px(cardH)}">` +
      `<rect width="100%" height="100%" rx="${px(card.radius)}" fill="${colours.paper.hex}"/></svg>`,
  );
  const picture = await sharp(join(MOBILE, 'intro-illustration@3x.jpg'))
    .resize(px(pictureW), px(pictureH))
    .png()
    .toBuffer();
  const w = artwork.wordmark;
  const wmOpacity = value('wordmark', 'opacity');
  const wmY = value('wordmark', 'translateY');
  const wordmarkImg = await sharp(join(MOBILE, 'intro-wordmark@3x.png'))
    .resize(px(w.width * pictureW), px(w.height * pictureH), { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer();
  const wordmarkFaded = await fade(wordmarkImg, wmOpacity);
  let cardImg = await sharp(cardBg)
    .composite([
      { input: picture, left: px(card.padding), top: px(card.padding) },
      {
        input: wordmarkFaded,
        left: px(card.padding + w.left * pictureW),
        top: px(card.padding + w.top * pictureH + wmY),
      },
    ])
    .png()
    .toBuffer();
  const s = value('illustration', 'scale');
  const scaledW = Math.max(1, Math.round(px(card.width) * s));
  const scaledH = Math.max(1, Math.round(px(cardH) * s));
  cardImg = await fade(
    await sharp(cardImg).resize(scaledW, scaledH).png().toBuffer(),
    value('illustration', 'opacity'),
  );

  const overlay = await sharp({
    create: { width: px(W), height: px(H), channels: 4, background: colours.navy.hex },
  })
    .composite([
      {
        input: cardImg,
        left: Math.round(px(cardLeft + card.width / 2) - scaledW / 2),
        top: Math.round(px(cardTop + cardH / 2) - scaledH / 2),
      },
    ])
    .png()
    .toBuffer();
  // What the exit reveals: the app, here only its background colour.
  const appBg = theme === 'dark' ? '#0f172a' : '#fdfdfe';
  return sharp({ create: { width: px(W), height: px(H), channels: 4, background: appBg } })
    .composite([{ input: await fade(overlay, exit) }])
    .png()
    .toBuffer();
}

/** Multiply an image's alpha by `opacity`. */
async function fade(image, opacity) {
  if (opacity >= 1) return image;
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * Math.max(0, opacity));
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

async function framed(image, label, width) {
  const meta = await sharp(image).metadata();
  const scaled = await sharp(image).resize({ width }).png().toBuffer();
  const h = Math.round((meta.height * width) / meta.width);
  return sharp({ create: { width, height: h + 40, channels: 4, background: '#f1f5f9' } })
    .composite([
      { input: scaled, left: 0, top: 0 },
      {
        input: caption(label, width, { size: 15, height: 40, background: '#f1f5f9' }),
        left: 0,
        top: h,
      },
    ])
    .png()
    .toBuffer();
}

async function strip(file, title, frames, frameWidth) {
  const images = await Promise.all(frames.map((f) => framed(f.image, f.label, frameWidth)));
  const metas = await Promise.all(images.map((i) => sharp(i).metadata()));
  const height = Math.max(...metas.map((m) => m.height)) + 60;
  const width = 24 + images.length * (frameWidth + 24);
  await sharp({ create: { width, height, channels: 4, background: '#e2e8f0' } })
    .composite([
      { input: caption(title, width, { background: '#f1f5f9' }), left: 0, top: 0 },
      ...images.map((input, i) => ({ input, left: 24 + i * (frameWidth + 24), top: 52 })),
    ])
    .png()
    .toFile(join(OUT, file));
}

export async function writePreviews({ mark, markOnSquare, png, colours, layout }) {
  await mkdir(OUT, { recursive: true });
  const foreground = await readFile(join(MOBILE, 'adaptive-foreground.png'));
  const monochrome = await readFile(join(MOBILE, 'adaptive-monochrome.png'));
  const icon = await readFile(join(MOBILE, 'icon.png'));
  const adaptive = { foreground, background: '#ffffff' };
  const themed = { foreground: monochrome, tint: { bg: '#d8e2ff', fg: '#1b3160' } };

  // The fallback, for comparison only: ላ alone, drawn from the same trace.
  const la = { ...mark, d: mark.glyphs[0].d, enclosing: enclosingOf(mark.glyphs[0]) };
  const laForeground = await png(
    markOnSquare(la, { size: 1024, diameter: (66 / 108) * 0.96, fill: colours.navy.hex }),
    1024,
  );

  for (const px of [48, 192]) {
    const tiles = [];
    for (const mask of Object.keys(MASKS)) {
      tiles.push({ image: await launcherIcon(adaptive, mask, px), label: `Android, ${mask}` });
    }
    tiles.push({ image: await launcherIcon(themed, 'circle', px), label: 'Android 13+ themed' });
    tiles.push({ image: await roundedIcon(icon, px), label: 'iOS / legacy' });
    tiles.push({
      image: await launcherIcon({ foreground: laForeground, background: '#ffffff' }, 'circle', px),
      label: 'Fallback: ላ alone',
    });
    await sheet(
      `icon-${px}.png`,
      `The app icon at ${px} px (top: actual size${px === 48 ? '; below: the same pixels enlarged ×4' : ''})`,
      tiles,
      { px, zoom: px === 48 ? 4 : 1 },
    );
  }

  // Favicons, on a light and a dark tab bar.
  const favicons = [];
  for (const [bar, name] of [
    ['#e8eaed', 'light tab bar'],
    ['#202124', 'dark tab bar'],
  ]) {
    for (const size of [16, 32]) {
      const file = await readFile(join(ROOT, `apps/dashboard/public/favicon-${size}.png`));
      favicons.push({
        image: await sharp({ create: { width: 32, height: 32, channels: 4, background: bar } })
          .composite([{ input: file, gravity: 'center' }])
          .png()
          .toBuffer(),
        label: `${size} px, ${name}`,
      });
    }
  }
  await sheet(
    'favicon.png',
    'The dashboard favicon (top: actual size; below: enlarged ×8)',
    favicons,
    {
      px: 32,
      zoom: 8,
    },
  );

  // The native splash: navy, the white mark in the 192 dp circle. Both themes.
  const W = 412;
  const H = 915;
  const splashIcon = await sharp(join(MOBILE, 'splash-icon.png'))
    .resize(192 * 2, 192 * 2)
    .png()
    .toBuffer();
  const splash = await sharp({
    create: { width: W * 2, height: H * 2, channels: 4, background: colours.navy.hex },
  })
    .composite([{ input: splashIcon, gravity: 'center' }])
    .png()
    .toBuffer();

  // The mobile intro, from the app's own numbers.
  const timeline = await import('../../apps/mobile/src/intro/timeline.ts');
  const artwork = layout;
  for (const theme of ['light', 'dark']) {
    const frame = (ms) => introFrame({ timeline, artwork, colours, ms, theme });
    await strip(
      `intro-mobile-${theme}.png`,
      `Mobile intro, ${theme} phone. COMPOSITED from the app's images and timeline, not captured on a device (DEVICE-TEST step 22).`,
      [
        { image: splash, label: 'native splash (after the next build)' },
        { image: await frame(0), label: 'intro, first frame: 0 ms' },
        { image: await frame(300), label: '300 ms' },
        { image: await frame(600), label: '600 ms' },
        { image: await frame(1000), label: 'last entrance frame: 1000 ms' },
        { image: await frame(1100), label: 'exit, 1100 ms: the app shows through' },
      ],
      260,
    );
  }
  console.warn(
    '  wrote docs/brand-previews/ (icon-48, icon-192, favicon, intro-mobile-light/dark)',
  );
}

function enclosingOf(glyph) {
  const n = glyph.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const points = [];
  for (let i = 0; i + 1 < n.length; i += 2) points.push([n[i], n[i + 1]]);
  const cx = (glyph.x0 + glyph.x1) / 2;
  const cy = (glyph.y0 + glyph.y1) / 2;
  let r = 0;
  for (const [x, y] of points) r = Math.max(r, Math.hypot(x - cx, y - cy));
  return { cx, cy, r };
}
