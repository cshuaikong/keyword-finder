/**
 * SQLite 数据库层
 * 单文件数据库，核心实体包括：
 *   - words       新词库：每次运行验证过的词（upsert 更新）
 *   - requirements 需求库：人工筛选通过、准备建站的词（预留，第2期加筛选 CLI）
 *   - rejects     淘汰池：被判定放弃的词 + 理由（不重复记录）
 *   - runs        运行记录：每次找词运行的元信息
 *   - games       游戏候选池：发现、生命周期、分析队列与机会评分
 *   - game_*      游戏来源、关键词和评分快照历史
 *
 * 使用 better-sqlite3（同步 API，单文件，适合定时任务场景）
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { calculateConfidence } from './confidence.js';
import type { ValidationEvidence } from './plugin.js';

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
      seen_count        INTEGER NOT NULL DEFAULT 1,
      workflow_status   TEXT NOT NULL DEFAULT 'review',
      confidence_score  INTEGER NOT NULL DEFAULT 0,
      confidence_level  TEXT NOT NULL DEFAULT 'low',
      validated_at      TEXT
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
      duration_ms      INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'succeeded',
      error_summary    TEXT,
      completed_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS run_steps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      INTEGER NOT NULL,
      step        TEXT NOT NULL,
      status      TEXT NOT NULL,
      item_count  INTEGER,
      error       TEXT,
      started_at  TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );

    -- 每次发现的原始证据；关键词主表只保存当前快照，signals 保存历史。
    CREATE TABLE IF NOT EXISTS signals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword     TEXT NOT NULL,
      source      TEXT NOT NULL,
      seed        TEXT,
      strength    INTEGER NOT NULL DEFAULT 50,
      observed_at TEXT NOT NULL,
      run_id      INTEGER,
      metadata    TEXT
    );

    -- 外部付费 API 用量账本，用于月度预算硬限制。
    CREATE TABLE IF NOT EXISTS api_usage (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      provider   TEXT NOT NULL,
      operation  TEXT NOT NULL,
      units      INTEGER NOT NULL DEFAULT 1,
      keyword    TEXT,
      run_id     INTEGER,
      used_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS validations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword     TEXT NOT NULL,
      dimension   TEXT NOT NULL,
      status      TEXT NOT NULL,
      confidence  INTEGER NOT NULL,
      from_cache  INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error       TEXT,
      checked_at  TEXT NOT NULL,
      run_id      INTEGER
    );

    CREATE TABLE IF NOT EXISTS scheduled_reviews (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword          TEXT NOT NULL,
      task_type        TEXT NOT NULL DEFAULT 'full',
      reason           TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'active',
      next_check_at    TEXT NOT NULL,
      interval_days    INTEGER NOT NULL DEFAULT 3,
      attempts         INTEGER NOT NULL DEFAULT 0,
      max_attempts     INTEGER NOT NULL DEFAULT 4,
      last_checked_at  TEXT,
      last_error       TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      UNIQUE(keyword, task_type)
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

    -- Steam 新发售游戏捕获（P0：雷达自动发现新游戏名的落地表）
    CREATE TABLE IF NOT EXISTS steam_games (
      appid         TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL
    );

    -- 游戏候选池：先判断游戏是否值得做，再为通过初筛的游戏扩词。
    CREATE TABLE IF NOT EXISTS games (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      source              TEXT NOT NULL DEFAULT 'steam',
      external_id         TEXT NOT NULL,
      title               TEXT NOT NULL,
      aliases             TEXT,
      source_url          TEXT,
      release_date        TEXT,
      platforms           TEXT,
      lifecycle_status    TEXT NOT NULL DEFAULT 'upcoming',
      processing_status   TEXT NOT NULL DEFAULT 'pending',
      priority            INTEGER NOT NULL DEFAULT 50,
      demand_score        INTEGER NOT NULL DEFAULT 0,
      momentum_score      INTEGER NOT NULL DEFAULT 0,
      content_score       INTEGER NOT NULL DEFAULT 0,
      competition_score   INTEGER NOT NULL DEFAULT 0,
      lifecycle_score     INTEGER NOT NULL DEFAULT 0,
      opportunity_score   INTEGER NOT NULL DEFAULT 0,
      confidence_score    INTEGER NOT NULL DEFAULT 0,
      first_seen_at       TEXT NOT NULL,
      last_seen_at        TEXT NOT NULL,
      next_analysis_at    TEXT,
      processed_at        TEXT,
      attempts            INTEGER NOT NULL DEFAULT 0,
      last_error          TEXT,
      metadata            TEXT,
      UNIQUE(source, external_id)
    );

    -- 同一游戏可被多个榜单/渠道重复发现；来源历史用于计算热度和置信度。
    CREATE TABLE IF NOT EXISTS game_sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id     INTEGER NOT NULL,
      source      TEXT NOT NULL,
      channel     TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      metadata    TEXT,
      UNIQUE(game_id, source, channel)
    );

    CREATE TABLE IF NOT EXISTS game_keywords (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id       INTEGER NOT NULL,
      keyword       TEXT NOT NULL,
      source        TEXT NOT NULL,
      intent        TEXT,
      discovered_at TEXT NOT NULL,
      UNIQUE(game_id, keyword)
    );

    -- 每次分析都留快照，为后续 1/3/7 天速度和回测保留数据。
    CREATE TABLE IF NOT EXISTS game_snapshots (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id           INTEGER NOT NULL,
      demand_score      INTEGER NOT NULL,
      momentum_score    INTEGER NOT NULL,
      content_score     INTEGER NOT NULL,
      competition_score INTEGER NOT NULL,
      lifecycle_score   INTEGER NOT NULL,
      opportunity_score INTEGER NOT NULL,
      keyword_count     INTEGER NOT NULL DEFAULT 0,
      observed_at       TEXT NOT NULL,
      metadata          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_words_score ON words(score DESC);
    CREATE INDEX IF NOT EXISTS idx_words_action ON words(action);
    CREATE INDEX IF NOT EXISTS idx_runs_run_at ON runs(run_at);
    CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id);
    CREATE INDEX IF NOT EXISTS idx_signals_keyword_time ON signals(keyword, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_signals_source_time ON signals(source, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_api_usage_provider_time ON api_usage(provider, used_at DESC);
    CREATE INDEX IF NOT EXISTS idx_validations_keyword_time ON validations(keyword, checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_reviews_due ON scheduled_reviews(status, next_check_at);
    CREATE INDEX IF NOT EXISTS idx_games_queue ON games(processing_status, priority DESC, next_analysis_at, first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_games_release ON games(release_date, lifecycle_status);
    CREATE INDEX IF NOT EXISTS idx_game_sources_game ON game_sources(game_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_game_keywords_game ON game_keywords(game_id, discovered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_game_snapshots_game ON game_snapshots(game_id, observed_at DESC);
  `);

  // 兼容旧数据库：SQLite 的 CREATE TABLE IF NOT EXISTS 不会补新增列。
  const ensureColumn = (table: string, column: string, definition: string) => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  ensureColumn('words', 'workflow_status', "TEXT NOT NULL DEFAULT 'review'");
  ensureColumn('words', 'confidence_score', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('words', 'confidence_level', "TEXT NOT NULL DEFAULT 'low'");
  ensureColumn('words', 'validated_at', 'TEXT');
  ensureColumn('runs', 'status', "TEXT NOT NULL DEFAULT 'succeeded'");
  ensureColumn('runs', 'error_summary', 'TEXT');
  ensureColumn('runs', 'completed_at', 'TEXT');

  // 旧 Steam 捕获数据无损迁入统一候选池；保留 steam_games 供旧版本兼容读取。
  database.exec(`
    INSERT OR IGNORE INTO games (
      source, external_id, title, lifecycle_status, processing_status,
      priority, first_seen_at, last_seen_at
    )
    SELECT 'steam', appid, title, 'launched', 'pending', 60, first_seen_at, last_seen_at
    FROM steam_games;
  `);

  // 已进入需求库的旧数据优先恢复为项目状态。
  database.exec(`
    UPDATE words SET workflow_status = CASE
      WHEN EXISTS (SELECT 1 FROM requirements r WHERE lower(r.keyword) = lower(words.keyword))
        THEN COALESCE((SELECT CASE r.status
          WHEN 'planned' THEN 'accepted'
          WHEN 'developing' THEN 'building'
          WHEN 'launched' THEN 'launched'
          WHEN 'abandoned' THEN 'archived'
          ELSE 'accepted' END
        FROM requirements r WHERE lower(r.keyword) = lower(words.keyword)), 'accepted')
      ELSE workflow_status
    END;
    UPDATE words SET workflow_status = 'rejected'
      WHERE EXISTS (SELECT 1 FROM rejects r WHERE lower(r.keyword) = lower(words.keyword))
        AND NOT EXISTS (SELECT 1 FROM requirements q WHERE lower(q.keyword) = lower(words.keyword));
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
  workflow_status: string;
  confidence_score: number;
  confidence_level: string;
  validated_at: string | null;
  priority_score?: number;
  source_count?: number;
  recent_signal_count?: number;
}

/**
 * 查询词库（按评分降序，可选行动建议过滤）
 */
export function queryWords(limit = 20, action?: string): WordRow[] {
  const database = getDb();
  if (action) {
    return database
      .prepare("SELECT * FROM words WHERE action = ? AND workflow_status IN ('discovered','queued','validated','review','retry_wait') ORDER BY score DESC LIMIT ?")
      .all(action, limit) as WordRow[];
  }
  return database
    .prepare("SELECT * FROM words WHERE workflow_status IN ('discovered','queued','validated','review','retry_wait') ORDER BY score DESC LIMIT ?")
    .all(limit) as WordRow[];
}

/**
 * 查询最近发现/更新的词（雷达常驻模式下看新词用）
 * 按 last_seen_at 倒序：被内环重复发现的词也会冒到前面
 */
export function queryRecentWords(limit = 15): WordRow[] {
  const database = getDb();
  return database
    .prepare("SELECT * FROM words WHERE workflow_status IN ('discovered','queued','validated','review','retry_wait') ORDER BY last_seen_at DESC LIMIT ?")
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
export interface RunRow {
  run_at: string;
  category: string;
  candidates_count: number;
  validated_count: number;
  duration_ms: number;
  status: RunStatus;
  error_summary: string | null;
}

export function getWordByKeyword(keyword: string): WordRow | undefined {
  return getDb().prepare('SELECT * FROM words WHERE lower(keyword) = lower(?)')
    .get(keyword.toLowerCase().trim()) as WordRow | undefined;
}

export function queryRuns(limit = 10): RunRow[] {
  const database = getDb();
  return database
    .prepare('SELECT run_at, category, candidates_count, validated_count, duration_ms, status, error_summary FROM runs ORDER BY id DESC LIMIT ?')
    .all(limit) as RunRow[];
}

export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed';
export type RunStepStatus = 'succeeded' | 'failed' | 'skipped';

/** 任务一启动就写入，确保空结果和中途失败也可观测。 */
export function startRun(category: string, seeds: string[] = []): number {
  const result = getDb().prepare(`
    INSERT INTO runs (run_at, category, seeds, candidates_count, validated_count, duration_ms, status)
    VALUES (?, ?, ?, 0, 0, 0, 'running')
  `).run(new Date().toISOString(), category, JSON.stringify(seeds));
  return Number(result.lastInsertRowid);
}

/** 完成任务并写入最终统计。 */
export function finishRun(
  runId: number,
  status: Exclude<RunStatus, 'running'>,
  data: { seeds?: string[]; candidates?: number; validated?: number; durationMs: number; error?: string },
): void {
  getDb().prepare(`
    UPDATE runs SET status = ?, seeds = COALESCE(?, seeds), candidates_count = ?, validated_count = ?,
      duration_ms = ?, error_summary = ?, completed_at = ? WHERE id = ?
  `).run(
    status,
    data.seeds ? JSON.stringify(data.seeds) : null,
    data.candidates ?? 0,
    data.validated ?? 0,
    data.durationMs,
    data.error ?? null,
    new Date().toISOString(),
    runId,
  );
}

/** 保存数据源、分析、存储、通知等阶段的独立结果。 */
export function recordRunStep(
  runId: number,
  step: string,
  status: RunStepStatus,
  data: { itemCount?: number; error?: string; startedAt?: Date } = {},
): void {
  const finishedAt = new Date();
  getDb().prepare(`
    INSERT INTO run_steps (run_id, step, status, item_count, error, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId, step, status, data.itemCount ?? null, data.error ?? null,
    (data.startedAt ?? finishedAt).toISOString(), finishedAt.toISOString(),
  );
}

export interface KeywordSignalInput {
  keyword: string;
  source: string;
  seed?: string;
  strength?: number;
  observedAt?: Date;
  runId?: number;
  metadata?: Record<string, unknown>;
}

function defaultSignalStrength(source: string): number {
  if (source.includes('breakout')) return 100;
  if (source.startsWith('trends')) return 80;
  if (source.startsWith('steam')) return 65;
  if (source.startsWith('reddit') || source.startsWith('hackernews')) return 60;
  if (source.startsWith('github') || source.startsWith('sitemap')) return 55;
  if (source.startsWith('suggest')) return 40;
  return 50;
}

/** 批量保存发现证据，不覆盖历史。 */
export function recordKeywordSignals(signals: KeywordSignalInput[]): void {
  if (signals.length === 0) return;
  const database = getDb();
  const insert = database.prepare(`
    INSERT INTO signals (keyword, source, seed, strength, observed_at, run_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  database.transaction((rows: KeywordSignalInput[]) => {
    const seen = new Set<string>();
    for (const signal of rows) {
      const keyword = signal.keyword.toLowerCase().trim();
      if (!keyword || !signal.source) continue;
      const seed = signal.seed?.toLowerCase().trim() || '';
      const dedupeKey = `${keyword}\u0000${signal.source}\u0000${seed}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      insert.run(
        keyword,
        signal.source,
        seed || null,
        Math.min(Math.max(signal.strength ?? defaultSignalStrength(signal.source), 0), 100),
        (signal.observedAt ?? new Date()).toISOString(),
        signal.runId ?? null,
        signal.metadata ? JSON.stringify(signal.metadata) : null,
      );
    }
  })(signals);
}

export interface ApiBudgetSnapshot {
  provider: string;
  monthlyBudget: number;
  reserve: number;
  used: number;
  remaining: number;
  spendableRemaining: number;
}

export function getApiBudget(provider: string, monthlyBudget: number, reserve = 0): ApiBudgetSnapshot {
  const month = new Date().toISOString().slice(0, 7);
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(units), 0) AS used FROM api_usage
    WHERE provider = ? AND substr(used_at, 1, 7) = ?
  `).get(provider, month) as { used: number };
  const safeBudget = Math.max(0, monthlyBudget);
  const safeReserve = Math.min(Math.max(0, reserve), safeBudget);
  const remaining = Math.max(0, safeBudget - row.used);
  return {
    provider,
    monthlyBudget: safeBudget,
    reserve: safeReserve,
    used: row.used,
    remaining,
    spendableRemaining: Math.max(0, remaining - safeReserve),
  };
}

export function canSpendApi(provider: string, units: number, monthlyBudget: number, reserve = 0): boolean {
  return getApiBudget(provider, monthlyBudget, reserve).spendableRemaining >= units;
}

export function recordApiUsage(
  provider: string,
  operation: string,
  units = 1,
  data: { keyword?: string; runId?: number } = {},
): void {
  getDb().prepare(`
    INSERT INTO api_usage (provider, operation, units, keyword, run_id, used_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(provider, operation, Math.max(1, units), data.keyword ?? null, data.runId ?? null, new Date().toISOString());
}

export interface ValidationHistoryRow {
  keyword: string;
  dimension: string;
  status: string;
  confidence: number;
  from_cache: number;
  result_json: string | null;
  error: string | null;
  checked_at: string;
  run_id: number | null;
}

/** 保存不可变验证历史，并根据最近 30 天各维度最新结果刷新关键词置信度。 */
export function recordValidationHistory(
  keyword: string,
  evidence: ValidationEvidence[],
  runId?: number,
): { score: number; level: 'low' | 'medium' | 'high' } {
  const database = getDb();
  const key = keyword.toLowerCase().trim();
  const insert = database.prepare(`
    INSERT INTO validations (keyword, dimension, status, confidence, from_cache, result_json, error, checked_at, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  database.transaction(() => {
    for (const item of evidence) {
      insert.run(
        key,
        item.dimension,
        item.status,
        Math.min(Math.max(Math.round(item.confidence), 0), 100),
        item.fromCache ? 1 : 0,
        item.result === undefined ? null : JSON.stringify(item.result),
        item.error ?? null,
        item.checkedAt.toISOString(),
        runId ?? null,
      );
    }
  })();

  const recent = database.prepare(`
    SELECT dimension, status, confidence, from_cache, result_json, error, checked_at
    FROM validations
    WHERE keyword = ? AND datetime(checked_at) >= datetime('now', '-30 days')
    ORDER BY checked_at ASC
  `).all(key) as ValidationHistoryRow[];
  const confidence = calculateConfidence(recent.map(row => ({
    dimension: row.dimension as ValidationEvidence['dimension'],
    status: row.status as ValidationEvidence['status'],
    confidence: row.confidence,
    fromCache: row.from_cache === 1,
    checkedAt: new Date(row.checked_at),
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    error: row.error ?? undefined,
  })));

  database.prepare(`
    UPDATE words SET confidence_score = ?, confidence_level = ?, validated_at = ?
    WHERE lower(keyword) = lower(?)
  `).run(confidence.score, confidence.level, new Date().toISOString(), key);
  return confidence;
}

export function queryValidationHistory(keyword: string, limit = 50): ValidationHistoryRow[] {
  return getDb().prepare(`
    SELECT keyword, dimension, status, confidence, from_cache, result_json, error, checked_at, run_id
    FROM validations WHERE keyword = ? ORDER BY checked_at DESC LIMIT ?
  `).all(keyword.toLowerCase().trim(), limit) as ValidationHistoryRow[];
}

export type ReviewTaskType = 'volume' | 'full';
export interface ScheduledReviewRow {
  id: number;
  keyword: string;
  task_type: ReviewTaskType;
  reason: string;
  status: 'active' | 'running' | 'completed' | 'exhausted' | 'cancelled';
  next_check_at: string;
  interval_days: number;
  attempts: number;
  max_attempts: number;
  last_checked_at: string | null;
  last_error: string | null;
  confidence_score?: number;
  source?: string | null;
  volume_level?: string;
  last_seen_at?: string;
}

export function scheduleKeywordReview(
  keyword: string,
  taskType: ReviewTaskType,
  reason: string,
  delayDays: number,
  maxAttempts = 4,
): void {
  const key = keyword.toLowerCase().trim();
  const now = new Date();
  const next = new Date(now.getTime() + Math.max(0, delayDays) * 24 * 3600 * 1000).toISOString();
  getDb().prepare(`
    INSERT INTO scheduled_reviews (
      keyword, task_type, reason, status, next_check_at, interval_days, attempts,
      max_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?, 0, ?, ?, ?)
    ON CONFLICT(keyword, task_type) DO UPDATE SET
      reason = excluded.reason,
      status = 'active',
      next_check_at = CASE
        WHEN scheduled_reviews.status = 'active' AND scheduled_reviews.next_check_at < excluded.next_check_at
          THEN scheduled_reviews.next_check_at ELSE excluded.next_check_at END,
      interval_days = excluded.interval_days,
      max_attempts = excluded.max_attempts,
      last_error = NULL,
      updated_at = excluded.updated_at
  `).run(key, taskType, reason, next, Math.max(1, delayDays), Math.max(1, maxAttempts), now.toISOString(), now.toISOString());
}

export function cancelKeywordReviews(keyword: string): void {
  getDb().prepare(`
    UPDATE scheduled_reviews SET status = 'cancelled', updated_at = ?
    WHERE keyword = ? AND status = 'active'
  `).run(new Date().toISOString(), keyword.toLowerCase().trim());
}

export function queryDueScheduledReviews(limit = 10, now: Date = new Date()): ScheduledReviewRow[] {
  return getDb().prepare(`
    SELECT r.*, w.confidence_score, w.source, w.volume_level, w.last_seen_at FROM scheduled_reviews r
    JOIN words w ON lower(w.keyword) = r.keyword
    WHERE r.status = 'active' AND datetime(r.next_check_at) <= datetime(?)
      AND w.workflow_status IN ('discovered','queued','validated','review','retry_wait')
    ORDER BY r.next_check_at ASC, w.confidence_score ASC
    LIMIT ?
  `).all(now.toISOString(), Math.max(0, limit)) as ScheduledReviewRow[];
}

/** 原子领取到期任务；一小时前崩溃遗留的 running 任务会自动释放。 */
export function claimDueScheduledReviews(limit = 10, now: Date = new Date()): ScheduledReviewRow[] {
  const database = getDb();
  return database.transaction(() => {
    database.prepare(`UPDATE scheduled_reviews SET status = 'active', updated_at = ?
      WHERE status = 'running' AND datetime(last_checked_at) < datetime(?, '-1 hour')`)
      .run(now.toISOString(), now.toISOString());
    const tasks = queryDueScheduledReviews(limit, now);
    const claim = database.prepare(`UPDATE scheduled_reviews SET status = 'running', last_checked_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'`);
    const claimed: ScheduledReviewRow[] = [];
    for (const task of tasks) {
      if (claim.run(now.toISOString(), now.toISOString(), task.id).changes > 0) {
        claimed.push({ ...task, status: 'running' });
      }
    }
    return claimed;
  })();
}

function nextReviewInterval(current: number): number {
  if (current < 3) return 3;
  if (current < 7) return 7;
  return 14;
}

export function finishScheduledReview(
  id: number,
  result: { resolved: boolean; error?: string },
): void {
  const database = getDb();
  const task = database.prepare('SELECT * FROM scheduled_reviews WHERE id = ?').get(id) as ScheduledReviewRow | undefined;
  if (!task || (task.status !== 'active' && task.status !== 'running')) return;
  const now = new Date();
  const attempts = task.attempts + 1;
  if (result.resolved) {
    database.prepare(`UPDATE scheduled_reviews SET status = 'completed', attempts = ?, last_checked_at = ?,
      last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(attempts, now.toISOString(), now.toISOString(), id);
    return;
  }
  if (attempts >= task.max_attempts) {
    database.prepare(`UPDATE scheduled_reviews SET status = 'exhausted', attempts = ?, last_checked_at = ?,
      last_error = ?, updated_at = ? WHERE id = ?`)
      .run(attempts, now.toISOString(), result.error ?? null, now.toISOString(), id);
    return;
  }
  const interval = nextReviewInterval(task.interval_days);
  const next = new Date(now.getTime() + interval * 24 * 3600 * 1000).toISOString();
  database.prepare(`UPDATE scheduled_reviews SET status = 'active', attempts = ?, interval_days = ?, next_check_at = ?,
    last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
    .run(attempts, interval, next, now.toISOString(), result.error ?? null, now.toISOString(), id);
}

/** 因全局预算等外部条件暂缓，不消耗任务尝试次数。 */
export function deferScheduledReview(id: number, delayDays: number, reason: string): void {
  const now = new Date();
  const next = new Date(now.getTime() + Math.max(1, delayDays) * 24 * 3600 * 1000).toISOString();
  getDb().prepare(`UPDATE scheduled_reviews SET status = 'active', next_check_at = ?, last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'running'`)
    .run(next, reason, now.toISOString(), id);
}

export function scheduledReviewStats(): { active: number; due: number; exhausted: number } {
  const rows = getDb().prepare(`SELECT status, COUNT(*) AS count FROM scheduled_reviews GROUP BY status`)
    .all() as Array<{ status: string; count: number }>;
  const count = (status: string) => rows.find(row => row.status === status)?.count ?? 0;
  const due = (getDb().prepare(`SELECT COUNT(*) AS count FROM scheduled_reviews
    WHERE status = 'active' AND datetime(next_check_at) <= datetime('now')`).get() as { count: number }).count;
  return { active: count('active'), due, exhausted: count('exhausted') };
}

export function queryScheduledReviews(limit = 100): ScheduledReviewRow[] {
  return getDb().prepare(`SELECT r.*, w.confidence_score, w.source, w.volume_level, w.last_seen_at
    FROM scheduled_reviews r LEFT JOIN words w ON lower(w.keyword) = r.keyword
    ORDER BY CASE r.status WHEN 'running' THEN 0 WHEN 'active' THEN 1 WHEN 'exhausted' THEN 2 ELSE 3 END,
      r.next_check_at ASC LIMIT ?`).all(Math.max(1, limit)) as ScheduledReviewRow[];
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

  const accept = database.transaction(() => {
    if (exists) {
      database
        .prepare("UPDATE requirements SET theme = COALESCE(?, theme), decision_note = COALESCE(?, decision_note), status = 'planned', updated_at = ? WHERE lower(keyword) = lower(?)")
        .run(theme ?? null, note ?? null, now, keyword);
    } else {
      database
        .prepare(`INSERT INTO requirements (keyword, theme, status, decision_note, word_id, created_at, updated_at)
                  VALUES (?, ?, 'planned', ?, ?, ?, ?)`)
        .run(word.keyword, theme ?? null, note ?? null, word.id, now, now);
    }
    database.prepare("UPDATE words SET workflow_status = 'accepted' WHERE id = ?").run(word.id);
    database.prepare('DELETE FROM rejects WHERE lower(keyword) = lower(?)').run(word.keyword);
    database.prepare("UPDATE scheduled_reviews SET status = 'cancelled', updated_at = ? WHERE keyword = lower(?) AND status = 'active'")
      .run(now, word.keyword);
  });
  accept();

  if (exists) return { ok: true, message: `「${word.keyword}」已在需求库，已更新主题/理由` };

  return { ok: true, message: `「${word.keyword}」已加入需求库（状态: planned 规划中）` };
}

/**
 * 淘汰某词：用事务写入淘汰池并把唯一工作流状态改为 rejected。
 */
export function rejectWord(keyword: string, reason?: string): { ok: boolean; message: string } {
  const database = getDb();
  const word = database
    .prepare('SELECT id, keyword, score FROM words WHERE lower(keyword) = lower(?)')
    .get(keyword) as { id: number; keyword: string; score: number } | undefined;

  if (!word) {
    return { ok: false, message: `新词库中不存在「${keyword}」` };
  }

  const requirement = database
    .prepare('SELECT status FROM requirements WHERE lower(keyword) = lower(?)')
    .get(word.keyword) as { status: string } | undefined;
  if (requirement && requirement.status !== 'abandoned') {
    return { ok: false, message: `「${word.keyword}」已进入需求库；请先把项目状态改为 abandoned` };
  }

  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(`INSERT INTO rejects (keyword, reason, score, rejected_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(keyword) DO UPDATE SET reason = excluded.reason, score = excluded.score, rejected_at = excluded.rejected_at`)
      .run(word.keyword, reason ?? null, word.score, now);
    database.prepare("UPDATE words SET workflow_status = 'rejected' WHERE id = ?").run(word.id);
    database.prepare("UPDATE scheduled_reviews SET status = 'cancelled', updated_at = ? WHERE keyword = lower(?) AND status = 'active'")
      .run(now, word.keyword);
  })();

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
  const workflowStatus: Record<RequirementStatus, string> = {
    planned: 'accepted', developing: 'building', launched: 'launched', abandoned: 'archived',
  };
  let changes = 0;
  database.transaction(() => {
    const result = database
      .prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE lower(keyword) = lower(?)')
      .run(status, new Date().toISOString(), keyword);
    changes = result.changes;
    if (changes > 0) {
      database.prepare('UPDATE words SET workflow_status = ? WHERE lower(keyword) = lower(?)')
        .run(workflowStatus[status as RequirementStatus], keyword);
    }
  })();

  if (changes === 0) {
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
  const activeWhere = "workflow_status IN ('discovered','queued','validated','review','retry_wait')";
  const total = (database.prepare(`SELECT COUNT(*) AS c FROM words WHERE ${activeWhere}`).get() as { c: number }).c;
  const byAction = database
    .prepare(`SELECT action, COUNT(*) AS c FROM words WHERE ${activeWhere} GROUP BY action`)
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
//   - queryUnverifiedWords: 外环验证队列（跨源/强度/新鲜度综合优先级）
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
    .prepare(`INSERT INTO words (keyword, volume_level, trend_direction, source, first_seen_at, last_seen_at, seen_count, workflow_status)
              VALUES (?, 'unknown', 'unknown', ?, ?, ?, 1, 'discovered')`)
    .run(key, source, now, now);
  return { created: true };
}

/**
 * 外环验证队列：未验证且 14 天内未查过量级的词。
 * 优先级综合最近 30 天跨源数、信号次数、最强信号、新鲜度和累计出现次数。
 * - LEFT JOIN volume_cache 排除 14 天内查过的：查无数据的词不反复占队列名额
 */
export function queryUnverifiedWords(limit = 5): WordRow[] {
  const database = getDb();
  return database
    .prepare(`SELECT w.*,
                COALESCE(s.source_count, 0) AS source_count,
                COALESCE(s.signal_count, 0) AS recent_signal_count,
                CAST(ROUND(
                  COALESCE(s.source_count, 0) * 25 +
                  MIN(COALESCE(s.signal_count, 0), 10) * 3 +
                  COALESCE(s.max_strength, 0) * 0.3 +
                  CASE
                    WHEN s.latest_at IS NULL THEN 0
                    WHEN julianday('now') - julianday(s.latest_at) <= 2 THEN 20
                    WHEN julianday('now') - julianday(s.latest_at) <= 7 THEN 10
                    ELSE 0
                  END +
                  MIN(w.seen_count, 10) * 2
                ) AS INTEGER) AS priority_score
              FROM words w
              LEFT JOIN volume_cache v ON v.keyword = lower(w.keyword)
              LEFT JOIN (
                SELECT keyword, COUNT(*) AS signal_count, COUNT(DISTINCT source) AS source_count,
                  MAX(strength) AS max_strength, MAX(observed_at) AS latest_at
                FROM signals
                WHERE datetime(observed_at) >= datetime('now', '-30 days')
                GROUP BY keyword
              ) s ON s.keyword = lower(w.keyword)
              WHERE w.volume_level = 'unknown'
                AND w.workflow_status IN ('discovered','queued','retry_wait')
                AND (v.checked_at IS NULL OR datetime(v.checked_at) < datetime('now', '-14 days'))
              ORDER BY priority_score DESC, w.last_seen_at DESC
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
    .prepare("UPDATE words SET volume_level = ?, volume_avg = ?, trend_direction = ?, workflow_status = CASE WHEN workflow_status IN ('discovered','queued','retry_wait') THEN 'review' ELSE workflow_status END WHERE lower(keyword) = lower(?)")
    .run(data.volumeLevel, data.volumeAvg ?? null, data.trendDirection, keyword.toLowerCase().trim());
}

/** 暂时验证失败：保留候选并明确进入可重试状态。 */
export function markWordValidationFailed(keyword: string): void {
  getDb().prepare("UPDATE words SET workflow_status = 'retry_wait' WHERE lower(keyword) = lower(?) AND workflow_status IN ('discovered','queued','retry_wait')")
    .run(keyword.toLowerCase().trim());
}

/** 未验证词队列总数（雷达状态摘要用） */
export function countUnverifiedWords(): number {
  const database = getDb();
  const row = database
    .prepare(`SELECT COUNT(*) AS c FROM words w
              LEFT JOIN volume_cache v ON v.keyword = lower(w.keyword)
              WHERE w.volume_level = 'unknown'
                AND w.workflow_status IN ('discovered','queued','retry_wait')
                AND (v.checked_at IS NULL OR datetime(v.checked_at) < datetime('now', '-14 days'))`)
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
    .prepare(`INSERT INTO runs (run_at, category, seeds, candidates_count, validated_count, duration_ms, status, completed_at)
              VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?)`)
    .run(new Date().toISOString(), category, JSON.stringify(seeds), candidatesCount, validatedCount, durationMs, new Date().toISOString());
}

// ─────────────────────────────────────────────────────────────
// 游戏候选池与持久化分析队列
// ─────────────────────────────────────────────────────────────

export type GameLifecycle = 'announced' | 'upcoming' | 'prelaunch' | 'launched' | 'growing' | 'declining' | 'archived';
export type GameProcessingStatus = 'pending' | 'analyzing' | 'processed' | 'retry' | 'rejected';

export interface GameRow {
  id: number;
  source: string;
  external_id: string;
  title: string;
  aliases: string | null;
  source_url: string | null;
  release_date: string | null;
  platforms: string | null;
  lifecycle_status: GameLifecycle;
  processing_status: GameProcessingStatus;
  priority: number;
  demand_score: number;
  momentum_score: number;
  content_score: number;
  competition_score: number;
  lifecycle_score: number;
  opportunity_score: number;
  confidence_score: number;
  first_seen_at: string;
  last_seen_at: string;
  next_analysis_at: string | null;
  processed_at: string | null;
  attempts: number;
  last_error: string | null;
  metadata: string | null;
  source_count?: number;
  keyword_count?: number;
}

export interface DiscoveredGameInput {
  source: string;
  externalId: string;
  title: string;
  channel: string;
  sourceUrl?: string;
  releaseDate?: string;
  platforms?: string[];
  lifecycleStatus: GameLifecycle;
  priority: number;
  metadata?: Record<string, unknown>;
}

/** 发现即入候选池。处理上限只限制消费，不会丢弃未处理游戏。 */
export function upsertGameCandidate(input: DiscoveredGameInput): { id: number; created: boolean } {
  const database = getDb();
  const now = new Date().toISOString();
  const existing = database.prepare('SELECT id FROM games WHERE source = ? AND external_id = ?')
    .get(input.source, input.externalId) as { id: number } | undefined;
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  let id: number;
  if (existing) {
    id = existing.id;
    database.prepare(`UPDATE games SET
      title = ?, source_url = COALESCE(?, source_url), release_date = COALESCE(?, release_date),
      platforms = COALESCE(?, platforms), lifecycle_status = ?, priority = MAX(priority, ?),
      last_seen_at = ?, metadata = COALESCE(?, metadata)
      WHERE id = ?`).run(
        input.title, input.sourceUrl || null, input.releaseDate || null,
        input.platforms ? JSON.stringify(input.platforms) : null,
        input.lifecycleStatus, input.priority, now, metadata, id,
      );
  } else {
    const result = database.prepare(`INSERT INTO games (
      source, external_id, title, source_url, release_date, platforms,
      lifecycle_status, processing_status, priority, first_seen_at, last_seen_at, next_analysis_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`).run(
      input.source, input.externalId, input.title, input.sourceUrl || null,
      input.releaseDate || null, input.platforms ? JSON.stringify(input.platforms) : null,
      input.lifecycleStatus, input.priority, now, now, now, metadata,
    );
    id = Number(result.lastInsertRowid);
  }
  database.prepare(`INSERT INTO game_sources (game_id, source, channel, observed_at, metadata)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(game_id, source, channel) DO UPDATE SET observed_at = excluded.observed_at, metadata = excluded.metadata`)
    .run(id, input.source, input.channel, now, metadata);
  return { id, created: !existing };
}

/** 兼容旧调用：同时写旧表和统一候选池。 */
export function upsertSteamGame(appid: string, title: string): { created: boolean } {
  const database = getDb();
  const now = new Date().toISOString();
  const old = database.prepare('SELECT appid FROM steam_games WHERE appid = ?').get(appid);
  database.prepare(`INSERT INTO steam_games (appid, title, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(appid) DO UPDATE SET title = excluded.title, last_seen_at = excluded.last_seen_at`)
    .run(appid, title, now, now);
  upsertGameCandidate({
    source: 'steam', externalId: appid, title, channel: 'new-releases',
    lifecycleStatus: 'launched', priority: 65,
  });
  return { created: !old };
}

export function queryPendingGames(limit = 5): GameRow[] {
  const database = getDb();
  return database.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM game_sources s WHERE s.game_id = g.id) AS source_count,
      (SELECT COUNT(*) FROM game_keywords k WHERE k.game_id = g.id) AS keyword_count
    FROM games g
    WHERE (
      g.processing_status IN ('pending','retry')
      OR (g.processing_status = 'processed' AND datetime(g.next_analysis_at) <= datetime('now'))
    ) AND (g.next_analysis_at IS NULL OR datetime(g.next_analysis_at) <= datetime('now'))
    ORDER BY g.priority DESC,
      CASE g.lifecycle_status WHEN 'prelaunch' THEN 0 WHEN 'launched' THEN 1 WHEN 'upcoming' THEN 2 ELSE 3 END,
      datetime(g.first_seen_at) ASC
    LIMIT ?`).all(Math.max(0, limit)) as GameRow[];
}

export function markGameAnalyzing(gameId: number): void {
  getDb().prepare(`UPDATE games SET processing_status = 'analyzing', attempts = attempts + 1,
    last_error = NULL WHERE id = ?`).run(gameId);
}

export interface GameScoreInput {
  demand: number;
  momentum: number;
  content: number;
  competition: number;
  lifecycle: number;
  opportunity: number;
  confidence: number;
  keywordCount: number;
  metadata?: Record<string, unknown>;
}

export function completeGameAnalysis(gameId: number, score: GameScoreInput): void {
  const database = getDb();
  const now = new Date().toISOString();
  const transaction = database.transaction(() => {
    const metadata = score.metadata ? JSON.stringify(score.metadata) : null;
    database.prepare(`UPDATE games SET processing_status = 'processed', processed_at = ?,
      demand_score = ?, momentum_score = ?, content_score = ?, competition_score = ?,
      lifecycle_score = ?, opportunity_score = ?, confidence_score = ?, last_error = NULL,
      metadata = COALESCE(?, metadata),
      next_analysis_at = datetime('now', CASE lifecycle_status
        WHEN 'prelaunch' THEN '+1 day' WHEN 'launched' THEN '+1 day' ELSE '+7 days' END)
      WHERE id = ?`).run(now, score.demand, score.momentum, score.content, score.competition,
        score.lifecycle, score.opportunity, score.confidence, metadata, gameId);
    database.prepare(`INSERT INTO game_snapshots (
      game_id, demand_score, momentum_score, content_score, competition_score,
      lifecycle_score, opportunity_score, keyword_count, observed_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      gameId, score.demand, score.momentum, score.content, score.competition,
      score.lifecycle, score.opportunity, score.keywordCount, now,
      metadata,
    );
  });
  transaction();
}

export function failGameAnalysis(gameId: number, error: string): void {
  const database = getDb();
  const row = database.prepare('SELECT attempts FROM games WHERE id = ?').get(gameId) as { attempts: number } | undefined;
  const attempts = row?.attempts || 1;
  const retryDays = Math.min(7, Math.max(1, 2 ** Math.max(0, attempts - 1)));
  database.prepare(`UPDATE games SET processing_status = CASE WHEN attempts >= 5 THEN 'rejected' ELSE 'retry' END,
    next_analysis_at = datetime('now', ?), last_error = ? WHERE id = ?`)
    .run(`+${retryDays} days`, error.slice(0, 1000), gameId);
}

export function recordGameKeywords(gameId: number, keywords: Array<{ keyword: string; source: string; intent?: string }>): number {
  const database = getDb();
  const now = new Date().toISOString();
  const insert = database.prepare(`INSERT INTO game_keywords (game_id, keyword, source, intent, discovered_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(game_id, keyword) DO UPDATE SET source = excluded.source, intent = COALESCE(excluded.intent, game_keywords.intent)`);
  let created = 0;
  const transaction = database.transaction(() => {
    for (const item of keywords) {
      const result = insert.run(gameId, item.keyword.toLowerCase().trim(), item.source, item.intent || null, now);
      if (result.changes > 0) created++;
    }
  });
  transaction();
  return created;
}

export function queryGames(limit = 50, status?: GameProcessingStatus): GameRow[] {
  const database = getDb();
  const where = status ? 'WHERE g.processing_status = ?' : '';
  const params = status ? [status, Math.max(0, limit)] : [Math.max(0, limit)];
  return database.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM game_sources s WHERE s.game_id = g.id) AS source_count,
      (SELECT COUNT(*) FROM game_keywords k WHERE k.game_id = g.id) AS keyword_count
    FROM games g ${where}
    ORDER BY g.opportunity_score DESC, g.priority DESC, datetime(g.last_seen_at) DESC LIMIT ?`)
    .all(...params) as GameRow[];
}

export function gameStats(): { total: number; pending: number; retry: number; processed: number; recommended: number } {
  return getDb().prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(CASE WHEN processing_status = 'pending' THEN 1 ELSE 0 END), 0) pending,
    COALESCE(SUM(CASE WHEN processing_status = 'retry' THEN 1 ELSE 0 END), 0) retry,
    COALESCE(SUM(CASE WHEN processing_status = 'processed' THEN 1 ELSE 0 END), 0) processed,
    COALESCE(SUM(CASE WHEN processing_status = 'processed' AND opportunity_score >= 65 THEN 1 ELSE 0 END), 0) recommended
    FROM games`).get() as { total: number; pending: number; retry: number; processed: number; recommended: number };
}

/** 旧展示 API 兼容。 */
export function querySteamGames(limit = 20): Array<{ appid: string; title: string; first_seen_at: string }> {
  return getDb().prepare(`SELECT external_id appid, title, first_seen_at FROM games
    WHERE source = 'steam' ORDER BY datetime(first_seen_at) DESC LIMIT ?`).all(limit) as Array<{ appid: string; title: string; first_seen_at: string }>;
}

// ─────────────────────────────────────────────────────────────
// Web 管理面板辅助函数（检索/分页/删除）
// ─────────────────────────────────────────────────────────────

/** 词库搜索过滤器 */
export interface WordFilter {
  /** 关键词模糊匹配（LIKE） */
  keyword?: string;
  /** 来源过滤（'trends:breakout' / 'trends' / 'suggest' 等） */
  source?: string;
  /** 量级过滤（'unknown' | 'A' | 'B' | 'C' | 'D'） */
  volumeLevel?: string;
  /** 行动建议过滤（'watch' | 'register-now' | 'skip'） */
  action?: string;
  /** 排序: priority=证据优先级 | recent=最近发现 | seen=出现次数 | score=评分 */
  sort?: 'priority' | 'recent' | 'seen' | 'score';
  limit?: number;
  offset?: number;
}

/**
 * 词库检索（web 管理面板用）：关键词模糊 + 多维过滤 + 分页
 * 返回匹配总数和当前页条目
 */
export function searchWords(filter: WordFilter = {}): { total: number; items: WordRow[] } {
  const database = getDb();
  const where: string[] = ["words.workflow_status IN ('discovered','queued','validated','review','retry_wait')"];
  const params: Array<string | number> = [];

  if (filter.keyword) {
    where.push('words.keyword LIKE ?');
    params.push(`%${filter.keyword.toLowerCase().trim()}%`);
  }
  if (filter.source) {
    where.push('words.source = ?');
    params.push(filter.source);
  }
  if (filter.volumeLevel) {
    where.push('words.volume_level = ?');
    params.push(filter.volumeLevel);
  }
  if (filter.action) {
    where.push('words.action = ?');
    params.push(filter.action);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // 排序（白名单映射，防注入）
  const sortMap: Record<string, string> = {
    recent: 'last_seen_at DESC',
    seen: 'seen_count DESC, last_seen_at DESC',
    score: 'score DESC',
    priority: 'priority_score DESC, last_seen_at DESC',
  };
  const orderSql = sortMap[filter.sort ?? 'recent'] ?? sortMap.recent;

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  const total = (database
    .prepare(`SELECT COUNT(*) AS c FROM words ${whereSql}`)
    .get(...params) as { c: number }).c;

  const items = database
    .prepare(`SELECT words.*,
        COALESCE(s.source_count, 0) AS source_count,
        COALESCE(s.signal_count, 0) AS recent_signal_count,
        CAST(ROUND(
          COALESCE(s.source_count, 0) * 25 + MIN(COALESCE(s.signal_count, 0), 10) * 3 +
          COALESCE(s.max_strength, 0) * 0.3 +
          CASE WHEN s.latest_at IS NULL THEN 0
            WHEN julianday('now') - julianday(s.latest_at) <= 2 THEN 20
            WHEN julianday('now') - julianday(s.latest_at) <= 7 THEN 10 ELSE 0 END +
          MIN(words.seen_count, 10) * 2
        ) AS INTEGER) AS priority_score
      FROM words
      LEFT JOIN (
        SELECT keyword, COUNT(*) AS signal_count, COUNT(DISTINCT source) AS source_count,
          MAX(strength) AS max_strength, MAX(observed_at) AS latest_at
        FROM signals WHERE datetime(observed_at) >= datetime('now', '-30 days')
        GROUP BY keyword
      ) s ON s.keyword = lower(words.keyword)
      ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as WordRow[];

  return { total, items };
}

/**
 * 从词库删除某词（web 面板的“仅删除”按钮，不记入淘汰池）
 */
export function deleteWord(keyword: string): { ok: boolean; message: string } {
  const database = getDb();
  const result = database
    .prepare('DELETE FROM words WHERE lower(keyword) = lower(?)')
    .run(keyword.toLowerCase().trim());
  if (result.changes === 0) {
    return { ok: false, message: `词库中不存在「${keyword}」` };
  }
  return { ok: true, message: `「${keyword}」已从词库删除` };
}

/**
 * 从需求库删除某词（web 面板）
 */
export function deleteRequirement(keyword: string): { ok: boolean; message: string } {
  const database = getDb();
  let changes = 0;
  database.transaction(() => {
    const result = database.prepare('DELETE FROM requirements WHERE lower(keyword) = lower(?)')
      .run(keyword.toLowerCase().trim());
    changes = result.changes;
    if (changes > 0) {
      database.prepare(`UPDATE words SET workflow_status = CASE
        WHEN EXISTS (SELECT 1 FROM rejects r WHERE lower(r.keyword) = lower(words.keyword)) THEN 'rejected'
        ELSE 'review' END WHERE lower(keyword) = lower(?)`)
        .run(keyword.toLowerCase().trim());
    }
  })();
  if (changes === 0) {
    return { ok: false, message: `需求库中不存在「${keyword}」` };
  }
  return { ok: true, message: `「${keyword}」已从需求库删除` };
}

/**
 * 从淘汰池删除记录（web 面板）
 */
export function deleteReject(keyword: string): { ok: boolean; message: string } {
  const database = getDb();
  let changes = 0;
  database.transaction(() => {
    const result = database.prepare('DELETE FROM rejects WHERE lower(keyword) = lower(?)')
      .run(keyword.toLowerCase().trim());
    changes = result.changes;
    if (changes > 0) {
      database.prepare(`UPDATE words SET workflow_status = CASE
        WHEN EXISTS (SELECT 1 FROM requirements q WHERE lower(q.keyword) = lower(words.keyword)) THEN
          COALESCE((SELECT CASE q.status WHEN 'planned' THEN 'accepted' WHEN 'developing' THEN 'building'
            WHEN 'launched' THEN 'launched' WHEN 'abandoned' THEN 'archived' ELSE 'accepted' END
            FROM requirements q WHERE lower(q.keyword) = lower(words.keyword)), 'accepted')
        ELSE 'review' END WHERE lower(keyword) = lower(?)`)
        .run(keyword.toLowerCase().trim());
    }
  })();
  if (changes === 0) {
    return { ok: false, message: `淘汰池中不存在「${keyword}」` };
  }
  return { ok: true, message: `「${keyword}」已从淘汰池删除` };
}
