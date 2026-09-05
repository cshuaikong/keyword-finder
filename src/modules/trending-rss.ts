import * as cheerio from 'cheerio';

export interface RssNews { title: string; url: string; source: string }
export interface GameClassification {
  kind: 'known-game' | 'game-related' | 'noise' | 'unknown';
  confidence: number;
  reasons: string[];
}
export interface RssTrendItem {
  query: string;
  search_volume: number | null;
  search_volume_label: string | null;
  rss_pub_date: string | null;
  news: RssNews[];
  classification: GameClassification;
}
export interface RssSnapshot {
  geo: string;
  observed_at: string;
  fetch_status: 'rss_limited' | 'failed';
  source_url: string;
  error: string | null;
  items: RssTrendItem[];
}

const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const gamingDomains = ['ign.com', 'gamespot.com', 'pcgamer.com', 'eurogamer.net', 'gematsu.com',
  'nintendolife.com', 'pushsquare.com', 'rockpapershotgun.com', 'store.steampowered.com',
  'playstation.com', 'xbox.com', 'nintendo.com'];
const gameContext = /\b(video game|videogame|gameplay|steam|playstation|nintendo|xbox|ps5|rpg|mmorpg|dlc)\b/i;
const noiseQuery = /\b(wordle|quordle|crossword|connections hints?|strands hints?|lottery|powerball)\b/i;
const personOrEvent = /\b(twitch|streamer|esports?|tournament|championship|quarterback|nba|nfl|mlb)\b/i;
const productContext = /\b(gameplay|launch|launches|release|released|trailer|announced|announcement|wishlist|expansion|patch|update)\b/i;

/** Explainable screening only. A gaming article does NOT verify the query as a game title. */
export function classifyRssTrend(query: string, news: RssNews[], knownTitles: Set<string> = new Set()): GameClassification {
  if (knownTitles.has(normalize(query))) return { kind: 'known-game', confidence: 95, reasons: ['精确匹配本地已发现游戏名'] };
  if (noiseQuery.test(query)) return { kind: 'noise', confidence: 90, reasons: ['每日答案/彩票类查询'] };
  const context = news.map(n => n.title).join(' ');
  if (personOrEvent.test(query + ' ' + context)) return { kind: 'unknown', confidence: 30, reasons: ['涉及主播、赛事或人物，需确认实体'] };
  const domainEvidence = news.some(n => {
    try {
      const host = new URL(n.url).hostname.toLowerCase();
      return gamingDomains.some(domain => host === domain || host.endsWith('.' + domain));
    } catch { return false; }
  });
  // Generic “game” alone is insufficient: sports and game shows share it.
  if ((domainEvidence || gameContext.test(context)) && productContext.test(context)) {
    return { kind: 'game-related', confidence: 65,
      reasons: [domainEvidence ? '相关新闻来自游戏媒体/平台' : '相关新闻含电子游戏平台或玩法词',
        '相关新闻含发售/预告/更新信息；尚未确认是游戏名'] };
  }
  return { kind: 'unknown', confidence: 0, reasons: ['缺少可核实的游戏证据，保留观察'] };
}

export function parseRssTraffic(label: string): number | null {
  const match = label.replace(/,/g, '').trim().match(/^(\d+(?:\.\d+)?)\s*([KM]?)\+?$/i);
  if (!match) return null;
  return Number(match[1]) * (match[2].toUpperCase() === 'M' ? 1000000 : match[2].toUpperCase() === 'K' ? 1000 : 1);
}

export function parseTrendingRss(xml: string, knownTitles: Set<string> = new Set()): RssTrendItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($('rss > channel').length !== 1 || /<!DOCTYPE/i.test(xml)) throw new Error('响应不是有效的 Google Trends RSS（可能是拦截页或协议变化）');
  const result: RssTrendItem[] = [];
  $('channel > item').each((_, el) => {
    const children = $(el).children();
    const text = (name: string) => children.filter((_, n) => n.type === 'tag' && n.name.split(':').pop() === name).first().text().trim();
    const query = text('title');
    if (!query) return;
    const news: RssNews[] = [];
    children.filter((_, n) => n.type === 'tag' && n.name.split(':').pop() === 'news_item').each((_, n) => {
      const childText = (name: string) => $(n).children().filter((_, c) => c.type === 'tag' && c.name.split(':').pop() === name).first().text().trim();
      news.push({ title: childText('news_item_title'), url: childText('news_item_url'), source: childText('news_item_source') });
    });
    const label = text('approx_traffic');
    const pubDate = text('pubDate');
    result.push({ query, search_volume: parseRssTraffic(label), search_volume_label: label || null,
      rss_pub_date: Number.isFinite(Date.parse(pubDate)) ? new Date(pubDate).toISOString() : null,
      news, classification: classifyRssTrend(query, news, knownTitles) });
  });
  return result;
}
