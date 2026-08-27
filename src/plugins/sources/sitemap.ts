/**
 * 游戏大站 Sitemap 监控数据源插件
 * 监控 CrazyGames、Poki 等大站的新增页面，反推新词
 * 哥飞原话："监控游戏大站的 sitemap 更新，从它们新增的页面里反推新词和新需求"
 *
 * 原理：
 * 1. 抓取大站的 sitemap.xml
 * 2. 与本地缓存对比，找出新增的 URL
 * 3. 从新增 URL 中提取关键词
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import { fetchText, fetchBuffer } from '../../modules/http.js';
import type { SourcePlugin } from '../../core/plugin.js';
import type { SourceItem } from '../../types.js';

/** 要监控的游戏大站（地址从各自 robots.txt 提取） */
const GAME_SITES = [
  { name: 'crazygames', sitemap: 'https://www.crazygames.com/sitemap-index.xml' },
  { name: 'poki', sitemap: 'https://poki.com/en/sitemaps/index.xml' },
  { name: 'y8', sitemap: 'https://www.y8.com/sitemaps/y8/en/sitemap.xml.gz' },
];

/** 缓存文件路径 */
const CACHE_FILE = resolve(process.cwd(), 'data/sitemap-cache.json');

interface CacheEntry {
  [site: string]: {
    urls: string[];
    lastChecked: string;
  };
}

/** 读取缓存 */
async function loadCache(): Promise<CacheEntry> {
  try {
    const text = await readFile(CACHE_FILE, 'utf-8');
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 保存缓存 */
async function saveCache(cache: CacheEntry): Promise<void> {
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

/** 解析 sitemap，返回 URL 列表（自动处理 gzip 压缩的 sitemap） */
async function parseSitemap(sitemapUrl: string): Promise<string[]> {
  let xml: string;

  if (sitemapUrl.endsWith('.gz')) {
    // gzip 压缩的 sitemap：服务端直接返回二进制内容，需手动解压
    const buf = await fetchBuffer(sitemapUrl);
    // gzip 魔数: 1f 8b
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      xml = gunzipSync(buf).toString('utf-8');
    } else {
      xml = buf.toString('utf-8');
    }
  } else {
    xml = await fetchText(sitemapUrl);
  }

  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: string[] = [];

  $('url > loc').each((_: number, el: any) => {
    urls.push($(el).text().trim());
  });

  // 如果是 sitemap index（嵌套 sitemap），只取前几个子 sitemap
  if (urls.length === 0) {
    const subSitemaps: string[] = [];
    $('sitemap > loc').each((_: number, el: any) => {
      subSitemaps.push($(el).text().trim());
    });

    // 只抓前 3 个子 sitemap，避免请求过多
    for (const sub of subSitemaps.slice(0, 3)) {
      try {
        const subXml = await fetchText(sub);
        const $sub = cheerio.load(subXml, { xmlMode: true });
        $sub('url > loc').each((_: number, el: any) => {
          urls.push($sub(el).text().trim());
        });
      } catch {
        // 子 sitemap 失败就跳过
      }
    }
  }

  return urls;
}

/** 从 URL 中提取关键词 */
function urlToKeyword(url: string): string | null {
  try {
    const parsed = new URL(url);
    // 去掉域名，取路径部分
    const path = parsed.pathname.replace(/\/$/, '');
    if (!path || path === '/') return null;

    // 取最后一段路径
    const segments = path.split('/').filter(Boolean);
    const last = segments[segments.length - 1];

    // 连字符转空格
    const keyword = last.replace(/-/g, ' ').trim();
    if (keyword.length < 3) return null;

    return keyword;
  } catch {
    return null;
  }
}

export const sitemapSource: SourcePlugin = {
  type: 'source',
  name: 'sitemap',
  async fetch(): Promise<{ items: SourceItem[] }> {
    const items: SourceItem[] = [];
    const cache = await loadCache();

    for (const site of GAME_SITES) {
      try {
        const urls = await parseSitemap(site.sitemap);
        const cached = cache[site.name];

        if (!cached) {
          // 首次运行：全部记录为缓存，只取少量作为样本
          cache[site.name] = {
            urls,
            lastChecked: new Date().toISOString(),
          };
          console.log(`  ✓ ${site.name} sitemap: 首次抓取 ${urls.length} 个 URL（建立缓存）`);

          // 首次运行时取最后 20 个 URL 作为样本
          for (const url of urls.slice(-20)) {
            const keyword = urlToKeyword(url);
            if (keyword) {
              items.push({
                title: keyword,
                url,
                source: `sitemap:${site.name}`,
              });
            }
          }
        } else {
          // 与缓存对比，找新增 URL
          const cachedSet = new Set(cached.urls);
          const newUrls = urls.filter(u => !cachedSet.has(u));
          console.log(`  ✓ ${site.name} sitemap: 新增 ${newUrls.length} 个 URL`);

          for (const url of newUrls) {
            const keyword = urlToKeyword(url);
            if (keyword) {
              items.push({
                title: keyword,
                url,
                source: `sitemap:${site.name}`,
              });
            }
          }

          // 更新缓存
          cache[site.name] = {
            urls,
            lastChecked: new Date().toISOString(),
          };
        }
      } catch (err: any) {
        console.log(`  ✗ ${site.name} sitemap 失败: ${err?.message || err}`);
      }
    }

    // 保存缓存
    await saveCache(cache);

    return { items };
  },
};
