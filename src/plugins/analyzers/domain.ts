/**
 * 域名可用性分析器插件
 * 引擎实现在 modules/domain.ts（DNS + RDAP 双重检查），此处为插件适配
 */

import { checkDomainAvailability } from '../../modules/domain.js';
import type { AnalyzerPlugin } from '../../core/plugin.js';

export const domainAnalyzer: AnalyzerPlugin = {
  type: 'analyzer',
  name: 'domain',
  async analyze(keyword) {
    try {
      const result = await checkDomainAvailability(keyword.keyword);
      return { domain: result };
    } catch {
      // 分析器约定：永不抛异常，失败返回空对象由 pipeline 兜底
      return {};
    }
  },
};
