import chalk from 'chalk';
import { config } from '../config.js';
import {
  claimDueScheduledReviews,
  deferScheduledReview,
  finishRun,
  finishScheduledReview,
  getApiBudget,
  getWordByKeyword,
  getVolumeCache,
  recordRunStep,
  startRun,
} from '../core/db.js';
import { validateCandidate } from '../core/pipeline.js';
import { sqliteStorageNotifier } from '../plugins/notifiers/sqlite-storage.js';
import type { FindResult, TrendingKeyword } from '../types.js';
import type { RunContext } from '../core/plugin.js';

export interface ScheduledReviewResult {
  claimed: number;
  completed: number;
  rescheduled: number;
  deferred: number;
  failed: number;
}

export async function runScheduledReviews(limit = config.reviewBatch): Promise<ScheduledReviewResult> {
  const started = Date.now();
  const runId = startRun('scheduled-review');
  const tasks = claimDueScheduledReviews(limit);
  const stats: ScheduledReviewResult = { claimed: tasks.length, completed: 0, rescheduled: 0, deferred: 0, failed: 0 };
  const errors: string[] = [];

  console.log(chalk.cyan(`\n🔁 [定时复查] 已领取 ${tasks.length} 个到期任务`));
  try {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const budget = getApiBudget('serpapi', config.serpapiMonthlyBudget, config.serpapiReserve);
      const hasFreshVolumeCache = Boolean(getVolumeCache(task.keyword));
      if (task.volume_level === 'unknown' && !hasFreshVolumeCache && budget.spendableRemaining === 0) {
        deferScheduledReview(task.id, 1, 'SerpAPI 自动预算已用尽');
        stats.deferred++;
        console.log(chalk.gray(`  [${i + 1}/${tasks.length}] ${task.keyword} → 预算不足，延后 1 天`));
        continue;
      }

      const candidate: TrendingKeyword = {
        keyword: task.keyword,
        seedWord: 'scheduled-review',
        source: task.source || 'scheduled-review',
        trendType: task.source?.includes('breakout') ? 'breakout' : 'rising',
        discoveredAt: task.last_seen_at ? new Date(task.last_seen_at) : new Date(),
      };
      const ctx: RunContext = {
        category: 'all', seeds: [], startedAt: new Date(), runId, scheduleReviews: false,
      };

      try {
        const outcome = await validateCandidate(candidate, ctx);
        const result: FindResult = {
          runAt: new Date(), seedsUsed: [], candidates: [candidate], validated: [outcome.validated],
          duration: Date.now() - started,
        };
        await sqliteStorageNotifier.notify(result, ctx);
        const stored = getWordByKeyword(task.keyword);
        const confidenceScore = stored?.confidence_score ?? outcome.validated.confidenceScore;
        const action = stored?.action ?? outcome.validated.intel.action;
        const resolved = confidenceScore >= 70 && action !== 'watch';
        const error = outcome.errors.length > 0 ? outcome.errors.join('; ') : undefined;
        finishScheduledReview(task.id, { resolved, error });
        if (resolved) stats.completed++;
        else stats.rescheduled++;
        errors.push(...outcome.errors);
        console.log(`  [${i + 1}/${tasks.length}] ${task.keyword} → 置信度 ${confidenceScore}% · ${resolved ? '完成' : '继续观察'}`);
      } catch (err: any) {
        const message = err?.message || String(err);
        finishScheduledReview(task.id, { resolved: false, error: message });
        stats.failed++;
        errors.push(`${task.keyword}: ${message}`);
        console.log(chalk.yellow(`  [${i + 1}/${tasks.length}] ${task.keyword} → 复查失败: ${message}`));
      }
    }

    recordRunStep(runId, 'scheduled-reviews', errors.length > 0 ? 'failed' : 'succeeded', {
      itemCount: tasks.length,
      error: errors.length > 0 ? errors.join('\n').slice(0, 4000) : undefined,
    });
    finishRun(runId, errors.length > 0 ? 'partial' : 'succeeded', {
      candidates: tasks.length,
      validated: stats.completed + stats.rescheduled,
      durationMs: Date.now() - started,
      error: errors.length > 0 ? errors.join('\n').slice(0, 4000) : undefined,
    });
    console.log(chalk.green(`\n✅ 复查完成: 完成 ${stats.completed}，继续观察 ${stats.rescheduled}，延后 ${stats.deferred}，失败 ${stats.failed}`));
    return stats;
  } catch (err: any) {
    const message = err?.message || String(err);
    finishRun(runId, 'failed', { durationMs: Date.now() - started, error: message });
    throw err;
  }
}
