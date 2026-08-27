/**
 * 标准评分器插件
 * 综合趋势/竞争/域名/词形四个维度计算 0-100 评分
 * 从原 modules/validator.ts 的 calculateScore 迁移而来
 */

import type { ScorerPlugin } from '../../core/plugin.js';

/**
 * 计算综合评分
 *   - 趋势分 (0-30)：优先真实 Google Trends 趋势方向，查不到时退回来源信号
 *   - 竞争分 (0-30)：低竞争=30，中=15，高=5
 *   - 域名分 (0-20)：可注册=20
 *   - 词形分 (0-20)：2-4 词最佳，语法碎片严重扣分
 *   - 量级门槛：unknown（查不到搜索量）扣 30，D 级（量级过低）扣 15
 */
export const standardScorer: ScorerPlugin = {
  type: 'scorer',
  name: 'standard-scorer',
  score(keyword, analyzed) {
    // 趋势分 (0-30)
    let trendScore = 0;
    const td = analyzed.volume?.trendDirection;
    if (td === 'up' || td === 'new') {
      // 真实搜索量向上 / 全新词（哥飞方法论最看重的信号）
      trendScore = 25;
    } else if (td === 'stable') {
      trendScore = 10;
    } else if (td === 'down') {
      trendScore = 0;
    } else {
      // 无 Trends 数据：退回来源信号（上限 20，弱于真实数据）
      if (keyword.trendType === 'breakout') {
        trendScore = 30;
      } else {
        const percent = keyword.growthPercent || 0;
        trendScore = Math.min(20, Math.round(percent / 1000 * 10));
      }
    }

    // 竞争分 (0-30)
    const difficulty = analyzed.competition?.difficulty ?? 'medium';
    let competitionScore = 0;
    switch (difficulty) {
      case 'low':
        competitionScore = 30;
        break;
      case 'medium':
        competitionScore = 15;
        break;
      case 'high':
        competitionScore = 5;
        break;
    }

    // 域名分 (0-20)
    const domainScore = analyzed.domain?.anyAvailable ? 20 : 0;

    // 词形质量分 (0-20)
    // 2-4个单词最理想，太长太短都不好；首尾是语法词/含连续重复词的碎片词严重扣分
    const words = keyword.keyword.split(' ').filter(w => w.length > 0);
    const wordCount = words.length;
    let lengthScore = 0;
    if (wordCount >= 2 && wordCount <= 4) {
      lengthScore = 20;
    } else if (wordCount === 1 || wordCount === 5) {
      lengthScore = 10;
    } else {
      lengthScore = 5;
    }

    // 结尾是语法词（from/to/in/of/that/and...）→ 句子碎片，扣 15 分
    const END_GRAMMAR = new Set([
      'from', 'to', 'in', 'of', 'for', 'that', 'and', 'with', 'on', 'a', 'an', 'the',
      'at', 'by', 'or', 'as', 'is', 'are', 'via', 'per', 'vs', 'it', 'its', 'this',
      'these', 'those', 'which', 'who', 'your', 'their', 'his', 'her',
    ]);
    if (END_GRAMMAR.has(words[words.length - 1])) {
      lengthScore = Math.max(0, lengthScore - 15);
    }

    // 开头是冠词/连词 → 扣 8 分
    const START_GRAMMAR = new Set([
      'a', 'an', 'the', 'and', 'or', 'for', 'with', 'to', 'of', 'in', 'on',
      'that', 'is', 'are', 'this', 'these', 'those',
    ]);
    if (START_GRAMMAR.has(words[0])) {
      lengthScore = Math.max(0, lengthScore - 8);
    }

    // 含连续重复词（如 "skills skills"）→ 扣 10 分
    for (let i = 1; i < words.length; i++) {
      if (words[i] === words[i - 1]) {
        lengthScore = Math.max(0, lengthScore - 10);
        break;
      }
    }

    let score = trendScore + competitionScore + domainScore + lengthScore;

    // 量级门槛（哥飞方法论硬指标）：搜索量是第一道门槛，没有量级其他维度再好也没用
    // unknown（查不到搜索量）：总分硬上限 39 → 强制落入"放弃"区，不进推荐
    // D 级（量级过低）：扣 20 分
    const volLevel = analyzed.volume?.volumeLevel ?? 'unknown';
    if (volLevel === 'unknown') {
      score = Math.min(score, 39);
    } else if (volLevel === 'D') {
      score = Math.max(0, score - 20);
    }

    return {
      score,
      breakdown: { trendScore, competitionScore, domainScore, lengthScore },
    };
  },
};
