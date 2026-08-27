/**
 * 插件化核心 - 插件接口定义
 *
 * 六类插件（每个执行环节都可插拔替换）：
 *   1. source    数据源：抓取数据（词根驱动或自发抓取）
 *   2. extractor 提取器：从原始条目中提取候选词
 *   3. analyzer  分析器：对候选词做一维分析（域名/竞品/量级/翻译）
 *   4. scorer    评分器：计算综合评分
 *   5. notifier  输出器：报告生成 / Telegram 推送 / 数据库存储
 *   6. ai-provider AI 提供商（预留，第2期实现语义分析）
 *
 * 设计约定：
 *   - 插件永不抛异常（内部自行捕获并降级），保证 pipeline 健壮
 *   - 插件通过 name 唯一标识，可通过 DISABLE_PLUGINS / DISABLE_SOURCES 禁用
 */

import type {
  SourceItem,
  TrendingKeyword,
  ScoreBreakdown,
  FindResult,
  VolumeLevel,
  TrendDirection,
  CompetitionInfo,
} from '../types.js';

/** 插件类型 */
export type PluginType = 'source' | 'extractor' | 'analyzer' | 'scorer' | 'notifier' | 'ai-provider';

/** 一次 pipeline 运行的共享上下文 */
export interface RunContext {
  /** 本次运行的分类 */
  category: 'game' | 'ai' | 'all';
  /** 本次选取的词根 */
  seeds: string[];
  /** 运行开始时间 */
  startedAt: Date;
}

/** 数据源产出（候选词 或 原始条目，二选一） */
export interface SourceOutput {
  /** 直接产出的候选词（如 Google Trends 飙升词） */
  candidates?: TrendingKeyword[];
  /** 产出的原始条目（如 Reddit 热帖，需经提取器处理） */
  items?: SourceItem[];
}

/**
 * 1. 数据源插件
 * 抓取外部数据，产出候选词或原始条目
 */
export interface SourcePlugin {
  type: 'source';
  /** 数据源名称，唯一标识 */
  name: string;
  /** 是否由词根驱动（如 Google Trends 需要词根作为输入） */
  needsSeeds?: boolean;
  /** 抓取数据 */
  fetch(ctx: RunContext): Promise<SourceOutput>;
}

/**
 * 2. 提取器插件
 * 从原始条目（标题/文本）中提取候选关键词
 */
export interface ExtractorPlugin {
  type: 'extractor';
  name: string;
  extract(items: SourceItem[], ctx: RunContext): TrendingKeyword[];
}

/**
 * 分析器返回的字段集合
 * 每个分析器只贡献自己负责的维度，pipeline 合并所有分析器结果
 */
export interface AnalyzerResult {
  /** 域名可用性（domain 分析器） */
  domain?: { available: string[]; taken: string[]; anyAvailable: boolean };
  /** 竞品分析（competition 分析器） */
  competition?: CompetitionInfo;
  /** 搜索量级与趋势（volume-trend 分析器） */
  volume?: {
    volumeLevel: VolumeLevel;
    volumeAvg?: number;
    trendDirection: TrendDirection;
    trendNote?: string;
  };
  /** 中文翻译（translate 分析器） */
  translation?: string;
}

/**
 * 3. 分析器插件
 * 对单个候选词做一维分析，失败时返回空对象（pipeline 用默认值兜底）
 */
export interface AnalyzerPlugin {
  type: 'analyzer';
  name: string;
  analyze(keyword: TrendingKeyword, ctx: RunContext): Promise<AnalyzerResult>;
}

/**
 * 4. 评分器插件
 * 综合各维度分析结果计算评分
 */
export interface ScorerPlugin {
  type: 'scorer';
  name: string;
  score(
    keyword: TrendingKeyword,
    analyzed: AnalyzerResult,
    ctx: RunContext,
  ): { score: number; breakdown: ScoreBreakdown };
}

/**
 * 5. 输出插件
 * 接收完整运行结果，执行报告生成 / 消息推送 / 数据存储
 */
export interface NotifierPlugin {
  type: 'notifier';
  name: string;
  notify(result: FindResult, ctx: RunContext): Promise<void>;
}

/**
 * 6. AI 提供商插件（预留接口，第2期实现语义分析时使用）
 * 统一抽象不同 AI 服务（OpenAI/Claude/本地模型），支持降级链
 */
export interface AiProviderPlugin {
  type: 'ai-provider';
  name: string;
  /** 发送提示词，返回补全文本 */
  complete(prompt: string, ctx: RunContext): Promise<string>;
}

/** 所有插件类型的联合 */
export type Plugin =
  | SourcePlugin
  | ExtractorPlugin
  | AnalyzerPlugin
  | ScorerPlugin
  | NotifierPlugin
  | AiProviderPlugin;
