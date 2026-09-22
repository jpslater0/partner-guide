-- ============================================================================
-- Metric queries for live/data.json
--
-- Verified 2026-09-18 against the figures published in the 10 September page.
-- Each block says which Metabase database to run it in, and what it reconciled
-- to. Placeholders: :broadcast_id :station_id :channel_id :start :end
--
-- DATABASES
--   db 2  Production-Main        MySQL      shows, chat, channels, replay state
--   db 3  Production-Starrocks   StarRocks  per listener stream logs
--   db 7  Production-Purchases   MySQL      music and Shopify purchases
--
-- RETENTION. This is the thing to design around. Measured 2026-09-18:
--   recorded_shows              ~2576 days   effectively permanent
--   broadcast_history           since 2023   effectively permanent
--   station_listener_history     60 days
--   chat_histories               30 days
--   tracks_play_history          14 days
--   listener_track_play_logs    long lived (db 3 is the warehouse)
--
-- Chat and listener figures for a show are UNRECOVERABLE about a month after
-- it airs. Capture a new card's figures within 14 days or they are gone, and
-- never try to recompute an archived card: data.json freezes them on purpose.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. RESOLVE A SHOW  (db 2)
-- Turns the broadcast id in a play link into everything else you need.
-- recorded_shows.id IS the id in https://app.stationhead.com/s/<id>.
-- Channel must be resolved through channels_stations. Do NOT use
-- channels.current_station_id, which returns NULL for past shows.
-- Verified: station 305115 -> channel 25 "Team Miley".
-- ---------------------------------------------------------------------------
SELECT bh.broadcast_id,
       bh.station_id,
       bh.start_time,
       bh.end_time,
       TIMESTAMPDIFF(MINUTE, bh.start_time, bh.end_time) AS minutes,
       rs.duration        AS duration_ms,   -- 16255656 = 4h 30m 55s, page said "4h 31m"
       rs.listens         AS people_in_room,
       rs.live_listens,
       c.id               AS channel_id,
       c.channel_name,
       c.alias,
       c.enabled,
       c.deleted_at,
       bh.phenix_vod_deleted_at,
       CASE WHEN bh.phenix_vod_deleted_at IS NULL THEN 'PLAYABLE' ELSE 'VOD_DELETED' END AS replay_state
FROM broadcast_history bh
LEFT JOIN recorded_shows rs ON rs.id = bh.broadcast_id
LEFT JOIN channels_stations cs ON cs.station_id = bh.station_id
LEFT JOIN channels c ON c.id = cs.channel_id
WHERE bh.broadcast_id = :broadcast_id;


-- ---------------------------------------------------------------------------
-- 2. WEEKLY REPLAY HEALTH CHECK  (db 2)  ** run this every week **
-- The only fully automatable metric, and the most important one. A card whose
-- VOD has been deleted is a false claim in a partner's hands. Feed it every
-- broadcastId in data.json; anything not PLAYABLE loses its play button.
-- Verified: all six current cards PLAYABLE on 2026-09-18.
-- ---------------------------------------------------------------------------
SELECT bh.broadcast_id,
       CASE WHEN bh.phenix_vod_deleted_at IS NULL THEN 'PLAYABLE' ELSE 'VOD_DELETED' END AS replay_state,
       bh.phenix_vod_deleted_at,
       c.alias,
       c.enabled,
       c.deleted_at
FROM broadcast_history bh
LEFT JOIN channels_stations cs ON cs.station_id = bh.station_id
LEFT JOIN channels c ON c.id = cs.channel_id
WHERE bh.broadcast_id IN (:broadcast_ids);


-- ---------------------------------------------------------------------------
-- 3. STREAMS FOR ONE ROOM  (db 3)
-- A stream is one listener playing one track for at least 30 seconds.
-- duration is in MILLISECONDS, so the qualifying threshold is 30000.
-- Verified: ENHYPEN station 666033 -> 240,386 against a published 240,343
--           (0.02% apart). Sabrina station 3260243 -> 25,472 against a
--           published 25,007 (1.9% apart, boundary effects).
-- Without the 30s filter ENHYPEN returns 434,888, so the threshold is the
-- whole ballgame. Never publish the unfiltered count.
-- ---------------------------------------------------------------------------
SELECT COUNT(*)                          AS streams,
       COUNT(DISTINCT account_id)        AS streaming_accounts
FROM production.listener_track_play_logs
WHERE station_id = :station_id
  AND event_time >= :start
  AND event_time <  :end
  AND duration >= 30000;


-- ---------------------------------------------------------------------------
-- 4. STREAMS FOR A WHOLE CHANNEL OVER A PERIOD  (db 3)
-- For "811,284 streams in six days" style figures spanning several rooms.
-- ---------------------------------------------------------------------------
SELECT COUNT(*)                   AS streams,
       COUNT(DISTINCT station_id) AS rooms,
       COUNT(DISTINCT account_id) AS streaming_accounts
FROM production.listener_track_play_logs
WHERE channel_id = :channel_id
  AND event_time >= :start
  AND event_time <  :end
  AND duration >= 30000;


-- ---------------------------------------------------------------------------
-- 5. CHAT MESSAGES IN A ROOM  (db 2)  ** 30 day retention **
-- Verified: Olivia broadcast 3550154 -> 7,850, the published figure EXACTLY.
--           Sabrina broadcast 3523095 -> 21,548 against a published 21,541.
-- Messages per minute and per second are derived from this and the duration,
-- which is how "8 messages every second" and "321 a minute" were reached.
-- ---------------------------------------------------------------------------
SELECT COUNT(*)                                                      AS messages,
       COUNT(DISTINCT ch.account_id)                                 AS chatters,
       ROUND(COUNT(*) / GREATEST(TIMESTAMPDIFF(MINUTE, bh.start_time, bh.end_time), 1), 1)
                                                                     AS messages_per_minute
FROM chat_histories ch
JOIN broadcast_history bh ON bh.broadcast_id = :broadcast_id
WHERE ch.station_id = bh.station_id
  AND ch.created_at >= bh.start_time
  AND ch.created_at <  bh.end_time
GROUP BY bh.start_time, bh.end_time;


-- ---------------------------------------------------------------------------
-- 6. PEOPLE IN THE ROOM  (db 2)
-- Use recorded_shows.listens, NOT a count from the stream logs. listens counts
-- everyone who was in the room, including guests with no linked music account;
-- the stream logs only see people who actually streamed.
-- Verified: Sabrina listens 9,792 vs published 9,791. Olivia 3,263 vs 3,262.
-- Consistently one higher, which is the host. Published figures appear to be
-- listens - 1. Confirm that convention before relying on it.
-- Counter-example: MARK listens 17,149 vs published 16,954, so this does not
-- hold everywhere. Treat as approximate and sanity check per show.
-- ---------------------------------------------------------------------------
SELECT rs.listens        AS people_in_room,
       rs.live_listens,
       rs.listens - 1    AS people_excluding_host
FROM recorded_shows rs
WHERE rs.id = :broadcast_id;


-- ---------------------------------------------------------------------------
-- 7. MEMBERS VS GUESTS IN A ROOM  (db 2)  ** 60 day retention **
-- For "63% of the room were not members" and "658 guests".
-- Not reconciled against the published Miley figures yet. Verify before use.
-- ---------------------------------------------------------------------------
SELECT (SELECT COUNT(DISTINCT l.account_id) FROM station_listener_history l
          WHERE l.station_id = bh.station_id
            AND l.start_time < bh.end_time
            AND COALESCE(l.end_time, bh.end_time) > bh.start_time) AS members,
       (SELECT COUNT(DISTINCT g.guest_id) FROM guest_station_listener_history g
          WHERE g.station_id = bh.station_id
            AND g.start_time < bh.end_time
            AND COALESCE(g.end_time, bh.end_time) > bh.start_time) AS guests
FROM broadcast_history bh
WHERE bh.broadcast_id = :broadcast_id;


-- ---------------------------------------------------------------------------
-- 8. MUSIC PURCHASES IN A ROOM  (db 7)
-- Verified: Team Miley channel 25, 6 Sept window -> 225 copies / 109 buyers
--           against a published 229 copies / 110 buyers.
-- No refunds in that window, so the 4 copy gap is definitional. The likely
-- cause is Shopify sales counted alongside music sales; see block 9.
-- ---------------------------------------------------------------------------
SELECT COALESCE(SUM(quantity), 0)                  AS copies_sold,
       COUNT(DISTINCT stationhead_user_id)         AS buyers,
       COUNT(DISTINCT country)                     AS buyer_countries
FROM track_purchase_transactions
WHERE stationhead_channel_id = :channel_id
  AND purchase_completed_at >= :start
  AND purchase_completed_at <  :end
  AND refunded_at IS NULL;


-- ---------------------------------------------------------------------------
-- 9. SHOPIFY PURCHASES IN A ROOM  (db 7)
-- Run alongside block 8 when a card says "bought the record" and the music
-- number alone does not reconcile.
-- ---------------------------------------------------------------------------
SELECT COALESCE(SUM(number_of_items), 0)   AS items_sold,
       COUNT(DISTINCT account_id)          AS buyers,
       COUNT(*)                            AS orders
FROM shopify_purchase_transactions
WHERE channel_id = :channel_id
  AND purchased_at >= :start
  AND purchased_at <  :end;


-- ---------------------------------------------------------------------------
-- 10. ROOMS OPENED BY A CHANNEL IN A PERIOD  (db 2)
-- For "5 rooms in six days" and "3 rooms opened on release day".
-- ---------------------------------------------------------------------------
SELECT COUNT(*)                        AS rooms,
       COUNT(DISTINCT bh.station_id)   AS distinct_stations,
       MAX(TIMESTAMPDIFF(MINUTE, bh.start_time, bh.end_time)) AS longest_minutes
FROM broadcast_history bh
JOIN channels_stations cs ON cs.station_id = bh.station_id
WHERE cs.channel_id = :channel_id
  AND bh.start_time >= :start
  AND bh.start_time <  :end;


-- ---------------------------------------------------------------------------
-- 11. PLATFORM FIGURES FOR THE PATTERN CARD  (db 2)
-- "shows in thirty days" reconciles to recorded_shows: 42,001 on 2026-09-18
-- against a published 47,226 as of 10 September. The number moves daily, so
-- always restate it with its own as-of date.
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS shows_last_30_days
FROM recorded_shows
WHERE date >= NOW() - INTERVAL 30 DAY;


-- ---------------------------------------------------------------------------
-- 12. DISTINCT TRACKS PLAYED IN A ROOM  (db 3)
-- Count from the warehouse, NOT from db 2. Verified 2026-09-21: Olivia's room
-- returns 24 distinct track_id (and 24 distinct isrc) against a published 23.
--
-- Do not use recorded_shows_tracks or tracks_play_history for this. Both
-- returned 17 for the same show, because tracks_play_history keeps only 14
-- days and recorded_shows_tracks holds what made it into the recording, which
-- is fewer tracks than were actually played to listeners.
-- ---------------------------------------------------------------------------
SELECT COUNT(DISTINCT track_id) AS distinct_tracks,
       COUNT(DISTINCT isrc)     AS distinct_isrcs
FROM production.listener_track_play_logs
WHERE station_id = :station_id
  AND event_time >= :start
  AND event_time <  :end;


-- ============================================================================
-- NOT RESOLVED. Do not auto-refresh these. Keep the published figure with its
-- as-of date, exactly as the refresh-partner-guide skill instructs.
--
--   "13.7B streams all time"   The db 3 lifetime aggregate TIMED OUT on
--                              2026-09-18. Expected: the skill says to keep
--                              the previous figure rather than guess.
--                              Checked 2026-09-21 against platform_daily.parquet
--                              in Rob Bonstein's shared "app" folder. It does
--                              NOT resolve this, for three separate reasons:
--                              it counts ALL plays with no duration column, so
--                              it cannot apply the 30s rule; it starts only at
--                              2024-01-01, so it is not all time; and it ends
--                              2026-09-08, a frozen snapshot. It totals 26.23B
--                              plays, which at the ~55% qualifying rate seen in
--                              real rooms implies ~14.4B against the published
--                              13.7B. Consistent, but not a derivation. Keep
--                              13.7B frozen with its as-of date.
--
--   "2M+ people who have streamed"
--                              Same query, same timeout. accounts in db 2 is
--                              7.6M total, which is registrations, NOT people
--                              who streamed. Do not substitute it.
--
--   "161 countries"            No country column on the stream logs.
--                              users.country (db 2) and
--                              track_purchase_transactions.country (db 7)
--                              exist but neither was reconciled to 161.
--
--   "13m 28s longest on the mic" (INI)
--                              recorded_shows.all_voice holds a URL to an
--                              audio file, not a duration. Mic time source
--                              not found.
--
--   Paris Paloma figures       Stated on the page as coming from the internal
--                              event report, and that show has no recording.
--                              Leave frozen.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 13. THE SPIKE: DAILY LISTENERS ON A CHANNEL  (db 3)  ** slow, ~2 minutes **
-- The number the pitch rests on. Compare the days an artist hosted against
-- the days the channel ran on its own. Do NOT describe this as the artist
-- mattering less; it is the opposite, it sizes what they add.
--
-- Verified 2026-09-22 across four channels, baseline day against the day the
-- artist hosted:
--   MARK       ch 142   ~175 -> 7,407    42x
--   BLACKPINK  ch 5     ~135 -> 3,250    24x
--   Stray Kids ch 16  ~3,200 -> 16,385    5x
--   INI        ch 306 ~1,600 -> 2,776   1.7x
-- 1.7x is the FLOOR, on a channel already running at 1,600 a day. Quieter
-- channels spike far harder. The page says "between two and forty times",
-- which is the measured range rounded inward, and is deliberately described
-- as "the shows we have measured" rather than as an average. It is four
-- shows, not a study.
--
-- TO MAKE IT AN AVERAGE you need to know which account is the artist, and
-- nothing in the schema says. There is no artist or verified badge: badge
-- types are All Access, Supporter tiers, ambassador and channel syndication.
-- `artists` carries no account id, and a channel's current_station_id belongs
-- to an ops account (bpstationhead, stayonair, ministreaming), not the artist.
-- The host list per channel is small and legible though, 5 to 47 accounts over
-- sixty days, with the official one obvious to a person (blackpink, straykids,
-- officialini). So the work is labelling, not compute.
--
-- CAUTION on resolving a channel from a station: MAX(channel_id) is wrong when
-- a station has sat under more than one channel. It gave channel 220 for BTS,
-- whose daily series shows no bump at all on the day of their own listening
-- party, so that reading was discarded. Resolve through channels_stations in
-- db 2 and check the series actually moves before trusting it.
--
-- Scanning a channel's daily series is expensive. Run it per channel, over a
-- bounded window, and never inside a page build.
-- ---------------------------------------------------------------------------
SELECT DATE(event_time) AS day,
       SUM(CASE WHEN duration >= 30000 THEN 1 ELSE 0 END) AS streams,
       COUNT(DISTINCT account_id) AS listeners
FROM production.listener_track_play_logs
WHERE channel_id = :channel_id
  AND event_time >= :start AND event_time < :end
GROUP BY DATE(event_time) ORDER BY day;
