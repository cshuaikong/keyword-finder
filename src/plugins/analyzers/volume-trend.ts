/**
 * 搜索量级与趋势分析器插件
 * 引擎实现在 modules/trends.ts（getVolumeAndTrend），此处为插件适配
 * 基于 12 个月 interestOverTime 数据判断量级（A/B/C/D）和趋势方向
 */

import { getVolumeAndTrend } from '../../modules/trends.js';
import type { AnalyzerPlugin } from '../../core/plugin.js';

export const volumeAnalyzer: AnalyzerPlugin = {
  type: 'analyzer',
  name: 'volume-trend',
  async analyze(keyword) {
    try {
      const result = await getVolumeAndTrend(keyword.keyword);
      const evidence = {
        dimension: 'volume' as const,
        status: result.status === 'failed' ? 'failed' as const
          : result.fromCache ? 'cached' as const
          : result.status === 'no-data' ? 'no-data' as const : 'success' as const,
        confidence: result.status === 'failed' ? 0 : result.status === 'no-data' ? 60 : result.fromCache ? 90 : 100,
        fromCache: result.fromCache,
        checkedAt: new Date(),
        result,
        error: result.status === 'failed' ? '量级服务请求失败或预算不足' : undefined,
      };
      if (result.status === 'failed') return { evidence: [evidence] };
      return { volume: result, evidence: [evidence] };
    } catch (err: any) {
      return { evidence: [{ dimension: 'volume', status: 'failed', confidence: 0, checkedAt: new Date(), error: err?.message || String(err) }] };
    }
  },
};
