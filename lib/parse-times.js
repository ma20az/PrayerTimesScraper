'use strict';
/**
 * Pure helpers for turning what waterloomasjid.com/main/index.php/prayers SHOWS into verified, dated, 24-hour data.
 * Nothing in here fills, copies or extrapolates days: a day exists in the output only if the page showed it.
 *
 * The page shows 12-hour clocks WITHOUT am/pm (e.g. Asr "6:26"), so the prayer decides am/pm:
 *   Fajr, Sunrise      -> AM            ("4:25"  -> 04:25)
 *   Dhuhr              -> 12:xx / 1:xx PM ("1:19" -> 13:19, "12:08" -> 12:08); iqamah may also be later PM ("2:00" -> 14:00)
 *   Asr, Maghrib, Isha -> PM            ("6:26"  -> 18:26, "8:37" -> 20:37, "10:13" -> 22:13)
 * Anything that doesn't fit these rules throws instead of guessing.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// allowed displayed hours per prayer and kind (start / iqamah). am/pm modes take an inclusive [min, max] range; 'noon' takes a list.
const RULES = {
  fajr:    { start: { am: [1, 11] }, iqamah: { am: [1, 11] } },
  sunrise: { start: { am: [1, 11] } },
  dhuhr:   { start: { noon: [12, 1] }, iqamah: { noon: [12, 1, 2, 3, 4] } },
  asr:     { start: { pm: [1, 11] }, iqamah: { pm: [1, 11] } },
  maghrib: { start: { pm: [1, 11] }, iqamah: { pm: [1, 11] } },
  isha:    { start: { pm: [1, 11] }, iqamah: { pm: [1, 11] } },
};

const pad = (n) => String(n).padStart(2, '0');

function canonicalPrayer(name) {
  const k = String(name || '').trim().toLowerCase();
  if (k === 'magrib') return 'maghrib'; // the page's own spelling
  if (RULES[k]) return k;
  throw new Error(`Unknown prayer "${name}"`);
}

/**
 * "6:26" + "asr" -> "18:26".  kind is 'start' or 'iqamah'.
 * Several times in one cell (Friday: "1:30, 2:15") -> the first one is used.
 */
function to24h(text, prayerName, kind = 'start') {
  const prayer = canonicalPrayer(prayerName);
  if (kind !== 'start' && kind !== 'iqamah') throw new Error(`kind must be start or iqamah`);
  let raw = String(text ?? '').trim();
  if (raw.includes(',')) raw = raw.split(',')[0].trim();
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(raw);
  if (!m) throw new Error(`Cannot read time "${text}" for ${prayer} ${kind}`);
  const h = Number(m[1]);
  const rule = RULES[prayer][kind];
  if (!rule) throw new Error(`${prayer} has no ${kind} time`);
  const [mode, hours] = Object.entries(rule)[0];
  const ok = mode === 'noon' ? hours.includes(h) : (h >= hours[0] && h <= hours[1]);
  if (!ok) throw new Error(`"${raw}" is not a plausible ${prayer} ${kind} time (refusing to guess am/pm)`);
  let out;
  if (mode === 'am') out = h;                      // 1..11 AM
  else if (mode === 'pm') out = h + 12;            // 1..11 PM
  else out = h === 12 ? 12 : h + 12;               // noon-ish: 12 stays 12, 1 -> 13
  return `${pad(out)}:${m[2]}`;
}

/** Page header pieces ("May 2025", "12 Mon") -> { date: "2025-05-12", weekday: 1 }. Throws if the year/month cannot be read. */
function parsePageDate(monthYear, dayDay) {
  const my = /^([A-Za-z]+)\s+(\d{4})$/.exec(String(monthYear || '').trim());
  if (!my) throw new Error(`No month/year in header "${monthYear}"`);
  const name = my[1].toLowerCase();
  const month = MONTHS.findIndex((m) => m === name || (name.length === 3 && m.startsWith(name))) + 1;
  if (!month) throw new Error(`Unknown month "${my[1]}"`);
  const dd = /^(\d{1,2})\s+([A-Za-z]{3})/.exec(String(dayDay || '').trim());
  if (!dd) throw new Error(`No day/weekday in "${dayDay}"`);
  const year = Number(my[2]), day = Number(dd[1]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) throw new Error(`Invalid calendar date ${year}-${month}-${day}`);
  const named = DAYS.indexOf(dd[2].toLowerCase());
  if (named < 0) throw new Error(`Unknown weekday "${dd[2]}"`);
  if (utc.getUTCDay() !== named) throw new Error(`${year}-${pad(month)}-${pad(day)} is not a ${dd[2]} (year or header misread)`);
  return { date: `${year}-${pad(month)}-${pad(day)}`, weekday: named };
}

const START_KEYS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const IQAMAH_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** One raw row from raw_data.json -> one validated day, or throws. */
function buildDay(row) {
  const m = /^([A-Za-z]+\s+\d{4})\s+(\d{1,2}\s+[A-Za-z]{3})$/.exec(String(row.date || '').trim());
  if (!m) throw new Error(`Cannot read the date header "${row.date}" (needs "Month YYYY D Ddd")`);
  const { date } = parsePageDate(m[1], m[2]);
  const prayers = {};
  for (const [name, v] of Object.entries(row.prayers || {})) prayers[canonicalPrayer(name)] = v;
  const day = { date };
  for (const k of START_KEYS) {
    if (!prayers[k] || !prayers[k].start) throw new Error(`${date}: missing ${k}`);
    day[k] = to24h(prayers[k].start, k, 'start');
  }
  for (const k of IQAMAH_KEYS) {
    const raw = prayers[k] && prayers[k].iqamah;
    day[`${k}_iqamah`] = raw && String(raw).trim() ? to24h(raw, k, 'iqamah') : null;
  }
  // sanity: day must run in order, and an iqamah can't precede its own start
  for (let i = 1; i < START_KEYS.length; i++) {
    if (toMin(day[START_KEYS[i]]) <= toMin(day[START_KEYS[i - 1]])) throw new Error(`${date}: ${START_KEYS[i]} (${day[START_KEYS[i]]}) is not after ${START_KEYS[i - 1]} (${day[START_KEYS[i - 1]]})`);
  }
  for (const k of IQAMAH_KEYS) {
    const iq = day[`${k}_iqamah`];
    if (iq && toMin(iq) < toMin(day[k])) throw new Error(`${date}: ${k} iqamah ${iq} is before its start ${day[k]}`);
  }
  return day;
}

/**
 * raw page rows -> latest.json payload. ONLY real days the page showed. Bad rows are skipped and reported, never repaired.
 * Throws when no valid day remains, so the workflow fails visibly instead of publishing an empty file.
 */
function buildLatest(rows, { generatedAt = new Date().toISOString(), sourceUrl, log = () => {} } = {}) {
  const days = new Map();
  const skipped = [];
  for (const row of rows || []) {
    try {
      const d = buildDay(row);
      if (days.has(d.date)) throw new Error(`${d.date}: appears twice on the page`);
      days.set(d.date, d);
    } catch (e) {
      skipped.push({ row: row && row.date, reason: e.message });
      log(`Skipping row "${row && row.date}": ${e.message}`);
    }
  }
  if (days.size === 0) throw new Error('No valid prayer days found on the page' + (skipped.length ? `; first problem: ${skipped[0].reason}` : ''));
  return {
    payload: { schema_version: 1, generated_at: generatedAt, source_url: sourceUrl, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) },
    skipped,
  };
}

module.exports = { to24h, parsePageDate, buildDay, buildLatest, START_KEYS, IQAMAH_KEYS };
