import './src/proxy.js';
import { findTrendingKeywords } from './src/modules/trends.js';

async function main() {
  // A线演示：功能词根 → Google 飙升词 → 从中捞游戏候选
  const seeds = ['walkthrough', 'co-op game', 'new game'];
  const trending = await findTrendingKeywords(seeds);
  console.log('\n===== 汇总 =====');
  for (const k of trending) {
    const label = k.trendType === 'breakout' ? 'BREAKOUT' : `+${k.growthPercent}%`;
    console.log(`  [${k.seedWord}] ${k.keyword}  [${label}]`);
  }
}
main();
