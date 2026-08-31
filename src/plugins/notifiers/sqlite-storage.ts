/**
 * SQLite 核心存储输出插件。
 * 运行生命周期由 pipeline 直接记录；本插件只负责验证结果入库。
 * 自动评分的 skip 只是建议，不等同于人工淘汰。
 */
import chalk from 'chalk';
import {
  cancelKeywordReviews,
  getDb,
  recordValidationHistory,
  scheduleKeywordReview,
} from '../../core/db.js';
import type { NotifierPlugin } from '../../core/plugin.js';
import { recommendAction } from '../../modules/assess.js';

function upsertWords(result: Parameters<NotifierPlugin['notify']>[0]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO words (
      keyword, score, volume_level, volume_avg, trend_direction, competition,
      dev_difficulty, monetization, site_type, action, domain_available,
      available_domains, chinese_meaning, brand_risk, source,
      first_seen_at, last_seen_at, seen_count, workflow_status,
      confidence_score, confidence_level, validated_at
    ) VALUES (
      @keyword, @score, @volumeLevel, @volumeAvg, @trendDirection, @competition,
      @devDifficulty, @monetization, @siteType, @action, @domainAvailable,
      @availableDomains, @chineseMeaning, @brandRisk, @source,
      @now, @now, 1, 'review', @confidenceScore, @confidenceLevel, @validatedAt
    )
    ON CONFLICT(keyword) DO UPDATE SET
      score = excluded.score,
      volume_level = excluded.volume_level,
      volume_avg = excluded.volume_avg,
      trend_direction = excluded.trend_direction,
      competition = excluded.competition,
      dev_difficulty = excluded.dev_difficulty,
      monetization = excluded.monetization,
      site_type = excluded.site_type,
      action = excluded.action,
      domain_available = excluded.domain_available,
      available_domains = excluded.available_domains,
      chinese_meaning = excluded.chinese_meaning,
      brand_risk = excluded.brand_risk,
      source = excluded.source,
      last_seen_at = excluded.last_seen_at,
      seen_count = words.seen_count + 1,
      confidence_score = excluded.confidence_score,
      confidence_level = excluded.confidence_level,
      validated_at = excluded.validated_at,
      workflow_status = CASE
        WHEN words.workflow_status IN ('discovered','queued','validated','review','retry_wait') THEN 'review'
        ELSE words.workflow_status
      END
  `);

  const insertMany = db.transaction((words: Array<Record<string, unknown>>) => {
    for (const word of words) upsert.run(word);
  });
  insertMany(result.validated.map(kw => ({
    keyword: kw.keyword,
    score: kw.score,
    volumeLevel: kw.intel.volumeLevel,
    volumeAvg: kw.intel.volumeAvg ?? null,
    trendDirection: kw.intel.trendDirection,
    competition: kw.competition.difficulty,
    devDifficulty: kw.intel.devDifficulty,
    monetization: kw.intel.monetization,
    siteType: kw.intel.siteType,
    action: kw.intel.action,
    domainAvailable: kw.domainAvailable ? 1 : 0,
    availableDomains: JSON.stringify(kw.availableDomains),
    chineseMeaning: kw.intel.chineseMeaning ?? null,
    brandRisk: kw.intel.brandRisk ?? null,
    source: kw.source ?? null,
    confidenceScore: kw.confidenceScore,
    confidenceLevel: kw.confidenceLevel,
    validatedAt: kw.validatedAt.toISOString(),
    now,
  })));
}

export const sqliteStorageNotifier: NotifierPlugin = {
  type: 'notifier',
  name: 'sqlite-storage',
  async notify(result, ctx) {
    try {
      upsertWords(result);
      for (const keyword of result.validated) {
        const confidence = recordValidationHistory(keyword.keyword, keyword.validationEvidence, ctx.runId);
        const decision = recommendAction({
          score: keyword.score,
          domainAvailable: keyword.domainAvailable,
          competition: keyword.competition,
          brandRisk: keyword.intel.brandRisk,
          confidenceScore: confidence.score,
        });
        getDb().prepare('UPDATE words SET action = ? WHERE lower(keyword) = lower(?)')
          .run(decision.action, keyword.keyword);
        if (ctx.scheduleReviews !== false) {
          cancelKeywordReviews(keyword.keyword);
          const failed = keyword.validationEvidence.some(item => item.status === 'failed');
          if (failed) {
            scheduleKeywordReview(keyword.keyword, 'full', '验证服务失败，等待重试', 1);
          } else if (confidence.score < 70) {
            scheduleKeywordReview(keyword.keyword, 'full', '验证覆盖或置信度不足', 3);
          } else if (decision.action === 'watch') {
            scheduleKeywordReview(keyword.keyword, 'full', decision.note, 7);
          }
        }
      }
      console.log(chalk.gray(`  💾 数据库已更新: ${result.validated.length} 个词入库`));
      console.log('');
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ 数据库存储失败: ${err?.message || err}`));
      console.log('');
      throw err;
    }
  },
};
