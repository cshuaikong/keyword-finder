import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = mkdtempSync(join(tmpdir(), 'keyword-finder-workflow-'));
process.env.DATA_DB_PATH = join(testDir, 'workflow.db');

const db = await import('./src/core/db.js');

after(() => {
  db.getDb().close();
  rmSync(testDir, { recursive: true, force: true });
});

test('关键词通过后离开待审核池，且项目未归档时不能淘汰', () => {
  db.upsertRadarWord('workflow state keyword', 'test');
  assert.equal(db.searchWords({ keyword: 'workflow state keyword' }).items[0].workflow_status, 'discovered');

  assert.equal(db.acceptWord('workflow state keyword', 'test').ok, true);
  assert.equal(db.searchWords({ keyword: 'workflow state keyword' }).total, 0);
  assert.equal(db.rejectWord('workflow state keyword', 'invalid transition').ok, false);
});

test('项目状态和淘汰决定保持单一当前状态', () => {
  assert.equal(db.updateRequirementStatus('workflow state keyword', 'developing').ok, true);
  let row = db.getDb().prepare('SELECT workflow_status FROM words WHERE keyword = ?')
    .get('workflow state keyword') as { workflow_status: string };
  assert.equal(row.workflow_status, 'building');

  assert.equal(db.updateRequirementStatus('workflow state keyword', 'abandoned').ok, true);
  assert.equal(db.rejectWord('workflow state keyword', 'project archived').ok, true);
  row = db.getDb().prepare('SELECT workflow_status FROM words WHERE keyword = ?')
    .get('workflow state keyword') as { workflow_status: string };
  assert.equal(row.workflow_status, 'rejected');

  assert.equal(db.deleteReject('workflow state keyword').ok, true);
  row = db.getDb().prepare('SELECT workflow_status FROM words WHERE keyword = ?')
    .get('workflow state keyword') as { workflow_status: string };
  assert.equal(row.workflow_status, 'archived');
});

test('运行生命周期保存最终状态和阶段记录', () => {
  const runId = db.startRun('test');
  db.recordRunStep(runId, 'source:test', 'succeeded', { itemCount: 2 });
  db.finishRun(runId, 'partial', {
    candidates: 2,
    validated: 1,
    durationMs: 10,
    error: 'optional notifier failed',
  });

  const run = db.queryRuns(1)[0];
  assert.equal(run.status, 'partial');
  assert.equal(run.candidates_count, 2);
  assert.equal(run.error_summary, 'optional notifier failed');
});

test('验证队列优先处理近期跨源强信号', () => {
  db.upsertRadarWord('weak signal keyword', 'suggest');
  db.upsertRadarWord('strong signal keyword', 'trends:breakout');
  db.recordKeywordSignals([
    { keyword: 'weak signal keyword', source: 'suggest', seed: 'game' },
    { keyword: 'strong signal keyword', source: 'trends:breakout', seed: 'game' },
    { keyword: 'strong signal keyword', source: 'suggest', seed: 'puzzle' },
    { keyword: 'strong signal keyword', source: 'reddit', seed: 'indie' },
  ]);

  const queue = db.queryUnverifiedWords(2);
  assert.equal(queue[0].keyword, 'strong signal keyword');
  assert.equal(queue[0].source_count, 3);
  assert.ok((queue[0].priority_score ?? 0) > (queue[1].priority_score ?? 0));
  const search = db.searchWords({ sort: 'priority', keyword: 'signal keyword' });
  assert.equal(search.items[0].keyword, 'strong signal keyword');
});

test('API 月度预算保留额度不可被普通任务消耗', () => {
  db.recordApiUsage('serpapi', 'TIMESERIES', 3, { keyword: 'budget keyword' });
  const budget = db.getApiBudget('serpapi', 5, 1);
  assert.equal(budget.used, 3);
  assert.equal(budget.remaining, 2);
  assert.equal(budget.spendableRemaining, 1);
  assert.equal(db.canSpendApi('serpapi', 2, 5, 1), false);
  assert.equal(db.canSpendApi('serpapi', 1, 5, 1), true);
});

test('游戏候选先完整入库，批次上限只限制消费队列', () => {
  for (let i = 1; i <= 8; i++) {
    db.upsertGameCandidate({
      source: 'steam', externalId: `queue-${i}`, title: `Queue Game ${i}`,
      channel: 'upcoming', lifecycleStatus: 'upcoming', priority: 60 + i,
    });
  }
  const batch = db.queryPendingGames(2).filter(game => game.external_id.startsWith('queue-'));
  assert.equal(batch.length, 2);
  assert.equal(db.queryGames(20).filter(game => game.external_id.startsWith('queue-')).length, 8);
});

test('同一游戏命中多个 Steam 榜单时去重并保留多源证据', () => {
  const first = db.upsertGameCandidate({
    source: 'steam', externalId: 'multi-source', title: 'Multi Source Game',
    channel: 'upcoming', lifecycleStatus: 'upcoming', priority: 70,
  });
  const second = db.upsertGameCandidate({
    source: 'steam', externalId: 'multi-source', title: 'Multi Source Game',
    channel: 'popular-upcoming', lifecycleStatus: 'prelaunch', priority: 95,
  });
  assert.equal(first.id, second.id);
  assert.equal(second.created, false);
  const game = db.queryGames(50).find(item => item.external_id === 'multi-source')!;
  assert.equal(game.source_count, 2);
  assert.equal(game.priority, 95);
  assert.equal(game.lifecycle_status, 'prelaunch');
});

test('游戏分析完成后保存评分、关键词和快照', () => {
  const game = db.queryGames(50).find(item => item.external_id === 'multi-source')!;
  db.markGameAnalyzing(game.id);
  db.recordGameKeywords(game.id, [
    { keyword: 'multi source game puzzle', source: 'test', intent: 'puzzle' },
    { keyword: 'multi source game puzzle', source: 'test', intent: 'puzzle' },
  ]);
  db.completeGameAnalysis(game.id, {
    demand: 80, momentum: 75, content: 70, competition: 50,
    lifecycle: 100, opportunity: 74, confidence: 72, keywordCount: 1,
  });
  const updated = db.queryGames(50).find(item => item.external_id === 'multi-source')!;
  assert.equal(updated.processing_status, 'processed');
  assert.equal(updated.opportunity_score, 74);
  assert.equal(updated.keyword_count, 1);
  const snapshots = db.getDb().prepare('SELECT COUNT(*) c FROM game_snapshots WHERE game_id = ?').get(game.id) as { c: number };
  assert.equal(snapshots.c, 1);
});

test('游戏生命周期围绕发售窗口正确分类', async () => {
  const { deriveGameLifecycle } = await import('./src/modules/game-radar.js');
  const now = new Date('2026-08-29T00:00:00Z');
  assert.equal(deriveGameLifecycle('2026-09-05', 'popular-upcoming', now), 'prelaunch');
  assert.equal(deriveGameLifecycle('2026-12-01', 'upcoming', now), 'upcoming');
  assert.equal(deriveGameLifecycle('2026-08-27', 'new-releases', now), 'launched');
});

test('Steam 搜索页解析游戏、日期、平台并过滤 DLC', async () => {
  const { parseSteamSearchHtml } = await import('./src/modules/steam-newreleases.js');
  const html = `<a class="search_result_row" href="https://store.steampowered.com/app/2713000/Test_Game/">
    <div class="search_name"><span class="title">Test Game</span><span class="platform_img win"></span></div>
    <div class="search_released">Aug 27, 2026</div>
  </a><a class="search_result_row" href="https://store.steampowered.com/app/2/Test_DLC/">
    <div class="search_name"><span class="title">Test Game Soundtrack DLC</span></div>
    <div class="search_released">Aug 28, 2026</div>
  </a>`;
  const games = parseSteamSearchHtml(html, 'new-releases', 75);
  assert.equal(games.length, 1);
  assert.equal(games[0].appid, '2713000');
  assert.equal(games[0].releaseDate, '2026-08-27');
  assert.deepEqual(games[0].platforms, ['PC']);
});

test('预算耗尽时 Trends 在发起网络请求前失败', async () => {
  const { config } = await import('./src/config.js');
  const trends = await import('./src/modules/trends.js');
  const previous = {
    key: config.serpapiKey,
    budget: config.serpapiMonthlyBudget,
    reserve: config.serpapiReserve,
  };
  config.serpapiKey = 'test-key-must-not-be-used';
  config.serpapiMonthlyBudget = 3;
  config.serpapiReserve = 0;
  try {
    const result = await trends.getVolumeAndTrend('budget blocked keyword');
    assert.equal(result.status, 'failed');
    assert.equal(db.getApiBudget('serpapi', 3, 0).used, 3);
  } finally {
    config.serpapiKey = previous.key;
    config.serpapiMonthlyBudget = previous.budget;
    config.serpapiReserve = previous.reserve;
  }
});

test('验证历史按固定维度权重计算置信度', () => {
  db.upsertRadarWord('confidence test keyword', 'test');
  const checkedAt = new Date();
  const first = db.recordValidationHistory('confidence test keyword', [
    { dimension: 'volume', status: 'success', confidence: 100, checkedAt },
    { dimension: 'competition', status: 'success', confidence: 90, checkedAt },
    { dimension: 'domain', status: 'success', confidence: 75, checkedAt },
    { dimension: 'translation', status: 'fallback', confidence: 55, checkedAt },
  ]);
  assert.equal(first.score, 87);
  assert.equal(first.level, 'high');
  assert.equal(db.queryValidationHistory('confidence test keyword').length, 4);
  const stored = db.getDb().prepare('SELECT confidence_score, confidence_level, validated_at FROM words WHERE keyword = ?')
    .get('confidence test keyword') as { confidence_score: number; confidence_level: string; validated_at: string | null };
  assert.equal(stored.confidence_score, 87);
  assert.equal(stored.confidence_level, 'high');
  assert.ok(stored.validated_at);

  const second = db.recordValidationHistory('confidence test keyword', [
    { dimension: 'competition', status: 'failed', confidence: 0, checkedAt: new Date(checkedAt.getTime() + 1000) },
  ]);
  assert.equal(second.score, 69);
  assert.equal(second.level, 'medium');
});

test('低置信度不会触发立即注册或自动放弃', async () => {
  const { recommendAction } = await import('./src/modules/assess.js');
  const result = recommendAction({
    score: 95,
    domainAvailable: true,
    competition: { topDomains: [], hasAuthority: false, resultCount: 0, difficulty: 'low' },
    confidenceScore: 45,
  });
  assert.equal(result.action, 'watch');
  assert.match(result.note, /置信度/);
});

test('观察任务可原子领取并按 1/3/7/14 天退避', () => {
  db.upsertRadarWord('scheduled review keyword', 'test');
  db.scheduleKeywordReview('scheduled review keyword', 'full', 'test due', 0, 4);
  assert.equal(db.scheduledReviewStats().due, 1);

  const firstClaim = db.claimDueScheduledReviews(10);
  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0].status, 'running');
  assert.equal(db.claimDueScheduledReviews(10).length, 0);

  db.finishScheduledReview(firstClaim[0].id, { resolved: false, error: 'still watching' });
  let task = db.queryScheduledReviews(10).find(row => row.keyword === 'scheduled review keyword')!;
  assert.equal(task.status, 'active');
  assert.equal(task.attempts, 1);
  assert.equal(task.interval_days, 3);

  db.getDb().prepare("UPDATE scheduled_reviews SET next_check_at = datetime('now', '-1 minute') WHERE id = ?").run(task.id);
  task = db.claimDueScheduledReviews(1)[0];
  db.finishScheduledReview(task.id, { resolved: true });
  task = db.queryScheduledReviews(10).find(row => row.keyword === 'scheduled review keyword')!;
  assert.equal(task.status, 'completed');
  assert.equal(task.attempts, 2);
});

test('关键词通过人工审核后会取消未完成观察任务', () => {
  db.upsertRadarWord('cancel review keyword', 'test');
  db.scheduleKeywordReview('cancel review keyword', 'full', 'waiting', 0);
  assert.equal(db.acceptWord('cancel review keyword').ok, true);
  const task = db.queryScheduledReviews(20).find(row => row.keyword === 'cancel review keyword')!;
  assert.equal(task.status, 'cancelled');
});
