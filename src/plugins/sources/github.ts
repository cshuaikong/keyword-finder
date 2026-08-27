/**
 * GitHub Trending 数据源插件
 * 监控 AI/游戏类开源项目的 trending 榜单
 * 新项目 = 新概念 = 新词（如 "cursor"、"bolt.new" 都是先从 GitHub 火起来的）
 * GitHub Trending 页面是 HTML，用 cheerio 解析
 */

import * as cheerio from 'cheerio';
import { fetchText } from '../../modules/http.js';
import type { SourcePlugin } from '../../core/plugin.js';
import type { SourceItem } from '../../types.js';

/** Trending 页面 URL（按语言过滤） */
const TRENDING_URLS = [
  { lang: 'all', url: 'https://github.com/trending?since=daily' },
  { lang: 'typescript', url: 'https://github.com/trending/typescript?since=daily' },
  { lang: 'python', url: 'https://github.com/trending/python?since=daily' },
];

/** 解析 Trending 页面 */
async function parseTrending(url: string, source: string): Promise<SourceItem[]> {
  const html = await fetchText(url, {
    'Accept': 'text/html,application/xhtml+xml',
  });

  const $ = cheerio.load(html);
  const items: SourceItem[] = [];

  // GitHub Trending 结构: <article class="Box-row"> 内含 <h2 class="h3"> 标题 + 描述
  $('article.Box-row').each((_: number, el: any) => {
    const $article = $(el);

    // 仓库名: owner/repo
    const h2Text = $article.find('h2').text().trim().replace(/\s+/g, ' ');
    if (!h2Text) return;

    // 描述
    const description = $article.find('p').text().trim();

    // 今日 stars
    const starsText = $article.find('span.d-inline-block.float-sm-right').text().trim();
    const starsMatch = starsText.match(/([\d,]+)\s*stars?/i);
    const stars = starsMatch ? parseInt(starsMatch[1].replace(/,/g, ''), 10) : 0;

    // 语言
    const lang = $article.find('[itemprop="programmingLanguage"]').text().trim();

    // 拼接完整标题: repo名 + 描述 + 语言
    const fullTitle = `${h2Text}${description ? ' ' + description : ''}${lang ? ' ' + lang : ''}`;

    items.push({
      title: fullTitle,
      url: `https://github.com/${h2Text}`,
      source,
      score: stars,
    });
  });

  return items;
}

export const githubTrendingSource: SourcePlugin = {
  type: 'source',
  name: 'github',
  async fetch(): Promise<{ items: SourceItem[] }> {
    const allItems: SourceItem[] = [];

    for (const { lang, url } of TRENDING_URLS) {
      try {
        const items = await parseTrending(url, `github:${lang}`);
        console.log(`  ✓ GitHub Trending (${lang}): ${items.length} 个项目`);
        allItems.push(...items);
      } catch (err: any) {
        console.log(`  ✗ GitHub Trending (${lang}) 失败: ${err?.message || err}`);
      }
      // 间隔 1 秒避免触发 GitHub 限流
      await new Promise(r => setTimeout(r, 1000));
    }

    allItems.sort((a, b) => (b.score || 0) - (a.score || 0));

    return { items: allItems };
  },
};
