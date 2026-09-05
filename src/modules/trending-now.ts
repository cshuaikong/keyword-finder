import { parseTrendingRss, type RssSnapshot } from './trending-rss.js';
import { ProxyAgent } from 'undici';
import { config } from '../config.js';
import { claimPoll, finishPoll, getRssCache, setRssCache, pollState, saveTrendingSnapshot } from '../core/trending-store.js';
import { getDb } from '../core/db.js';
import type { TrendingKeyword } from '../types.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function trendingNowEnabled(): boolean {
  return config.trendingNowEnabled && ![...config.disablePlugins, ...config.disableSources].includes('trending-now');
}

export function nextPollDelay(failures: number, retryAfterMs = 0, random = Math.random): number {
  const base = failures > 0
    ? Math.min(24 * 3600000, config.trendingNowIntervalMs * 2 ** Math.min(failures, 10))
    : config.trendingNowIntervalMs;
  const jitter = failures > 0 ? random() * config.trendingNowJitterMs
    : (random() * 2 - 1) * config.trendingNowJitterMs;
  return Math.max(25 * 60000, Math.round(base + jitter), retryAfterMs);
}

export function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

export interface PollResult {
  status: 'success' | 'partial' | 'failed' | 'skipped';
  candidates: TrendingKeyword[];
  nextAt: number;
  errors: string[];
}

/** RSS only. No internal Google web protocol; a 403/429 pauses ALL regions. */
export async function pollTrendingNow(deps: {
  fetchImpl?: typeof fetch; now?: () => number; sleep?: typeof sleep;
} = {}): Promise<PollResult> {
  const now = deps.now ?? Date.now;
  if (!trendingNowEnabled()) return { status: 'skipped', candidates: [], nextAt: 0, errors: [] };
  if (!config.trendingNowGeos.length) throw new Error('TRENDING_NOW_GEOS 必须包含至少一个两字母地区码');
  // Reserve a full interval before network I/O. Restarting or a second process cannot bypass cooldown.
  const token = claimPoll(now(), Math.max(config.trendingNowIntervalMs, config.trendingNowGeos.length * 45000));
  if (!token) return { status: 'skipped', candidates: [], nextAt: pollState().next_at, errors: [] };
  const state = pollState();
  const proxyUrl = config.httpsProxy || config.httpProxy;
  const agent = !deps.fetchImpl && proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  let blocked = false;
  let retryUntil = 0;
  let successes = 0;
  const errors: string[] = [];
  const candidates: TrendingKeyword[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', 'keyword-finder/1.0 (+https://github.com/cshuaikong/keyword-finder)');
    const response = await (deps.fetchImpl ?? fetch)(url, {
      ...init, headers,
      ...(agent ? { dispatcher: agent } : {}),
    });
    if (response.status === 403 || response.status === 429) blocked = true;
    retryUntil = Math.max(retryUntil, now() + parseRetryAfter(response.headers.get('retry-after'), now()));
    return response;
  };
  try {
    for (let i = 0; i < config.trendingNowGeos.length; i++) {
      if (i > 0) await (deps.sleep ?? sleep)(3000);
      const geo = config.trendingNowGeos[i];
      const sourceUrl = `https://trends.google.com/trending/rss?geo=${geo}`;
      const snapshot: RssSnapshot = { geo, observed_at: new Date(now()).toISOString(),
        source_url: sourceUrl, fetch_status: 'rss_limited', error: null, items: [] };
      try {
        const cached = getRssCache(geo);
        const headers: Record<string, string> = { Accept: 'application/rss+xml,text/xml' };
        if (cached?.etag) headers['If-None-Match'] = cached.etag;
        if (cached?.last_modified) headers['If-Modified-Since'] = cached.last_modified;
        const response = await fetchImpl(sourceUrl, { headers, signal: AbortSignal.timeout(15000) });
        if (!response.ok && response.status !== 304) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        const xml = response.status === 304 ? cached?.xml : await response.text();
        if (!xml) throw new Error('RSS 返回空数据或304但无本地缓存');
        const known = getDb().prepare('SELECT title FROM games').all() as { title: string }[];
        const titles = new Set(known.map(g => g.title.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')));
        snapshot.items = parseTrendingRss(xml, titles);
        candidates.push(...saveTrendingSnapshot(snapshot, now()));
        if (response.status !== 304) setRssCache(geo, xml, response.headers.get('etag'), response.headers.get('last-modified'));
        successes++;
        console.log(`[Trending RSS] ${geo}: ${snapshot.items.length} 条，游戏候选 ${snapshot.items.filter(i => ['known-game', 'game-related'].includes(i.classification.kind)).length}`);
      } catch (err) {
        const message = `${geo}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(message);
        saveTrendingSnapshot({ ...snapshot, fetch_status: 'failed', items: [], error: message }, now());
      }
      if (blocked || retryUntil > now()) break;
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (agent) await agent.close().catch(() => {});
    const failures = errors.length ? state.failures + 1 : 0;
    const nextAt = now() + nextPollDelay(failures, Math.max(0, retryUntil - now()));
    finishPoll(token, nextAt, failures, errors.length ? errors.join('\n').slice(0, 4000) : null);
  }
  const result: PollResult = {
    status: errors.length ? successes ? 'partial' : 'failed' : 'success',
    candidates: [...new Map(candidates.map(c => [c.keyword, c])).values()],
    nextAt: pollState().next_at, errors,
  };
  console.log(`[Trending Now] ${result.status}，新增/加速 ${result.candidates.length} 词；下次 ${new Date(result.nextAt).toLocaleString()}`);
  if (errors.length) console.warn('[Trending Now] 采集失败，已退避:', errors.join('; '));
  return result;
}

/** Recursive timer waits for completion; no overlapping polls or fixed cron-hour bursts. */
export function startTrendingNowWatcher(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!trendingNowEnabled()) return () => {};
  const tick = async () => {
    let delay = config.trendingNowIntervalMs;
    try {
      const result = await pollTrendingNow();
      delay = Math.max(1000, result.nextAt - Date.now());
    } catch (err) {
      console.warn('[Trending Now] 调度错误:', err instanceof Error ? err.message : String(err));
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, Math.min(delay, 2147483647));
  };
  timer = setTimeout(() => { void tick(); }, 0);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
