/**
 * SQLite 存储输出插件
 * 每次运行结束后把结果写入数据库：
 *   - runs  记录本次运行
 *   - words 验证过的词 upsert（重复出现的词更新评分/趋势/出现次数）
 *   - rejects 被判定"放弃"的词记入淘汰池（含理由，不重复记录）
 */

import chalk from 'chalk';
import { getDb } from '../../core/db.js';
import type { NotifierPlugin } from '../../core/plugin.js';

/** 写 runs 记录 */
function insertRun(
  result: Parameters<NotifierPlugin['notify']>[0],
  category: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO runs (run_at, category, seeds, candidates_count, validated_count, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    result.runAt.toISOString(),
    category,
    JSON.stringify(result.seedsUsed),
    result.candidates.length,
    result.validated.length,
    result.duration,
  );
}

/** 写 words（upsert） */
function upsertWords(result: Parameters<NotifierPlugin['notify']>[0]): void {
  const db = getDb();
  const now = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO words (
      keyword, score, volume_level, volume_avg, trend_direction, competition,
      dev_difficulty, monetization, site_type, action, domain_available,
      available_domains, chinese_meaning, brand_risk, source,
      first_seen_at, last_seen_at, seen_count
    ) VALUES (
      @keyword, @score, @volumeLevel, @volumeAvg, @trendDirection, @competition,
      @devDifficulty, @monetization, @siteType, @action, @domainAvailable,
      @availableDomains, @chineseMeaning, @brandRisk, @source,
      @now, @now, 1
    )
    ON CONFLICT(keyword) DO UPDATE SET
      score             = excluded.score,
      volume_level      = excluded.volume_level,
      volume_avg        = excluded.volume_avg,
      trend_direction   = excluded.trend_direction,
      competition       = excluded.competition,
      dev_difficulty    = excluded.dev_difficulty,
      monetization      = excluded.monetization,
      site_type         = excluded.site_type,
      action            = excluded.action,
      domain_available  = excluded.domain_available,
      available_domains = excluded.available_domains,
      chinese_meaning   = excluded.chinese_meaning,
      brand_risk        = excluded.brand_risk,
      source            = excluded.source,
      last_seen_at      = excluded.last_seen_at,
      seen_count        = words.seen_count + 1
  `);

  const insertMany = db.transaction((words: Array<Record<string, unknown>>) => {
    for (const w of words) {
      upsert.run(w);
    }
  });

  insertMany(
    result.validated.map(kw => ({
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
      now,
    })),
  );
}

/** 写 rejects（被放弃的词 + 理由） */
function insertRejects(result: Parameters<NotifierPlugin['notify']>[0]): void {
  const db = getDb();
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO rejects (keyword, reason, score, rejected_at)
    VALUES (?, ?, ?, ?)
  `);

  const insertMany = db.transaction((words: Array<{ keyword: string; reason: string; score: number }>) => {
    for (const w of words) {
      insert.run(w.keyword, w.reason, w.score, now);
    }
  });

  insertMany(
    result.validated
      .filter(kw => kw.intel.action === 'skip')
      .map(kw => ({
        keyword: kw.keyword,
        reason: kw.intel.actionNote,
        score: kw.score,
      })),
  );
}

/**
 * SQLite 存储输出插件
 */
export const sqliteStorageNotifier: NotifierPlugin = {
  type: 'notifier',
  name: 'sqlite-storage',
  async notify(result, ctx) {
    try {
      insertRun(result, ctx.category);
      upsertWords(result);
      insertRejects(result);
      console.log(chalk.gray(`  💾 数据库已更新: ${result.validated.length} 个词入库`));
      console.log('');
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ 数据库存储失败: ${err?.message || err}`));
      console.log('');
    }
  },
};
