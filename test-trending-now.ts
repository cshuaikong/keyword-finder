import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RssSnapshot, RssTrendItem } from './src/modules/trending-rss.js';

const dir = mkdtempSync(join(tmpdir(), 'keyword-trending-'));
process.env.DATA_DB_PATH = join(dir, 'test.db');
const { config } = await import('./src/config.js');
const db = await import('./src/core/db.js');
const store = await import('./src/core/trending-store.js');
const polling = await import('./src/modules/trending-now.js');
const rss = await import('./src/modules/trending-rss.js');
const now = Date.parse('2026-09-05T00:00:00Z');
store.pollState();
beforeEach(() => {
  db.getDb().exec(`DELETE FROM trending_history; DELETE FROM trending_snapshots; DELETE FROM trending_rss_cache;
    DELETE FROM scheduled_reviews; DELETE FROM signals; DELETE FROM words;
    UPDATE trending_poll_state SET next_at=0, failures=0, lease=NULL, last_error=NULL;`);
  config.trendingNowEnabled = true;
  config.trendingNowGeos = ['US'];
  config.trendingNowIntervalMs = 1800000;
  config.trendingNowJitterMs = 300000;
});
after(() => { db.getDb().close(); rmSync(dir, { recursive: true, force: true }); });

function item(overrides: Partial<RssTrendItem> = {}): RssTrendItem {
  return { query: 'Example Game', search_volume: 1000, search_volume_label: '1000+',
    rss_pub_date: '2026-09-04T20:00:00Z', news: [],
    classification: { kind: 'game-related', confidence: 65, reasons: ['fixture'] }, ...overrides };
}
function snapshot(items = [item()], geo = 'US'): RssSnapshot {
  return { geo, observed_at: new Date(now).toISOString(), fetch_status: 'rss_limited',
    source_url: `https://trends.google.com/trending/rss?geo=${geo}`, error: null, items };
}
const xml = `<rss xmlns:ht="https://trends.google.com/trending/rss"><channel><item>
  <title>Example &amp; Game</title><ht:approx_traffic>2K+</ht:approx_traffic>
  <pubDate>Fri, 04 Sep 2026 20:00:00 GMT</pubDate><ht:news_item>
  <ht:news_item_title>Example &amp; Game announced for PS5</ht:news_item_title>
  <ht:news_item_url>https://www.ign.com/articles/example</ht:news_item_url>
  <ht:news_item_source>IGN</ht:news_item_source></ht:news_item></item></channel></rss>`;

test('RSS parser retains news, decodes XML and never invents growth or official categories', () => {
  const rows = rss.parseTrendingRss(xml);
  assert.equal(rows[0].query, 'Example & Game');
  assert.equal(rows[0].search_volume, 2000);
  assert.equal(rows[0].news[0].source, 'IGN');
  assert.equal(rows[0].classification.kind, 'game-related');
  assert.equal('growthPercent' in rows[0], false);
  assert.equal(rss.parseRssTraffic('20,000+'), 20000);
  assert.equal(rss.parseRssTraffic('1.5M+'), 1500000);
  assert.equal(rss.parseRssTraffic('unknown'), null);
  assert.throws(() => rss.parseTrendingRss('<html>captcha</html>'), /RSS/);
});

test('classification rejects game ambiguity, daily answers and spoofed domains; exact known title wins', () => {
  const news = (title: string, url = 'https://news.example/item') => [{ title, url, source: 'Example' }];
  assert.equal(rss.classifyRssTrend('Example Game', [], new Set(['example game'])).kind, 'known-game');
  assert.equal(rss.classifyRssTrend('wordle today', news('New game release')).kind, 'noise');
  assert.equal(rss.classifyRssTrend('team match', news('MLB game update')).kind, 'unknown');
  assert.equal(rss.classifyRssTrend('a person', news('Twitch streamer announced a new video game')).kind, 'unknown');
  assert.equal(rss.classifyRssTrend('something', news('New release', 'https://ign.com.evil.example/x')).kind, 'unknown');
  assert.equal(rss.classifyRssTrend('New Title', news('New Title launches on Steam')).kind, 'game-related');
});

test('unknown and expired topics are archived but not enqueued', () => {
  const result = store.saveTrendingSnapshot(snapshot([item(), item({ query: 'Unknown', classification: { kind: 'unknown', confidence: 0, reasons: [] } }),
    item({ query: 'Old Game', rss_pub_date: '2026-09-01T00:00:00Z' }), item({ query: 'Undated Game', rss_pub_date: null })]), now);
  assert.deepEqual(result.map(c => c.keyword), ['example game']);
  assert.equal(db.queryDueScheduledReviews(10).length, 1);
  assert.equal((db.getDb().prepare('SELECT COUNT(*) n FROM trending_history').get() as any).n, 4);
});

test('duplicates stay quiet; cumulative volume bucket doubling emits only once', () => {
  assert.equal(store.saveTrendingSnapshot(snapshot(), now).length, 1);
  assert.equal(store.saveTrendingSnapshot(snapshot(), now + 1).length, 0);
  assert.equal(store.saveTrendingSnapshot(snapshot([item({ search_volume: 1500 })]), now + 2).length, 0);
  assert.equal(store.saveTrendingSnapshot(snapshot([item({ search_volume: 2000 })]), now + 3).length, 1);
  assert.equal(store.saveTrendingSnapshot(snapshot([item({ search_volume: 2000 })]), now + 4).length, 0);
  const history = db.getDb().prepare('SELECT * FROM trending_history').get() as any;
  assert.equal(history.peak_volume, 2000);
  assert.equal(history.first_seen_at, new Date(now).toISOString());
  assert.equal(db.queryDueScheduledReviews(10).length, 1);
});

test('unknown topic can later qualify; each region keeps its own history', () => {
  store.saveTrendingSnapshot(snapshot([item({ classification: { kind: 'unknown', confidence: 0, reasons: [] } })]), now);
  assert.equal(store.saveTrendingSnapshot(snapshot(), now + 1).length, 1);
  assert.equal(store.saveTrendingSnapshot(snapshot(undefined, 'GB'), now + 1).length, 1);
  assert.equal((db.getDb().prepare('SELECT COUNT(*) n FROM trending_history').get() as any).n, 2);
});

test('rejected words are not rescheduled and missing volumes are not coerced to zero', () => {
  store.saveTrendingSnapshot(snapshot([item({ search_volume: null })]), now);
  assert.equal((db.getDb().prepare('SELECT peak_volume FROM trending_history').get() as any).peak_volume, null);
  db.rejectWord('example game', 'not useful');
  assert.equal(store.saveTrendingSnapshot(snapshot([item({ search_volume: 4000 })]), now + 1).length, 0);
  assert.equal(db.queryDueScheduledReviews(10).length, 0);
});

test('transaction rollback leaves no consumed signal if enqueue fails', () => {
  db.getDb().exec(`CREATE TRIGGER fail_trend_insert BEFORE INSERT ON signals BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
  try { assert.throws(() => store.saveTrendingSnapshot(snapshot(), now), /test failure/); }
  finally { db.getDb().exec('DROP TRIGGER fail_trend_insert'); }
  assert.equal(db.getWordByKeyword('example game'), undefined);
  assert.equal((db.getDb().prepare('SELECT COUNT(*) n FROM trending_history').get() as any).n, 0);
  assert.equal(store.saveTrendingSnapshot(snapshot(), now).length, 1);
});

test('persistent claims prevent overlap and stale completion cannot replace a newer lease', () => {
  const first = store.claimPoll(now, 1000)!;
  assert.equal(store.claimPoll(now + 1, 1000), null);
  const second = store.claimPoll(now + 1001, 1000)!;
  store.finishPoll(first, now + 999999, 9, 'stale');
  assert.equal(store.pollState().lease, second);
  store.finishPoll(second, now + 5000, 0, null);
  assert.equal(store.pollState().next_at, now + 5000);
});

test('jitter stays 25–35 minutes; failures back off and honor long Retry-After', () => {
  assert.equal(polling.nextPollDelay(0, 0, () => 0), 25 * 60000);
  assert.equal(polling.nextPollDelay(0, 0, () => 1), 35 * 60000);
  assert.equal(polling.nextPollDelay(1, 0, () => 0), 60 * 60000);
  assert.equal(polling.nextPollDelay(2, 0, () => 0), 120 * 60000);
  assert.equal(polling.parseRetryAfter('7200', now), 7200000);
  assert.equal(polling.parseRetryAfter(new Date(now + 7200000).toUTCString(), now), 7200000);
  assert.equal(polling.nextPollDelay(1, 172800000, () => 0), 172800000);
});

test('429 stops all regions without retries and persists server cooldown', async () => {
  config.trendingNowGeos = ['US', 'GB'];
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '7200' } });
  };
  const result = await polling.pollTrendingNow({ fetchImpl, now: () => now });
  assert.equal(result.status, 'failed');
  assert.equal(calls, 1);
  assert.ok(result.nextAt >= now + 7200000);
  assert.equal((await polling.pollTrendingNow({ fetchImpl, now: () => now + 1 })).status, 'skipped');
  assert.equal(calls, 1);
});

test('403 stops all regions; HTML challenge is a failed fetch rather than an empty success', async () => {
  config.trendingNowGeos = ['US', 'GB'];
  let calls = 0;
  await polling.pollTrendingNow({ fetchImpl: async () => { calls++; return new Response('Forbidden', { status: 403 }); }, now: () => now });
  assert.equal(calls, 1);
  config.trendingNowGeos = ['US'];
  db.getDb().exec('UPDATE trending_poll_state SET next_at=0');
  const result = await polling.pollTrendingNow({ fetchImpl: async () => new Response('<html>captcha</html>'), now: () => now });
  assert.equal(result.status, 'failed');
  assert.equal(store.getRssCache('US'), undefined);
});

test('200 caches validators, 304 reuses XML without duplicate signals, and success clears backoff', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://trends.google.com/trending/rss?geo=US');
    if (calls === 1) return new Response(xml, { headers: { ETag: 'v1' } });
    assert.equal(new Headers(init?.headers).get('if-none-match'), 'v1');
    return new Response(null, { status: 304 });
  };
  assert.equal((await polling.pollTrendingNow({ fetchImpl, now: () => now })).candidates.length, 1);
  db.getDb().exec('UPDATE trending_poll_state SET next_at=0, failures=3');
  assert.equal((await polling.pollTrendingNow({ fetchImpl, now: () => now + 1800000 })).candidates.length, 0);
  assert.equal(calls, 2);
  assert.equal(store.pollState().failures, 0);
});

test('disabled source makes no requests', async () => {
  config.trendingNowEnabled = false;
  assert.equal((await polling.pollTrendingNow({ fetchImpl: async () => { throw new Error('must not call'); } })).status, 'skipped');
});
