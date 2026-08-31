/**
 * 控制台摘要输出（框架内置输出）
 * 从原 index.ts 的 printSummary 迁移而来
 */

import chalk from 'chalk';
import type { FindResult } from '../types.js';

/** 推荐门槛：只有通过量级门槛（评分≥40，非 unknown 量级）的词才值得推荐 */
const RECOMMEND_MIN_SCORE = 40;

/**
 * 输出结果摘要
 */
export function printSummary(result: FindResult): void {
  console.log('');
  console.log(chalk.cyan('═══════════════════════════════════════════'));
  console.log(chalk.cyan('  📊 找词结果摘要'));
  console.log(chalk.cyan('═══════════════════════════════════════════'));
  console.log('');
  console.log(`  候选词: ${result.candidates.length} 个`);
  console.log(`  已验证: ${result.validated.length} 个`);
  console.log(`  耗时:   ${(result.duration / 1000).toFixed(1)}s`);
  console.log('');

  // Top 5 推荐（只推通过量级门槛的词）
  const recommendable = result.validated.filter(k => k.score >= RECOMMEND_MIN_SCORE && k.confidenceScore >= 70);
  const top5 = recommendable.slice(0, 5);
  if (top5.length > 0) {
    console.log(chalk.green('  🏆 Top 5 推荐词:'));
    console.log('');
    top5.forEach((kw, i) => {
      const trend = kw.trendType === 'breakout' ? '🔥Breakout' : `📈+${(kw.growthPercent || 0).toLocaleString()}%`;
      const domain = kw.domainAvailable ? kw.availableDomains[0] : '域名已注册';
      const zh = kw.intel.chineseMeaning ? ` | ${kw.intel.chineseMeaning}` : '';
      const vol = kw.intel.volumeLevel === 'unknown' ? '量级:?' : `量级:${kw.intel.volumeLevel}`;
      const trendDir = kw.intel.trendDirection === 'up' ? '📈上升' : kw.intel.trendDirection === 'new' ? '✨新词' : kw.intel.trendDirection === 'stable' ? '➡️平稳' : kw.intel.trendDirection === 'down' ? '📉下降' : '趋势:?';
      console.log(`  ${i + 1}. ${chalk.bold(kw.keyword)}${kw.intel.brandRisk ? chalk.yellow(' ⚠品牌') : ''} (评分: ${kw.score}，置信度: ${kw.confidenceScore}%)${zh}`);
      console.log(`     ${trend} | 竞争: ${kw.competition.difficulty} | ${vol} | ${trendDir} | 难度:${kw.intel.devDifficulty} | ${domain}`);
    });
    console.log('');
  } else {
    console.log(chalk.gray('  🏆 本轮无通过量级门槛的推荐词（未配置 SerpAPI 时量级数据缺失，所有词不推荐）'));
    console.log('');
  }

  // 域名可注册的词（排除品牌词 + 通过量级门槛）
  const availableOnes = result.validated.filter(k => k.domainAvailable && !k.intel.brandRisk && k.score >= RECOMMEND_MIN_SCORE && k.confidenceScore >= 70);
  if (availableOnes.length > 0) {
    console.log(chalk.green(`  ✅ 域名可注册的词: ${availableOnes.length} 个`));
    availableOnes.slice(0, 5).forEach(kw => {
      console.log(`     ${kw.keyword} → ${kw.availableDomains[0]}`);
    });
    console.log('');
  }

  // 低竞争的蓝海词（排除品牌词 + 通过量级门槛）
  const blueOcean = result.validated.filter(k => k.competition.difficulty === 'low' && !k.intel.brandRisk && k.score >= RECOMMEND_MIN_SCORE && k.confidenceScore >= 70);
  if (blueOcean.length > 0) {
    console.log(chalk.green(`  🌊 蓝海词（低竞争）: ${blueOcean.length} 个`));
    blueOcean.slice(0, 5).forEach(kw => {
      console.log(`     ${kw.keyword} (评分: ${kw.score})`);
    });
    console.log('');
  }
}
