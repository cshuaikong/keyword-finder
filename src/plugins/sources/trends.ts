/**
 * Google Trends 数据源插件
 * 由词根驱动：查询每个词根的相关飙升词
 * 引擎实现在 modules/trends.ts（findTrendingKeywords），此处为插件适配
 */

import { findTrendingKeywords } from '../../modules/trends.js';
import type { SourcePlugin } from '../../core/plugin.js';

export const trendsSource: SourcePlugin = {
  type: 'source',
  name: 'trends',
  needsSeeds: true,
  async fetch(ctx) {
    const candidates = await findTrendingKeywords(ctx.seeds);
    return { candidates };
  },
};
