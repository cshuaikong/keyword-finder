/** 游戏优先雷达：发现游戏 → 入持久化队列 → 初筛机会 → 扩展真实搜索需求。 */

import chalk from 'chalk';
import { config } from '../config.js';
import {
  completeGameAnalysis,
  failGameAnalysis,
  markGameAnalyzing,
  queryPendingGames,
  recordGameKeywords,
  recordKeywordSignals,
  upsertGameCandidate,
  upsertRadarWord,
  type GameLifecycle,
  type GameRow,
} from '../core/db.js';
import { discoverSteamGames, type SteamDiscoveryChannel } from './steam-newreleases.js';
import { suggestMine } from './suggest.js';
import { analyzeCompetition } from '../plugins/analyzers/competition.js';

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function deriveGameLifecycle(releaseDate: string | undefined, channel: SteamDiscoveryChannel, now = new Date()): GameLifecycle {
  if (!releaseDate) return channel === 'new-releases' ? 'launched' : 'upcoming';
  const release = new Date(`${releaseDate}T00:00:00Z`);
  const days = Math.ceil((release.getTime() - now.getTime()) / 86_400_000);
  if (days > 14) return 'upcoming';
  if (days >= 0) return 'prelaunch';
  return 'launched';
}

function intentOf(keyword: string): string {
  if (/crash|error|fix|settings|performance|fps|save|controller|steam deck|ultrawide/i.test(keyword)) return 'technical';
  if (/achievement|trophy|unlock/i.test(keyword)) return 'achievement';
  if (/collect|location|where|relic|blade|charm|point/i.test(keyword)) return 'collectible';
  if (/puzzle|door|symbol|mirror|temple|maze|solution/i.test(keyword)) return 'puzzle';
  if (/ending|story|lore|character|explained/i.test(keyword)) return 'story';
  if (/walkthrough|chapter|guide|how to|boss|best|tips/i.test(keyword)) return 'guide';
  return 'other';
}

function scoreLifecycle(game: GameRow, now = new Date()): number {
  if (!game.release_date) return game.lifecycle_status === 'upcoming' ? 55 : 60;
  const release = new Date(`${game.release_date}T00:00:00Z`);
  const days = Math.ceil((release.getTime() - now.getTime()) / 86_400_000);
  if (days >= -7 && days <= 14) return 100;
  if (days > 14 && days <= 60) return 85;
  if (days > 60 && days <= 180) return 65;
  if (days < -7 && days >= -30) return 75;
  if (days < -30 && days >= -90) return 45;
  return 30;
}

async function analyzeGameCompetition(title: string): Promise<{
  score: number;
  verified: boolean;
  domains: string[];
  authorityDomains: string[];
  failedQueries: number;
}> {
  const strongDomains = [
    'wikipedia.org', 'youtube.com', 'reddit.com', 'ign.com', 'gamesradar.com',
    'gamerant.com', 'game8.co', 'gamepressure.com', 'powerpyx.com', 'neoseeker.com',
    'mobalytics.gg', 'gamespot.com', 'xboxachievements.com', 'trueachievements.com',
    'playstationtrophies.org', 'fandom.com', 'steamcommunity.com', 'pcgamer.com',
  ];
  const queries = [
    `"${title}"`,
    `"${title}" guide walkthrough`,
    `"${title}" wiki collectibles`,
  ];
  const domains = new Set<string>();
  const authorityDomains = new Set<string>();
  let highDifficultyQueries = 0;
  let successfulQueries = 0;
  let failedQueries = 0;
  for (const query of queries) {
    try {
      const result = await analyzeCompetition(query);
      if (result.topDomains.length > 0) successfulQueries++;
      if (result.difficulty === 'high') highDifficultyQueries++;
      for (const domain of result.topDomains) domains.add(domain);
      for (const domain of result.topDomains) {
        if (strongDomains.some(strong => domain === strong || domain.endsWith(`.${strong}`))) authorityDomains.add(domain);
      }
    } catch {
      failedQueries++;
    }
  }
  if (successfulQueries === 0) {
    return { score: 50, verified: false, domains: [], authorityDomains: [], failedQueries };
  }
  // 这是“可进入程度”：强站/高难查询越多，分数越低。
  const score = clamp(82 - highDifficultyQueries * 12 - authorityDomains.size * 3 - Math.max(0, domains.size - 8));
  return {
    score,
    verified: true,
    domains: [...domains].slice(0, 20),
    authorityDomains: [...authorityDomains].slice(0, 20),
    failedQueries,
  };
}

export interface GameRadarResult {
  discoveredRows: number;
  created: number;
  queued: number;
  processed: number;
  failed: number;
  keywords: number;
  sourceErrors: string[];
}

/** 抓取全部列表并完整入库。batch 只限制后续分析消费量。 */
export async function runGameRadar(batch = config.gameAnalysisBatch): Promise<GameRadarResult> {
  console.log(chalk.cyan('\n🎮 [游戏雷达] Steam 新发售 + 即将发售 + 热门即将发售'));
  const discovery = await discoverSteamGames();
  let created = 0;
  const unique = new Set<string>();
  for (const item of discovery.games) {
    unique.add(item.appid);
    const lifecycle = deriveGameLifecycle(item.releaseDate, item.channel);
    const result = upsertGameCandidate({
      source: 'steam',
      externalId: item.appid,
      title: item.title,
      channel: item.channel,
      sourceUrl: item.sourceUrl,
      releaseDate: item.releaseDate,
      platforms: item.platforms,
      lifecycleStatus: lifecycle,
      priority: item.priority + (lifecycle === 'prelaunch' ? 10 : lifecycle === 'launched' ? 5 : 0),
      metadata: { steamChannel: item.channel },
    });
    if (result.created) created++;
  }
  console.log(chalk.gray(`  候选入库: ${unique.size} 款（新建 ${created}），来源错误 ${discovery.errors.length}`));
  for (const error of discovery.errors) console.log(chalk.yellow(`    ⚠ ${error}`));

  const queue = queryPendingGames(Math.max(0, batch));
  let processed = 0;
  let failed = 0;
  let keywords = 0;
  for (const game of queue) {
    markGameAnalyzing(game.id);
    try {
      console.log(chalk.gray(`  分析 [${game.lifecycle_status}] ${game.title}`));
      const suggestions = await suggestMine(game.title, config.suggestDelay, { patternsOnly: true });
      const valid = suggestions
        .map(item => item.keyword.toLowerCase().trim())
        .filter(keyword => keyword.length >= 4 && keyword.length <= 100);
      const uniqueKeywords = [...new Set(valid)];
      const keywordRows = uniqueKeywords.map(keyword => ({ keyword, source: 'steam:suggest', intent: intentOf(keyword) }));
      recordGameKeywords(game.id, keywordRows);
      for (const item of keywordRows) upsertRadarWord(item.keyword, item.source);
      recordKeywordSignals(keywordRows.map(item => ({
        keyword: item.keyword,
        source: item.source,
        seed: game.title,
        strength: 70,
        metadata: { gameId: game.id, appid: game.external_id, intent: item.intent },
      })));

      const sourceCount = game.source_count || 1;
      const intentCount = new Set(keywordRows.map(item => item.intent)).size;
      const competitors = await analyzeGameCompetition(game.title);
      const demand = clamp(game.priority * 0.72 + sourceCount * 6);
      const momentum = clamp(35 + sourceCount * 15 + (game.lifecycle_status === 'prelaunch' ? 15 : game.lifecycle_status === 'launched' ? 10 : 0));
      const content = clamp(30 + Math.min(45, uniqueKeywords.length * 2) + Math.min(20, intentCount * 4));
      const competition = competitors.score;
      const lifecycle = scoreLifecycle(game);
      const opportunity = clamp(demand * 0.30 + momentum * 0.20 + content * 0.20 + competition * 0.20 + lifecycle * 0.10);
      const confidence = clamp(35 + sourceCount * 12 + (uniqueKeywords.length >= 5 ? 15 : uniqueKeywords.length > 0 ? 8 : 0) + (competitors.verified ? 12 : 0));
      completeGameAnalysis(game.id, {
        demand, momentum, content, competition, lifecycle, opportunity, confidence,
        keywordCount: uniqueKeywords.length,
        metadata: {
          intentCount,
          sourceCount,
          scoringVersion: 1,
          competitionStatus: competitors.verified ? 'verified' : 'unverified',
          competitors: competitors.domains,
          authorityCompetitors: competitors.authorityDomains,
          failedCompetitionQueries: competitors.failedQueries,
        },
      });
      processed++;
      keywords += uniqueKeywords.length;
      console.log(chalk.gray(`    ${uniqueKeywords.length} 词 | 机会 ${opportunity} | 置信度 ${confidence}`));
    } catch (error: any) {
      failed++;
      failGameAnalysis(game.id, error?.message || String(error));
      console.log(chalk.yellow(`    分析失败，已进入重试队列: ${error?.message || error}`));
    }
  }
  console.log(chalk.green(`✅ 游戏雷达完成: 队列 ${queue.length}，完成 ${processed}，失败 ${failed}，扩词 ${keywords}`));
  return {
    discoveredRows: discovery.games.length,
    created,
    queued: queue.length,
    processed,
    failed,
    keywords,
    sourceErrors: discovery.errors,
  };
}
