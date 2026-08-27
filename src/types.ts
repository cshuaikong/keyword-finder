/**
 * 全局类型定义
 */

/** 从 Google Trends 发现的候选关键词 */
export interface TrendingKeyword {
  /** 关键词文本 */
  keyword: string;
  /** 来源词根 */
  seedWord: string;
  /** 来源标记（社媒/数据源） */
  source?: string;
  /** 趋势类型 */
  trendType: 'rising' | 'breakout';
  /** 增长百分比（rising 类有值） */
  growthPercent?: number;
  /** 发现时间 */
  discoveredAt: Date;
}

/** 数据源产出的原始条目（社交源等，需经提取器转为候选词） */
export interface SourceItem {
  /** 条目标题/文本 */
  title: string;
  /** 原始链接 */
  url: string;
  /** 来源名称 */
  source: string;
  /** 热度指标（点赞数/分数） */
  score?: number;
  /** 发布时间 */
  publishedAt?: Date;
}

/** 搜索量级 */
export type VolumeLevel = 'A' | 'B' | 'C' | 'D' | 'unknown';

/** 趋势方向 */
export type TrendDirection = 'up' | 'stable' | 'down' | 'new' | 'unknown';

/** 开发难度 */
export type DevDifficulty = 'low' | 'medium' | 'high';

/** 额外情报（翻译/量级/趋势/难度） */
export interface KeywordIntel {
  /** 中文意思 */
  chineseMeaning?: string;
  /** 搜索量级: A极高/B高/C中/D低 */
  volumeLevel: VolumeLevel;
  /** 最近3个月平均搜索指数(0-100) */
  volumeAvg?: number;
  /** 趋势方向: 上升/平稳/下降/新词 */
  trendDirection: TrendDirection;
  /** 趋势变化说明（如"后3月较前3月 +80%"） */
  trendNote?: string;
  /** 技术开发难度 */
  devDifficulty: DevDifficulty;
  /** 难度理由 */
  devDifficultyReason: string;
  /** 变现潜力: 高/中/低 */
  monetization: 'high' | 'medium' | 'low';
  /** 建议建站类型 */
  siteType: string;
  /** 行动建议 */
  action: 'register-now' | 'watch' | 'skip';
  /** 品牌风险（词中含商标名时提示，不可注册域名） */
  brandRisk?: string;
  /** 行动建议说明 */
  actionNote: string;
}

/** 经过验证的关键词结果 */
export interface ValidatedKeyword extends TrendingKeyword {
  /** 域名是否可注册 */
  domainAvailable: boolean;
  /** 可用域名列表 */
  availableDomains: string[];
  /** 竞品分析 */
  competition: CompetitionInfo;
  /** 综合评分 (0-100) */
  score: number;
  /** 评分详情 */
  scoreBreakdown: ScoreBreakdown;
  /** 额外情报 */
  intel: KeywordIntel;
}

/** 竞品信息 */
export interface CompetitionInfo {
  /** 搜索结果前几名网站的域名 */
  topDomains: string[];
  /** 是否有大品牌/权威站占据 */
  hasAuthority: boolean;
  /** 搜索结果页面数量级 */
  resultCount: number;
  /** 竞品质量评估: low/medium/high */
  difficulty: 'low' | 'medium' | 'high';
}

/** 评分明细 */
export interface ScoreBreakdown {
  /** 趋势分 (0-30)：breakout=30, rising 按比例 */
  trendScore: number;
  /** 竞争分 (0-30)：竞品越弱分越高 */
  competitionScore: number;
  /** 域名分 (0-20)：域名可注册=20 */
  domainScore: number;
  /** 词长度分 (0-20)：短词更有价值 */
  lengthScore: number;
}

/** 找词运行结果 */
export interface FindResult {
  /** 运行时间 */
  runAt: Date;
  /** 使用的词根 */
  seedsUsed: string[];
  /** 发现的候选词 */
  candidates: TrendingKeyword[];
  /** 验证通过的词 */
  validated: ValidatedKeyword[];
  /** 关键词簇（同主题分组） */
  clusters?: Array<{ theme: string; keywords: string[] }>;
  /** 运行耗时(ms) */
  duration: number;
}

/** 报告格式 */
export interface Report {
  result: FindResult;
  markdown: string;
}
