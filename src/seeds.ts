/**
 * 词根库 - 来自哥飞社群总结 + 扩展
 * 这些是通用且流量大的关键词后缀/前缀
 * 使用时与具体主题组合，如 "game generator", "ai maker" 等
 */

// 游戏类常用词根（做小游戏站重点关注）
export const gameSeeds = [
  'game', 'games', 'play', 'player',
  'simulator', 'puzzle', 'arcade', 'racing',
  'shooter', 'adventure', 'strategy', 'board game',
  'io game', 'multiplayer', 'online game',
  'coloring page', 'quiz', 'trivia',
  'cheat', 'walkthrough', 'guide',
];

// AI 工具类词根
export const aiSeeds = [
  'ai', 'generator', 'creator', 'maker', 'builder',
  'converter', 'editor', 'enhancer', 'optimizer',
  'detector', 'analyzer', 'assistant', 'chat',
  'summarizer', 'paraphraser', 'humanizer',
  'simulator', 'tester', 'checker',
];

// 通用功能类词根（哥飞原始 51 词根 + 扩展）
export const generalSeeds = [
  'action', 'advisor', 'agent', 'analyzer',
  'anime', 'answer', 'art', 'assistant', 'audio',
  'avatar', 'best', 'builder', 'calculator', 'cartoon',
  'cataloger', 'character', 'chart', 'chat', 'cheat',
  'checker', 'clue', 'code', 'coloring page', 'comparator',
  'compiler', 'composer', 'connector', 'constructor', 'convert',
  'converter', 'crawler', 'creator', 'dashboard', 'designer',
  'detector', 'diagram', 'directory', 'downloader', 'editor',
  'emoji', 'enhancer', 'evaluator', 'example', 'explorer',
  'extractor', 'face', 'faq', 'figure', 'filter',
  'finder', 'font', 'format', 'generator', 'graph',
  'guide', 'helper', 'hint', 'how to', 'humanizer',
  'icon', 'ideas', 'illustration', 'image', 'interpreter',
  'layout', 'list', 'logo', 'maker', 'manager',
  'meme', 'model', 'modifier', 'monitor', 'music',
  'navigator', 'notifier', 'online', 'optimizer',
  'paraphraser', 'pattern', 'photo', 'picture', 'planner',
  'portal', 'portrait', 'processor', 'receiver',
  'recommend', 'recorder', 'resources', 'responder', 'restorer',
  'review', 'sample', 'scheduler', 'scraper', 'sender',
  'simulator', 'solver', 'song', 'sound', 'speech',
  'starter', 'studio', 'style', 'summarizer', 'summary',
  'syncer', 'tattoo', 'template', 'tester', 'text',
];

// 全部词根（去重合并）
export const allSeeds = [...new Set([...gameSeeds, ...aiSeeds, ...generalSeeds])];

/**
 * 根据分类获取词根
 */
export function getSeedsByCategory(category: 'game' | 'ai' | 'all'): string[] {
  switch (category) {
    case 'game':
      return gameSeeds;
    case 'ai':
      return aiSeeds;
    case 'all':
      return allSeeds;
    default:
      return allSeeds;
  }
}

/**
 * 根据日期确定性轮换取词根（雷达模式用）
 *
 * 与随机选取不同：同一日期永远返回同一组词根，保证：
 *   - 长周期内词根均匀轮换（如每日 2 个，24 词根 12 天轮完）
 *   - 结果可复盘（某天发现哪些词可回溯当日词根）
 *   - 多实例/重启不重复消耗
 *
 * @param date   基准日期（默认今天）
 * @param count  每次取几个词根
 */
export function getSeedsByDate(
  date: Date = new Date(),
  count = 2,
  category: 'game' | 'ai' | 'all' = 'game',
): string[] {
  const pool = getSeedsByCategory(category);
  // 以天为单位计算偏移：每天偏移 count 个，保证顺序轮换
  const dayNumber = Math.floor(date.getTime() / 86400000);
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = (dayNumber * count + i) % pool.length;
    picked.push(pool[idx]);
  }
  return picked;
}

/**
 * 随机选取指定数量的词根
 */
export function getRandomSeeds(count: number, category: 'game' | 'ai' | 'all' = 'all'): string[] {
  const seeds = getSeedsByCategory(category);
  const shuffled = [...seeds].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, seeds.length));
}
