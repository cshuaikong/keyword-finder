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
  return (await inspectDomain(domain)).status === 'available';
}

type DomainCheckStatus = 'available' | 'taken' | 'uncertain';

function isMissingDnsRecord(err: any): boolean {
  return ['ENOTFOUND', 'ENODATA', 'ENODOMAIN', 'NXDOMAIN'].includes(err?.code);
}

async function inspectDomain(domain: string): Promise<{ status: DomainCheckStatus; reason: string }> {
  let dnsUncertain = false;
  const resolvers: Array<(name: string) => Promise<unknown[]>> = [
    name => dns.resolve4(name),
    name => dns.resolveMx(name),
    name => dns.resolveNs(name),
  ];
  for (const resolveRecord of resolvers) {
    try {
      const records = await resolveRecord(domain);
      if (Array.isArray(records) && records.length > 0) return { status: 'taken', reason: 'DNS 记录存在' };
    } catch (err: any) {
      if (!isMissingDnsRecord(err)) dnsUncertain = true;
    }
  }

  const registered = await isRegisteredByRdap(domain);
  if (registered === true) return { status: 'taken', reason: 'RDAP 已注册' };
  if (registered === false) return { status: 'available', reason: 'RDAP 确认未注册' };
  return {
    status: 'uncertain',
    reason: dnsUncertain ? 'DNS/RDAP 请求失败' : '无 DNS 记录但 RDAP 无法确认',
  };
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
  uncertain: string[];
  anyAvailable: boolean;
  confidence: number;
}> {
  const baseDomain = keywordToDomain(keyword);

  // 跳过过短或过长的域名
  if (baseDomain.length < 3 || baseDomain.length > 30) {
    return { available: [], taken: [], uncertain: [], anyAvailable: false, confidence: 0 };
  }

  const available: string[] = [];
  const taken: string[] = [];
  const uncertain: string[] = [];

  // 并行检查所有后缀（DNS 查询很快）
  const checks = DOMAIN_SUFFIXES.map(async (suffix) => {
    const fullDomain = baseDomain + suffix;
    const check = await inspectDomain(fullDomain);
    return { domain: fullDomain, ...check };
  });

  const results = await Promise.all(checks);

  for (const r of results) {
    if (r.status === 'available') {
      available.push(r.domain);
    } else if (r.status === 'taken') {
      taken.push(r.domain);
    } else {
      uncertain.push(r.domain);
    }
  }

  return {
    available,
    taken,
    uncertain,
    anyAvailable: available.length > 0,
    confidence: Math.round(((available.length + taken.length) / Math.max(results.length, 1)) * 100),
  };
}
