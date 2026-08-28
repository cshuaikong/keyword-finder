/**
 * SQLite 数据库层
 * 单文件数据库，四个表：
 *   - words       新词库：每次运行验证过的词（upsert 更新）
 *   - requirements 需求库：人工筛选通过、准备建站的词（预留，第2期加筛选 CLI）
 *   - rejects     淘汰池：被判定放弃的词 + 理由（不重复记录）
 *   - runs        运行记录：每次找词运行的元信息
 *
 * 使用 better-sqlite3（同步 API，单文件，适合定时任务场景）
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

let db: Database.Database | null = null;

/** 建表 */
function initTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS words (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword           TEXT NOT NULL UNIQUE,
      score             INTEGER NOT NULL DEFAULT 0,
      volume_level      TEXT NOT NULL DEFAULT 'unknown',
      volume_avg        INTEGER,
      trend_direction   TEXT NOT NULL DEFAULT 'unknown',
      competition       TEXT NOT NULL DEFAULT 'medium',
      dev_difficulty    TEXT NOT NULL DEFAULT 'medium',
      monetization      TEXT NOT NULL DEFAULT 'medium',
      site_type         TEXT,
      action            TEXT NOT NULL DEFAULT 'watch',
      domain_available  INTEGER NOT NULL DEFAULT 0,
      available_domains TEXT,
      chinese_meaning   TEXT,
      brand_risk        TEXT,
      source            TEXT,
      first_seen_at     TEXT NOT NULL,
      last_seen_at      TEXT NOT NULL,
      seen_count        INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS requirements (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword       TEXT NOT NULL UNIQUE,
      theme         TEXT,
      status        TEXT NOT NULL DEFAULT 'planned',
      decision_note TEXT,
      word_id       INTEGER,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rejects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword     TEXT NOT NULL UNIQUE,
      reason      TEXT,
      score       INTEGER,
      rejected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at           TEXT NOT NULL,
      category         TEXT NOT NULL DEFAULT 'all',
      seeds            TEXT,
      candidates_count INTEGER NOT NULL DEFAULT 0,
      validated_count  INTEGER NOT NULL DEFAULT 0,
      duration_ms      INTEGER NOT NULL DEFAULT 0
    );

    -- SerpAPI 结果缓存（免费额度 100 次/月，缓存是省额度的关键）
    CREATE TABLE IF NOT EXISTS volume_cache (
      keyword         TEXT NOT NULL UNIQUE,
      volume_level    TEXT NOT NULL,
      volume_avg      INTEGER,
      trend_direction TEXT NOT NULL,
      trend_note      TEXT,
      checked_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trend_cache (
      seed       TEXT NOT NULL UNIQUE,
      keywords   TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_words_score ON words(score DESC);
    CREATE INDEX IF NOT EXISTS idx_words_action ON words(action);
    CREATE INDEX IF NOT EXISTS idx_runs_run_at ON runs(run_at);
  `);
}

/**
 * 获取数据库单例（首次调用时创建并建表）
 */
export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = new Database(config.dbPath);
    // WAL 模式：写入更快，适合定时批量写入
    db.pragma('journal_mode = WAL');
    initTables(db);
  }
  return db;
}

/** 词库行结构 */
export interface WordRow {
  id: number;
  keyword: string;
  score: number;
  volume_level: string;
  volume_avg: number | null;
  trend_direction: string;
  competition: string;
  dev_difficulty: string;
  monetization: string;
  site_type: string | null;
  action: string;
  domain_available: number;
  available_domains: string | null;
  chinese_meaning: string | null;
  brand_risk: string | null;
  source: string | null;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
}

/**
 * 查询词库（按评分降序，可选行动建议过滤）
 */
export function queryWords(limit = 20, action?: string): WordRow[] {
  const database = getDb();
  if (action) {
    return database
      .prepare('SELECT * FROM words WHERE action = ? ORDER BY score DESC LIMIT ?')
      .all(action, limit) as WordRow[];
  }
  return database
    .prepare('SELECT * FROM words ORDER BY score DESC LIMIT ?')
    .all(limit) as WordRow[];
}

/**
 * 查询淘汰池
 */
export function queryRejects(limit = 20): Array<{ keyword: string; reason: string | null; score: number | null; rejected_at: string }> {
  const database = getDb();
  return database
    .prepare('SELECT keyword, reason, score, rejected_at FROM rejects ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<{ keyword: string; reason: string | null; score: number | null; rejected_at: string }>;
}

/**
 * 查询运行记录
 */
export function queryRuns(limit = 10): Array<{ run_at: string; category: string; candidates_count: number; validated_count: number; duration_ms: number }> {
  const database = getDb();
  return database
    .prepare('SELECT run_at, category, candidates_count, validated_count, duration_ms FROM runs ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<{ run_at: string; category: string; candidates_count: number; validated_count: number; duration_ms: number }>;
}

/** 需求库状态 */
export const REQUIREMENT_STATUSES = ['planned', 'developing', 'launched', 'abandoned'] as const;
export type RequirementStatus = typeof REQUIREMENT_STATUSES[number];

/** 需求库行结构 */
export interface RequirementRow {
  id: number;
  keyword: string;
  theme: string | null;
  status: string;
  decision_note: string | null;
  word_id: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * 筛选通过：把词从新词库移入需求库
 * 已存在则更新主题/理由
 */
export function acceptWord(keyword: string, theme?: string, note?: string): { ok: boolean; message: string } {
  const database = getDb();
  const word = database
    .prepare('SELECT id, keyword FROM words WHERE lower(keyword) = lower(?)')
    .get(keyword) as { id: number; keyword: string } | undefined;

  if (!word) {
    return { ok: false, message: `新词库中不存在「${keyword}」（先运行 find 让它入库）` };
  }

  const now = new Date().toISOString();
  const exists = database
    .prepare('SELECT id FROM requirements WHERE lower(keyword) = lower(?)')
    .get(keyword);

  if (exists) {
    database
      .prepare('UPDATE requirements SET theme = COALESCE(?, theme), decision_note = COALESCE(?, decision_note), updated_at = ? WHERE lower(keyword) = lower(?)')
      .run(theme ?? null, note ?? null, now, keyword);
    return { ok: true, message: `「${word.keyword}」已在需求库，已更新主题/理由` };
  }

  database
    .prepare(`INSERT INTO requirements (keyword, theme, status, decision_note, word_id, created_at, updated_at)
              VALUES (?, ?, 'planned', ?, ?, ?, ?)`)
    .run(word.keyword, theme ?? null, note ?? null, word.id, now, now);

  return { ok: true, message: `「${word.keyword}」已加入需求库（状态: planned 规划中）` };
}

/**
 * 淘汰某词：记入淘汰池（含理由），并从新词库移除
 * 之后再次被发现时会重新评估（淘汰不是永久的）
 */
export function rejectWord(keyword: string, reason?: string): { ok: boolean; message: string } {
  const database = getDb();
  const word = database
    .prepare('SELECT id, keyword, score FROM words WHERE lower(keyword) = lower(?)')
    .get(keyword) as { id: number; keyword: string; score: number } | undefined;

  if (!word) {
    return { ok: false, message: `新词库中不存在「${keyword}」` };
  }

  const now = new Date().toISOString();
  database
    .prepare('INSERT OR IGNORE INTO rejects (keyword, reason, score, rejected_at) VALUES (?, ?, ?, ?)')
    .run(word.keyword, reason ?? null, word.score, now);
  database.prepare('DELETE FROM words WHERE id = ?').run(word.id);

  return { ok: true, message: `「${word.keyword}」已淘汰${reason ? `（${reason}）` : ''}` };
}

/**
 * 更新需求库词的状态（建站进度跟踪）
 * planned 规划中 → developing 开发中 → launched 已上线 → abandoned 已放弃
 */
export function updateRequirementStatus(keyword: string, status: string): { ok: boolean; message: string } {
  if (!REQUIREMENT_STATUSES.includes(status as RequirementStatus)) {
    return { ok: false, message: `状态必须是: ${REQUIREMENT_STATUSES.join(' | ')}` };
  }

  const database = getDb();
  const result = database
    .prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE lower(keyword) = lower(?)')
    .run(status, new Date().toISOString(), keyword);

  if (result.changes === 0) {
    return { ok: false, message: `需求库中不存在「${keyword}」（先用 accept 通过筛选）` };
  }

  return { ok: true, message: `「${keyword}」状态已更新为 ${status}` };
}

/**
 * 查询需求库（按更新时间倒序）
 */
export function queryRequirements(limit = 50): RequirementRow[] {
  const database = getDb();
  return database
    .prepare('SELECT * FROM requirements ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as RequirementRow[];
}

/** 词库统计 */
export function wordsStats(): { total: number; registerNow: number; watch: number; skip: number } {
  const database = getDb();
  const total = (database.prepare('SELECT COUNT(*) AS c FROM words').get() as { c: number }).c;
  const byAction = database
    .prepare('SELECT action, COUNT(*) AS c FROM words GROUP BY action')
    .all() as Array<{ action: string; c: number }>;
  const find = (a: string) => byAction.find(r => r.action === a)?.c ?? 0;
  return {
    total,
    registerNow: find('register-now'),
    watch: find('watch'),
    skip: find('skip'),
  };
}

// ─────────────────────────────────────────────────────────────
// SerpAPI 结果缓存（省额度的关键：免费额度 100 次/月）
//   - volume_cache: TIMESERIES 验证结果（14 天内不重复查）
//   - trend_cache:  词根飙升词结果（3 天内不重复查）
// 注："查无数据/unknown" 也缓存——噪声词短期内同样查不到，避免反复烧额度
// ─────────────────────────────────────────────────────────────

/** 量级缓存有效期：14 天（12 个月趋势窗口变化缓慢） */
export const VOLUME_CACHE_TTL_MS = 14 * 24 * 3600 * 1000;
/** 飙升词缓存有效期：3 天（RELATED_QUERIES 窗口本身是 7 天） */
export const TREND_CACHE_TTL_MS = 3 * 24 * 3600 * 1000;

/** 量级缓存行结构 */
export interface VolumeCacheRow {
  keyword: string;
  volume_level: string;
  volume_avg: number | null;
  trend_direction: string;
  trend_note: string | null;
  checked_at: string;
}

/**
 * 读取量级缓存（未过期才返回）
 */
export function getVolumeCache(keyword: string): VolumeCacheRow | undefined {
  const database = getDb();
  const row = database
    .prepare('SELECT * FROM volume_cache WHERE keyword = ?')
    .get(keyword.toLowerCase().trim()) as VolumeCacheRow | undefined;
  if (!row) return undefined;
  const age = Date.now() - new Date(row.checked_at).getTime();
  if (age > VOLUME_CACHE_TTL_MS) return undefined;
  return row;
}

/**
 * 写入量级缓存（upsert，刷新 checked_at）
 */
export function setVolumeCache(data: {
  keyword: string;
  volume_level: string;
  volume_avg?: number | null;
  trend_direction: string;
  trend_note?: string | null;
}): void {
  const database = getDb();
  database
    .prepare(`INSERT INTO volume_cache (keyword, volume_level, volume_avg, trend_direction, trend_note, checked_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(keyword) DO UPDATE SET
                volume_level = excluded.volume_level,
                volume_avg = excluded.volume_avg,
                trend_direction = excluded.trend_direction,
                trend_note = excluded.trend_note,
                checked_at = excluded.checked_at`)
    .run(
      data.keyword.toLowerCase().trim(),
      data.volume_level,
      data.volume_avg ?? null,
      data.trend_direction,
      data.trend_note ?? null,
      new Date().toISOString(),
    );
}

/**
 * 读取词根飙升词缓存（未过期才返回）
 * 返回缓存的飙升词 JSON（TrendingKeyword 数组，Date 已序列化）
 */
export function getTrendSeedCache(seed: string): string | undefined {
  const database = getDb();
  const row = database
    .prepare('SELECT keywords, checked_at FROM trend_cache WHERE seed = ?')
    .get(seed.toLowerCase().trim()) as { keywords: string; checked_at: string } | undefined;
  if (!row) return undefined;
  const age = Date.now() - new Date(row.checked_at).getTime();
  if (age > TREND_CACHE_TTL_MS) return undefined;
  return row.keywords;
}

/**
 * 写入词根飙升词缓存（upsert，刷新 checked_at）
 * @param keywordsJson TrendingKeyword 数组的 JSON 序列化结果
 */
export function setTrendSeedCache(seed: string, keywordsJson: string): void {
  const database = getDb();
  database
    .prepare(`INSERT INTO trend_cache (seed, keywords, checked_at) VALUES (?, ?, ?)
              ON CONFLICT(seed) DO UPDATE SET
                keywords = excluded.keywords,
                checked_at = excluded.checked_at`)
    .run(seed.toLowerCase().trim(), keywordsJson, new Date().toISOString());
}

// ─────────────────────────────────────────────────────────────
// 雷达模式辅助函数（常驻双环调度用）
//   - upsertRadarWord:      内环轻量入库（未验证，volume_level=unknown）
//   - queryUnverifiedWords: 外环验证队列（seen_count 高优先）
//   - updateWordVolume:     外环验证后回写量级
//   - countUnverifiedWords: 队列总数（雷达状态显示）
//   - insertRadarRun:       雷达运行记录（--list 命令可见）
// ─────────────────────────────────────────────────────────────

/**
 * 轻量入库：找词环发现的词直接进 words 表（未验证状态）
 * - 新词：INSERT，volume_level='unknown'
 * - 已有词：seen_count+1、last_seen_at 刷新，不覆盖任何已验证字段
 * @param source 来源标记（'trends:breakout' / 'trends' / 'suggest' 等）
 * @returns created 是否为新入库词
 */
export function upsertRadarWord(keyword: string, source: string): { created: boolean } {
  const database = getDb();
  const key = keyword.toLowerCase().trim();
  const now = new Date().toISOString();

  const existing = database
    .prepare('SELECT id FROM words WHERE lower(keyword) = lower(?)')
    .get(key) as { id: number } | undefined;

  if (existing) {
    database
      .prepare('UPDATE words SET seen_count = seen_count + 1, last_seen_at = ? WHERE id = ?')
      .run(now, existing.id);
    return { created: false };
  }

  database
    .prepare(`INSERT INTO words (keyword, volume_level, trend_direction, source, first_seen_at, last_seen_at, seen_count)
              VALUES (?, 'unknown', 'unknown', ?, ?, ?, 1)`)
    .run(key, source, now, now);
  return { created: true };
}

/**
 * 外环验证队列：未验证且 14 天内未查过量级的词
 * - seen_count DESC：被多个词根/多天重复发现的词优先验证（信号更强）
 * - LEFT JOIN volume_cache 排除 14 天内查过的：查无数据的词不反复占队列名额
 */
export function queryUnverifiedWords(limit = 5): WordRow[] {
  const database = getDb();
  return database
    .prepare(`SELECT w.* FROM words w
              LEFT JOIN volume_cache v ON v.keyword = lower(w.keyword)
              WHERE w.volume_level = 'unknown'
                AND (v.checked_at IS NULL OR v.checked_at < datetime('now', '-14 days'))
              ORDER BY w.seen_count DESC, w.last_seen_at DESC
              LIMIT ?`)
    .all(limit) as WordRow[];
}

/**
 * 量级回写：外环验证后更新 words 表
 * 只写量级/趋势字段，competition/action 等留给人工筛选（accept/reject）
 */
export function updateWordVolume(
  keyword: string,
  data: { volumeLevel: string; volumeAvg?: number; trendDirection: string },
): void {
  const database = getDb();
  database
    .prepare('UPDATE words SET volume_level = ?, volume_avg = ?, trend_direction = ? WHERE lower(keyword) = lower(?)')
    .run(data.volumeLevel, data.volumeAvg ?? null, data.trendDirection, keyword.toLowerCase().trim());
}

/** 未验证词队列总数（雷达状态摘要用） */
export function countUnverifiedWords(): number {
  const database = getDb();
  const row = database
    .prepare(`SELECT COUNT(*) AS c FROM words w
              LEFT JOIN volume_cache v ON v.keyword = lower(w.keyword)
              WHERE w.volume_level = 'unknown'
                AND (v.checked_at IS NULL OR v.checked_at < datetime('now', '-14 days'))`)
    .get() as { c: number };
  return row.c;
}

/**
 * 雷达运行记录（category 区分内环/外环，--list 命令可见）
 */
export function insertRadarRun(
  category: 'radar-inner' | 'radar-outer',
  seeds: string[],
  candidatesCount: number,
  validatedCount: number,
  durationMs: number,
): void {
  const database = getDb();
  database
    .prepare(`INSERT INTO runs (run_at, category, seeds, candidates_count, validated_count, duration_ms)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), category, JSON.stringify(seeds), candidatesCount, validatedCount, durationMs);
}
