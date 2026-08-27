import './src/proxy.js';
import { findTrendingKeywords, getVolumeAndTrend } from './src/modules/trends.js';

async function main() {
  // 维度③：量级 + 飙升词
  const v = await getVolumeAndTrend('nodus fall');
  console.log('VOLUME →', JSON.stringify(v));
  const trending = await findTrendingKeywords(['nodus fall']);
  for (const k of trending) {
    const label = k.trendType === 'breakout' ? 'BREAKOUT' : `+${k.growthPercent}%`;
    console.log(`  ${k.keyword}  [${label}]`);
  }
  if (trending.length === 0) console.log('  (no trending words)');
}
main();
