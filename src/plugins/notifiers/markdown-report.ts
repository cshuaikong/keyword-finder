/**
 * Markdown 报告输出插件
 * 生成 Markdown 报告 + 保存原始 JSON 数据（时间戳命名，每次运行独立文件）
 * 从原 modules/report.ts 迁移而来
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { config } from '../../config.js';
import type { NotifierPlugin } from '../../core/plugin.js';
import type { FindResult } from '../../types.js';

/** 来源 → 中文标签 */
function sourceLabel(source?: string): string {
  if (!source) return '—';
  if (source.startsWith('reddit')) return '🟠 Reddit';
  if (source.startsWith('hn:')) return '🟡 Hacker News';
  if (source.startsWith('github')) return '⚫ GitHub';
  if (source.startsWith('sitemap')) return '🔵 游戏站地图';
  if (source === 'trends') return '🔴 Google Trends';
  return source;
}

/** 量级 → 中文 */
function volumeLabel(level: string): string {
  switch (level) {
    case 'A': return 'A 极高';
    case 'B': return 'B 高';
    case 'C': return 'C 中';
    case 'D': return 'D 低';
    default: return '?';
  }
}

/** 趋势方向 → 中文 */
function trendDirectionLabel(direction: string): string {
  switch (direction) {
    case 'up': return '📈 上升';
    case 'stable': return '➡️ 平稳';
    case 'down': return '📉 下降';
    case 'new': return '✨ 新词';
    default: return '?';
  }
}

/** 开发难度 → 中文 */
function difficultyLevelLabel(level: string): string {
  switch (level) {
    case 'low': return '🟢 低（1天可上线）';
    case 'medium': return '🟡 中（3-7天）';
    case 'high': return '🔴 高（需API开发）';
    default: return '?';
  }
}

/** 变现潜力 → 中文 */
function monetizationLabel(level: string): string {
  switch (level) {
    case 'high': return '💰 高';
    case 'medium': return '💰 中';
    case 'low': return '💰 低';
    default: return '?';
  }
}

/** 行动建议 → 中文 */
function actionLabel(action: string): string {
  switch (action) {
    case 'register-now': return '🚀 立即注册';
    case 'watch': return '👀 观察一周';
    case 'skip': return '⛔ 放弃';
    default: return '?';
  }
}

/**
 * 生成 Markdown 格式的找词报告
 */
export function generateMarkdown(result: FindResult): string {
  const date = formatDate(result.runAt);
  const lines: string[] = [];

  lines.push(`# 找词报告 - ${date}`);
  lines.push('');
  lines.push(`> 运行耗时: ${(result.duration / 1000).toFixed(1)}s`);
  lines.push(`> 使用词根: ${result.seedsUsed.join(', ')}`);
  lines.push(`> 发现候选词: ${result.candidates.length} 个`);
  lines.push(`> 验证通过: ${result.validated.length} 个`);
  lines.push('');

  // 推荐词（按评分排序）
  if (result.validated.length > 0) {
    lines.push('## 推荐词（按评分排序）');
    lines.push('');
    lines.push('| # | 关键词 | 中文 | 评分 | 来源 | 量级 | 趋势 | 难度 | 变现 | 域名 |');
    lines.push('|---|--------|------|------|------|------|------|------|------|------|');

    result.validated.forEach((kw, i) => {
      const domain = kw.domainAvailable
        ? `✅ ${kw.availableDomains[0] || ''}`
        : '❌';
      lines.push(
        `| ${i + 1} | **${kw.keyword}**${kw.intel.brandRisk ? ' ⚠' : ''} | ${kw.intel.chineseMeaning || '—'} | ${kw.score} | ${sourceLabel(kw.source)} | ${volumeLabel(kw.intel.volumeLevel)} | ${trendDirectionLabel(kw.intel.trendDirection)} | ${difficultyLevelLabel(kw.intel.devDifficulty)} | ${monetizationLabel(kw.intel.monetization)} | ${domain} |`
      );
    });

    lines.push('');
  }

  // 主题簇（同主题关键词分组，可做整站）
  if (result.clusters && result.clusters.length > 0) {
    lines.push('## 🗂 主题簇（可整站开发的词）');
    lines.push('');
    lines.push('以下关键词共享同一主题，可以做一个站同时覆盖多个词：');
    lines.push('');

    result.clusters.forEach((cluster, i) => {
      lines.push(`### 簇 ${i + 1}: ${cluster.theme}`);
      lines.push('');
      lines.push(`> ${cluster.keywords.join(' | ')}`);
      lines.push('');
    });
  }

  // 详细分析
  if (result.validated.length > 0) {
    lines.push('## 详细分析');
    lines.push('');

    result.validated.forEach((kw, i) => {
      const intel = kw.intel;
      lines.push(`### ${i + 1}. ${kw.keyword}`);
      if (intel.chineseMeaning) {
        lines.push(`> 中文: ${intel.chineseMeaning}`);
      }
      lines.push('');
      lines.push(`- **评分**: ${kw.score}/100（趋势${kw.scoreBreakdown.trendScore} + 竞争${kw.scoreBreakdown.competitionScore} + 域名${kw.scoreBreakdown.domainScore} + 词形${kw.scoreBreakdown.lengthScore}）`);
      lines.push(`- **来源**: ${sourceLabel(kw.source)}（词根: ${kw.seedWord}）`);
      lines.push(`- **趋势**: ${kw.trendType === 'breakout' ? '🔥 Breakout' : `📈 +${(kw.growthPercent || 0).toLocaleString()}%`}`);
      lines.push(`- **搜索量级**: ${volumeLabel(intel.volumeLevel)}${intel.volumeAvg !== undefined ? `（指数 ${intel.volumeAvg}）` : ''}`);
      lines.push(`- **潜力趋势**: ${trendDirectionLabel(intel.trendDirection)}${intel.trendNote ? `，${intel.trendNote}` : ''}`);
      lines.push(`- **竞争难度**: ${difficultyText(kw.competition.difficulty)}`);
      lines.push(`- **开发难度**: ${difficultyLevelLabel(intel.devDifficulty)} - ${intel.devDifficultyReason}`);
      lines.push(`- **建议站型**: ${intel.siteType} | **变现潜力**: ${monetizationLabel(intel.monetization)}`);
      if (intel.brandRisk) {
        lines.push(`- **品牌风险**: ⚠ 含商标词「${intel.brandRisk}」- 不可注册域名，可做教程/内容内页`);
      }
      lines.push(`- **行动建议**: ${actionLabel(intel.action)} - ${intel.actionNote}`);
      lines.push(`- **竞品域名**: ${kw.competition.topDomains.slice(0, 5).join(', ') || '无'}`);
      lines.push(`- **可用域名**: ${kw.availableDomains.join(', ') || '无'}`);
      lines.push(`- **Google Trends**: https://trends.google.com/trends/explore?q=${encodeURIComponent(kw.keyword)}`);
      lines.push(`- **Google 搜索**: https://www.google.com/search?q=${encodeURIComponent(kw.keyword)}`);
      lines.push('');
    });
  }

  // 候选词列表（未验证的）
  if (result.candidates.length > 0) {
    lines.push('## 全部候选词（未验证）');
    lines.push('');
    lines.push('| # | 关键词 | 趋势 | 来源 |');
    lines.push('|---|--------|------|------|');

    result.candidates.slice(0, 50).forEach((kw, i) => {
      const trend = kw.trendType === 'breakout'
        ? '🔥 Breakout'
        : `📈 +${(kw.growthPercent || 0).toLocaleString()}%`;
      lines.push(`| ${i + 1} | ${kw.keyword} | ${trend} | ${sourceLabel(kw.source)} |`);
    });

    if (result.candidates.length > 50) {
      lines.push(`| ... | 还有 ${result.candidates.length - 50} 个词未显示 | | |`);
    }

    lines.push('');
  }

  // 下一步行动建议
  lines.push('## 下一步行动');
  lines.push('');
  lines.push('1. **选词**: 优先看「🚀 立即注册」+「量级 A/B」+「趋势上升」的词');
  lines.push('2. **注册域名**: 到 Namecheap/Cloudflare 注册可用域名');
  lines.push('3. **快速建站**: 按建议站型套模板，低难度词当天上线');
  lines.push('4. **验证搜索量**: 到 [Google 关键词规划工具](https://ads.google.com/) 查看真实搜索量');
  lines.push('5. **开始 SEO**: 做好页面标题、描述、内链结构');
  lines.push('');
  lines.push('---');
  lines.push(`*报告由 keyword-finder 自动生成于 ${new Date().toISOString()}*`);

  return lines.join('\n');
}

/**
 * 保存报告到文件
 * 文件名带时间戳，每次运行生成独立文件，不会被覆盖
 */
async function saveReport(markdown: string, reportDir: string, date: Date): Promise<string> {
  await mkdir(reportDir, { recursive: true });

  const filename = `report-${formatDateTime(date)}.md`;
  const filepath = resolve(reportDir, filename);
  await writeFile(filepath, markdown, 'utf-8');

  return filepath;
}

/**
 * 保存原始数据（JSON 格式，方便后续分析）
 */
async function saveRawData(result: FindResult, reportDir: string, date: Date): Promise<string> {
  await mkdir(reportDir, { recursive: true });

  const filename = `data-${formatDateTime(date)}.json`;
  const filepath = resolve(reportDir, filename);
  await writeFile(filepath, JSON.stringify(result, null, 2), 'utf-8');

  return filepath;
}

function formatDateTime(d: Date): string {
  const datePart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const timePart = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${datePart}-${timePart}`;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function difficultyText(d: string): string {
  switch (d) {
    case 'low': return '🟢 低竞争（蓝海）';
    case 'medium': return '🟡 中等竞争';
    case 'high': return '🔴 高竞争（有权威站）';
    default: return '未知';
  }
}

/**
 * Markdown 报告输出插件
 */
export const markdownReportNotifier: NotifierPlugin = {
  type: 'notifier',
  name: 'markdown-report',
  async notify(result) {
    const markdown = generateMarkdown(result);
    const reportPath = await saveReport(markdown, config.reportDir, result.runAt);
    const dataPath = await saveRawData(result, config.reportDir, result.runAt);

    console.log(chalk.gray(`  📄 报告已保存: ${reportPath}`));
    console.log(chalk.gray(`  📊 数据已保存: ${dataPath}`));
    console.log('');
  },
};
