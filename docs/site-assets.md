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
sidecar with measured duration, dimensions, and SHA-256 digest, checks the 8 MB limit, and updates the generated
`videos` field. Run `pnpm site:facts:check` before publishing. Inspect the resulting frame,
captions, and sidecar before committing any media.

## Feature documentation snapshots

`site/data/feature-docs.json` holds draft and published page records; source and test bindings live
in `site/data/feature-docs-evidence.json`. Run `pnpm feature-docs:report` to see draft coverage,
then `pnpm site:facts` to generate the public `documentation` block. A page graduates when its
labels and error sentences match cited UI sources, each step has a real PNG under `site/docs/`
with matching metadata and a 250 KB maximum, and related pages are published or explicitly
deferred. Record each capture's SHA-256 in the private evidence file. `pnpm site:facts:check`
verifies those bindings. CI stages only referenced docs PNGs
with `product.json` in one orphan commit; a docs image change changes the content digest.
`pnpm feature-docs:complete` remains red while any verified user-facing page is draft. Keep
`product.docsUrl` at its existing destination until the website serves feature pages.
