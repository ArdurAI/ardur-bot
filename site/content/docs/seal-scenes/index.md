---
title: "Seal scenes"
description: "A bot's seal shows what the bot is doing: starting, thinking, searching, working through steps, waiting for its owner, paused, done or stopped with an error. An operator can tell…"
source_path: "docs/seal-scenes.md"
---

> [Source: docs/seal-scenes.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/seal-scenes.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

A bot's seal shows what the bot is doing: starting, thinking, searching, working through steps, waiting for its owner, paused, done or stopped with an error. An operator can tell at a glance which bot needs them; a screen reader hears the same phase after a busy bot's name. How each phase looks and moves is data, shared by web, desktop and mobile, so changing it means editing one file.

The first style ("pack") is **Landscapes and wonders**, transcribed from the
approved B34 canvas. **Simple ring** keeps the plain turning ring the seal used
before scenes.

## Phases

`packages/core/src/seal-scenes/types.ts` defines one phase enum: `idle`,
`starting`, `thinking`, `searching`, `steps` (with optional progress
`{ done, total }`), `waiting`, `paused`, `done` and `error`.

`deriveSealPhase` in `packages/core/src/seal-scenes/phase.ts` maps what the UI
already knows to a phase. Each row has its own test in `phase.test.ts`.

| Input | Phase |
| --- | --- |
| No run (`idle` or no status) | `idle` |
| `queued` | `starting` |
| `leased` | `starting` |
| `running`, started less than 1.5 s ago | `starting`, until 1.5 s after the start |
| `running`, the current tool call is a search, read or browse | `searching` |
| `running`, the plan or task list has two or more steps | `steps`, with progress |
| `running`, anything else | `thinking` |
| `waiting_input` | `waiting` |
| `waiting_takeover` | `paused` |
| `completed`, ended less than 4 s ago | `done`, until 4 s after the end |
| `completed`, ended 4 s or more ago, or end unknown | `idle` |
| `failed`, error not yet seen | `error` |
| `failed`, error seen | `idle` |
| `cancelled` | `idle` |

A search, read or browse call is one whose tool name or work-record line contains
a word such as search, read, fetch, browse, browser, navigate, grep, glob, find,
lookup or recall. `sealActivity` reads a run's activity from the thread: the tool
call at the end of its live message, and its subagents as the task list. No
runtime reports a structured plan to clients yet, so subagents are the task list
today.

On web and desktop the shell derives phases for the open thread's bots from its
runs, their live work record, runs it saw complete in this session, and failed
runs the reader has not dismissed. The bot list's status covers runs elsewhere,
and a newer run anywhere ends an error. Mobile maps each bot's run status, and its
thread's activity avatar also reads the live work record.

## Packs

A pack (`SealScenePack`) has an `id`, a `name`, and for every phase a `labelKey`
and a list of `layers`. A layer has:

- `shape`: a circle, path, line or rect in a 100 × 100 viewBox. The seal's disc
  fills the box; ring layers sit at radius 42.
- `fill` and `stroke`: a paint token with an opacity. A stroke width is a number
  or `ring` / `thin`, which resolve per size.
- `band`: the z-order, bottom to top `disc`, `scene`, then the bot's initial, then
  `ring` and `badge`.
- `sizes`: `all`, `large` (40 px and up) or `small` (under 40 px). Scene layers are
  usually large only; a few layers exist only at small sizes, such as the tide
  that stands in for the sundial.
- `opacity` and `rotate` (degrees about the centre): with the fill and stroke,
  these are the still pose.
- `motion`: one looping animation, or a list. Each names a `property` (`rotate`,
  `translateX`, `translateY`, `scale`, `opacity`, `strokeOpacity`, `fillOpacity`
  or `dashOffset`), `keyframes` as `[{ at, value }]` from 0 to 1, `durationMs`,
  `easing` (`linear`, `ease-in-out`, `ease-out` or cubic-bezier points),
  `delayMs`, `direction` (`normal`, `reverse` or `alternate`) and `origin`.
  Before its delay a motion holds its first keyframe.

Size rules for every pack are in `types.ts`: under 40 px the ring is 7 units wide
and the initial 60, and from 40 px they are 4 and 48.

### Change a scene

Edit the phase's entry in its pack file, for example
`packages/core/src/seal-scenes/packs/landscapes-wonders.ts`. Then open the gallery
to see every size, moving and still, in both themes.

### Add a pack

1. Add a file under `packages/core/src/seal-scenes/packs/` that exports a
   `SealScenePack`.
2. Register it in `SEAL_SCENE_PACKS` in `packages/core/src/seal-scenes/index.ts`.
3. If it uses a new label key, add it to `sealLabelMessage` in
   `apps/web/src/lib/seal-labels.ts`, run `pnpm --filter @ardurbot/web
   intl:extract`, translate it in every web catalog, and add it to the Russian
   and Chinese mobile catalogs. Tests fail until each is translated.

The guard tests in `packages/core/src/seal-scenes/seal-scenes.test.ts` run for
every registered pack.

### Switch the default

Change `DEFAULT_SEAL_SCENE_PACK` in `packages/core/src/seal-scenes/index.ts`.

### A reader's own choice

The account's appearance preferences have a `sealScenes` key: a pack id, or null
for the default. An unknown id falls back to the default. Web and desktop read it
through `SealScenePackProvider`. Mobile follows the default, as it follows the
device for appearance. There is no Settings control yet; with two packs it is a
one-line follow-up.

## Rules

- **Tokens only.** Packs paint with `pigment` (the bot's colour), `paper` and
  `ink` (the Ink & Seal paper and ink, the same in both themes, from `sealPaints`
  in `@ardurbot/ui-tokens`) and `attention` (the theme's `warning`). Pack data
  never holds a colour value.
- **Ink & Seal.** A phase never changes the seal's colour. The initial stays
  readable between the scene and the ring. Under 28 px the edge is a true circle.
  A chosen image or mascot keeps its pigment edge and shows only the ring and
  badge bands.
- **Reduced motion.** The still pose is what a reader with reduced motion sees, so
  each layer's attributes must read on their own. On web and desktop, the OS
  setting or the account's Reduce motion setting means no animation classes are
  applied; the compiled CSS also applies only when motion is allowed. Mobile uses
  the OS setting and starts no animation.
- **Performance.** Motions use transforms and opacity where they can. The
  exceptions are the starting ring drawing itself (a dash offset), the aurora's
  drifting dashes and the pyramid's filling tiers; the last two show only from
  40 px. Web compiles each pack's motions to CSS keyframes once and adds them to
  the page once; seals out of view pause. Mobile turns layers that move as a
  whole on their own native view.

## Renderers

- Web and desktop: `BotAvatar` in `packages/ui-web/src/bot-avatar.tsx` takes a
  `phase` or a run `status`. `packages/ui-web/src/seal-scene.tsx` draws the layers
  and `seal-scene-css.ts` compiles the motions.
- Mobile: `apps/mobile/components/bot-avatar.tsx` draws the same layers with
  react-native-svg through `seal-layers.tsx`. `apps/mobile/lib/seal-scene.ts`
  turns each motion into `withTiming` steps inside `withSequence` and
  `withRepeat`, played the way CSS plays its keyframes.

## Gallery

With `pnpm dev` running, open `/dev/seals` on the web app (for example
`http://127.0.0.1:5173/dev/seals`). It shows every pack in every phase at 112, 40
and 24 px, moving and still, on light and dark. It exists only on the development
server and nothing links to it.

In CI, `apps/web/e2e/seal-gallery.spec.ts` captures one screenshot per theme into
the web e2e artifacts, and `avatar-motion.spec.ts` checks that nothing animates
under reduced motion and that the gallery's moving seals do.
