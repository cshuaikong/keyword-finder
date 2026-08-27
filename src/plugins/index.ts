/**
 * 内置插件清单
 * 所有内置插件在此注册（按执行顺序排列）
 * 新增插件 = 在对应目录新建文件 + 加入此列表
 * 禁用插件 = 在 .env 中配置 DISABLE_PLUGINS=插件名1,插件名2
 */

import type { Plugin } from '../core/plugin.js';

// 数据源（并行抓取）
import { trendsSource } from './sources/trends.js';
import { redditSource } from './sources/reddit.js';
import { hackerNewsSource } from './sources/hackernews.js';
import { githubTrendingSource } from './sources/github.js';
import { sitemapSource } from './sources/sitemap.js';

// 提取器（原始条目 → 候选词）
import { ngramExtractor } from './extractors/ngram.js';

// 分析器（对候选词并行做四路分析）
import { domainAnalyzer } from './analyzers/domain.js';
import { competitionAnalyzer } from './analyzers/competition.js';
import { volumeAnalyzer } from './analyzers/volume-trend.js';
import { translateAnalyzer } from './analyzers/translate.js';

// 评分器（综合评分）
import { standardScorer } from './scorers/standard.js';

// 输出（报告 → 推送 → 存储，按顺序执行）
import { markdownReportNotifier } from './notifiers/markdown-report.js';
import { telegramNotifier } from './notifiers/telegram.js';
import { sqliteStorageNotifier } from './notifiers/sqlite-storage.js';

/** 内置插件注册列表 */
export const builtinPlugins: Plugin[] = [
  // 数据源
  trendsSource,
  redditSource,
  hackerNewsSource,
  githubTrendingSource,
  sitemapSource,
  // 提取器
  ngramExtractor,
  // 分析器
  domainAnalyzer,
  competitionAnalyzer,
  volumeAnalyzer,
  translateAnalyzer,
  // 评分器
  standardScorer,
  // 输出
  markdownReportNotifier,
  telegramNotifier,
  sqliteStorageNotifier,
];
