# Ōtori — Logo & brand mark

> Design SSOT for the brand mark. The canonical source is
> [`docs/assets/logo.svg`](../assets/logo.svg); `logo.png` is rendered from it.

## The mark

**"Phoenix perched on the Ō."** A light ring — the letter **O**, a stage
ring, a spinning record — with four tail feathers sweeping up and to the
right for motion. The ring's hole reads as an eye; the whole shape reads
as a small phoenix taking off from a stage.

The asymmetric sweep (variant E3 in the drafts) was chosen over the
symmetric fan (E1) and the centered monogram (C): it reads as *logo, not
icon* — it has a direction and a gesture, not just a silhouette.

## The four colors (the easter egg)

The four feathers are the member colors of **Wonderlands×Showtime**
(WxS), the Project SEKAI unit the product is named after — ADR-0001 §1
records that `Ōtori` comes from 鳳えむ (Otori Emu), 鳳 = phoenix, echoing
Phoenix Wonderland.

| Feather | Hex | WxS member | Public meaning (App.css accent) |
|---|---|---|---|
| Gold | `#FFBB00` | Tenma Tsukasa | library |
| Pink | `#FF66BB` | Otori Emu | lyrics |
| Green | `#33DD99` | Kusanagi Nene | playback |
| Purple | `#BB88EE` | Kamishiro Rui | spectrum |

The egg is **deniable by construction**: the app already maps four
accent colors to its four functional areas (`--library` / `--lyrics` /
`--playback` / `--spectrum` in `src/App.css`). The logo simply flies the
same four colors. Fans of WxS recognize the member palette; everyone else
sees the product's own accent system. Both readings are true.

## Legal boundary

Per ADR-0001 §1, the product deliberately avoids anything that points
100% at the IP owner (SEGA / Colorful Palette, an aggressive trademark
enforcer):

- **Colors are safe.** A palette is not trademarkable; four hex values
  carry a plausible in-app rationale.
- **Avoided:** character-specific coined marks (the "Wonderhoy" catch
  phrase — kept only as an internal theme name, never the product name),
  the circus-tent / Wonder Stage silhouette, any member likeness.

The mark is a phoenix and a record. Nothing in it is ownable by the IP
holder.

## Sizing

Verified legible at 512 / 128 / 32 px (`docs/design/logo-drafts/`):
at 32 px the ring + colored feathers still resolve. Because the mark
carries no facial features, it survives menubar / favicon sizes — the
cute face-and-blush variants (F1–F3) lose their expression below ~128 px
and were dropped for that reason.

If a large-format "mascot" treatment is ever wanted (welcome screen,
About page), variant F3 (winking face + blush) is the sketched starting
point.

## Assets

- `docs/assets/logo.svg` — canonical source
- `docs/assets/logo.png` — 256 px, used by README and `social-preview.svg`
- `docs/design/logo-drafts/` — the full exploration (A–D concepts,
  E1–E3 fusions, F1–F3 cute pass, `otori-logo.svg` final)
