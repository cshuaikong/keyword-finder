/**
 * 插件化 pipeline 编排引擎
 * 一次找词运行的完整流程，各环节通过注册表调用插件：
 *
 *   词根选取 → 数据源并行抓取 → 提取器 → 合并去重
 *   → 分析器四路并行（域名/竞品/量级/翻译）→ 评分器 → 情报组装
 *   → 排序 + 聚类 → 摘要输出 → 输出插件（报告/推送/存储）
 *
 * 逻辑与原 index.ts 的 runKeywordFinder 保持一致，仅改为插件驱动。
 */

import chalk from 'chalk';
import { config } from '../config.js';
import { getRandomSeeds } from '../seeds.js';
import { buildIntel, detectBrandRisk } from '../modules/assess.js';
import { registry } from './registry.js';
import { clusterKeywords } from './cluster.js';
import { printSummary } from './summary.js';
import { finishRun, recordKeywordSignals, recordRunStep, startRun } from './db.js';
import { calculateConfidence } from './confidence.js';
import type {
  RunContext,
  SourcePlugin,
  ExtractorPlugin,
  AnalyzerPlugin,
  ScorerPlugin,
  NotifierPlugin,
  AnalyzerResult,
} from './plugin.js';
import type {
  FindResult,
  ValidatedKeyword,
  TrendingKeyword,
  SourceItem,
} from '../types.js';

/** 合并去重多个候选词列表（保留出现最早的记录） */
function mergeCandidates(...lists: TrendingKeyword[][]): TrendingKeyword[] {
  const merged = new Map<string, TrendingKeyword>();

  for (const list of lists) {
    for (const candidate of list) {
      const key = candidate.keyword.toLowerCase().trim();
      if (!merged.has(key)) {
        merged.set(key, candidate);
      }
    }
  }

  return [...merged.values()];
}

/** 合并多个分析器的结果（各分析器贡献不同维度，互不重叠） */
function mergeAnalyzerResults(results: AnalyzerResult[]): AnalyzerResult {
  const merged: AnalyzerResult = {};
  for (const r of results) {
    if (r.evidence) merged.evidence = [...(merged.evidence || []), ...r.evidence];
    if (r.domain) merged.domain = r.domain;
    if (r.competition) merged.competition = r.competition;
    if (r.volume) merged.volume = r.volume;
    if (r.translation !== undefined) merged.translation = r.translation;
  }
  return merged;
}

/** 纯语法词尾巴（句子碎片特征） */
const GRAMMAR_TAIL = new Set([
  'from', 'to', 'in', 'of', 'for', 'that', 'and', 'with', 'on', 'a', 'an', 'the',
  'at', 'by', 'or', 'as', 'is', 'are', 'via', 'per', 'vs', 'it', 'its', 'this',
  'these', 'those', 'which', 'who', 'your', 'their', 'his', 'her', 'my', 'our',
]);

/**
 * 本地快速预筛（不消耗任何 API）：过滤明显噪声候选
 *   - 含数字（如 "gpt-image2 530 20"）
 *   - 词数 <2 或 >5（单词不成候选、超长是句子）
 *   - 语法词尾巴（如 "hermes-agent the"）
 *   - 品牌词（商标冲突，建站无意义）
 * 预筛后的候选词才有资格进入验证队列
 */
function quickPreFilter(candidates: TrendingKeyword[]): TrendingKeyword[] {
  return candidates.filter(c => {
    const kw = c.keyword.trim();
    if (!kw) return false;

    // 含数字 → 标题切片噪声
    if (/\d/.test(kw)) return false;

    const words = kw.split(/\s+/);
    if (words.length < 2 || words.length > 5) return false;

    // 语法词结尾 → 句子碎片
    if (GRAMMAR_TAIL.has(words[words.length - 1].toLowerCase())) return false;

    // 品牌词 → 商标冲突
    if (detectBrandRisk(kw)) return false;

    return true;
  });
}

/**
 * 跨源均衡采样：从每个数据源轮流各取 1 个，直到凑满验证配额
 * 解决"验证队列被单一高频源（如 GitHub）垄断"的问题
 */
function sampleAcrossSources(candidates: TrendingKeyword[], limit: number): TrendingKeyword[] {
  // 按 source 分组
  const bySource = new Map<string, TrendingKeyword[]>();
  for (const c of candidates) {
    const key = c.source || 'unknown';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(c);
  }

  // trends 源优先（哥飞方法论核心：搜索量飙升词），其余源保持出现顺序
  const sourceOrder = ['trends', ...([...bySource.keys()].filter(k => k !== 'trends'))];

  const picked: TrendingKeyword[] = [];
  let round = 0;
  while (picked.length < limit) {
    let added = false;
    for (const src of sourceOrder) {
      const list = bySource.get(src);
      if (list && round < list.length && picked.length < limit) {
        picked.push(list[round]);
        added = true;
      }
    }
    round++;
    if (!added) break; // 所有源都已取完
  }

  return picked;
}

/** 对单个指定关键词执行完整验证，供发现流程与定时复查共同复用。 */
export async function validateCandidate(
  candidate: TrendingKeyword,
  ctx: RunContext,
): Promise<{ validated: ValidatedKeyword; errors: string[] }> {
  const errors: string[] = [];
  const analyzers = registry.enabled<AnalyzerPlugin>('analyzer', config.disablePlugins);
  const scorer = registry.enabled<ScorerPlugin>('scorer', config.disablePlugins)[0];
  const analyzerResults = await Promise.allSettled(
    analyzers.map(analyzer => analyzer.analyze(candidate, ctx)),
  );
  const successfulResults: AnalyzerResult[] = [];
  analyzerResults.forEach((analyzerResult, index) => {
    if (analyzerResult.status === 'fulfilled') {
      successfulResults.push(analyzerResult.value);
    } else {
      const analyzer = analyzers[index];
      const message = analyzerResult.reason?.message || String(analyzerResult.reason);
      errors.push(`analyzer:${analyzer.name}:${candidate.keyword}: ${message}`);
      if (ctx.runId) recordRunStep(ctx.runId, `analyzer:${analyzer.name}`, 'failed', {
        error: `${candidate.keyword}: ${message}`,
      });
    }
  });

  const analyzed = mergeAnalyzerResults(successfulResults);
  const validationEvidence = analyzed.evidence || [];
  const confidence = calculateConfidence(validationEvidence);
  for (const evidence of validationEvidence.filter(item => item.status === 'failed')) {
    const message = evidence.error || `${evidence.dimension} 验证失败`;
    errors.push(`validation:${evidence.dimension}:${candidate.keyword}: ${message}`);
    if (ctx.runId) recordRunStep(ctx.runId, `validation:${evidence.dimension}`, 'failed', {
      error: `${candidate.keyword}: ${message}`,
    });
  }

  const domainResult = analyzed.domain ?? { available: [], taken: [], anyAvailable: false };
  const competition = analyzed.competition ?? {
    topDomains: [], hasAuthority: false, resultCount: 0, difficulty: 'medium' as const,
  };
  const { score, breakdown } = scorer
    ? scorer.score(candidate, analyzed, ctx)
    : { score: 0, breakdown: { trendScore: 0, competitionScore: 0, domainScore: 0, lengthScore: 0 } };
  const intel = buildIntel({
    keyword: candidate.keyword,
    chineseMeaning: analyzed.translation || '',
    volumeLevel: analyzed.volume?.volumeLevel ?? 'unknown',
    volumeAvg: analyzed.volume?.volumeAvg,
    trendDirection: analyzed.volume?.trendDirection ?? 'unknown',
    trendNote: analyzed.volume?.trendNote,
    score,
    domainAvailable: domainResult.anyAvailable,
    competition,
    confidenceScore: confidence.score,
  });

  return {
    errors,
    validated: {
      ...candidate,
      domainAvailable: domainResult.anyAvailable,
      availableDomains: domainResult.available,
      competition,
      score,
      scoreBreakdown: breakdown,
      intel,
      confidenceScore: confidence.score,
      confidenceLevel: confidence.level,
      validatedAt: new Date(),
      validationEvidence,
    },
  };
}

/**
 * 执行一次找词流程
 */
async function runPipelineInternal(
  category: 'game' | 'ai' | 'all',
  runId: number,
): Promise<{ result: FindResult; errors: string[] }> {
  const startTime = Date.now();
  const runAt = new Date();
  const errors: string[] = [];

  console.log(chalk.cyan('╔══════════════════════════════════════════╗'));
  console.log(chalk.cyan('║     🔑 自动找词工具 v2.0（插件化）       ║'));
  console.log(chalk.cyan('║     基于哥飞「找新词」方法论              ║'));
  console.log(chalk.cyan('╚══════════════════════════════════════════╝'));
  console.log('');

  // Step 1: 随机选取词根
  const seeds = getRandomSeeds(config.seedsPerRun, category);
  const ctx: RunContext = { category, seeds, startedAt: runAt, runId };
  console.log(chalk.yellow(`📌 本次选取 ${seeds.length} 个词根: ${seeds.join(', ')}`));

  // Step 2: 并行运行所有数据源插件（词根驱动 + 自发抓取）
  console.log(chalk.yellow('\n📡 并行抓取数据源...\n'));

  // 数据源禁用列表 = DISABLE_SOURCES（旧配置，向后兼容）+ DISABLE_PLUGINS（新配置）
  const sourceDisabled = [...config.disableSources, ...config.disablePlugins];
  const sources = registry.enabled<SourcePlugin>('source', sourceDisabled);

  const items: SourceItem[] = [];
  const trendsCandidates: TrendingKeyword[] = [];
  const stats: Record<string, number> = {};

  const sourceResults = await Promise.allSettled(
    sources.map(async (source) => {
      const out = await source.fetch(ctx);
      stats[source.name] = (out.candidates?.length || 0) + (out.items?.length || 0);
      return out;
    }),
  );

  for (let i = 0; i < sourceResults.length; i++) {
    const result = sourceResults[i];
    const source = sources[i];
    if (result.status === 'fulfilled') {
      if (result.value.candidates) trendsCandidates.push(...result.value.candidates);
      if (result.value.items) items.push(...result.value.items);
      recordRunStep(runId, `source:${source.name}`, 'succeeded', {
        itemCount: (result.value.candidates?.length || 0) + (result.value.items?.length || 0),
      });
    } else {
      const message = result.reason?.message || String(result.reason);
      errors.push(`source:${source.name}: ${message}`);
      recordRunStep(runId, `source:${source.name}`, 'failed', { error: message });
    }
  }

  console.log('');
  const sourceStats = Object.entries(stats)
    .map(([name, count]) => `${name}=${count}条`)
    .join(', ');
  console.log(chalk.gray(`  数据源统计: ${sourceStats || (sources.length === 0 ? '全部禁用' : '全部失败')}`));

  // Step 3: 提取器插件：原始条目 → 候选词
  let socialCandidates: TrendingKeyword[] = [];
  const extractors = registry.enabled<ExtractorPlugin>('extractor', config.disablePlugins);
  for (const extractor of extractors) {
    try {
      const extracted = extractor.extract(items, ctx);
      socialCandidates = socialCandidates.concat(extracted);
      recordRunStep(runId, `extractor:${extractor.name}`, 'succeeded', { itemCount: extracted.length });
    } catch (err: any) {
      const message = err?.message || String(err);
      errors.push(`extractor:${extractor.name}: ${message}`);
      recordRunStep(runId, `extractor:${extractor.name}`, 'failed', { error: message });
    }
  }
  console.log(chalk.gray(`  社交源提取: ${socialCandidates.length} 个候选词`));

  const discoveredSignals = [...trendsCandidates, ...socialCandidates];
  try {
    recordKeywordSignals(discoveredSignals.map(candidate => ({
      keyword: candidate.keyword,
      source: candidate.trendType === 'breakout' && candidate.source === 'trends'
        ? 'trends:breakout'
        : (candidate.source || 'unknown'),
      seed: candidate.seedWord,
      observedAt: candidate.discoveredAt,
      runId,
      metadata: {
        trendType: candidate.trendType,
        growthPercent: candidate.growthPercent,
      },
    })));
    recordRunStep(runId, 'signals', 'succeeded', { itemCount: discoveredSignals.length });
  } catch (err: any) {
    const message = err?.message || String(err);
    errors.push(`signals: ${message}`);
    recordRunStep(runId, 'signals', 'failed', { error: message });
  }

  // Step 4: 合并去重
  const candidates: TrendingKeyword[] = mergeCandidates(trendsCandidates, socialCandidates);
  console.log(chalk.yellow(`\n📊 合并后共 ${candidates.length} 个候选词`));

  if (candidates.length === 0) {
    console.log(chalk.red('\n❌ 未发现任何候选词，可能原因:'));
    console.log('   - Google Trends 限流（稍后重试）');
    console.log('   - 数据源全部失败（检查代理设置）');
    console.log('   - 当前词根没有相关飙升词');

    return { result: {
      runAt,
      seedsUsed: seeds,
      candidates: [],
      validated: [],
      duration: Date.now() - startTime,
    }, errors };
  }

  // Step 4.5: 本地预筛（不消耗 API）
  const preFiltered = quickPreFilter(candidates);
  console.log(chalk.gray(`  预筛后剩余 ${preFiltered.length} 个候选词（过滤 ${candidates.length - preFiltered.length} 个噪声）`));

  // Step 5: 验证候选词（分析器并行 → 评分器 → 情报组装）
  console.log(chalk.yellow(`\n🔬 开始验证前 ${config.verifyPerRun} 个候选词（跨源均衡采样）...\n`));

  const validated: ValidatedKeyword[] = [];
  const toValidate = sampleAcrossSources(preFiltered, config.verifyPerRun);
  let analyzerFailureCount = 0;

  for (let i = 0; i < toValidate.length; i++) {
    const candidate = toValidate[i];
    console.log(`[${i + 1}/${toValidate.length}] 验证: "${candidate.keyword}"`);

    const outcome = await validateCandidate(candidate, ctx);
    validated.push(outcome.validated);
    errors.push(...outcome.errors);
    analyzerFailureCount += outcome.errors.length;

    const item = outcome.validated;
    const scoreColor = item.score >= 60 ? chalk.green : item.score >= 40 ? chalk.yellow : chalk.red;
    const volLabel = item.intel.volumeLevel === 'unknown' ? '量级:?' : `量级:${item.intel.volumeLevel}`;
    console.log(`  → 评分: ${scoreColor(String(item.score))} | 置信度: ${item.confidenceScore}% | 竞争: ${item.competition.difficulty} | 域名: ${item.domainAvailable ? '✅' : '❌'} | ${volLabel} | ${item.intel.chineseMeaning || '—'}`);

    // 每个验证之间稍作等待
    if (i < toValidate.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Step 6: 排序 + 聚类
  validated.sort((a, b) => b.score - a.score);
  const clusters = clusterKeywords(validated);

  const result: FindResult = {
    runAt,
    seedsUsed: seeds,
    candidates,
    validated,
    clusters,
    duration: Date.now() - startTime,
  };

  // Step 7: 控制台摘要
  printSummary(result);

  // Step 8: 输出插件（报告生成 / Telegram 推送 / 数据库存储）
  const notifiers = registry.enabled<NotifierPlugin>('notifier', config.disablePlugins);
  for (const notifier of notifiers) {
    const startedAt = new Date();
    try {
      await notifier.notify(result, ctx);
      recordRunStep(runId, `output:${notifier.name}`, 'succeeded', {
        itemCount: result.validated.length,
        startedAt,
      });
    } catch (err: any) {
      const message = err?.message || String(err);
      errors.push(`output:${notifier.name}: ${message}`);
      recordRunStep(runId, `output:${notifier.name}`, 'failed', { error: message, startedAt });
      console.log(chalk.yellow(`  ⚠ 输出插件 ${notifier.name} 失败，其他输出继续执行`));
    }
  }

  if (analyzerFailureCount === 0) {
    recordRunStep(runId, 'analysis', 'succeeded', { itemCount: validated.length });
  }

  return { result, errors };
}

/** 公开入口：任何空结果、部分失败或异常都会留下持久化运行记录。 */
export async function runPipeline(category: 'game' | 'ai' | 'all' = 'all'): Promise<FindResult> {
  const started = Date.now();
  const runId = startRun(category);
  try {
    const { result, errors } = await runPipelineInternal(category, runId);
    finishRun(runId, errors.length > 0 ? 'partial' : 'succeeded', {
      seeds: result.seedsUsed,
      candidates: result.candidates.length,
      validated: result.validated.length,
      durationMs: Date.now() - started,
      error: errors.length > 0 ? errors.join('\n').slice(0, 4000) : undefined,
    });
    return result;
  } catch (err: any) {
    const message = err?.message || String(err);
    recordRunStep(runId, 'pipeline', 'failed', { error: message });
    finishRun(runId, 'failed', { durationMs: Date.now() - started, error: message });
    throw err;
  }
}
