/**
 * Web 管理面板（零依赖内置 HTTP 服务器）
 *
 * 跟随 radar --watch / find --watch 常驻运行时自动启动，
 * 也可以独立运行：npx tsx src/index.ts webui
 *
 * 提供：
 *   - GET  /            中文管理面板页面
 *   - GET  /api/stats   词库统计
 *   - GET  /api/words   词库检索（关键词/来源/量级/行动过滤 + 分页）
 *   - POST /api/words/accept     通过 → 需求库
 *   - POST /api/words/reject     淘汰 → 淘汰池
 *   - POST /api/words/delete     仅从词库删除
 *   - GET  /api/requirements     需求库列表
 *   - POST /api/requirements/status  更新建站状态
 *   - POST /api/requirements/delete  删除需求
 *   - GET  /api/rejects          淘汰池
 *   - POST /api/rejects/delete   删除淘汰记录
 *   - GET  /api/runs             运行记录
 *
 * 安全：默认只监听 127.0.0.1（本机访问），端口可配 WEBUI_PORT
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import {
  searchWords,
  deleteWord,
  deleteRequirement,
  deleteReject,
  acceptWord,
  rejectWord,
  updateRequirementStatus,
  queryRequirements,
  queryRejects,
  queryRuns,
  wordsStats,
  countUnverifiedWords,
} from '../core/db.js';
import chalk from 'chalk';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
/** 管理面板页面文件路径（public/index.html） */
const PAGE_PATH = resolve(__dirname, '../../public/index.html');

/** 读取 JSON 请求体 */
function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) rejectPromise(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {});
      } catch {
        rejectPromise(new Error('JSON 解析失败'));
      }
    });
    req.on('error', rejectPromise);
  });
}

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** 统一响应格式 */
function reply(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, data);
}

/** 解析查询参数 */
function parseQuery(url: string): Record<string, string> {
  const q: Record<string, string> = {};
  const idx = url.indexOf('?');
  if (idx < 0) return q;
  for (const [k, v] of new URLSearchParams(url.slice(idx + 1))) {
    q[k] = v;
  }
  return q;
}

/** 路由处理 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url || '/').split('?')[0];
  const method = req.method || 'GET';

  try {
    // ── 页面 ──
    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      if (!existsSync(PAGE_PATH)) {
        sendJson(res, 500, { error: `页面文件不存在: ${PAGE_PATH}` });
        return;
      }
      const html = readFileSync(PAGE_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ── 统计 ──
    if (method === 'GET' && url === '/api/stats') {
      const stats = wordsStats();
      reply(res, { ...stats, unverified: countUnverifiedWords() });
      return;
    }

    // ── 词库检索 ──
    if (method === 'GET' && url === '/api/words') {
      const q = parseQuery(req.url || '');
      const result = searchWords({
        keyword: q.q || undefined,
        source: q.source || undefined,
        volumeLevel: q.volume || undefined,
        action: q.action || undefined,
        sort: (q.sort as 'recent' | 'seen' | 'score') || 'recent',
        limit: q.limit ? parseInt(q.limit, 10) : 50,
        offset: q.offset ? parseInt(q.offset, 10) : 0,
      });
      reply(res, result);
      return;
    }

    // ── 词库操作 ──
    if (method === 'POST' && url === '/api/words/accept') {
      const body = await readJsonBody(req);
      reply(res, acceptWord(body.keyword, body.theme, body.note));
      return;
    }
    if (method === 'POST' && url === '/api/words/reject') {
      const body = await readJsonBody(req);
      reply(res, rejectWord(body.keyword, body.reason));
      return;
    }
    if (method === 'POST' && url === '/api/words/delete') {
      const body = await readJsonBody(req);
      reply(res, deleteWord(body.keyword));
      return;
    }

    // ── 需求库 ──
    if (method === 'GET' && url === '/api/requirements') {
      reply(res, queryRequirements(500));
      return;
    }
    if (method === 'POST' && url === '/api/requirements/status') {
      const body = await readJsonBody(req);
      reply(res, updateRequirementStatus(body.keyword, body.status));
      return;
    }
    if (method === 'POST' && url === '/api/requirements/delete') {
      const body = await readJsonBody(req);
      reply(res, deleteRequirement(body.keyword));
      return;
    }

    // ── 淘汰池 ──
    if (method === 'GET' && url === '/api/rejects') {
      reply(res, queryRejects(500));
      return;
    }
    if (method === 'POST' && url === '/api/rejects/delete') {
      const body = await readJsonBody(req);
      reply(res, deleteReject(body.keyword));
      return;
    }

    // ── 运行记录 ──
    if (method === 'GET' && url === '/api/runs') {
      reply(res, queryRuns(100));
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message || String(err) });
  }
}

/** 服务器单例（避免重复启动） */
let serverStarted = false;

/**
 * 启动 Web 管理面板
 * @param port 端口（默认 config.webuiPort）
 */
export async function startWebUi(port: number = config.webuiPort): Promise<void> {
  if (serverStarted) return;

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      if (!res.headersSent) sendJson(res, 500, { error: err?.message || String(err) });
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.log(chalk.yellow(`⚠ 端口 ${port} 已被占用，管理面板跳过（可能已在另一个进程运行）`));
        resolvePromise();
      } else {
        rejectPromise(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      serverStarted = true;
      console.log(chalk.magenta(`🌐 管理面板已启动: http://127.0.0.1:${port}`));
      console.log(chalk.gray(`   浏览器打开即可检索/筛选/通过/淘汰/删除词库`));
      resolvePromise();
    });
  });
}
