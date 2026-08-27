/**
 * 域名可用性检查模块
 * 双重检查：DNS 查询（是否已建站） + RDAP 查询（是否已注册）
 * RDAP 是免费 WHOIS 替代协议，无需 API 密钥
 */

import dns from 'node:dns/promises';
import { fetchJson } from './http.js';

/** RDAP 查询结果（简化） */
interface RdapResponse {
  errorCode?: number;
  ldhName?: string;
}

/** 要检查的域名后缀列表 */
const DOMAIN_SUFFIXES = ['.com', '.io', '.co', '.net', '.org'];

/**
 * RDAP 查询域名是否已注册
 * 返回: true=已注册, false=可注册, null=无法判断
 * RDAP 比 DNS 更准确——很多域名被注册了但没建站（无 DNS 记录）
 * 注意：rdap.org 可能对部分代理 IP 返回 403，此时无法判断
 */
async function isRegisteredByRdap(domain: string): Promise<boolean | null> {
  try {
    const data = await fetchJson<RdapResponse>(
      `https://rdap.org/domain/${domain}`,
      { 'Accept': 'application/rdap+json, application/json' },
    );

    // 404 或 errorCode 404 表示未注册
    if (data?.errorCode === 404) return false;
    // 有 ldhName 表示已注册
    if (data?.ldhName) return true;

    return null;
  } catch (err: any) {
    // HTTP 404 会抛异常，视为未注册
    if (err?.message?.includes('404')) return false;
    // 403/网络错误等：无法判断（代理 IP 可能被 rdap.org 拦截）
    return null;
  }
}

/**
 * 检查单个域名是否可用（未被注册/使用）
 * 双重检查：DNS + RDAP
 */
export async function isDomainAvailable(domain: string): Promise<boolean> {
  try {
    // 尝试解析 A 记录
    await dns.resolve4(domain);
    return false; // 有 A 记录，域名已被使用
  } catch {
    // A 记录不存在，继续检查其他记录
  }

  try {
    // 尝试解析 MX 记录（邮件服务器）
    await dns.resolveMx(domain);
    return false; // 有 MX 记录，域名已被使用
  } catch {
    // MX 记录不存在
  }

  try {
    // 尝试解析 NS 记录
    await dns.resolveNs(domain);
    return false; // 有 NS 记录，域名已被使用
  } catch {
    // NS 记录不存在
  }

  // DNS 全部无记录，再查 RDAP 确认是否已注册但未建站
  // 注意：RDAP 对部分后缀（.io/.co）支持不稳定，无法判断时只信 DNS 结果
  try {
    const registered = await isRegisteredByRdap(domain);
    if (registered === true) return false;
    // registered === false 或 null 都继续，按 DNS 结果处理
  } catch {
    // RDAP 查询失败，只信 DNS 结果
  }

  // DNS 无记录 + RDAP 未注册 → 可以注册
  return true;
}

/**
 * 将关键词转换为域名格式
 * 例如: "ai game generator" → "aigamegenerator"
 */
export function keywordToDomain(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // 去掉特殊字符
    .replace(/\s+/g, '')          // 去掉空格
    .replace(/-/g, '');           // 去掉连字符
}

/**
 * 批量检查关键词的域名可用性
 * 返回可用的域名列表
 */
export async function checkDomainAvailability(keyword: string): Promise<{
  available: string[];
  taken: string[];
  anyAvailable: boolean;
}> {
  const baseDomain = keywordToDomain(keyword);

  // 跳过过短或过长的域名
  if (baseDomain.length < 3 || baseDomain.length > 30) {
    return { available: [], taken: [], anyAvailable: false };
  }

  const available: string[] = [];
  const taken: string[] = [];

  // 并行检查所有后缀（DNS 查询很快）
  const checks = DOMAIN_SUFFIXES.map(async (suffix) => {
    const fullDomain = baseDomain + suffix;
    const isAvailable = await isDomainAvailable(fullDomain);
    return { domain: fullDomain, available: isAvailable };
  });

  const results = await Promise.all(checks);

  for (const r of results) {
    if (r.available) {
      available.push(r.domain);
    } else {
      taken.push(r.domain);
    }
  }

  return {
    available,
    taken,
    anyAvailable: available.length > 0,
  };
}
