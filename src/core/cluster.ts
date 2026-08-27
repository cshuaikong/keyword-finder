/**
 * 关键词聚类（框架内置处理环节）
 * 把共享 2+ 个有效词的词归为一簇，供报告"主题簇"展示
 * 从原 modules/report.ts 迁移而来
 */

import type { ValidatedKeyword } from '../types.js';

/** 停用词（聚类时忽略） */
const CLUSTER_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'of', 'in', 'on',
  'game', 'games', 'free', 'online', 'best', 'top', 'how', 'what', 'is',
  'your', 'my', 'new', 'play', 'ai',
]);

/**
 * 关键词聚类：把共享 2+ 个有效词的词归为一簇
 * 返回主题簇列表
 */
export function clusterKeywords(keywords: ValidatedKeyword[]): Array<{ theme: string; keywords: string[] }> {
  const items = keywords.map(kw => ({
    text: kw.keyword,
    words: kw.keyword.toLowerCase().split(/\s+/).filter(w =>
      w.length >= 2 && !CLUSTER_STOP_WORDS.has(w)
    ),
  }));

  const clusters: Array<{ theme: string; keywords: string[] }> = [];
  const used = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    if (used.has(items[i].text)) continue;

    const clusterWords = new Set(items[i].words);
    const clusterKeywords = [items[i].text];
    used.add(items[i].text);

    // 找与当前簇共享 2+ 词的词
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(items[j].text)) continue;

      const shared = items[j].words.filter(w => clusterWords.has(w));
      if (shared.length >= 2) {
        clusterKeywords.push(items[j].text);
        items[j].words.forEach(w => clusterWords.add(w));
        used.add(items[j].text);
      }
    }

    // 至少 2 个词才算簇
    if (clusterKeywords.length >= 2) {
      clusters.push({
        theme: clusterKeywords[0].toUpperCase(),
        keywords: clusterKeywords,
      });
    }
  }

  return clusters;
}
