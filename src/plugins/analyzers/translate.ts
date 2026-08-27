/**
 * 中文翻译分析器插件
 * 引擎实现在 modules/translate.ts（Google → MyMemory → 本地词典 三级降级）
 * 此处为插件适配
 */

import { translateToChinese } from '../../modules/translate.js';
import type { AnalyzerPlugin } from '../../core/plugin.js';

export const translateAnalyzer: AnalyzerPlugin = {
  type: 'analyzer',
  name: 'translate',
  async analyze(keyword) {
    try {
      const translation = await translateToChinese(keyword.keyword);
      return { translation };
    } catch {
      return { translation: '' };
    }
  },
};
