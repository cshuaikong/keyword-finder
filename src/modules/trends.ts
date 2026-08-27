/**
 * Google Trends 模块（SerpAPI 版）
 *
 * 旧版依赖 google-trends-api 直连 trends.google.com 公开接口，
 * 已遭 Google 反爬拦截（返回 HTML 登录墙），因此改用 SerpAPI 官方 API：
 *   - RELATED_QUERIES: 词根 → 飙升词（Breakout / Rising），哥飞方法论核心引擎
 *   - TIMESERIES: 关键词 12 个月搜索热度，用于量级分级（A/B/C/D）与趋势判断
 *
 * 需要配置环境变量 SERPAPI_KEY（https://serpapi.com 注册，免费 100 次/月）
 * 未配置时优雅降级：飙升词返回空、量级返回 unknown，不阻塞主流程。
 */

import { config } from '../config.js';
import { fetchJson } from './http.js';
import { getVolumeCache, setVolumeCache, getTrendSeedCache, setTrendSeedCache } from '../core/db.js';
import type { TrendingKeyword, VolumeLevel, TrendDirection } from '../types.js';

/** 延迟函数，用于限流 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * SerpAPI Google Trends 请求
 * 文档: https://serpapi.com/google-trends-api
 */
async function serpTrends(params: Record<string, string>): Promise<any> {
  if (!config.serpapiKey) {
    throw new Error('SERPAPI_KEY 未配置');
  }

  const qs = new URLSearchParams({
    engine: 'google_trends',
    api_key: config.serpapiKey,
    hl: 'en',
    ...params,
  });

  return fetchJson<any>(`https://serpapi.com/search?${qs.toString()}`);
}

/**
 * 查询单个词根的相关飙升词（SerpAPI RELATED_QUERIES）
 * 仅取 rising 列表：value 为 "Breakout" 的算爆词，"+N%" 的算上升词
 * 带 SQLite 缓存：同一词根 3 天内不重复查（省 SerpAPI 免费额度）
 */
async function getRelatedQueriesForSeed(seed: string): Promise<TrendingKeyword[]> {
  // 缓存命中：直接返回（Date 需要反序列化）
  const cached = getTrendSeedCache(seed);
  if (cached) {
    try {
      const list = JSON.parse(cached) as TrendingKeyword[];
      console.log(`  ✓ [${seed}] 命中缓存（${list.length} 个飙升词，不消耗额度）`);
      return list.map(k => ({ ...k, discoveredAt: new Date(k.discoveredAt) }));
    } catch {
      // JSON 损坏则忽略缓存，重新查询
    }
  }

  const keywords: TrendingKeyword[] = [];

  try {
    const data = await serpTrends({
      q: seed,
      data_type: 'RELATED_QUERIES',
      date: 'now 7-d', // 最近 7 天（与旧版一致）
    });

    const rising = data?.related_queries?.rising || [];

    for (const item of rising) {
      if (!item.query) continue;

      // value: "Breakout" 或 "+4,500%"（hl=en 时固定英文）
      const valueStr = String(item.value ?? '');
      if (valueStr.includes('Breakout')) {
        keywords.push({
          keyword: item.query,
          seedWord: seed,
          source: 'trends',
          trendType: 'breakout',
          discoveredAt: new Date(),
        });
      } else {
        // extracted_value 是数值型百分比，优先用它；否则解析 "+4,500%"
        const percent = typeof item.extracted_value === 'number'
          ? item.extracted_value
          : parseInt(valueStr.replace(/[+%,]/g, ''), 10);
        if (!isNaN(percent) && percent > 0) {
          keywords.push({
            keyword: item.query,
            seedWord: seed,
            source: 'trends',
            trendType: 'rising',
            growthPercent: percent,
            discoveredAt: new Date(),
          });
        }
      }
    }

    console.log(`  ✓ [${seed}] 发现 ${keywords.length} 个飙升词`);

    // 写入缓存（连同空结果一起缓存，避免短期内重复查无结果的词根）
    setTrendSeedCache(seed, JSON.stringify(keywords));
  } catch (err: any) {
    console.log(`  ✗ [${seed}] Trends 查询失败: ${err?.message || err}`);
  }

  return keywords;
}

/**
 * 批量查询多个词根的飙升词
 * 内置限流机制，避免触发 SerpAPI 速率限制
 */
export async function findTrendingKeywords(seeds: string[]): Promise<TrendingKeyword[]> {
  console.log(`\n🔍 开始从 ${seeds.length} 个词根中发现飙升词（SerpAPI）...\n`);

  if (!config.serpapiKey) {
    console.log('  ⚠ 未配置 SERPAPI_KEY，Google Trends 引擎跳过');
    console.log('    注册 https://serpapi.com 后写入 .env: SERPAPI_KEY=xxx');
    console.log('    （无 Trends 引擎时找词质量会明显下降，靠社区源补充）');
    return [];
  }

  const allKeywords: TrendingKeyword[] = [];
  const seen = new Set<string>(); // 去重

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    console.log(`[${i + 1}/${seeds.length}] 查询词根: "${seed}"`);

    const keywords = await getRelatedQueriesForSeed(seed);

    // 去重
    for (const kw of keywords) {
      const normalized = kw.keyword.toLowerCase().trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        allKeywords.push(kw);
      }
    }

    // 限流：每次查询后等待
    if (i < seeds.length - 1) {
      console.log(`  ⏳ 等待 ${config.trendsDelay / 1000}s 避免限流...`);
      await sleep(config.trendsDelay);
    }
  }

  // 按优先级排序：breakout > rising（按增长百分比降序）
  allKeywords.sort((a, b) => {
    if (a.trendType !== b.trendType) {
      return a.trendType === 'breakout' ? -1 : 1;
    }
    return (b.growthPercent || 999999) - (a.growthPercent || 999999);
  });

  console.log(`\n📊 共发现 ${allKeywords.length} 个不重复的飙升词`);
  console.log(`   其中 Breakout: ${allKeywords.filter(k => k.trendType === 'breakout').length} 个`);
  console.log(`   其中 Rising: ${allKeywords.filter(k => k.trendType === 'rising').length} 个`);

  return allKeywords;
}



/**
 * 查询关键词的搜索量级和趋势方向（SerpAPI TIMESERIES，12 个月）
 *   - 量级：最近 3 个月平均指数分级 A/B/C/D（A≥70 B≥40 C≥15）
 *   - 趋势：后 3 月 vs 前 3 月比值判断 上升/平稳/下降/新词
 * 带 SQLite 缓存：同一词 14 天内不重复查（省 SerpAPI 免费额度）；
 * "查无数据/unknown" 也缓存——噪声词短期内同样查不到，避免反复烧额度。
 */
export async function getVolumeAndTrend(keyword: string): Promise<{
  volumeLevel: VolumeLevel;
  volumeAvg?: number;
  trendDirection: TrendDirection;
  trendNote?: string;
}> {
  // 缓存命中：直接返回
  const cached = getVolumeCache(keyword);
  if (cached) {
    return {
      volumeLevel: cached.volume_level as VolumeLevel,
      volumeAvg: cached.volume_avg ?? undefined,
      trendDirection: cached.trend_direction as TrendDirection,
      trendNote: cached.trend_note ?? undefined,
    };
  }

  try {
    const data = await serpTrends({
      q: keyword,
      data_type: 'TIMESERIES',
      date: 'today 12-m', // 最近 12 个月
    });

    const timeline: Array<{ values?: Array<{ value?: string; extracted_value?: number }> }> =
      data?.interest_over_time?.timeline_data || [];

    if (timeline.length === 0) {
      // 查无数据：写入缓存（unknown），噪声词短期内同样查不到，避免反复烧额度
      setVolumeCache({ keyword, volume_level: 'unknown', trend_direction: 'unknown', trend_note: '无搜索数据' });
      return { volumeLevel: 'unknown', trendDirection: 'unknown' };
    }

    const values = timeline.map(d => {
      const first = d?.values?.[0];
      if (!first) return 0;
      if (typeof first.extracted_value === 'number') return first.extracted_value;
      return parseInt(String(first.value ?? '0'), 10) || 0;
    });

    // 最近 3 个月平均（周粒度约 52 个点，取最后 12 个）
    const recent = values.slice(-12);
    const volumeAvg = recent.reduce((s, v) => s + v, 0) / Math.max(recent.length, 1);

    // 量级分级
    let volumeLevel: VolumeLevel;
    if (volumeAvg >= 70) volumeLevel = 'A';
    else if (volumeAvg >= 40) volumeLevel = 'B';
    else if (volumeAvg >= 15) volumeLevel = 'C';
    else volumeLevel = 'D';

    // 趋势判断：后 3 月 vs 前 3 月
    const third = Math.floor(values.length / 3);
    const early = values.slice(0, third);
    const late = values.slice(-third);

    const earlyAvg = early.reduce((s, v) => s + v, 0) / Math.max(early.length, 1);
    const lateAvg = late.reduce((s, v) => s + v, 0) / Math.max(late.length, 1);

    let trendDirection: TrendDirection;
    let trendNote: string | undefined;

    if (earlyAvg === 0 && lateAvg > 0) {
      trendDirection = 'new'; // 早期无数据，近期才有 → 新词
      trendNote = '全新词（此前无搜索）';
    } else if (earlyAvg === 0 && lateAvg === 0) {
      trendDirection = 'unknown';
    } else {
      const ratio = lateAvg / earlyAvg;
      if (ratio > 1.3) {
        trendDirection = 'up';
        trendNote = `后3月较前3月 +${Math.round((ratio - 1) * 100)}%`;
      } else if (ratio < 0.7) {
        trendDirection = 'down';
        trendNote = `后3月较前3月 -${Math.round((1 - ratio) * 100)}%`;
      } else {
        trendDirection = 'stable';
        trendNote = '搜索量平稳';
      }
    }

    // 写入缓存（14 天有效期）
    setVolumeCache({
      keyword,
      volume_level: volumeLevel,
      volume_avg: Math.round(volumeAvg),
      trend_direction: trendDirection,
      trend_note: trendNote,
    });

    return { volumeLevel, volumeAvg: Math.round(volumeAvg), trendDirection, trendNote };
  } catch {
    // 限流/网络错误：不缓存、不阻塞主流程（下次可重试）
    return { volumeLevel: 'unknown', trendDirection: 'unknown' };
  }
}
