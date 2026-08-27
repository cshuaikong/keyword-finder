/**
 * 关键词情报评估规则引擎
 * 根据关键词语义特征，评估：
 *   - 技术开发难度（建站需要多久）
 *   - 变现潜力（广告价值）
 *   - 建议建站类型（工具站/游戏站/资讯站/下载站）
 *   - 行动建议（结合评分、域名、竞争）
 */

import type { DevDifficulty, KeywordIntel } from '../types.js';
import type { CompetitionInfo } from '../types.js';

/** 评估结果（不含行动建议，行动建议需要结合评分） */
export interface AssessmentResult {
  devDifficulty: DevDifficulty;
  devDifficultyReason: string;
  monetization: 'high' | 'medium' | 'low';
  siteType: string;
}

/** 关键词语义特征 → 站型/难度/变现 */
const SITE_PATTERNS: Array<{
  siteType: string;
  pattern: RegExp;
  devDifficulty: DevDifficulty;
  monetization: 'high' | 'medium' | 'low';
  reason: string;
}> = [
  // AI 工具（需接 API，难度中高，变现高）
  {
    siteType: 'AI 工具站',
    pattern: /\b(ai|gpt|llm|artificial intelligence|chatbot)\b/i,
    devDifficulty: 'high',
    monetization: 'high',
    reason: '需要接入 AI API（OpenAI/Claude 等），有持续成本',
  },
  // 生成器/转换器类工具（可套模板，难度低，变现高）
  {
    siteType: '在线工具站',
    pattern: /\b(generator|maker|builder|converter|calculator|counter|checker|downloader|editor|remover|enhancer|compressor|resizer|summarizer|paraphraser|translator|optimizer)\b/i,
    devDifficulty: 'low',
    monetization: 'high',
    reason: '纯前端逻辑可套模板，广告 CPM 高',
  },
  // 游戏站（需游戏内容，难度中，变现中）
  {
    siteType: '小游戏站',
    pattern: /\b(game|games|simulator|quiz|trivia|arcade|puzzle|solver|multiplayer|playground|sprunki|unblocked)\b/i,
    devDifficulty: 'medium',
    monetization: 'medium',
    reason: '可用 HTML5 游戏模板快速搭建，靠广告变现',
  },
  // 下载站（难度低，变现中，有版权风险）
  {
    siteType: '下载站',
    pattern: /\b(download|apk|mod apk|free download)\b/i,
    devDifficulty: 'low',
    monetization: 'medium',
    reason: '页面简单，但需注意版权风险',
  },
  // 答案/攻略/资讯类（纯内容，难度低，变现低-中）
  {
    siteType: '资讯/内容站',
    pattern: /\b(answers|lyrics|meaning|definition|wiki|guide|walkthrough|tutorial|how to|tips|cheats|codes|news|update)\b/i,
    devDifficulty: 'low',
    monetization: 'low',
    reason: '纯文字内容页，SEO 见效慢，CPM 偏低',
  },
  // 品牌/人名/影视（不适合建站）
  {
    siteType: '品牌词（不建议）',
    pattern: /\b(google|microsoft|apple|facebook|instagram|tiktok|youtube|netflix|spotify|roblox|fortnite|minecraft|chipotle|starbucks|nintendo|playstation|xbox|pokemon|tesla|amazon|disney|marvel|adobe|canva)\b/i,
    devDifficulty: 'low',
    monetization: 'low',
    reason: '品牌词有法律风险，哥飞提醒过不能碰',
  },
];

/**
 * 商标词库（做域名有法律风险，但可做教程/内容选题）
 * 命中后：不允许注册域名，行动建议强制降级
 */
const BRAND_WORDS: string[] = [
  // AI 产品
  'claude', 'anthropic', 'codex', 'openai', 'chatgpt', 'gemini', 'bard',
  'copilot', 'cursor', 'midjourney', 'stable diffusion', 'runway', 'perplexity',
  // 硬件/软件
  'logitech', 'logi', 'razer', 'steelseries', 'corsair', 'samsung', 'nvidia',
  'amd', 'intel', 'huawei', 'xiaomi', 'sony', 'lg', 'dell', 'hp', 'lenovo',
  // 平台/游戏
  'google', 'microsoft', 'apple', 'facebook', 'instagram', 'tiktok', 'youtube',
  'netflix', 'spotify', 'roblox', 'fortnite', 'minecraft', 'nintendo',
  'playstation', 'xbox', 'pokemon', 'steam', 'discord', 'twitch', 'tesla',
  'amazon', 'disney', 'marvel', 'adobe', 'canva', 'figma', 'notion', 'slack',
  'zoom', 'shopify', 'wordpress', 'wix', 'stripe', 'paypal',
];

/**
 * 检测词中是否含商标名（词边界匹配，避免误伤 ship→hp、blog→lg）
 * @returns 命中的品牌名，无则 undefined
 */
export function detectBrandRisk(keyword: string): string | undefined {
  const lower = keyword.toLowerCase();
  for (const brand of BRAND_WORDS) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(lower)) return brand;
  }
  return undefined;
}

/** 默认：内容站 */
const DEFAULT_ASSESSMENT: AssessmentResult = {
  devDifficulty: 'low',
  devDifficultyReason: '静态内容页即可，无特殊技术依赖',
  monetization: 'medium',
  siteType: '内容站',
};

/**
 * 评估关键词的站型/难度/变现
 */
export function assessKeyword(keyword: string): AssessmentResult {
  for (const p of SITE_PATTERNS) {
    if (p.pattern.test(keyword)) {
      return {
        devDifficulty: p.devDifficulty,
        devDifficultyReason: p.reason,
        monetization: p.monetization,
        siteType: p.siteType,
      };
    }
  }
  return DEFAULT_ASSESSMENT;
}

/**
 * 综合评分 + 域名 + 竞争 → 行动建议
 */
export function recommendAction(params: {
  score: number;
  domainAvailable: boolean;
  competition: CompetitionInfo;
  brandRisk?: string;
}): { action: 'register-now' | 'watch' | 'skip'; note: string } {
  const { score, domainAvailable, competition, brandRisk } = params;

  // 品牌词：不可注册域名，只能作为内容选题观察
  if (brandRisk) {
    return {
      action: 'watch',
      note: `⚠ 含品牌词「${brandRisk}」不可注册域名（商标风险），可作为教程/内容选题做内页`,
    };
  }

  // 立即注册：高分 + 域名可用 + 低竞争
  if (score >= 75 && domainAvailable && competition.difficulty === 'low') {
    return { action: 'register-now', note: '高分蓝海词，建议今天注册域名上线' };
  }

  // 立即注册：高分 + 域名可用 + 中竞争（仍有机会）
  if (score >= 85 && domainAvailable && competition.difficulty === 'medium') {
    return { action: 'register-now', note: '高分词，中竞争但值得切入' };
  }

  // 放弃：域名不可用 且 高竞争
  if (!domainAvailable && competition.difficulty === 'high') {
    return { action: 'skip', note: '域名已被占用且竞争激烈，建议放弃' };
  }

  // 放弃：品牌词低分
  if (score < 40) {
    return { action: 'skip', note: '评分过低，性价比不高' };
  }

  // 默认：观察
  return { action: 'watch', note: '条件不完全成熟，先观察一周趋势再决定' };
}

/**
 * 组装完整情报（供验证阶段调用）
 */
export function buildIntel(params: {
  keyword: string;
  chineseMeaning: string;
  volumeLevel: KeywordIntel['volumeLevel'];
  volumeAvg?: number;
  trendDirection: KeywordIntel['trendDirection'];
  trendNote?: string;
  score: number;
  domainAvailable: boolean;
  competition: CompetitionInfo;
}): KeywordIntel {
  const assessment = assessKeyword(params.keyword);
  const brandRisk = detectBrandRisk(params.keyword);
  const action = recommendAction({
    score: params.score,
    domainAvailable: params.domainAvailable,
    competition: params.competition,
    brandRisk,
  });

  return {
    chineseMeaning: params.chineseMeaning || undefined,
    volumeLevel: params.volumeLevel,
    volumeAvg: params.volumeAvg,
    trendDirection: params.trendDirection,
    trendNote: params.trendNote,
    devDifficulty: assessment.devDifficulty,
    devDifficultyReason: assessment.devDifficultyReason,
    monetization: assessment.monetization,
    siteType: assessment.siteType,
    action: action.action,
    actionNote: action.note,
    brandRisk,
  };
}
