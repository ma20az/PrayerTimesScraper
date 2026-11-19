'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { to24h, parsePageDate, buildDay, buildLatest } = require('../lib/parse-times');

// REAL data: captured from waterloomasjid.com on Mon 12 May 2025 (see extraction_log.txt in this repo's history).
const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'raw_data_2025-05-12_real.json'), 'utf8'));

test('12h -> 24h using the real May 12 2025 values (page shows no AM/PM)', () => {
  assert.equal(to24h('4:25', 'Fajr'), '04:25');       // AM
  assert.equal(to24h('6:01', 'Sunrise'), '06:01');    // AM
  assert.equal(to24h('1:19', 'Dhuhr'), '13:19');      // 1:xx PM
  assert.equal(to24h('6:26', 'Asr'), '18:26');        // PM (the example in the brief)
  assert.equal(to24h('8:37', 'Magrib'), '20:37');     // the page's own spelling
  assert.equal(to24h('10:13', 'Isha'), '22:13');      // PM
  assert.equal(to24h('5:15', 'Fajr', 'iqamah'), '05:15');
  assert.equal(to24h('1:45', 'Dhuhr', 'iqamah'), '13:45');
  assert.equal(to24h('6:45', 'Asr', 'iqamah'), '18:45');
  assert.equal(to24h('8:41', 'Maghrib', 'iqamah'), '20:41');
  assert.equal(to24h('10:15', 'Isha', 'iqamah'), '22:15');
});

test('Dhuhr: 12:xx stays noon, 1:xx is PM; a later winter iqamah is PM too', () => {
  assert.equal(to24h('12:08', 'Dhuhr'), '12:08');
  assert.equal(to24h('12:45', 'Dhuhr', 'iqamah'), '12:45');
  assert.equal(to24h('2:00', 'Dhuhr', 'iqamah'), '14:00');
});

test('Friday cell with several times uses the first', () => {
  assert.equal(to24h('1:30, 2:15', 'Dhuhr', 'iqamah'), '13:30');
});

test('refuses to guess instead of producing a wrong time', () => {
  assert.throws(() => to24h('12:10', 'Isha'), /refusing to guess/);   // past-midnight Isha is not representable on one date
  assert.throws(() => to24h('11:30', 'Dhuhr'), /plausible/);
  assert.throws(() => to24h('13:00', 'Asr'), /plausible/);
  assert.throws(() => to24h('6:26', 'Sunrise', 'iqamah'), /no iqamah/);
  assert.throws(() => to24h('abc', 'Fajr'), /Cannot read/);
  assert.throws(() => to24h('6:26', 'Tahajjud'), /Unknown prayer/);
});

test('year and month come from the "May 2025 12 Mon" header and are cross-checked against the weekday', () => {
  assert.deepEqual(parsePageDate('May 2025', '12 Mon'), { date: '2025-05-12', weekday: 1 });
  assert.throws(() => parsePageDate('May 2024', '12 Mon'), /not a Mon/);   // wrong year would be caught
  assert.throws(() => parsePageDate('', '12 Mon'), /No month\/year/);
  assert.throws(() => parsePageDate('Feb 2025', '30 Sun'), /Invalid calendar date/);
});

test('real raw_data.json -> 7 real, dated, ordered days', () => {
  const { payload, skipped } = buildLatest(real, { generatedAt: '2025-05-12T23:12:44.000Z', sourceUrl: 'https://waterloomasjid.com/main/index.php/prayers' });
  assert.equal(skipped.length, 0);
  assert.equal(payload.days.length, 7);
  assert.deepEqual(payload.days.map((d) => d.date), ['2025-05-12', '2025-05-13', '2025-05-14', '2025-05-15', '2025-05-16', '2025-05-17', '2025-05-18']);
  assert.deepEqual(payload.days[0], {
    date: '2025-05-12', fajr: '04:25', sunrise: '06:01', dhuhr: '13:19', asr: '18:26', maghrib: '20:37', isha: '22:13',
    fajr_iqamah: '05:15', dhuhr_iqamah: '13:45', asr_iqamah: '18:45', maghrib_iqamah: '20:41', isha_iqamah: '22:15',
  });
  assert.equal(payload.generated_at, '2025-05-12T23:12:44.000Z');
  assert.equal(payload.source_url, 'https://waterloomasjid.com/main/index.php/prayers');
});

test('latest.json never contains days the page did not show (no weekday-pattern filling)', () => {
  const { payload } = buildLatest(real, { sourceUrl: 'x' });
  assert.equal(payload.days.length, real.length);   // 7 in, 7 out; the monthly CSV would have had 31
});

test('a month boundary keeps the right year per row', () => {
  // SYNTHETIC rows (weekdays are consistent: 31 Dec 2025 was a Wednesday, 1 Jan 2026 a Thursday)
  const base = real[0].prayers;
  const rows = [{ date: 'December 2025 31 Wed', prayers: base }, { date: 'January 2026 1 Thu', prayers: base }];
  const { payload } = buildLatest(rows, { sourceUrl: 'x' });
  assert.deepEqual(payload.days.map((d) => d.date), ['2025-12-31', '2026-01-01']);
});

test('bad rows are skipped and reported, good rows survive; all-bad throws', () => {
  const bad = { date: 'May 2025 13 Tue', prayers: { ...real[1].prayers, Asr: { start: '6:26', iqamah: '' }, Isha: { start: '12:10', iqamah: '' } } };
  const { payload, skipped } = buildLatest([real[0], bad], { sourceUrl: 'x' });
  assert.equal(payload.days.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /refusing to guess/);
  assert.throws(() => buildLatest([bad], { sourceUrl: 'x' }), /No valid prayer days/);
  assert.throws(() => buildLatest([], { sourceUrl: 'x' }), /No valid prayer days/);
});

test('rows that run out of order are rejected', () => {
  const wrong = JSON.parse(JSON.stringify(real[0]));
  wrong.prayers.Asr.start = '1:10'; // -> 13:10, which is before Dhuhr 13:19
  assert.throws(() => buildDay(wrong), /not after dhuhr/);
});
