# Website assets

The public site's product facts come from `site/data/product.json`. The CI publish job captures
the three screenshots in `apps/web/e2e/site-screenshots.spec.ts` with seeded demo data, stages the
referenced files, and copies screenshots and any `site/media/` files to `site-assets`. The video
uses the same deterministic web fixture approach. Its run result is rendered by the routine and
conversation UI, with no external accounts or live data.

## Record and export the Routines video

From `apps/web`, record one 1920 × 1080 take (choose a writable directory outside the repo):

```sh
WEB_PORT=5391 SITE_VIDEO_DIR=<dir> pnpm exec playwright test e2e/site-video.spec.ts
```

From the repository root, export the approved take:

```sh
site/scripts/render-routines-video.sh <dir>/routines-demo.webm <dir>/routines-demo.shots.json
```

The export cuts processing time using the recorded shot offsets, writes a verbatim WebVTT caption
track for both silent videos, a poster from the final hold, and the `site/media/routines-demo.json`
sidecar with measured duration and dimensions, checks the 8 MB limit, and updates the generated
`videos` field. Run `pnpm site:facts:check` before publishing. Inspect the resulting frame,
captions, and sidecar before committing any media.
