/**
 * HTTP 请求工具
 * Node.js 内置 fetch (undici) 不会自动走 global-agent 的代理
 * 这里统一封装带代理的请求
 */

import { ProxyAgent } from 'undici';
import { config } from '../config.js';

/** 获取代理 Agent（如果配置了代理） */
function getProxyAgent(): ProxyAgent | undefined {
  const proxyUrl = config.httpsProxy || config.httpProxy;
  if (!proxyUrl) {
    return undefined;
  }
  // undici 的 ProxyAgent 直接接受代理 URL
  return new ProxyAgent(proxyUrl);
}

/**
 * 带代理的 GET 请求
 * 返回响应文本
 */
export async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const dispatcher = getProxyAgent();

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers,
    },
    // @ts-ignore - dispatcher 是 undici 内部参数
    dispatcher,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

/**
 * 带代理的 GET JSON 请求
 */
export async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const text = await fetchText(url, headers);
  return JSON.parse(text) as T;
}

/**
 * 带代理的 GET 请求，返回二进制 Buffer
 * 用于 .gz 等二进制内容
 */
export async function fetchBuffer(url: string, headers?: Record<string, string>): Promise<Buffer> {
  const dispatcher = getProxyAgent();

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
      ...headers,
    },
    // @ts-ignore - dispatcher 是 undici 内部参数
    dispatcher,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
