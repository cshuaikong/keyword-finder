import type { SourcePlugin } from '../../core/plugin.js';
import { pollTrendingNow } from '../../modules/trending-now.js';

export const trendingNowSource: SourcePlugin = {
  type: 'source', name: 'trending-now', needsSeeds: false,
  async fetch(ctx) {
    if (ctx.category === 'ai') return { candidates: [] };
    try {
      return { candidates: (await pollTrendingNow()).candidates };
    } catch (err) {
      console.warn('[Trending Now] 来源暂不可用:', err instanceof Error ? err.message : String(err));
      return { candidates: [] };
    }
  },
};
