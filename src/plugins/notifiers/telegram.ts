/**
 * Telegram 推送输出插件
 * 把候选新词推送到 Telegram 频道/私聊
 * 从原 notify/telegram.ts 迁移而来
 *
 * 配置步骤：
 * 1. 在 Telegram 搜索 @BotFather，发送 /newbot 创建机器人，拿到 BOT_TOKEN
 * 2. 给你的机器人发一条消息
 * 3. 访问 https://api.telegram.org/bot<TOKEN>/getUpdates 拿到 chat_id
 * 4. 把 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID 填入 .env
 */

import { ProxyAgent } from 'undici';
import chalk from 'chalk';
import { config as appConfig } from '../../config.js';
import type { NotifierPlugin } from '../../core/plugin.js';

/** 要推送的词条结构 */
export interface NotifyItem {
  keyword: string;
  score: number;
  trendType: string;
  competition: string;
  domains: string[];
  chineseMeaning?: string;
  volumeLevel?: string;
  trendDirection?: string;
  devDifficulty?: string;
}

/** 检查 Telegram 是否已配置 */
export function isTelegramConfigured(): boolean {
  return Boolean(appConfig.telegramBotToken && appConfig.telegramChatId);
}

/**
 * 发送 Markdown 格式消息到 Telegram（带代理的 POST 请求）
 */
export async function sendTelegramMessage(text: string): Promise<boolean> {
  if (!isTelegramConfigured()) {
    console.log('  ⚠ Telegram 未配置（TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID），跳过推送');
    return false;
  }

  const url = `https://api.telegram.org/bot${appConfig.telegramBotToken}/sendMessage`;

  // undici 的 fetch 需要显式传入 ProxyAgent 才会走代理
  const proxyUrl = appConfig.httpsProxy || appConfig.httpProxy;
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: appConfig.telegramChatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
      // @ts-ignore - dispatcher 是 undici 内部参数
      dispatcher,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return true;
  } catch (err: any) {
    console.log(`  ✗ Telegram 推送失败: ${err?.message || err}`);
    return false;
  }
}

/**
 * 格式化候选词列表为 Telegram 消息
 */
export function formatTelegramMessage(items: NotifyItem[], title = '🔑 新词快报'): string {
  if (items.length === 0) {
    return `${title}\n\n今日无高价值新词`;
  }

  const lines = items.slice(0, 10).map((item, i) => {
    const domains = item.domains.slice(0, 2).join(' / ');
    const trend = item.trendType === 'breakout' ? '🔥' : '📈';
    const comp = item.competition === 'low' ? '🟢低竞争' : item.competition === 'medium' ? '🟡中竞争' : '🔴高竞争';
    const vol = item.volumeLevel && item.volumeLevel !== 'unknown' ? `量级${item.volumeLevel} ` : '';
    const zh = item.chineseMeaning ? `（${item.chineseMeaning}）` : '';
    const diff = item.devDifficulty ? ` 难度:${item.devDifficulty}` : '';
    return `${i + 1}. *${item.keyword}* ${zh} (${item.score}分)\n   ${trend} ${comp} ${vol}| ${domains || '❌域名不可用'}${diff}`;
  });

  return `${title}\n\n${lines.join('\n')}`;
}

/**
 * Telegram 推送输出插件
 */
export const telegramNotifier: NotifierPlugin = {
  type: 'notifier',
  name: 'telegram',
  async notify(result) {
    if (!isTelegramConfigured()) {
      console.log(chalk.yellow('📨 Telegram 未配置，跳过推送'));
      console.log('');
      return;
    }

    console.log(chalk.yellow('📨 推送 Telegram 快报...'));

    const items: NotifyItem[] = result.validated.slice(0, 10).map(kw => ({
      keyword: kw.keyword,
      score: kw.score,
      trendType: kw.trendType,
      competition: kw.competition.difficulty,
      domains: kw.availableDomains,
      chineseMeaning: kw.intel.chineseMeaning,
      volumeLevel: kw.intel.volumeLevel,
      trendDirection: kw.intel.trendDirection,
      devDifficulty: kw.intel.devDifficulty,
    }));

    const message = formatTelegramMessage(items);
    await sendTelegramMessage(message);
    console.log('');
  },
};
