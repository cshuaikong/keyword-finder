/**
 * Reddit 数据源插件
 * 抓取游戏/独立开发/副业等板块的热帖，提取"炫耀帖"和游戏新词
 *
 * 注意：Reddit 官方 JSON API 会拦截数据中心 IP（HTTP 403），
 * 但 RSS 接口（.rss）可用，因此本模块使用 RSS + XML 解析。
 */

import * as cheerio from 'cheerio';
import { fetchText } from '../../modules/http.js';
import type { SourcePlugin } from '../../core/plugin.js';
import type { SourceItem } from '../../types.js';

/** 要监控的 subreddit 列表 */
const SUBREDDITS = [
  'WebGames',        // 网页游戏
  'gaming',          // 游戏综合
  'IndieDev',        // 独立开发
  'SideProject',     // 副业项目
  'indiegames',      // 独立游戏
  'gamedev',         // 游戏开发
];

/** 每次运行随机选多少个板块（Reddit 对数据中心 IP 限流很严，避免请求过多） */
const SUBREDDITS_PER_RUN = 3;

/** 随机选取板块 */
function pickSubreddits(): string[] {
  const shuffled = [...SUBREDDITS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, SUBREDDITS_PER_RUN);
}

/** 抓取单个 subreddit 的 RSS 热帖 */
async function fetchSubredditRss(subreddit: string): Promise<SourceItem[]> {
  const url = `https://www.reddit.com/r/${subreddit}/.rss`;
  const xml = await fetchText(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const $ = cheerio.load(xml, { xmlMode: true });
  const items: SourceItem[] = [];

  $('entry').each((_: number, el: any) => {
    const $entry = $(el);
    const title = $entry.find('title').text().trim();
    if (!title) return;

    const link = $entry.find('link').attr('href') || '';
    // RSS 2.0 的 link 可能直接是文本
    const linkText = $entry.find('link').text().trim();

    items.push({
      title,
      url: link || linkText,
      source: `reddit:${subreddit}`,
      // 赞数从 category 属性或其他字段难以获取，按时间排序即可
      score: 0,
      publishedAt: $entry.find('updated').length
        ? new Date($entry.find('updated').text().trim())
        : undefined,
    });
  });

  return items;
}

export const redditSource: SourcePlugin = {
  type: 'source',
  name: 'reddit',
  async fetch(): Promise<{ items: SourceItem[] }> {
    const allItems: SourceItem[] = [];
    // 每次运行随机选 3 个板块，降低请求密度（长期覆盖所有板块）
    const subs = pickSubreddits();

    for (const sub of subs) {
      try {
        const items = await fetchSubredditRss(sub);
        console.log(`  ✓ Reddit r/${sub}: ${items.length} 个帖子`);
        allItems.push(...items);
      } catch (err: any) {
        console.log(`  ✗ Reddit r/${sub} 失败: ${err?.message || err}`);
      }
      // Reddit 限流较严：每请求间隔 6 秒（连续请求会触发 429）
      await new Promise(r => setTimeout(r, 6000));
    }

    return { items: allItems };
  },
};
