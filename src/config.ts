import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../.env') });

export interface Config {
  serpapiKey: string;
  httpProxy: string;
  httpsProxy: string;
  cronSchedule: string;
  seedsPerRun: number;
  reportDir: string;
  trendsDelay: number; // 请求间隔(ms)，避免被限流
  maxRelatedQueries: number; // 每个词根最多取多少个相关词
  geo: string; // Google Trends 地区
  telegramBotToken: string;
  telegramChatId: string;
  verifyPerRun: number; // 每轮最多验证多少个候选词
  disableSources: string[]; // 禁用的数据源列表（旧配置，向后兼容）
  disablePlugins: string[]; // 禁用插件列表（新配置，适用于所有插件类型）
  dbPath: string; // SQLite 数据库文件路径
}

export const config: Config = {
  serpapiKey: process.env.SERPAPI_KEY || '',
  httpProxy: process.env.HTTP_PROXY || '',
  httpsProxy: process.env.HTTPS_PROXY || '',
  cronSchedule: process.env.CRON_SCHEDULE || '0 8 * * *',
  seedsPerRun: parseInt(process.env.SEEDS_PER_RUN || '5', 10),
  reportDir: process.env.REPORT_DIR || resolve(__dirname, '../reports'),
  trendsDelay: 3000, // Google Trends 限流较严，3秒间隔
  maxRelatedQueries: 15,
  geo: '', // 空=全球，可设为 'US', 'JP', 'KR' 等
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  verifyPerRun: parseInt(process.env.VERIFY_PER_RUN || '20', 10),
  disableSources: (process.env.DISABLE_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean),
  // 插件禁用列表：如 DISABLE_PLUGINS=telegram,sitemap 可禁用任意类型的插件
  disablePlugins: (process.env.DISABLE_PLUGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  dbPath: process.env.DATA_DB_PATH || resolve(__dirname, '../data/keywords.db'),
};
