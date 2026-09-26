# ላቁም? — Brand

The brand rules, where each asset comes from, and how to regenerate them.
Written with the product owner's rules (after Session 2); the numbers below are
asserted by tests, so this document cannot quietly drift from the code.

## The source image, and its licence

|             |                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| File        | `assets/brand/source/laqum-illustration.jpg`, **never edited**                                                                      |
| Supplied as | `assets/brand/laqum-illustration.png.jpg` (a JPEG despite the `.png`; Windows hid the second extension)                             |
| Format      | JPEG, 1456 × 736, 80,850 bytes                                                                                                      |
| SHA-256     | `615646dc66439b7a816ffb2915bf9aacaba730ad310773419b5430e1e4a05774` (the build refuses any other)                                    |
| Content     | A red car with a driver, a parking attendant in orange with a card reader, a checkered band, and the navy "ላቁም?" wordmark, on white |
| **Source**  | **TO CONFIRM BY PRODUCT OWNER**                                                                                                     |
| **Licence** | **TO CONFIRM BY PRODUCT OWNER**                                                                                                     |

**Do not assume it is licensed.** Before anything public: who made it, under
what licence, and whether that licence allows commercial use AND modification.
We modify it: the wordmark is traced into a vector, cut out of the picture and
redrawn on top, and the picture is cropped and resized.

## Colours

Sampled from the source by `scripts/brand/build.mjs`, recorded in
`assets/brand/generated/brand.json`, and mirrored in `BRAND`
(`packages/shared/src/brand.ts`); `brand.test.ts` asserts they agree.

| Token    | Hex       | Sampled from                                          | Pixels |
| -------- | --------- | ----------------------------------------------------- | -----: |
| `navy`   | `#1f3f71` | The wordmark's ink, median, eroded 2 px off its edges | 22,576 |
| `orange` | `#d57933` | The attendant's vest, median                          | 13,215 |
| `paper`  | `#fdfdfd` | The image's white, median of its four corners         |  1,600 |
| car red  | `#dc544e` | The car body, median. **FORBIDDEN, see rule 2.**      | 15,288 |

"Sampled exactly" means a median: a JPEG has no single exact value, and the
ink's own pixels vary around it (the commonest are `#204073` and `#1f4073`).

## The rules

**1. Brand colours are identity, not interface.** They mark the product: the
app icon, the splash, the two opening animations, the favicon. They never fill
a tile, chip, badge or button on the dashboard or the driver's screens, where
colour means slot status. That is not caution for its own sake. CIEDE2000
distances to the status and connection colours (ΔE ≤ 10 reads as "the same
colour" at a glance):

| Brand colour | Closest operational colour                | ΔE2000 |
| ------------ | ----------------------------------------- | -----: |
| navy         | out of service, dark theme `#334155`      |    8.0 |
| navy         | occupied, light theme `#1d4ed8`           |   14.0 |
| orange       | connection "reconnecting", dark `#fb923c` |    9.0 |
| orange       | reserved, dark theme `#a16207`            |   14.0 |

Kept to identity surfaces, they can never be mistaken for a status. Tests:
`apps/dashboard/src/intro.test.ts` and `apps/mobile/test/brand-config.test.ts`
scan both apps and fail if a brand colour appears outside the intro;
`brand.test.ts` pins the closest distances above, so a palette change shows
up here.

**2. Red is not ours.** Red means "act now" in this product: it is the
overstay tile. The car's red is ΔE2000 8.3 from it, so it is never a UI
colour. The nearest brand colour, orange, is 19.3 away: a neighbour, not a
shade. Asserted.

**3. Orange is an accent, used sparingly.** Orange on white is 3.18:1, below
AA, so orange is never text on a light surface. Text on orange, if any is ever
drawn there, is `#0f172a` (5.62:1).

**4. Everything written on a brand colour clears WCAG AA (4.5:1), in both
themes.** The brand surfaces do not change with the theme (a navy backdrop, a
white card), so each pair holds in light and dark alike:

| Text on surface                 | Contrast |
| ------------------------------- | -------: |
| White mark on the navy splash   |  10.46:1 |
| Navy wordmark on the paper card |  10.28:1 |
| Navy wordmark on the white icon |  10.46:1 |
| `#0f172a` on orange             |   5.62:1 |

Navy is never text on the dark theme's own background (1.71:1): in dark mode
the wordmark stays on its white card.

**5. The slot-status colours are unchanged**, exactly as `STATUS_PALETTE`
has them.

## The mark

The mark is the **full "ላቁም?" wordmark**, traced from the source into a
vector (`assets/brand/generated/wordmark.svg`), in navy on white. Every icon,
the splash and the favicon are drawn from that one path.

**Legible at 48 px:** yes, at the small end. On a 48 px launcher icon it is
about 41 × 14 px under every mask; ቁ's counter and the ? stay distinct. The
previews show it at actual size and enlarged, beside the one simplification
worth having if you disagree: **ላ alone** (`docs/brand-previews/icon-48.png`,
last tile). Not built into anything; say if you want it.

The first glyph was checked, because an inverted V can be ለ or ላ: its left leg
stops at y 392 and its right reaches the baseline at 424, which is ላ (as
rendered by Ebrima and Nyala). The wordmark reads ላቁም?.

At 16 px (the favicon in a tab) the word is about 14 × 5 px and cannot be
read; it is recognisable as the navy mark on white, which is what a tab icon
needs. Browsers that take the SVG favicon draw it sharp at any size.

## The assets

All generated by `scripts/brand/build.mjs`; none edited by hand.

| Asset                                               | Where                                                    | Notes                                                                  |
| --------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `icon.png` (1024, opaque)                           | `apps/mobile/assets/brand/`, `app.config.ts` `icon`      | iOS and legacy Android; the mark across 80% of the width               |
| `adaptive-foreground.png` (1024)                    | `android.adaptiveIcon.foregroundImage`, white background | Inside 96% of the 66/108 safe circle; the build refuses ink outside it |
| `adaptive-monochrome.png` (1024)                    | `android.adaptiveIcon.monochromeImage`                   | Android 13+ themed icons use only its alpha                            |
| `splash-icon.png` (1024)                            | `expo-splash-screen` plugin, `imageWidth: 192`, navy     | White mark inside the 192 dp circle Android shows; both themes         |
| `intro-illustration[@2x,@3x].jpg`                   | The mobile intro                                         | The picture with the wordmark cut out; 9, 23 and 40 KB (limit 200 KB)  |
| `intro-wordmark[@2x,@3x].png`                       | The mobile intro                                         | The traced wordmark, placed at `BRAND_ARTWORK`                         |
| `favicon.svg`, `favicon-16/32.png`                  | `apps/dashboard/public/`, `index.html`                   | Rounded white square, navy mark                                        |
| `apple-touch-icon.png` (180)                        | `apps/dashboard/public/`                                 | Opaque; iOS rounds it                                                  |
| `intro-illustration[@2x].jpg`, `intro-wordmark.svg` | `apps/dashboard/src/brand/`                              | The dashboard intro                                                    |

**The icon and the splash are NATIVE.** They reach the phone only with the
next EAS build, which by decision is the one that adds Firebase (Phase 5,
push). The opening animations are JavaScript: a reload shows them.

## The opening animations

**Mobile** (`apps/mobile/src/intro/`): the native splash (navy, the white mark)
hands over to a navy backdrop, so there is no flash between them; the
illustration fades and scales in on a white card of its own paper colour, then
the wordmark settles into its place, then the overlay fades to the app. At
most 1.2 s, opacity and transform only, on the native driver; cold start only,
never from a link; in parallel with the session restore; a still frame for at
most 300 ms under reduced motion. The card is also what keeps the picture from
being a white rectangle on a dark screen: its white background could not be
cut out cleanly (a JPEG, with a soft shadow under the car).

**Dashboard** (`apps/dashboard/src/components/Intro.tsx`): the same motion in
800 ms, on the page's own background (so light and dark differ), once per
browser session, pointer events off and aria-hidden, over the app rather than
before it.

## Regenerating

```bash
pnpm brand                        # regenerate every asset from the source
pnpm brand:check                  # CI: fail if a committed asset differs
pnpm brand:previews               # also write docs/brand-previews/ (icon, favicon, mobile intro)
BRAND_PREVIEWS=1 pnpm e2e         # real screenshots: dashboard intro, dev checkout page
```

`--check` compares text outputs byte for byte and images by their decoded
pixels (image encoders differ slightly between platforms; the picture must
not). Tooling: `sharp` 0.35.4 (libvips, prebuilt, no install script) and
`imagetracerjs` 1.2.6 (public domain, pure JavaScript), both development
dependencies only.

## Open questions for the product owner

- **The source and licence** of the illustration (above).
- **ላ alone** for the icon, if the full wordmark at 48 px is too small for you.
- **Not a brand colour, but the same concern:** both apps' button colour
  (`accent` light, `#1d4ed8`) is exactly the light "occupied" tile blue. It
  predates this work and was left alone; say if buttons should move away from
  it.
