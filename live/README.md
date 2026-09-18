# live/ — "Stationhead, the last three weeks"

`index.html` is **generated**. Do not hand-edit it, and do not upload it through the
GitHub web UI. Edit `data.json` and rebuild.

```bash
node live/build.mjs --check   # verify, write nothing
node live/build.mjs           # regenerate live/index.html
```

## Files

| File | Role |
|---|---|
| `data.json` | Source of truth. All copy, figures, dates and broadcast ids. |
| `_style.css` | Presentation. Inlined into the page at build time. |
| `build.mjs` | Renderer plus the pre-ship checks. No dependencies. |
| `index.html` | Generated output. Committed, because GitHub Pages serves it. |
| `og-image.png` | Social preview image. |

## Why build-time and not fetch-at-runtime

Social scrapers do not run JavaScript. The `og:` numbers have to be literal text in the
file, because the link preview is the first thing a manager or label contact sees when
this gets texted to them. A page that fetched `data.json` in the browser would show a
correct page with a stale preview.

## The three week window

`meta.asOf` and `meta.windowDays` define the window. Cards dated inside it render as full
cards, in the order they appear in `data.json` — that order is **editorial**, strongest
first, not chronological. Cards that fall outside roll into the Archive section
automatically, sorted newest first. Nothing gets deleted.

## Checks that block a build

`build.mjs` exits non-zero and writes nothing if:

- an em dash appears in the output
- the inline JS does not parse
- `<section>`, `<div>` or `<p>` tags are unbalanced
- **the social copy headlines a figure that has rolled into the archive.** This is the
  one that matters. When a show drops out of the window, `meta.og` has to be rewritten
  or the link preview keeps selling an archived room.
- a `broadcastId` is not an integer, or the window is empty

A card with no recording sets `broadcastId: null` and gives a `noRecordingReason`. It
renders without a play button rather than with a dead one.

## Replays expire

`broadcast_history.phenix_vod_deleted_at` in Metabase database 2 records when a VOD is
deleted. A card whose replay has been deleted is a false claim in a partner's hands, so
the weekly refresh re-checks every `broadcastId` and pulls the play button when the VOD
has gone.
