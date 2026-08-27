/**
 * Google Suggest 免费挖掘模块（0 额度引擎）
 *
 * 直接请求 suggestqueries.google.com 的公开 JSON 端点，不消耗 SerpAPI 额度：
 *   - 词根递进：seed + a-z/0-9 逐字符递进，挖完整长尾（经典 ASK 法）
 *   - 前缀模式：游戏名 + how to/where/best/key/boss/enemies 等模式词
 *
 * 用途：内环（找词环）的免费火力，与 SerpAPI 词根引擎互补。
 * 返回词条统一包装成 TrendingKeyword，source 标记为 'suggest'。
 */

import type { TrendingKeyword } from '../types.js';

/** 前缀模式词（游戏攻略场景的高价值提问词） */
export const SUGGEST_PATTERNS = [
  'how to', 'where', 'best', 'key', 'boss', 'enemies',
  'weapon', 'solo', 'multiplayer', 'tips', 'guide', 'walkthrough',
];

/** 建议的递进字符集（a-z + 数字，经典 ASK 法） */
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 延迟函数 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 单次 suggest 请求：返回 Google 自动补全的建议列表
 * client=firefox 返回纯 JSON（[query, [suggestions]]）
 */
async function fetchSuggest(q: string): Promise<string[]> {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/130.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`suggest HTTP ${res.status}`);
  const data = (await res.json()) as [string, string[]];
  return data[1] ?? [];
}

/**
 * 词根递进挖掘：seed + 单字符，返回全部建议
 * 例：'grain rot' + 'a' → ['grain rot all enemies', ...]
 */
async function suggestByChar(seed: string, ch: string): Promise<string[]> {
  return fetchSuggest(`${seed} ${ch}`);
}

/**
 * 前缀模式挖掘：游戏名 + 模式词（how to/where/best...）
 */
async function suggestByPattern(seed: string, pattern: string): Promise<string[]> {
  return fetchSuggest(`${seed} ${pattern}`);
}

/**
 * 对单个种子执行完整免费挖掘：
 *   1. 逐字符递进（36 请求）
 *   2. 前缀模式（12 请求）
 * 共约 48 个免费请求，返回去重后的长尾词列表。
 *
 * @param seed  种子词（通常是游戏名）
 * @param delayMs 请求间隔（默认 150ms，避免触发限流）
 */
export async function suggestMine(
  seed: string,
  delayMs = 150,
): Promise<TrendingKeyword[]> {
  const found = new Map<string, TrendingKeyword>();

  // 1. 字符递进
  for (const ch of CHARS) {
    try {
      const list = await suggestByChar(seed, ch);
      for (const kw of list) {
        const key = kw.toLowerCase().trim();
        if (key && !found.has(key)) {
          found.set(key, {
            keyword: key,
            seedWord: seed,
            source: 'suggest',
            trendType: 'rising',
            growthPercent: 0,
            discoveredAt: new Date(),
          });
        }
      }
    } catch {
      // 单字符请求失败忽略，继续下一个
    }
    await sleep(delayMs);
  }

  // 2. 前缀模式
  for (const pattern of SUGGEST_PATTERNS) {
    try {
      const list = await suggestByPattern(seed, pattern);
      for (const kw of list) {
        const key = kw.toLowerCase().trim();
        if (key && !found.has(key)) {
          found.set(key, {
            keyword: key,
            seedWord: seed,
            source: 'suggest',
            trendType: 'rising',
            growthPercent: 0,
            discoveredAt: new Date(),
          });
        }
      }
    } catch {
      // 单模式请求失败忽略
    }
    await sleep(delayMs);
  }

  return [...found.values()];
}
