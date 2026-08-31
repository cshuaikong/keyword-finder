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
      const noData = result.available.length === 0 && result.taken.length === 0 && result.uncertain.length === 0;
      return {
        domain: result,
        evidence: [{
          dimension: 'domain',
          status: noData ? 'no-data' : result.uncertain.length > 0 ? 'fallback' : 'success',
          confidence: noData ? 10 : result.confidence,
          checkedAt: new Date(),
          result,
        }],
      };
    } catch (err: any) {
      // 分析器约定：永不抛异常，失败返回空对象由 pipeline 兜底
      return { evidence: [{ dimension: 'domain', status: 'failed', confidence: 0, checkedAt: new Date(), error: err?.message || String(err) }] };
    }
  },
};
