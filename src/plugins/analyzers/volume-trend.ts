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
      return { volume: result };
    } catch {
      return {};
    }
  },
};
