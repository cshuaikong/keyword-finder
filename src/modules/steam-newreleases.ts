/**
 * Steam 新发售游戏捕获引擎（P0 缺口）
 *
 * 问题：雷达的词根池是手工维护的，新发售游戏名无法自动进入
 *   → 8/27 的 Star Wars Zero Company、Resonance 发售了雷达完全不知道
 *   → 攻略词窗口（发售前 2 周 ~ 发售后 4 周）错过
 *
 * 方案：抓 Steam 商店搜索页（按发售日倒序，服务端渲染，无需 API key）
 *   1. 解析最新 50 款新发售游戏（appid + 标题）
 *   2. 噪声过滤：DLC/原声带/Demo/非拉丁字符等
 *   3. 与本地缓存 diff，只返回本轮新出现的游戏
 *
 * 额度：0（纯免费抓取），后续挖掘走内环 suggest（免费）+ 外环验证
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { fetchText } from './http.js';
import { config } from '../config.js';

/** Steam 新发售搜索页（按发售日倒序，category1=998 限定游戏大类） */
const STEAM_NEW_RELEASES_URL =
  'https://store.steampowered.com/search/?sort_by=Released_DESC&category1=998&supportedlang=english';

/** 捕获缓存：已见过的 appid 集合（diff 用） */
const CACHE_FILE = resolve(process.cwd(), 'data/steam-releases-cache.json');

/** 标题噪声模式：这类条目不是可攻略的游戏本体 */
const NOISE_TITLE_PATTERNS = [
  /\b(dlc|soundtrack|ost|artbook|demo|bundle|season pass|expansion|beta|playtest|prologue|trailer|launch edition|upgrade)\b/i,
];

/** 非拉丁字符（中文/日文/韩文）：只做英文站，排除 */
const NON_LATIN = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

export interface NewReleaseGame {
  appid: string;
  title: string;
}

interface SteamCache {
  appids: Record<string, boolean>;
}

/** 读取捕获缓存 */
async function loadCache(): Promise<SteamCache> {
  try {
    const text = await readFile(CACHE_FILE, 'utf-8');
    const data = JSON.parse(text) as SteamCache;
    return data.appids ? data : { appids: {} };
  } catch {
    return { appids: {} };
  }
}

/** 保存捕获缓存 */
async function saveCache(cache: SteamCache): Promise<void> {
  await mkdir(resolve(process.cwd(), 'data'), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

/** 标题噪声过滤 */
function isNoiseTitle(title: string): boolean {
  if (NON_LATIN.test(title)) return true; // 命中非拉丁字符 → 排除
  if (title.length < 3 || title.length > 40) return true;
  for (const p of NOISE_TITLE_PATTERNS) {
    if (p.test(title)) return true;
  }
  return false;
}

/**
 * 抓取新发售游戏列表（按发售日倒序前 50 款）
 * 返回过滤噪声后的游戏（appid + 标题）
 */
async function scrapeNewReleases(): Promise<NewReleaseGame[]> {
  const html = await fetchText(STEAM_NEW_RELEASES_URL, { Cookie: 'birthtime=631152000' });
  const $ = cheerio.load(html);
  const games: NewReleaseGame[] = [];

  $('a.search_result_row').each((_: number, el: any) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const m = href.match(/\/app\/(\d+)\//);
    const title = $el.find('span.title').text().trim();
    if (!m || !title) return;
    if (isNoiseTitle(title)) return;
    games.push({ appid: m[1], title });
  });

  return games;
}

/**
 * 捕获本轮新增发售的游戏（与缓存 diff，只返回新出现的）
 *
 * 缓存策略：本轮抓到的全部 appid 立即标记已见（含未取出的），
 * 下次运行只处理"更新上架"的游戏。上架越久的游戏攻略窗口越窄，
 * 只处理最新一批是合理的。
 *
 * @param limit 本轮最多返回几个新游戏（防止上架高峰灌爆内环 suggest）
 */
export async function captureNewReleases(
  limit: number = config.steamReleaseLimit,
): Promise<NewReleaseGame[]> {
  const games = await scrapeNewReleases();
  if (games.length === 0) return [];

  const cache = await loadCache();
  const fresh = games.filter(g => !cache.appids[g.appid]);

  for (const g of games) cache.appids[g.appid] = true;
  await saveCache(cache);

  return fresh.slice(0, limit);
}
