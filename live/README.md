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
| `queries.sql` | Verified metric queries, with what each one reconciled to. |

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


## Where the numbers come from

`queries.sql` holds the verified SQL, one block per metric, with the figure each
one reconciled to. Three Metabase databases are involved:

| Database | Holds |
|---|---|
| 2 `Production-Main` | shows, chat, channels, replay state |
| 3 `Production-Starrocks` | per listener stream logs |
| 7 `Production-Purchases` | music and Shopify purchases |

A **stream** is one listener playing one track for at least 30 seconds.
`listener_track_play_logs.duration` is in milliseconds, so the filter is
`duration >= 30000`. Dropping that filter roughly doubles the number: ENHYPEN's
room reads 434,888 unfiltered against 240,386 filtered. Never publish the
unfiltered count.

**People in the room** is `recorded_shows.listens`, not a count from the stream
logs. `listens` includes guests with no linked music account; the stream logs
only see people who actually streamed.

Resolve a show's channel through `channels_stations`. `channels.current_station_id`
returns NULL for past shows.

## Scene guarantees: Western never drops off

Every event carries a `region`: `western`, `kpop` or `jpop`. `meta.guarantees`
sets a floor per scene:

```json
"guarantees": { "western": 2 }
```

If the window leaves fewer than the floor, the builder **pulls that scene's
newest cards back out of the archive**, however old they are, and says so in
its output. Staler beats absent. The page must never read as all one scene
just because that scene happened to be busy that fortnight.

A rescued card is older than the window, so the headline timeframe is derived
from the **oldest card actually on show**, not from `windowDays`. Rescue two
six week old cards and the title, the bar, the OG alt text and the intro all
change themselves to "the last six weeks". The page cannot claim three weeks
while showing something older.

The build fails if a floor cannot be met, or if any event has no `region`.

## Retention: capture new figures within two weeks

Measured 2026-09-18:

| Table | Retention |
|---|---|
| `recorded_shows` | ~2576 days, effectively permanent |
| `broadcast_history` | since 2023, effectively permanent |
| `listener_track_play_logs` (db 3) | long lived |
| `station_listener_history` | 60 days |
| `chat_histories` | **30 days** |
| `tracks_play_history` | **14 days** |

Chat and listener figures for a show become unrecoverable about a month after it
airs. So:

- capture a new card's figures within two weeks of the show, or they are gone
- **never recompute an archived card.** `data.json` freezes its figures on
  purpose, and the Archive section says the numbers are as reported at the time

## What the weekly job may and may not refresh

Refresh automatically: the replay health check (block 2), the as-of date, the
window, and platform figures that carry their own as-of date.

Do not refresh automatically: any figure in the NOT RESOLVED list at the bottom
of `queries.sql`, and any archived card. New cards get drafted for review, never
published unsupervised, because this URL goes to managers and labels.
