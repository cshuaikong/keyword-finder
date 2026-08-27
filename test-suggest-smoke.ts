/** 临时冒烟测试：suggestMine 单种子耗时与产出 */
import './src/proxy.js';
import { suggestMine } from './src/modules/suggest.js';

async function main() {
  const t0 = Date.now();
  const list = await suggestMine('online game', 150);
  console.log(`done: ${list.length} words in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('sample:', list.slice(0, 8).map(k => k.keyword).join(' | '));
  process.exit(0);
}
main();
