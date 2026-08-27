/**
 * n-gram 关键词提取器插件
 * 从社交媒体的标题/文本中提取候选关键词
 * 策略：n-gram 提取 + 词根库匹配 + 停用词过滤 + 首尾语法词修剪
 *
 * 替换提取器 = 替换本文件（或新增文件 + 改注册列表）
 */

import { allSeeds } from '../../seeds.js';
import type { ExtractorPlugin } from '../../core/plugin.js';
import type { SourceItem, TrendingKeyword } from '../../types.js';

/** 常见停用词（英文） */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
  'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from',
  'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'all', 'any', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can',
  'will', 'just', 'should', 'now', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did',
  'doing', 'this', 'that', 'these', 'those', 'am', 'it', 'its', 'as',
  'of', 'what', 'which', 'who', 'whom', 'you', 'your', 'i', 'me', 'my',
  'we', 'our', 'they', 'their', 'he', 'him', 'his', 'she', 'her',
  'how', 'why', 'where', 'when', 'make', 'made', 'get', 'got', 'new',
  'top', 'best', 'free', 'online', 'using', 'use', 'used', 'like',
  'every', 'day', 'first', 'last', 'next', 'see', 'watch', 'read',
  'post', 'link', 'thread', 'week', 'month', 'year', 'today', 'day',
  'news', 'update', 'updates', 'release', 'launch', 'version', 'review',
  'vs', 'via', 'per', 'com', 'www', 'http', 'https', 'reddit',
]);

/**
 * 边界修剪用的纯语法词（冠词/介词/连词/代词/助动词）
 * 注意：不含 free/new/best/top 等带语义的词，避免误修 "free xxx" 这类好词
 */
const EDGE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
  'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from',
  'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'all', 'any', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can',
  'will', 'just', 'should', 'now', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did',
  'doing', 'this', 'that', 'these', 'those', 'am', 'it', 'its', 'as',
  'of', 'what', 'which', 'who', 'whom', 'you', 'your', 'i', 'me', 'my',
  'we', 'our', 'they', 'their', 'he', 'him', 'his', 'she', 'her',
  'how', 'why', 'where', 'when', 'via', 'per', 'vs',
]);

/** 高频无意义词（非新词指示词） */
const NOISE_WORDS = new Set([
  'lol', 'omg', 'wtf', 'btw', 'fyi', 'imo', 'imho', 'tbh', 'ama',
  'tifu', 'til', 'eli5', 'nsfw', 'oc', 'xpost', 'repost',
]);

/**
 * 从标题/文本中提取候选关键词
 */
export function extractKeywordsFromText(text: string, options?: {
  maxKeywords?: number;
  minLength?: number;
}): string[] {
  const maxKeywords = options?.maxKeywords ?? 5;
  const minLength = options?.minLength ?? 3;

  // 清理文本
  const cleaned = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')     // 去掉标点
    .replace(/\s+/g, ' ')          // 合并空格
    .trim();

  if (!cleaned) return [];

  const words = cleaned.split(' ').filter(w => w.length >= 2);
  if (words.length === 0) return [];

  const results = new Map<string, number>(); // keyword -> score

  // 策略1：2-4 词 n-gram，且包含词根库中的词
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      const gram = words.slice(i, i + n);

      // 修剪首尾纯语法词（去掉 "the xxx for" 这类句子碎片）
      let start = 0;
      while (start < gram.length && (EDGE_STOP_WORDS.has(gram[start]) || NOISE_WORDS.has(gram[start]))) start++;
      let end = gram.length;
      while (end > start && EDGE_STOP_WORDS.has(gram[end - 1])) end--;
      const trimmed = gram.slice(start, end);

      // 修剪后至少 2 个词才算候选
      if (trimmed.length < 2) continue;

      // 去掉连续重复词（如 "skills skills"）
      const deduped: string[] = [];
      for (const w of trimmed) {
        if (deduped[deduped.length - 1] !== w) deduped.push(w);
      }
      if (deduped.length < 2) continue;

      const gramText = deduped.join(' ');

      // 检查是否包含词根
      const hasSeed = deduped.some(w => allSeeds.includes(w));

      // 检查是否全停用词
      const allStop = deduped.every(w => STOP_WORDS.has(w));

      if (allStop) continue;

      // 词根匹配的 gram 得分更高
      const score = hasSeed ? 3 : 1;

      // 长度过滤
      if (gramText.length < minLength) continue;

      const existing = results.get(gramText);
      if (!existing || existing < score) {
        results.set(gramText, score);
      }
    }
  }

  // 策略2：包含词根的短语优先，其次是长短语
  const sorted = [...results.entries()]
    .sort((a, b) => {
      // 先按分数降序
      if (b[1] !== a[1]) return b[1] - a[1];
      // 再按长度降序（更具体的词优先）
      return b[0].length - a[0].length;
    })
    .map(([kw]) => kw)
    .slice(0, maxKeywords);

  return sorted;
}

/**
 * n-gram 提取器插件
 * 将数据源条目转换为候选词（出现频次越高，模拟增长幅度越大）
 */
export const ngramExtractor: ExtractorPlugin = {
  type: 'extractor',
  name: 'ngram',
  extract(items: SourceItem[]): TrendingKeyword[] {
    const seen = new Map<string, { count: number; source: string; score: number }>();

    for (const item of items) {
      const keywords = extractKeywordsFromText(item.title, { maxKeywords: 5 });

      for (const kw of keywords) {
        const existing = seen.get(kw);
        if (existing) {
          existing.count++;
          existing.score += item.score || 0;
        } else {
          seen.set(kw, { count: 1, source: item.source, score: item.score || 0 });
        }
      }
    }

    // 转换并排序：出现频次 > 热度分数
    const candidates: TrendingKeyword[] = [...seen.entries()]
      .map(([keyword, v]) => ({
        keyword,
        seedWord: v.source,
        source: v.source,
        trendType: 'rising' as const,
        growthPercent: Math.min(9900, v.count * 900), // 频次 × 900 模拟增长幅度
        discoveredAt: new Date(),
      }))
      .sort((a, b) => {
        const scoreA = seen.get(a.keyword)?.score || 0;
        const scoreB = seen.get(b.keyword)?.score || 0;
        return scoreB - scoreA;
      });

    return candidates;
  },
};
