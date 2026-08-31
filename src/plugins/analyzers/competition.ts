/**
 * 竞品分析器插件
 * 通过 Bing 搜索结果分析竞品强度
 * 从原 modules/validator.ts 的 analyzeCompetition 迁移而来
 */

import * as cheerio from 'cheerio';
import { fetchText } from '../../modules/http.js';
import type { AnalyzerPlugin } from '../../core/plugin.js';
import type { CompetitionInfo } from '../../types.js';

/** 已知的大品牌/权威域名（这些站占据搜索结果说明竞争激烈） */
const AUTHORITY_DOMAINS = [
  'wikipedia.org', 'youtube.com', 'amazon.com', 'github.com',
  'poki.com', 'crazygames.com', 'y8.com', 'miniclip.com',
  'kongregate.com', 'armorgames.com', 'newgrounds.com',
  'reddit.com', 'twitter.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'medium.com', 'forbes.com', 'techcrunch.com',
  'microsoft.com', 'google.com', 'apple.com',
  // 游戏攻略/媒体强站
  'ign.com', 'gamesradar.com', 'gamerant.com', 'game8.co', 'gamepressure.com',
  'powerpyx.com', 'neoseeker.com', 'mobalytics.gg', 'gamefaqs.gamespot.com',
  'xboxachievements.com', 'trueachievements.com', 'playstationtrophies.org',
  'fandom.com', 'steamcommunity.com', 'windowscentral.com', 'pcgamer.com',
];

/**
 * 通过 Bing 搜索分析竞品情况
 * 注意：直接请求 Google 搜索可能被限流，Bing 对爬虫友好
 */
export async function analyzeCompetition(keyword: string): Promise<CompetitionInfo> {
  const topDomains: string[] = [];
  let hasAuthority = false;
  let resultCount = 0;

  // 使用 Bing 搜索（对爬虫友好，不会被限流/验证）
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(keyword)}&count=10`;
  const html = await fetchText(searchUrl);

  const $ = cheerio.load(html);

    // Bing 搜索结果结构: <li class="b_algo"> 内含 <cite> 域名
  $('li.b_algo cite').each((_: number, el: any) => {
    const text = $(el).text().trim();
      // 提取域名: https://www.example.com/path → example.com
      const domainMatch = text.match(/(?:https?:\/\/)?(?:www\.)?([^/\s>]+)/i);
    if (domainMatch) {
      const domain = domainMatch[1].toLowerCase();
        // 过滤无效域名
      if (domain.includes('.') && !domain.includes('...') && !topDomains.includes(domain)) {
        topDomains.push(domain);
      }
    }
  });

    // 检查是否有权威站点
  hasAuthority = topDomains.some(d =>
    AUTHORITY_DOMAINS.some(auth => d.endsWith(auth) || d === auth)
  );

  resultCount = topDomains.length;

  // 评估竞争难度
  const difficulty = evaluateDifficulty(topDomains, hasAuthority);

  return {
    topDomains: topDomains.slice(0, 10),
    hasAuthority,
    resultCount,
    difficulty,
  };
}

/**
 * 评估竞争难度
 */
function evaluateDifficulty(topDomains: string[], hasAuthority: boolean): 'low' | 'medium' | 'high' {
  // 有权威站点占据 → 高难度
  if (hasAuthority) {
    return 'high';
  }

  // 无可解析结果可能是页面结构变化/反爬，不能误判为蓝海。
  if (topDomains.length === 0) return 'medium';

  // 搜索结果少于 3 个 → 低难度（蓝海）
  if (topDomains.length < 3) {
    return 'low';
  }

  // 检查是否有看起来是个人站/小站的
  const isSmallSite = (domain: string) => {
    return !AUTHORITY_DOMAINS.some(auth => domain.endsWith(auth));
  };

  const smallSiteCount = topDomains.filter(isSmallSite).length;

  // 大部分是小站 → 低难度
  if (smallSiteCount >= topDomains.length * 0.7) {
    return 'low';
  }

  // 混合 → 中等难度
  return 'medium';
}

export const competitionAnalyzer: AnalyzerPlugin = {
  type: 'analyzer',
  name: 'competition',
  async analyze(keyword) {
    try {
      const competition = await analyzeCompetition(keyword.keyword);
      const noData = competition.topDomains.length === 0;
      return {
        competition,
        evidence: [{
          dimension: 'competition',
          status: noData ? 'no-data' : 'success',
          confidence: noData ? 25 : 90,
          checkedAt: new Date(),
          result: competition,
        }],
      };
    } catch (err: any) {
      console.log(`  ⚠ 竞品分析失败: ${keyword.keyword} - 使用默认评估`);
      return { evidence: [{ dimension: 'competition', status: 'failed', confidence: 0, checkedAt: new Date(), error: err?.message || String(err) }] };
    }
  },
};
