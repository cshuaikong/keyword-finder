/**
 * 中文翻译分析器插件
 * 引擎实现在 modules/translate.ts（Google → MyMemory → 本地词典 三级降级）
 * 此处为插件适配
 */

import { translateToChineseDetailed } from '../../modules/translate.js';
import type { AnalyzerPlugin } from '../../core/plugin.js';

export const translateAnalyzer: AnalyzerPlugin = {
  type: 'analyzer',
  name: 'translate',
  async analyze(keyword) {
    try {
      const result = await translateToChineseDetailed(keyword.keyword);
      const confidence = result.provider === 'google' ? 95
        : result.provider === 'mymemory' ? 85
        : result.provider === 'dictionary' ? 55 : 10;
      return {
        translation: result.text,
        evidence: [{
          dimension: 'translation',
          status: result.fromCache ? 'cached' : result.provider === 'dictionary' ? 'fallback' : result.provider === 'none' ? 'no-data' : 'success',
          confidence: result.fromCache ? Math.max(0, confidence - 5) : confidence,
          fromCache: result.fromCache,
          checkedAt: new Date(),
          result,
        }],
      };
    } catch (err: any) {
      return { translation: '', evidence: [{ dimension: 'translation', status: 'failed', confidence: 0, checkedAt: new Date(), error: err?.message || String(err) }] };
    }
  },
};
