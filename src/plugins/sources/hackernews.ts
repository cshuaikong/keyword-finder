/**
 * Hacker News 数据源插件
 * 抓取 Show HN / Ask HN 和热帖
 * "炫耀帖"是哥飞提到的黄金信号——程序员发布新产品时一定会在 HN 宣传
 * 使用官方免费 Firebase API，无需密钥
 */

import { fetchJson } from '../../modules/http.js';
import type { SourcePlugin } from '../../core/plugin.js';
import type { SourceItem } from '../../types.js';

interface HNItem {
  id: number;
  title: string;
  url?: string;
  score?: number;
  time?: number;
}

/** 抓取 Top Stories 列表 */
async function fetchTopStories(limit = 30): Promise<number[]> {
  const ids = await fetchJson<number[]>('https://hacker-news.firebaseio.com/v0/topstories.json');
  return ids.slice(0, limit);
}

/** 抓取 Show HN 列表 */
async function fetchShowHN(limit = 30): Promise<number[]> {
  const ids = await fetchJson<number[]>('https://hacker-news.firebaseio.com/v0/showstories.json');
  return ids.slice(0, limit);
}

/** 批量抓取条目详情 */
async function fetchItems(ids: number[], source: string): Promise<SourceItem[]> {
  const items: SourceItem[] = [];

  // 并发抓取（HN API 支持高并发）
  const batch = await Promise.allSettled(
    ids.map(id => fetchJson<HNItem>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`))
  );

  for (const result of batch) {
    if (result.status !== 'fulfilled') continue;
    const item = result.value;
    if (!item?.title) continue;

    items.push({
      title: item.title,
      url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
      source,
      score: item.score || 0,
      publishedAt: item.time ? new Date(item.time * 1000) : undefined,
    });
  }

  return items;
}

export const hackerNewsSource: SourcePlugin = {
  type: 'source',
  name: 'hackernews',
  async fetch(): Promise<{ items: SourceItem[] }> {
    const allItems: SourceItem[] = [];

    try {
      // Show HN（炫耀帖，最核心的信号）
      const showIds = await fetchShowHN(30);
      const showItems = await fetchItems(showIds, 'hn:show');
      console.log(`  ✓ HN Show HN: ${showItems.length} 个帖子`);
      allItems.push(...showItems);
    } catch (err: any) {
      console.log(`  ✗ HN Show HN 失败: ${err?.message || err}`);
    }

    try {
      // Top Stories
      const topIds = await fetchTopStories(30);
      const topItems = await fetchItems(topIds, 'hn:top');
      console.log(`  ✓ HN Top Stories: ${topItems.length} 个帖子`);
      allItems.push(...topItems);
    } catch (err: any) {
      console.log(`  ✗ HN Top Stories 失败: ${err?.message || err}`);
    }

    allItems.sort((a, b) => (b.score || 0) - (a.score || 0));

    return { items: allItems };
  },
};
