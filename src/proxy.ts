/**
 * 代理引导模块
 * 在所有网络请求之前加载，为全局 HTTPS 请求设置代理
 *
 * 使用方式：
 *   1. 在 .env 中配置 HTTPS_PROXY=http://127.0.0.1:7890
 *   2. 或者在命令行设置环境变量
 *
 * 常见代理地址：
 *   - Clash: http://127.0.0.1:7890
 *   - V2Ray: http://127.0.0.1:10809
 *   - SSR: http://127.0.0.1:1080
 */

import { config } from './config.js';

const proxyUrl = config.httpsProxy || config.httpProxy || process.env.GLOBAL_AGENT_HTTP_PROXY;

if (proxyUrl) {
  // 设置 global-agent 环境变量
  process.env.GLOBAL_AGENT_HTTP_PROXY = proxyUrl;

  // 部分代理（如 bigbear）会拦截 HTTPS 并使用自签名证书，需要跳过证书验证
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  // 动态导入 global-agent（它会自动拦截所有 HTTPS 请求）
  try {
    const { bootstrap } = await import('global-agent');
    bootstrap();
    console.log(`🌐 代理已启用: ${proxyUrl}`);
  } catch (err) {
    console.warn(`⚠ 代理加载失败: ${proxyUrl}，将使用直连模式`);
  }
} else {
  console.log('⚠ 未配置代理，Google Trends 可能无法访问（国内需要代理）');
  console.log('  → 请在 .env 文件中配置 HTTPS_PROXY=http://127.0.0.1:7890');
}
