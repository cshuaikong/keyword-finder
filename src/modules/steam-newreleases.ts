/**
 * Steam 游戏发现器
 *
 * 同时扫描新发售、即将发售和热门即将发售。这里只负责发现并返回完整列表，
 * “每轮处理几个”的限制由数据库持久化队列承担，因此不会再出现先标记、后截断导致丢词。
 */

import * as cheerio from 'cheerio';
import { fetchText } from './http.js';

export type SteamDiscoveryChannel = 'new-releases' | 'upcoming' | 'popular-upcoming';

export interface SteamDiscoveredGame {
  appid: string;
  title: string;
  channel: SteamDiscoveryChannel;
  sourceUrl: string;
  releaseDate?: string;
  platforms: string[];
  priority: number;
}

export interface NewReleaseGame {
  appid: string;
  title: string;
}

const STEAM_CHANNELS: Array<{ channel: SteamDiscoveryChannel; url: string; priority: number }> = [
  {
    channel: 'popular-upcoming',
    url: 'https://store.steampowered.com/search/?filter=popularcomingsoon&category1=998&supportedlang=english',
    priority: 85,
  },
  {
    channel: 'upcoming',
    url: 'https://store.steampowered.com/search/?filter=comingsoon&category1=998&supportedlang=english',
    priority: 70,
  },
  {
    channel: 'new-releases',
    url: 'https://store.steampowered.com/search/?sort_by=Released_DESC&category1=998&supportedlang=english',
    priority: 75,
  },
];

const NOISE_TITLE_PATTERNS = [
  /\b(dlc|soundtrack|ost|artbook|demo|bundle|season pass|expansion|beta|playtest|prologue|trailer|launch edition|upgrade)\b/i,
];
const NON_LATIN = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

function isNoiseTitle(title: string): boolean {
  if (NON_LATIN.test(title)) return true;
  if (title.length < 3 || title.length > 80) return true;
  return NOISE_TITLE_PATTERNS.some(pattern => pattern.test(title));
}

function parseSteamDate(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || /coming soon|to be announced|announced/i.test(normalized)) return undefined;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  // Steam 展示的是日历日期，不是一个 UTC 时刻；保留本地年月日可避免东八区被换算到前一天。
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function scrapeChannel(
  channel: SteamDiscoveryChannel,
  url: string,
  priority: number,
): Promise<SteamDiscoveredGame[]> {
  const html = await fetchText(url, { Cookie: 'birthtime=631152000; Steam_Language=english' });
  return parseSteamSearchHtml(html, channel, priority);
}

/** 独立解析器便于用固定 HTML 回归测试，避免把网络可用性和页面解析混为一谈。 */
export function parseSteamSearchHtml(
  html: string,
  channel: SteamDiscoveryChannel,
  priority: number,
): SteamDiscoveredGame[] {
  const $ = cheerio.load(html);
  const games: SteamDiscoveredGame[] = [];

  $('a.search_result_row').each((_: number, el: any) => {
    const row = $(el);
    const href = row.attr('href') || '';
    const match = href.match(/\/app\/(\d+)\//);
    const title = row.find('span.title').text().trim();
    if (!match || !title || isNoiseTitle(title)) return;

    const platforms: string[] = [];
    const platformClasses = row.find('.search_name .platform_img')
      .map((__: number, node: any) => $(node).attr('class') || '').get().join(' ');
    if (/win/i.test(platformClasses)) platforms.push('PC');
    if (/mac/i.test(platformClasses)) platforms.push('Mac');
    if (/linux/i.test(platformClasses)) platforms.push('Linux');

    games.push({
      appid: match[1],
      title,
      channel,
      sourceUrl: `https://store.steampowered.com/app/${match[1]}/`,
      releaseDate: parseSteamDate(row.find('.search_released').text()),
      platforms,
      priority,
    });
  });
  return games;
}

export async function discoverSteamGames(): Promise<{ games: SteamDiscoveredGame[]; errors: string[] }> {
  const discovered: SteamDiscoveredGame[] = [];
  const errors: string[] = [];
  for (const source of STEAM_CHANNELS) {
    try {
      const games = await scrapeChannel(source.channel, source.url, source.priority);
      discovered.push(...games);
    } catch (error: any) {
      errors.push(`${source.channel}: ${error?.message || String(error)}`);
    }
  }
  return { games: discovered, errors };
}

/** 旧 API 兼容；不再维护会造成丢词的文件缓存。 */
export async function captureNewReleases(limit = 5): Promise<NewReleaseGame[]> {
  const source = STEAM_CHANNELS.find(item => item.channel === 'new-releases')!;
  const games = await scrapeChannel(source.channel, source.url, source.priority);
  return games.slice(0, Math.max(0, limit)).map(game => ({ appid: game.appid, title: game.title }));
}
