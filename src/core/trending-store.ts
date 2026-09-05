import { randomUUID } from 'node:crypto';
import type { RssSnapshot } from '../modules/trending-rss.js';
import { getDb, getWordByKeyword, recordKeywordSignals, scheduleKeywordReview, upsertRadarWord } from './db.js';
import type { TrendingKeyword } from '../types.js';

export interface PollState { next_at: number; failures: number; lease: string | null; last_error: string | null }
export interface RssCache { xml: string; etag: string | null; last_modified: string | null }

function database() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS trending_poll_state (
      id INTEGER PRIMARY KEY CHECK(id = 1), next_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, lease TEXT, last_error TEXT
    );
    INSERT OR IGNORE INTO trending_poll_state (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS trending_rss_cache (geo TEXT PRIMARY KEY, xml TEXT NOT NULL, etag TEXT, last_modified TEXT);
    CREATE TABLE IF NOT EXISTS trending_snapshots (
      id INTEGER PRIMARY KEY, geo TEXT NOT NULL, observed_at TEXT NOT NULL,
      fetch_status TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trending_snapshots_time ON trending_snapshots(observed_at);
    CREATE TABLE IF NOT EXISTS trending_history (
      keyword TEXT NOT NULL, geo TEXT NOT NULL, first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, rss_pub_date TEXT, peak_volume REAL,
      emitted_volume REAL, emitted_at TEXT, payload TEXT NOT NULL,
      PRIMARY KEY(keyword, geo)
    );
  `);
  return db;
}
export function pollState(): PollState {
  return database().prepare('SELECT * FROM trending_poll_state WHERE id = 1').get() as PollState;
}
export function getRssCache(geo: string): RssCache | undefined {
  return database().prepare('SELECT * FROM trending_rss_cache WHERE geo = ?').get(geo) as RssCache | undefined;
}
export function setRssCache(geo: string, xml: string, etag: string | null, lastModified: string | null): void {
  database().prepare(`INSERT INTO trending_rss_cache (geo, xml, etag, last_modified) VALUES (?, ?, ?, ?)
    ON CONFLICT(geo) DO UPDATE SET xml=excluded.xml, etag=excluded.etag, last_modified=excluded.last_modified`)
    .run(geo, xml, etag, lastModified);
}
export function listTrendingHistory(limit = 50): Array<Record<string, unknown>> {
  const rows = database().prepare('SELECT * FROM trending_history ORDER BY last_seen_at DESC, keyword LIMIT ?')
    .all(limit) as Array<{ keyword: string; geo: string; peak_volume: number | null; payload: string; last_seen_at: string }>;
  return rows.map(row => {
    const item = JSON.parse(row.payload) as RssSnapshot['items'][number];
    return { keyword: row.keyword, geo: row.geo, classification: item.classification.kind,
      classificationConfidence: item.classification.confidence, peakVolumeLowerBound: row.peak_volume,
      lastSeen: row.last_seen_at, reasons: item.classification.reasons.join('; ') };
  });
}
/** Durable cooldown and atomic lease prevent overlapping processes sharing one database. */
export function claimPoll(now: number, holdMs: number): string | null {
  const db = database();
  return db.transaction(() => {
    if (pollState().next_at > now) return null;
    const token = randomUUID();
    db.prepare('UPDATE trending_poll_state SET next_at = ?, lease = ? WHERE id = 1').run(now + holdMs, token);
    return token;
  }).immediate();
}
export function finishPoll(token: string, nextAt: number, failures: number, error: string | null): void {
  database().prepare(`UPDATE trending_poll_state SET next_at = ?, failures = ?, last_error = ?, lease = NULL
    WHERE id = 1 AND lease = ?`).run(nextAt, failures, error, token);
}

/** Archive all RSS topics; enqueue only evidenced game candidates in the same transaction. */
export function saveTrendingSnapshot(output: RssSnapshot, now = Date.now()): TrendingKeyword[] {
  const db = database();
  const observedAt = new Date(now).toISOString();
  return db.transaction(() => {
    db.prepare('INSERT INTO trending_snapshots (geo, observed_at, fetch_status, payload) VALUES (?, ?, ?, ?)')
      .run(output.geo, observedAt, output.fetch_status, JSON.stringify(output));
    db.prepare('DELETE FROM trending_snapshots WHERE observed_at < ?').run(new Date(now - 30 * 86400000).toISOString());
    const candidates: TrendingKeyword[] = [];
    if (output.fetch_status !== 'rss_limited') return candidates;
    const seen = new Set<string>();
    for (const item of output.items) {
      const key = item.query.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!key || key.length > 200 || seen.has(key)) continue;
      seen.add(key);
      const previous = db.prepare('SELECT * FROM trending_history WHERE keyword = ? AND geo = ?').get(key, output.geo) as {
        first_seen_at: string; rss_pub_date: string | null; peak_volume: number | null;
        emitted_volume: number | null; emitted_at: string | null;
      } | undefined;
      const volume = item.search_volume;
      const published = item.rss_pub_date ? Date.parse(item.rss_pub_date) : NaN;
      const fresh = Number.isFinite(published) && published <= now + 300000 && published >= now - 86400000;
      const recurring = !!previous?.emitted_at && now - Date.parse(previous.emitted_at) >= 86400000
        && published > Date.parse(previous.rss_pub_date ?? '');
      const accelerated = volume !== null && previous?.emitted_volume != null && previous.emitted_volume > 0
        && volume >= previous.emitted_volume * 2;
      const classified = ['known-game', 'game-related'].includes(item.classification.kind);
      const existing = getWordByKeyword(key);
      const eligible = !existing || ['discovered', 'queued', 'validated', 'review', 'retry_wait'].includes(existing.workflow_status);
      const emit = fresh && classified && eligible && (!previous?.emitted_at || recurring || accelerated);
      db.prepare(`INSERT INTO trending_history
        (keyword, geo, first_seen_at, last_seen_at, rss_pub_date, peak_volume, emitted_volume, emitted_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(keyword, geo) DO UPDATE SET last_seen_at=excluded.last_seen_at,
          rss_pub_date=excluded.rss_pub_date, peak_volume=excluded.peak_volume,
          emitted_volume=excluded.emitted_volume, emitted_at=excluded.emitted_at, payload=excluded.payload`)
        .run(key, output.geo, previous?.first_seen_at ?? observedAt, observedAt, item.rss_pub_date,
          volume === null && previous?.peak_volume == null ? null : Math.max(volume ?? 0, previous?.peak_volume ?? 0),
          emit ? volume : previous?.emitted_volume ?? null,
          emit ? observedAt : previous?.emitted_at ?? null, JSON.stringify(item));
      if (!emit) continue;
      upsertRadarWord(key, 'trending-now:rss');
      recordKeywordSignals([{
        keyword: key, source: 'trending-now:rss', seed: output.geo, strength: item.classification.kind === 'known-game' ? 70 : 45,
        observedAt: new Date(now), metadata: {
          geo: output.geo, volumeLowerBound: volume, volumeLabel: item.search_volume_label,
          reason: recurring ? 'reappeared' : accelerated ? 'volume-bucket-doubled' : 'new',
          rssPublishedAt: item.rss_pub_date, classification: item.classification, news: item.news,
          sourceUrl: output.source_url, officialCategory: null, officialGrowthPercent: null,
        },
      }]);
      const review = db.prepare("SELECT id FROM scheduled_reviews WHERE keyword = ? AND status IN ('active', 'running')").get(key);
      if (!review) scheduleKeywordReview(key, 'full', 'RSS 游戏相关候选：实体及建站机会待完整验证', 0);
      candidates.push({ keyword: key, source: 'trending-now:rss', seedWord: `RSS:${output.geo}`,
        trendType: 'rising', discoveredAt: new Date(now) });
    }
    return candidates;
  }).immediate();
}
