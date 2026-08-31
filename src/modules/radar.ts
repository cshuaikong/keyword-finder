/**
 * 常驻雷达调度器（双环架构）
 *
 * 内环·找词环（轻量，每日）：
 *   ① getSeedsByDate 日期轮换取词根（每日 2 个，24 词根 12 天轮完）
 *   ② SerpAPI RELATED_QUERIES 飙升词（≤2 credits，3 天缓存兜底）
 *   ③ Google Suggest 免费挖掘（0 额度，词根递进 + 前缀模式）
 *   ④ 新词去重 → upsertRadarWord 轻量入库（volume_level=unknown）
 *
 * 外环·验证环（批量，每周）：
 *   ① queryUnverifiedWords 取未验证词（证据优先级排序）
 *   ② getVolumeAndTrend 验证量级（缓存命中 0 额度，未命中 1 credit/词）
 *   ③ updateWordVolume 回写 words 表
 *
 * 额度预算（SerpAPI 免费 100/月）：
 *   内环 2 credits/天 ≈ 60/月 + 外环 5 词/周 ≈ 20/月 ≈ 80/月，留 20 余量
 */

import chalk from 'chalk';
import { config } from '../config.js';
import { getSeedsByDate } from '../seeds.js';
import { findTrendingKeywords, getVolumeAndTrend } from './trends.js';
import { suggestMine } from './suggest.js';
import { runGameRadar } from './game-radar.js';
import {
  upsertRadarWord,
  queryUnverifiedWords,
  updateWordVolume,
  markWordValidationFailed,
  insertRadarRun,
  recordKeywordSignals,
  getApiBudget,
  recordValidationHistory,
  cancelKeywordReviews,
  scheduleKeywordReview,
} from '../core/db.js';

/** 延迟函数，用于限流 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 内环入库预筛：过滤明显噪声词
 * - 超长短语（歌词/句子串词）不要
 * - 非英文/特殊字符词不要
 * SerpAPI 飙升词不受此限制（Google 已筛过一轮）
 */
function isViableKeyword(keyword: string): boolean {
  const k = keyword.trim();
  if (k.length < 4 || k.length > 60) return false;
  if (k.split(/\s+/).length > 6) return false;
  if (!/^[a-z0-9\s'\-:.!?]+$/i.test(k)) return false;
  return true;
}

/** 内环单次运行统计 */
export interface InnerLoopResult {
  seeds: string[];
  found: number;   // 本轮发现（去重后）
  created: number; // 新入库词数
  steamGames: number; // 本轮新捕获的 Steam 游戏数
}

/**
 * 内环：找词（轻量，每日运行）
 * SerpAPI 飙升词（额度引擎）+ Google Suggest（免费引擎）合并去重入库
 */
export async function runInnerLoop(date: Date = new Date()): Promise<InnerLoopResult> {
  const started = Date.now();
  const seeds = getSeedsByDate(date, config.radarSeedsPerDay, 'game');
  console.log(chalk.cyan(`\n🛰 [内环·找词] 今日词根: ${seeds.join(' | ')}\n`));

  // keyword -> source（同一词被两个引擎都发现时，保留信号更强的来源）
  const seen = new Map<string, string>();
  const signals: Array<{ keyword: string; source: string; seed?: string; strength?: number; metadata?: Record<string, unknown> }> = [];

  // ① SerpAPI 飙升词（额度引擎，≤ radarSeedsPerDay credits）
  const trending = await findTrendingKeywords(seeds);
  for (const k of trending) {
    const key = k.keyword.toLowerCase().trim();
    const source = k.trendType === 'breakout' ? 'trends:breakout' : 'trends';
    if (key) signals.push({
      keyword: key,
      source,
      seed: k.seedWord,
      strength: k.trendType === 'breakout' ? 100 : 80,
      metadata: { growthPercent: k.growthPercent },
    });
    if (key && !seen.has(key)) {
      seen.set(key, source);
    }
  }

  // ② Google Suggest 免费挖掘（0 额度引擎）
  // 泛词根只用前缀模式（12 请求）：完整字符递进会挖出海量噪声长尾，
  // 那是游戏名定向挖掘（L4 需求挖掘阶段）的事，不归内环
  console.log(chalk.gray('  ⛏ 免费引擎: Google Suggest 前缀模式...'));
  for (const seed of seeds) {
    const list = await suggestMine(seed, config.suggestDelay, { patternsOnly: true });
    let added = 0;
    for (const k of list) {
      const key = k.keyword.toLowerCase().trim();
      // suggest 来源过噪声预筛，SerpAPI 词不受限
      if (key && isViableKeyword(key)) {
        signals.push({ keyword: key, source: 'suggest', seed });
        if (!seen.has(key)) {
          seen.set(key, 'suggest');
          added++;
        }
      }
    }
    console.log(chalk.gray(`    [${seed}] suggest 挖到 ${list.length} 个长尾（预筛入库 ${added}）`));
  }

  // ③ 游戏优先雷达：三类 Steam 列表全部入持久化队列，再限量消费扩词。
  let steamGames = 0;
  try {
    const gameResult = await runGameRadar(config.gameAnalysisBatch);
    steamGames = gameResult.created;
  } catch (err: any) {
    console.log(chalk.gray(`    游戏雷达失败（跳过，不影响通用找词）: ${err?.message || err}`));
  }

  // ④ 轻量入库
  let created = 0;
  for (const [key, source] of seen) {
    const r = upsertRadarWord(key, source);
    if (r.created) created++;
  }
  recordKeywordSignals(signals);

  const duration = Date.now() - started;
  insertRadarRun('radar-inner', seeds, seen.size, created, duration);

  console.log(chalk.green(`\n✅ 内环完成: 发现 ${seen.size} 词（新词 ${created}），新游戏 ${steamGames}，耗时 ${(duration / 1000).toFixed(0)}s`));
  return { seeds, found: seen.size, created, steamGames };
}

/**
 * 外环：验证（批量，每周运行）
 * 队列来自 queryUnverifiedWords（跨源、强度、新鲜度综合优先），
 * getVolumeAndTrend 内部命中缓存则 0 额度
 */
export async function runOuterLoop(
  batch: number = config.radarVerifyBatch,
): Promise<{ verified: number; noData: number; failed: number; fromCache: number }> {
  const started = Date.now();
  const budget = getApiBudget('serpapi', config.serpapiMonthlyBudget, config.serpapiReserve);
  const effectiveBatch = Math.min(batch, budget.spendableRemaining);
  const queue = queryUnverifiedWords(effectiveBatch);
  console.log(chalk.cyan(`\n🔬 [外环·验证] 队列 ${queue.length} 词（证据优先级排序）`));
  console.log(chalk.gray(`  SerpAPI 预算: 已用 ${budget.used}/${budget.monthlyBudget}，可自动使用 ${budget.spendableRemaining}，保留 ${budget.reserve}`));

  if (queue.length === 0) {
    console.log(chalk.gray(effectiveBatch === 0 ? '  自动预算已用尽，本轮不发起付费验证' : '  队列为空，无需验证'));
    insertRadarRun('radar-outer', [], 0, 0, Date.now() - started);
    return { verified: 0, noData: 0, failed: 0, fromCache: 0 };
  }

  let verified = 0;
  let noData = 0;
  let failed = 0;
  let fromCache = 0;

  for (let i = 0; i < queue.length; i++) {
    const word = queue[i];
    const v = await getVolumeAndTrend(word.keyword); // 内部命中缓存则 0 额度
    const evidence = {
      dimension: 'volume' as const,
      status: v.status === 'failed' ? 'failed' as const
        : v.fromCache ? 'cached' as const
        : v.status === 'no-data' ? 'no-data' as const : 'success' as const,
      confidence: v.status === 'failed' ? 0 : v.status === 'no-data' ? 60 : v.fromCache ? 90 : 100,
      fromCache: v.fromCache,
      checkedAt: new Date(),
      result: v,
      error: v.status === 'failed' ? '量级服务请求失败或预算不足' : undefined,
    };
    if (v.status === 'failed') {
      failed++;
      markWordValidationFailed(word.keyword);
    } else {
      updateWordVolume(word.keyword, v);
      if (v.status === 'success') verified++;
      else noData++;
    }
    if (v.fromCache) fromCache++;
    const confidence = recordValidationHistory(word.keyword, [evidence]);
    cancelKeywordReviews(word.keyword);
    if (v.status === 'failed') {
      scheduleKeywordReview(word.keyword, 'volume', '搜索量验证失败', 1);
    } else if (v.status === 'no-data') {
      scheduleKeywordReview(word.keyword, 'volume', '搜索量暂无数据，等待再次确认', 7);
    } else if (confidence.score < 70) {
      scheduleKeywordReview(word.keyword, 'full', '量级已确认，等待完整验证', 3);
    }

    const cacheTag = v.fromCache ? ' [缓存]' : '';
    const statusTag = v.status === 'failed' ? '失败，等待重试' : v.status === 'no-data' ? '无数据' : '成功';
    console.log(
      `  [${i + 1}/${queue.length}] ${word.keyword} (优先级 ${word.priority_score ?? 0}) → ${v.volumeLevel} (avg ${v.volumeAvg ?? '?'}) ${v.trendDirection} [${statusTag}]${cacheTag}`,
    );

    if (i < queue.length - 1) await sleep(1000); // 外环限流
  }

  const duration = Date.now() - started;
  insertRadarRun('radar-outer', [], queue.length, verified + noData, duration);

  console.log(chalk.green(`\n✅ 外环完成: 成功 ${verified}，无数据 ${noData}，失败 ${failed}，缓存命中 ${fromCache}，耗时 ${(duration / 1000).toFixed(0)}s`));
  return { verified, noData, failed, fromCache };
}
