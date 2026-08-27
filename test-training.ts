import './src/proxy.js';
import { findTrendingKeywords, getVolumeAndTrend } from './src/modules/trends.js';

async function main() {
  const seeds = ["soul's remnant", 'sandustry', 'grain rot'];
  for (const s of seeds) {
    console.log(`\n========== ${s} ==========`);
    try {
      const v = await getVolumeAndTrend(s);
      console.log('VOLUME →', JSON.stringify(v));
    } catch (e: any) {
      console.log('VOLUME → ERR', e?.message ?? e);
    }
    try {
      const trending = await findTrendingKeywords([s]);
      for (const k of trending) {
        const label = k.trendType === 'breakout' ? 'BREAKOUT' : `+${k.growthPercent}%`;
        console.log(`  ${k.keyword}  [${label}]`);
      }
      if (trending.length === 0) console.log('  (no trending words)');
    } catch (e: any) {
      console.log('TREND → ERR', e?.message ?? e);
    }
  }
}
main();
