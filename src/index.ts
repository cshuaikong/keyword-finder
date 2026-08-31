/**
 * 自动找词工具 - 主入口（v2.0 插件化）
 *
 * 入口只做三件事：
 *   1. 加载代理
 *   2. 注册内置插件
 *   3. 解析 CLI 参数并启动 pipeline
 *
 * 所有业务逻辑在 core/pipeline.ts + plugins/ 中，通过插件接口插拔：
 *   数据源 → 提取器 → 分析器 → 评分器 → 输出器
 *
 * 用法:
 *   npm run find              # 默认运行（全分类）
 *   npm run find:game         # 只找游戏类词
 *   npm run find:ai           # 只找 AI 工具类词
 *   npm run watch             # 定时模式（每天自动运行）
 *   npm run list              # 查看词库（SQLite）
 */

// 代理必须在所有其他模块之前加载
import './proxy.js';

import { Command } from 'commander';
import chalk from 'chalk';
import cron from 'node-cron';
import { config } from './config.js';
import { registry } from './core/registry.js';
import { runPipeline } from './core/pipeline.js';
import {
  queryWords,
  queryRecentWords,
  queryRejects,
  queryRuns,
  queryRequirements,
  wordsStats,
  acceptWord,
  rejectWord,
  updateRequirementStatus,
  countUnverifiedWords,
  querySteamGames,
  getApiBudget,
  scheduledReviewStats,
  queryGames,
  gameStats,
} from './core/db.js';
import { runInnerLoop, runOuterLoop } from './modules/radar.js';
import { runGameRadar } from './modules/game-radar.js';
import { runScheduledReviews } from './modules/reviews.js';
import { startWebUi } from './modules/webui.js';
import { builtinPlugins } from './plugins/index.js';

// 注册所有内置插件（新增插件只需加入 plugins/index.ts 的列表）
registry.registerAll(builtinPlugins);

/**
 * 执行一次找词流程
 * 报告保存 / Telegram 推送 / 数据库存储均由输出插件在 pipeline 内完成
 */
async function executeAndReport(category: 'game' | 'ai' | 'all') {
  await runPipeline(category);
}

/**
 * 查看词库（--list 命令）
 */
function printWordLibrary(): void {
  console.log(chalk.cyan('═══════════════════════════════════════════'));
  console.log(chalk.cyan('  📚 新词库（SQLite）'));
  console.log(chalk.cyan('═══════════════════════════════════════════'));
  console.log('');

  const stats = wordsStats();
  console.log(`  总计: ${stats.total} 个词 | 🚀立即注册: ${stats.registerNow} | 👀观察: ${stats.watch} | ⛔放弃: ${stats.skip}`);
  const budget = getApiBudget('serpapi', config.serpapiMonthlyBudget, config.serpapiReserve);
  console.log(`  SerpAPI: 已用 ${budget.used}/${budget.monthlyBudget} | 可自动使用 ${budget.spendableRemaining} | 保留 ${budget.reserve}`);
  const reviews = scheduledReviewStats();
  console.log(`  观察任务: 活跃 ${reviews.active} | 已到期 ${reviews.due} | 已耗尽 ${reviews.exhausted}`);
  console.log('');

  // Top 20 高分词
  const words = queryWords(20);
  if (words.length > 0) {
    console.log(chalk.green('  🏆 高分词 Top 20:'));
    console.log('');
    console.log('  | 关键词 | 评分 | 置信度 | 量级 | 竞争 | 行动 | 出现次数 | 中文 |');
    console.log('  |--------|------|--------|------|------|------|----------|------|');
    words.forEach(w => {
      const action = w.action === 'register-now' ? '🚀' : w.action === 'watch' ? '👀' : '⛔';
      console.log(`  | ${w.keyword} | ${w.score} | ${w.confidence_score}% | ${w.volume_level} | ${w.competition} | ${action} | ${w.seen_count}次 | ${w.chinese_meaning || '—'} |`);
    });
    console.log('');
  }

  // 最近发现/更新的词（雷达常驻模式下看新词用）
  const recent = queryRecentWords(15);
  if (recent.length > 0) {
    console.log(chalk.green('  🆕 最近发现/更新的词:'));
    console.log('');
    console.log('  | 关键词 | 量级 | 来源 | 出现 | 最近时间 |');
    console.log('  |--------|------|------|------|----------|');
    recent.forEach(w => {
      console.log(`  | ${w.keyword} | ${w.volume_level} | ${w.source || '—'} | ${w.seen_count}次 | ${fmtLocalTime(w.last_seen_at)} |`);
    });
    console.log('');
  }

  // 需求库（已通过人工筛选）
  const requirements = queryRequirements(50);
  if (requirements.length > 0) {
    console.log(chalk.green('  📋 需求库（已通过筛选，按建站进度）:'));
    console.log('');
    console.log('  | 关键词 | 状态 | 主题 | 理由 |');
    console.log('  |--------|------|------|------|');
    requirements.forEach(r => {
      console.log(`  | ${r.keyword} | ${requirementStatusLabel(r.status)} | ${r.theme || '—'} | ${r.decision_note || '—'} |`);
    });
    console.log('');
  }

  // 最近淘汰的词
  const rejects = queryRejects(10);
  if (rejects.length > 0) {
    console.log(chalk.red('  ⛔ 最近淘汰的词:'));
    console.log('');
    rejects.forEach(r => {
      console.log(`     ${r.keyword} (评分: ${r.score ?? '?'}) - ${r.reason || '无理由'}`);
    });
    console.log('');
  }

  // 游戏候选池：生命周期、处理队列与机会分
  const games = queryGames(15);
  if (games.length > 0) {
    const gs = gameStats();
    console.log(chalk.green(`  🎮 游戏候选池（总计 ${gs.total} / 待分析 ${gs.pending + gs.retry} / 推荐 ${gs.recommended}）:`));
    console.log('');
    console.log('  | 游戏 | 阶段 | 队列 | 机会 | 置信度 | 关键词 | 发布日 |');
    console.log('  |------|------|------|------|--------|--------|--------|');
    games.forEach(g => {
      console.log(`  | ${g.title} | ${g.lifecycle_status} | ${g.processing_status} | ${g.opportunity_score} | ${g.confidence_score}% | ${g.keyword_count || 0} | ${g.release_date || '待定'} |`);
    });
    console.log('');
  }

  // 最近运行记录
  const runs = queryRuns(5);
  if (runs.length > 0) {
    console.log(chalk.gray('  ⏱ 最近运行:'));
    console.log('');
    runs.forEach(r => {
      console.log(`     ${r.run_at} | ${r.status} | 分类:${r.category} | 候选:${r.candidates_count} | 验证:${r.validated_count} | 耗时:${(r.duration_ms / 1000).toFixed(0)}s`);
    });
    console.log('');
  }
}

/** 需求库状态 → 中文标签 */
function requirementStatusLabel(status: string): string {
  switch (status) {
    case 'planned': return '🗓 规划中';
    case 'developing': return '🔨 开发中';
    case 'launched': return '🚀 已上线';
    case 'abandoned': return '❌ 已放弃';
    default: return status;
  }
}

/** 时间格式化：ISO(UTC) → 本地时区 MM-DD HH:MM */
function fmtLocalTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 主程序
 */
async function main() {
  const program = new Command();

  program
    .name('keyword-finder')
    .description('自动找词工具 - 基于哥飞方法论（插件化架构）')
    // 子命令名之后的 option 交给子命令自己解析，
    // 否则主程序的 -n/--seeds 会吞掉 accept 的 -n/--note 参数
    .enablePositionalOptions()
    .option('-c, --category <type>', '词根分类: game | ai | all', 'all')
    .option('-n, --seeds <count>', '每次选取的词根数量', String(config.seedsPerRun))
    .option('--watch', '定时模式，每天自动运行')
    .option('--list', '查看词库（新词库/需求库/淘汰池/运行记录）');

  // 人工筛选：通过 → 需求库
  program
    .command('accept <keyword>')
    .description('筛选通过：把词移入需求库（开始建站规划）')
    .option('-t, --theme <theme>', '主题分类，如「AI 工具」「小游戏」')
    .option('-n, --note <note>', '入选理由')
    .action((keyword: string, options: { theme?: string; note?: string }) => {
      const r = acceptWord(keyword, options.theme, options.note);
      console.log(r.ok ? chalk.green(`✅ ${r.message}`) : chalk.red(`❌ ${r.message}`));
    });

  // 人工筛选：淘汰
  program
    .command('reject <keyword>')
    .description('淘汰某词（记入淘汰池并附理由）')
    .option('-r, --reason <reason>', '淘汰理由')
    .action((keyword: string, options: { reason?: string }) => {
      const r = rejectWord(keyword, options.reason);
      console.log(r.ok ? chalk.green(`✅ ${r.message}`) : chalk.red(`❌ ${r.message}`));
    });

  // 建站进度跟踪
  program
    .command('status <keyword> <status>')
    .description('更新需求库词的状态: planned | developing | launched | abandoned')
    .action((keyword: string, status: string) => {
      const r = updateRequirementStatus(keyword, status);
      console.log(r.ok ? chalk.green(`✅ ${r.message}`) : chalk.red(`❌ ${r.message}`));
    });

  // 常驻雷达（双环：内环找词 + 外环验证）
  program
    .command('radar')
    .description('常驻雷达：内环每日找词 + 外环批量验证（双环调度）')
    .option('--inner-only', '只跑内环（找词）')
    .option('--outer-only', '只跑外环（验证）')
    .option('--watch', '常驻模式：内环每日自动找词 + 外环每周自动验证')
    .action(async (options: { innerOnly?: boolean; outerOnly?: boolean; watch?: boolean }) => {
      const runBoth = !options.innerOnly && !options.outerOnly;

      // 常驻模式：内环每日 + 外环每周自动运行
      if (options.watch) {
        console.log(chalk.cyan('🛰 雷达常驻模式启动'));
        console.log(chalk.gray(`   内环(找词): 每日 ${config.radarInnerCron}`));
        console.log(chalk.gray(`   外环(验证): 每周 ${config.radarOuterCron}`));
        console.log(chalk.gray(`   观察复查: ${config.reviewCron}`));
        console.log(chalk.gray('   按 Ctrl+C 停止\n'));

        // 管理面板随雷达常驻模式自动带起
        await startWebUi();

        // 启动即跑一轮
        if (runBoth || options.innerOnly) await runInnerLoop();
        if (runBoth || options.outerOnly) await runOuterLoop();

        let innerRunning = false;
        let outerRunning = false;
        let reviewRunning = false;
        cron.schedule(config.radarInnerCron, () => {
          if (innerRunning) {
            console.log(chalk.yellow('⚠ 上一轮内环仍在运行，本次调度跳过'));
            return;
          }
          innerRunning = true;
          console.log(chalk.cyan(`\n⏰ [${new Date().toLocaleString()}] 内环触发`));
          runInnerLoop()
            .catch(err => console.log(chalk.red('内环出错:'), err))
            .finally(() => { innerRunning = false; });
        });
        cron.schedule(config.radarOuterCron, () => {
          if (outerRunning) {
            console.log(chalk.yellow('⚠ 上一轮外环仍在运行，本次调度跳过'));
            return;
          }
          outerRunning = true;
          console.log(chalk.cyan(`\n⏰ [${new Date().toLocaleString()}] 外环触发`));
          runOuterLoop()
            .catch(err => console.log(chalk.red('外环出错:'), err))
            .finally(() => { outerRunning = false; });
        });
        cron.schedule(config.reviewCron, () => {
          if (reviewRunning) {
            console.log(chalk.yellow('⚠ 上一轮观察复查仍在运行，本次调度跳过'));
            return;
          }
          reviewRunning = true;
          runScheduledReviews()
            .catch(err => console.log(chalk.red('观察复查出错:'), err))
            .finally(() => { reviewRunning = false; });
        });

        // 常驻不退出（cron 由 node-cron 内部定时器驱动）
        await new Promise(() => {});
        return;
      }

      // 单次模式
      if (runBoth || options.innerOnly) await runInnerLoop();
      if (runBoth || options.outerOnly) await runOuterLoop();

      // 状态摘要
      const pending = countUnverifiedWords();
      console.log(chalk.gray(`\n📋 未验证词队列: 还剩 ${pending} 个待外环处理`));
    });

  program
    .command('review')
    .description('执行到期观察任务（置信度不足/失败/待观察关键词）')
    .option('-l, --limit <count>', '本轮最多处理数量', String(config.reviewBatch))
    .action(async (options: { limit?: string }) => {
      const parsed = parseInt(options.limit || String(config.reviewBatch), 10);
      const limit = Number.isFinite(parsed) ? Math.max(0, parsed) : config.reviewBatch;
      await runScheduledReviews(limit);
    });

  program
    .command('games')
    .description('运行游戏优先雷达：发现游戏、入持久化队列、初筛建站机会并扩词')
    .option('-l, --limit <count>', '本轮最多分析几款（发现入库不受限制）', String(config.gameAnalysisBatch))
    .action(async (options: { limit?: string }) => {
      const parsed = parseInt(options.limit || String(config.gameAnalysisBatch), 10);
      const limit = Number.isFinite(parsed) ? Math.max(0, parsed) : config.gameAnalysisBatch;
      await runGameRadar(limit);
      const stats = gameStats();
      console.log(chalk.gray(`\n📋 游戏池: ${stats.total} | 待分析 ${stats.pending + stats.retry} | 已完成 ${stats.processed} | 推荐 ${stats.recommended}`));
    });

  // Web 管理面板（独立启动，或随 watch 模式自动带起）
  program
    .command('webui')
    .description('启动 Web 管理面板（浏览器中检索/筛选/通过/淘汰/删除词库）')
    .option('-p, --port <port>', '监听端口', String(config.webuiPort))
    .action(async (options: { port?: string }) => {
      await startWebUi(parseInt(options.port || String(config.webuiPort), 10));
      console.log(chalk.gray('   按 Ctrl+C 停止'));
      // 常驻不退出
      await new Promise(() => {});
    });

  // 默认动作：无子命令时执行（find / list / watch）
  // 注意：定义了子命令后必须给主程序配 action handler，
  // 否则 commander 会认为“漏了子命令”而打印帮助并退出
  program.action(async () => {
    const opts = program.opts();
    const category = opts.category as 'game' | 'ai' | 'all';

    // 查看词库模式
    if (opts.list) {
      printWordLibrary();
      return;
    }

    if (opts.seeds) {
      config.seedsPerRun = parseInt(opts.seeds, 10);
    }

    // 定时模式
    if (opts.watch) {
      console.log(chalk.cyan(`⏰ 定时模式启动，每天 ${config.cronSchedule} 自动运行`));
      console.log(chalk.gray(`   观察复查: ${config.reviewCron}`));
      console.log(chalk.gray('   按 Ctrl+C 停止\n'));

      // 管理面板随常驻模式自动带起
      await startWebUi();

      // 先立即运行一次
      await executeAndReport(category);

      // 设置定时任务
      let scheduledRunActive = false;
      let scheduledReviewActive = false;
      cron.schedule(config.cronSchedule, async () => {
        if (scheduledRunActive) {
          console.log(chalk.yellow('⚠ 上一轮找词任务仍在运行，本次调度跳过'));
          return;
        }
        scheduledRunActive = true;
        console.log(chalk.cyan(`\n⏰ [${new Date().toLocaleString()}] 定时任务触发\n`));
        try {
          await executeAndReport(category);
        } catch (err) {
          console.log(chalk.red('定时找词出错:'), err);
        } finally {
          scheduledRunActive = false;
        }
      });
      cron.schedule(config.reviewCron, () => {
        if (scheduledReviewActive) return;
        scheduledReviewActive = true;
        runScheduledReviews()
          .catch(err => console.log(chalk.red('观察复查出错:'), err))
          .finally(() => { scheduledReviewActive = false; });
      });

      return;
    }

    // 单次运行模式
    await executeAndReport(category);
  });

  await program.parseAsync(process.argv);
}

// 运行
main().catch(err => {
  console.error(chalk.red('❌ 运行出错:'), err);
  process.exit(1);
});
