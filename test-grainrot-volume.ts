import './src/proxy.js';
import { config } from './src/config.js';
import { fetchJson } from './src/modules/http.js';
import { getVolumeAndTrend } from './src/modules/trends.js';

async function main() {
  // 1. RELATED_QUERIES 全量（top + rising）—— 词群盘子
  console.log('========== RELATED_QUERIES: "grain rot" ==========');
  try {
    const qs = new URLSearchParams({
      engine: 'google_trends',
      api_key: config.serpapiKey,
      hl: 'en',
      q: 'grain rot',
      data_type: 'RELATED_QUERIES',
      date: 'now 7-d',
    });
    const data = await fetchJson<any>(`https://serpapi.com/search?${qs.toString()}`);
    const top = data?.related_queries?.top || [];
    const rising = data?.related_queries?.rising || [];
    console.log('--- TOP (当前量最大的相关词) ---');
    for (const t of top) console.log(`  ${t.query}  [value: ${t.value}]`);
    console.log('--- RISING ---');
    for (const r of rising) console.log(`  ${r.query}  [${r.value}]`);
  } catch (e: any) {
    console.log('RELATED_QUERIES ERR', e?.message ?? e);
  }

  // 2. 核心长尾词逐个查量级（带缓存，命中不耗额度）
  const tails = [
    'grain rot',
    'grain rot game',
    'grain rot wiki',
    'grain rot enemies',
    'grain rot key',
    'grain rot weapons',
    'grain rot solo',
    'grain rot boss',
    'grain rot steam',
    'grain rot how to play',
  ];
  console.log('\n========== TIMESERIES 长尾词量级 ==========');
  for (const t of tails) {
    const v = await getVolumeAndTrend(t);
    console.log(`  ${t.padEnd(24)} → ${v.volumeLevel}  avg=${v.volumeAvg ?? '?'}  ${v.trendDirection}${v.trendNote ? ' (' + v.trendNote + ')' : ''}`);
  }
}
main();
