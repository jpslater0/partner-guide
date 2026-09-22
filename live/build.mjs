#!/usr/bin/env node
/**
 * Builds live/index.html from live/data.json + live/_style.css.
 *
 * Why build-time and not fetch-at-runtime: social scrapers do not run JS, so the
 * og: numbers have to be real text in the file. A partner texts this link and the
 * preview is the first thing anyone sees.
 *
 * Usage:
 *   node live/build.mjs           write index.html
 *   node live/build.mjs --check   verify only, write nothing (exit 1 on failure)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK_ONLY = process.argv.includes('--check');

const data = JSON.parse(readFileSync(join(HERE, 'data.json'), 'utf8'));
const css = readFileSync(join(HERE, '_style.css'), 'utf8').trimEnd();
const { meta } = data;

/* ---------- window split ---------- */
const WORDS = ['zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve'];
const asOf = new Date(meta.asOf + 'T00:00:00Z');
const cutoff = new Date(asOf.getTime() - meta.windowDays * 86400000);
const iso = d => d.toISOString().slice(0, 10);

const inWindow  = data.events.filter(e => e.date >= iso(cutoff));
const outWindow = data.events.filter(e => e.date <  iso(cutoff));

// Scene guarantees. The page must never become all one scene just because that
// is what happened to be busy lately. A scene below its floor pulls its newest
// cards back out of the archive, however old they are. Staler beats absent.
const guarantees = meta.guarantees ?? {};
const rescued = new Set();
for (const [region, floor] of Object.entries(guarantees)) {
  const have = inWindow.filter(e => e.region === region).length;
  if (have >= floor) continue;
  outWindow.filter(e => e.region === region)
           .sort((a, b) => b.date.localeCompare(a.date))
           .slice(0, floor - have)
           .forEach(e => rescued.add(e.id));
}

// Displayed cards keep the order they were authored in: the sequence is
// editorial (strongest first), not chronological. Only the archive gets sorted.
const displayed = data.events.filter(e => e.date >= iso(cutoff) || rescued.has(e.id));
const archived  = outWindow.filter(e => !rescued.has(e.id))
                           .sort((a, b) => b.date.localeCompare(a.date));

const countWord = WORDS[displayed.length] ?? String(displayed.length);

// The headline timeframe is derived from the OLDEST card actually on show, not
// from windowDays. Rescuing an older card widens the claim the page makes, and
// the page must not say three weeks while showing something from six weeks ago.
const oldestShown = displayed.reduce((m, e) => (e.date < m ? e.date : m), meta.asOf);
const spanDays  = Math.round((asOf - new Date(oldestShown + 'T00:00:00Z')) / 86400000);
const spanWeeks = Math.max(1, Math.ceil(spanDays / 7));
// Past about two months, weeks stop reading naturally, so switch to months.
const spanMonths = Math.max(1, Math.round(spanDays / 30.44));
const spanUnit = spanWeeks > 8 ? 'month' : 'week';
const spanN    = spanWeeks > 8 ? spanMonths : spanWeeks;
const spanNWord = (WORDS[spanN] ?? String(spanN)).toLowerCase();
const spanPhrase = spanN === 1 ? `the last ${spanUnit}` : `the last ${spanNWord} ${spanUnit}s`;
const SpanPhrase = spanN === 1 ? `Last ${spanUnit}`     : `Last ${spanNWord} ${spanUnit}s`;

// Long-form dates for the methodology note, so it cannot drift from the window.
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const longDate = (d, withYear) =>
  `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ' ' + d.getUTCFullYear() : ''}`;

const TOKENS = {
  '{{CountCap}}': countWord,
  '{{count}}': countWord.toLowerCase(),
  '{{thing}}': displayed.length === 1 ? 'thing' : 'things',
  '{{asOfLong}}': longDate(asOf, true),
  '{{asOfShort}}': longDate(asOf, false),
  '{{windowStartShort}}': longDate(cutoff, false),
  '{{windowStartLong}}': longDate(cutoff, true),
  '{{figureDates}}': (() => {
    const ds = [...new Set(displayed.map(e => e.figuresAsOf).filter(Boolean))].sort();
    const human = ds.map(x => longDate(new Date(x + 'T00:00:00Z'), true));
    return human.length <= 1 ? (human[0] ?? longDate(asOf, true))
         : human.slice(0, -1).join(', ') + ' and ' + human[human.length - 1];
  })(),
  '{{spanPhrase}}': spanPhrase,
  '{{SpanPhrase}}': SpanPhrase,
};
const sub = s => Object.entries(TOKENS).reduce((acc, [k, v]) => acc.replaceAll(k, v), s);

/* ---------- fragments ---------- */
const PLAY_BASE = 'https://app.stationhead.com/s/';
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const chatStrip = list => !list?.length ? '' : `  <p class="chatlbl">From the chat</p>
  <div class="chat">
${list.map(m => `    <span class="m">${esc(m)}</span>`).join('\n')}
  </div>`;
const figs = list => list.length ? `  <div class="figs">
${list.map(f => `    <div class="fig"><span class="n">${f.n}</span><span class="l">${f.l}</span></div>`).join('\n')}
  </div>` : '';
const paras = (list, cls = '') =>
  (list ?? []).map(p => `  <p${cls ? ` class="${cls}"` : ''}>${sub(p)}</p>`).join('\n');

const introCard = i => `<section class="card">
  <p class="when">${i.when}</p>
  <h1>${i.h1}</h1>
  <div id="videoslot">
    <video id="sizzle" controls playsinline preload="metadata">
      <source src="${i.video}" type="video/mp4">
    </video>
  </div>
  <p class="lead">${i.lead}</p>
${paras(i.body)}
</section>`;

const eventCard = e => [
  '<section class="card">',
  `  <p class="when">${e.when}</p>`,
  `  <p class="who">${e.who}</p>`,
  `  <span class="hero">${e.hero}</span>`,
  `  <span class="herolbl">${e.herolbl}</span>`,
  figs(e.figs),
  paras(e.body),
  e.quote ? `  <p class="quote">${e.quote}</p>` : '',
  chatStrip(e.chat),
  e.broadcastId
    ? `  <a class="play" href="${PLAY_BASE}${e.broadcastId}"><span class="tri"></span>${e.playLabel}</a>`
    : '',
  '</section>',
].filter(Boolean).join('\n');

const patternCard = p => [
  '<section class="card">',
  `  <p class="when">${p.when}</p>`,
  `  <h2>${p.h2}</h2>`,
  paras(p.body),
  figs(p.figs),
  `  <p class="note">${sub(p.note)}</p>`,
  '</section>',
].filter(Boolean).join('\n');

const archiveCard = (a, list) => {
  if (!list.length) return '';
  const rows = list.map(e => {
    const tail = e.broadcastId
      ? `<a class="archplay" href="${PLAY_BASE}${e.broadcastId}">Play back</a>`
      : `<span class="archgone">No recording</span>`;
    return `    <div class="archrow"><span class="archwhen">${e.when}</span><span class="archwho">${e.who}</span><span class="archnum">${e.hero} ${e.herolbl}</span>${tail}</div>`;
  }).join('\n');
  return `<section class="card archcard">
  <p class="when">${a.when}</p>
  <h2>${a.h2}</h2>
  <p class="archintro">${a.intro}</p>
  <div class="archlist">
${rows}
  </div>
</section>`;
};

const staticCard = s => [
  '<section class="card">',
  `  <p class="when">${s.when}</p>`,
  `  <h2>${s.h2}</h2>`,
  s.ol ? `  <ol>\n${s.ol.map(li => `    <li>${li}</li>`).join('\n')}\n  </ol>` : '',
  s.ul ? `  <ul>\n${s.ul.map(li => `    <li>${li}</li>`).join('\n')}\n  </ul>` : '',
  s.note ? `  <p class="note">${s.note}</p>` : '',
  '</section>',
].filter(Boolean).join('\n');

const INLINE_JS = `
(function(){
  var feed = document.getElementById('feed');
  var prog = document.getElementById('prog');

  // Reveal the hero video only if a real file actually loads.
  var slot = document.getElementById('videoslot');
  var vid = document.getElementById('sizzle');
  if (vid && slot){
    vid.addEventListener('loadeddata', function(){ slot.classList.add('ready'); });
    vid.addEventListener('error', function(){ slot.classList.remove('ready'); }, true);
  }

  function onScroll(){
    var max = feed.scrollHeight - feed.clientHeight;
    var pct = max > 0 ? (feed.scrollTop / max) * 100 : 0;
    prog.style.width = pct + '%';
  }
  feed.addEventListener('scroll', onScroll);
  onScroll();
})();
`.trim();

const robots = meta.noindex
  ? `<!-- Keep this page out of search results while it is a shared partner link.
     Remove BOTH lines below only if you decide to make it publicly discoverable. -->
<meta name="robots" content="noindex, nofollow">
<meta name="googlebot" content="noindex, nofollow">`
  : '<!-- Publicly discoverable. -->';

const cards = [
  introCard(data.intro),
  ...displayed.map(eventCard),
  patternCard(data.pattern),
  archiveCard(data.archive, archived),
  ...data.static.map(staticCard),
].filter(Boolean);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${sub(meta.title)}</title>
<meta name="description" content="${sub(meta.description)}">

${robots}

<!-- GENERATED FILE. Do not hand-edit.
     Source: live/data.json  ->  node live/build.mjs
     Built ${new Date().toISOString().slice(0, 10)} from data as of ${meta.asOf}. -->
<link rel="canonical" href="${meta.baseUrl}">

<meta property="og:type" content="website">
<meta property="og:site_name" content="Stationhead">
<meta property="og:url" content="${meta.baseUrl}">
<meta property="og:title" content="${sub(meta.title)}">
<meta property="og:description" content="${sub(meta.og.description)}">
<meta property="og:image" content="${meta.baseUrl}${meta.og.image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${sub(meta.og.imageAlt)}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${sub(meta.title)}">
<meta name="twitter:description" content="${sub(meta.og.twitterDescription)}">
<meta name="twitter:image" content="${meta.baseUrl}${meta.og.image}">

<meta name="theme-color" content="#121212">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23121212'/%3E%3Ccircle cx='16' cy='16' r='7' fill='%23A663FF'/%3E%3C/svg%3E">
<style>
${css}
</style>
</head>
<body>

<div id="prog"></div>
<div id="bar">
  <div class="brandrow">
    <span class="mark">STATI<span class="dot"></span>NHEAD</span>
    <span class="asof">${sub(meta.windowLabel)} &middot; ${meta.asOfLabel}</span>
  </div>
</div>

<div id="feed">

${cards.join('\n\n')}

</div>

<script>
${INLINE_JS}
</script>
</body>
</html>
`;

/* ---------- verification ---------- */
const fail = [];
const warn = [];

// 1. House rule: no em dashes in partner-facing copy.
if (html.includes('—')) fail.push('em dash present in output');

// 1b. "Room" is not a word the product uses. It crept back in through a meta
//      tag once, which the visible-text check missed, so this scans everything.
{
  const rooms = html.match(/\brooms?\b/gi) ?? [];
  if (rooms.length) {
    const where = [...html.matchAll(/.{40}\brooms?\b.{40}/gi)].slice(0, 3).map(m => m[0].replace(/\s+/g, ' '));
    fail.push(`"room" appears ${rooms.length} time(s); the product says show, channel or listening party. ` +
              where.map(w => `\n         ...${w}...`).join(''));
  }
}

// 2. Inline JS must parse.
try { new Function(INLINE_JS); } catch (e) { fail.push('inline JS does not parse: ' + e.message); }

// 3. Balanced sections and core tags.
const count = re => (html.match(re) ?? []).length;
if (count(/<section\b/g) !== count(/<\/section>/g)) fail.push('unbalanced <section> tags');
if (count(/<div\b/g) !== count(/<\/div>/g)) fail.push('unbalanced <div> tags');
if (count(/<p\b/g) !== count(/<\/p>/g)) fail.push('unbalanced <p> tags');

// 4. Staleness guard. Every figure quoted in the social copy must still exist on
//    the page, otherwise the link preview claims a number the page no longer shows.
const social = sub(meta.og.description) + ' ' + sub(meta.og.twitterDescription);
// Only the cards still inside the window count as backing. A figure that has
// rolled into the archive must not headline the link preview.
const currentText = [
  JSON.stringify(displayed),
  JSON.stringify(data.pattern),
  JSON.stringify(data.intro),
].join(' ');
const archiveText = JSON.stringify(archived);
for (const tok of new Set(social.match(/\d[\d,.]{2,}[BM%]?/g) ?? [])) {
  if (currentText.includes(tok)) continue;
  fail.push(archiveText.includes(tok)
    ? `social copy headlines ${tok}, but that show has rolled into the archive. Rewrite meta.og in data.json.`
    : `social copy quotes ${tok}, which no card shows any more. Rewrite meta.og in data.json.`);
}

// 5. Every play link points at a real broadcast id.
for (const e of data.events) {
  if (e.broadcastId != null && !Number.isInteger(e.broadcastId)) {
    fail.push(`${e.id}: broadcastId is not an integer`);
  }
  if (e.broadcastId == null && !e.noRecordingReason) {
    warn.push(`${e.id}: no play link and no noRecordingReason given`);
  }
}

// 6. Scene guarantees must hold.
for (const [region, floor] of Object.entries(guarantees)) {
  const shown = displayed.filter(e => e.region === region).length;
  if (shown < floor) {
    fail.push(`only ${shown} ${region} card(s) on the page, floor is ${floor}. ` +
              `Add one or lower meta.guarantees.${region}.`);
  }
}

// 7z. Chat quotes must be plausible: present only where chat still exists.
for (const e of data.events) {
  if (!e.chat) continue;
  if (!Array.isArray(e.chat) || e.chat.some(m => typeof m !== 'string' || !m.trim())) {
    fail.push(`${e.id}: chat must be a list of non-empty strings`);
  }
  const ageDays = Math.round((asOf - new Date(e.date + 'T00:00:00Z')) / 86400000);
  if (ageDays > 30) {
    fail.push(`${e.id}: quotes chat from a show ${ageDays} days old, but chat is only kept 30 days. ` +
              `Either the quotes are invented or they were captured earlier and need a note.`);
  }
}

// 7a. Figures must carry a capture date, and it must not predate the show.
for (const e of data.events) {
  if (!e.figuresAsOf) { fail.push(`${e.id}: no figuresAsOf, cannot date its numbers`); continue; }
  if (e.figuresAsOf < e.date) fail.push(`${e.id}: figuresAsOf ${e.figuresAsOf} is before the show on ${e.date}`);
}

// 7b. Every event needs a region, or the guarantees cannot be checked.
for (const e of data.events) {
  if (!e.region) fail.push(`${e.id}: no region set, cannot enforce scene guarantees`);
}

// 8. Card count sanity.
if (displayed.length === 0) fail.push('no cards to show, page would be empty');

/* ---------- report ---------- */
const label = CHECK_ONLY ? 'check' : 'build';
console.log(`[${label}] window ${iso(cutoff)} .. ${meta.asOf} (${meta.windowDays}d)`);
const mix = Object.entries(displayed.reduce((a, e) => ((a[e.region] = (a[e.region] ?? 0) + 1), a), {}))
                  .map(([r, n]) => `${r} ${n}`).join(', ');
console.log(`[${label}] ${displayed.length} shown (${mix}), ${archived.length} archived, ${cards.length} cards total`);
if (rescued.size) {
  console.log(`[${label}] rescued from archive to hold a floor: ${[...rescued].join(', ')}`);
}
console.log(`[${label}] headline timeframe reads "${spanPhrase}" (oldest card ${oldestShown})`);
console.log(`[${label}] social copy reads "${countWord} ${TOKENS['{{thing}}']}"`);
for (const w of warn) console.log(`[warn]  ${w}`);
for (const f of fail) console.log(`[FAIL]  ${f}`);

if (fail.length) {
  console.error(`\n${fail.length} check(s) failed. Nothing written.`);
  process.exit(1);
}
if (CHECK_ONLY) { console.log('\nAll checks passed. Nothing written (--check).'); process.exit(0); }

writeFileSync(join(HERE, 'index.html'), html);
console.log(`\nWrote live/index.html (${(html.length / 1024).toFixed(1)} KB)`);
