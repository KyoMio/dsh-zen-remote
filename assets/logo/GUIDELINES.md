# dsh-zen-remote — Logo & Identity Guidelines

## 1. The Mark (Hex Tunnel)

- **Concept**: Two 180°-symmetric 60° hexagonal halves interlock around a sharp negative-space **Z** tunnel, representing dual-node connectivity (`Host ↔ Client` / `Peer ↔ Peer`) over LAN, P2P, and encrypted relay.
- **Construction**: Pure vector outlines on a `0° / 60°` angular grid (`viewBox="0 0 256 256"`), 16 anchor points, zero strokes, zero `<text>`, zero filters or masks.
- **Wordmark**: Custom geometric sans outlines (`dsh-zen-remote`), optically matched in stroke weight and 60° `z` diagonal to the symbol (no system font dependencies).

## 2. File Inventory

| Asset | File | Use when |
|---|---|---|
| Primary symbol (light UI) | `dsh-zen-remote-symbol-color.svg` | Light backgrounds (`#FFFFFF`, `#F5F6F8`), ≥ 24 px |
| Primary symbol (dark UI) | `dsh-zen-remote-symbol-dark.svg` | Dark backgrounds (`#0F1115`, `#121418`, `#1B2028`), optically compensated (0.98 scale) |
| Small-size symbol (16–24 px) | `dsh-zen-remote-symbol-small.svg` | Favicons, tray icons, tight toolbars (widened tunnel gap) |
| One-colour symbol | `dsh-zen-remote-symbol-black.svg`, `-white.svg`, `-mono-3d5cff.svg` | Monochrome print, embossed tiles, single-ink overlays |
| Containers | `dsh-zen-remote-symbol-square.svg`, `-favicon.svg`, `-app-icon.svg` | Avatars, browser tabs, rounded launcher tiles (`#3D5CFF` + `#FFFFFF`) |
| Horizontal lockup | `dsh-zen-remote-horizontal-{color,dark,adaptive,black,white}.svg` | README header, docs banner, desktop top bar (`adaptive` stays legible on both `#FFFFFF` & `#0D1117`) |
| Stacked lockup | `dsh-zen-remote-stacked-{color,dark,adaptive,black,white}.svg` | Narrow viewports, social/hero cards, splash screens |
| Wordmark only | `dsh-zen-remote-wordmark-{color,black,white}.svg` | Contexts where the symbol is already anchored nearby |
| Raster & Web/PWA bundle | `png/*-512|1024.png`, `web/favicon.ico`, `web/icon-*.png`, `web/site.webmanifest` | Production HTML `<head>`, PWA manifest, documentation previews |

## 3. Clear Space & Minimum Size

- **Clear space**: Maintain at least **1/4 of the symbol width** (`64` units on the `256×256` master grid, roughly the cap/x-height gap `X`) clear of text, borders, and other marks on all sides.
- **Minimum sizes**:
  - **Horizontal lockup**: `>= 120 px` wide (screen) · `>= 32 mm` wide (print) — below this, switch to stacked lockup or symbol-only.
  - **Stacked lockup**: `>= 64 px` wide (screen) · `>= 18 mm` wide (print).
  - **Symbol-only**: `>= 24 px` (`symbol-color`/`dark`); use `symbol-small` / `web/favicon-16.png` down to **`16 px`** (`6 mm` print).

## 4. Colour Palette

| Token | HEX | RGB | CMYK (approx.) | Surface |
|---|---|---|---|---|
| **Quiet Slate** | `#1B2028` | `27, 32, 40` | `32 / 20 / 0 / 84` | Light-UI primary ink & dark tile |
| **Cobalt Tunnel** | `#3D5CFF` | `61, 92, 255` | `76 / 64 / 0 / 0` | Light-UI accent & app-icon tile |
| **Mist Ink** | `#F0F4FA` | `240, 244, 250` | `4 / 2 / 0 / 2` | Dark-UI primary ink |
| **Bright Cobalt** | `#5C7BFF` | `92, 123, 255` | `64 / 52 / 0 / 0` | Dark-UI accent |

- **Approved pairs**: Full-colour light on `#FFFFFF` / `#F5F6F8`; dark variant (`#F0F4FA` + `#5C7BFF`) on `#0F1115` / `#121418` / `#1B2028`; solid white on `#3D5CFF` or `#1B2028`; solid `#111111` on light paper.

## 5. Typography & Licensing Note

- The `dsh-zen-remote` wordmark is drawn purely from custom geometric SVG paths (no embedded or external font licence required for the logo assets themselves).
- For accompanying UI headlines and body copy, continue using the project's system sans / Inter stack (`gateway-server/src/web/styles/global.css`).

## 6. Usage Don'ts

Do not stretch or skew · do not rotate the mark away from its flat-top horizontal orientation · do not add drop shadows, outer strokes, blur, or gradients · do not rearrange or scale individual parts inside a lockup · do not place the uncontained light-UI mark over busy imagery or low-contrast mid-tones · do not re-typeset the wordmark in a different font.

## 7. Open Notes

- **Trademark**: Automated logo library checks cleared direct collisions within the `developer-tools` reference set (`Zorin OS`, `OpenZeppelin`, `ZenHub`, etc.), but cannot guarantee legal trademark clearance; run an official registry / reverse-image check before formal commercial trademark filing.
