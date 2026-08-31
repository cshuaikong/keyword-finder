/**
 * 关键词中文翻译模块
 * 多级降级策略：
 *   1. Google Translate 免费接口（速度快，但代理 IP 可能被 429）
 *   2. MyMemory 免费 API（稳定，匿名额度 5000 字符/天）
 *   3. 本地常用词词典（离线兜底，保证核心词有翻译）
 */

import { fetchJson } from '../modules/http.js';

/** 简单内存缓存：同一进程内相同词只翻译一次 */
export interface TranslationResult {
  text: string;
  provider: 'google' | 'mymemory' | 'dictionary' | 'none';
  fromCache: boolean;
}

const cache = new Map<string, Omit<TranslationResult, 'fromCache'>>();

/** 本地常用词词典（离线兜底） */
const LOCAL_DICT: Record<string, string> = {
  'game': '游戏', 'games': '游戏', 'gaming': '游戏',
  'online': '在线', 'free': '免费', 'play': '玩', 'player': '玩家',
  'ai': 'AI', 'tool': '工具', 'tools': '工具',
  'generator': '生成器', 'maker': '制作器', 'builder': '构建器',
  'converter': '转换器', 'calculator': '计算器', 'counter': '计数器',
  'checker': '检查器', 'downloader': '下载器', 'editor': '编辑器',
  'remover': '移除器', 'enhancer': '增强器', 'compressor': '压缩器',
  'resizer': '缩放器', 'summarizer': '摘要器', 'paraphraser': '改写器',
  'translator': '翻译器', 'optimizer': '优化器', 'tester': '测试工具',
  'simulator': '模拟器', 'solver': '求解器', 'dashboard': '仪表盘',
  'quiz': '测验', 'trivia': '冷知识问答', 'puzzle': '谜题',
  'arcade': '街机', 'shooter': '射击', 'strategy': '策略',
  'multiplayer': '多人', 'walkthrough': '攻略', 'cheats': '作弊码',
  'codes': '代码', 'mod': '模组', 'apk': '安卓安装包',
  'download': '下载', 'unblocked': '不封锁的', 'snake': '贪吃蛇',
  'word': '单词', 'words': '单词', 'text': '文本', 'image': '图片',
  'video': '视频', 'audio': '音频', 'pdf': 'PDF', 'youtube': '油管',
  'google': '谷歌', 'notes': '笔记', 'note': '笔记',
  'timer': '计时器', 'list': '列表',
  'random': '随机', 'name': '名字', 'meme': '表情包',
  'mortal': '凡人', 'shell': '壳', 'stalker': '潜行者',
  'coloring': '涂色', 'page': '页', 'board': '棋盘',
  'card': '卡片', 'fight': '战斗', 'battle': '战斗',
  'driving': '驾驶', 'racing': '赛车',
  'sport': '运动', 'soccer': '足球', 'football': '足球',
  'basketball': '篮球', 'baseball': '棒球', 'tennis': '网球',
  'lyrics': '歌词', 'answers': '答案', 'meaning': '含义',
  'definition': '定义', 'wiki': '维基', 'guide': '指南',
  'tutorial': '教程', 'tips': '技巧', 'news': '新闻',
  'how': '如何', 'to': '去', 'the': '', 'a': '', 'an': '',
  'of': '的', 'in': '在', 'for': '为了', 'with': '和',
  'and': '和', 'or': '或', 'vs': '对比', 'new': '新的',
  'best': '最好的', 'top': '顶部', '2': '2', '3': '3',
  'is': '是', 'what': '什么', 'why': '为什么',
};

/** 逐词词典翻译（离线兜底） */
function translateByDict(text: string): string {
  const words = text.toLowerCase().split(/\s+/);
  const parts: string[] = [];

  for (const w of words) {
    const mapped = LOCAL_DICT[w];
    if (mapped !== undefined) {
      if (mapped) parts.push(mapped); // 空串 = 跳过停用词
    } else if (/^[\d.]+$/.test(w)) {
      parts.push(w);
    } else {
      parts.push(w); // 未知词保留原文
    }
  }

  return parts.join(' ');
}

/** Google Translate 免费接口 */
async function tryGoogle(text: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
  const data = await fetchJson<any>(url, { 'Accept': 'application/json' });

  const first = data?.[0];
  if (Array.isArray(first) && first.length > 0) {
    const translated = first
      .map((seg: any) => seg?.[0] || '')
      .join('')
      .trim();
    if (translated) return translated;
  }
  return '';
}

/** MyMemory 免费 API */
async function tryMyMemory(text: string): Promise<string> {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`;
  const data = await fetchJson<any>(url, { 'Accept': 'application/json' });

  if (data?.responseStatus === 200) {
    const translated = data?.responseData?.translatedText;
    if (translated && typeof translated === 'string' && translated.trim()) {
      return translated.trim();
    }
  }
  return '';
}

/**
 * 翻译英文关键词为中文（多级降级）
 */
export async function translateToChinese(text: string): Promise<string> {
  return (await translateToChineseDetailed(text)).text;
}

export async function translateToChineseDetailed(text: string): Promise<TranslationResult> {
  const key = text.toLowerCase().trim();
  if (!key) return { text: '', provider: 'none', fromCache: false };

  // 命中缓存直接返回
  if (cache.has(key)) {
    return { ...cache.get(key)!, fromCache: true };
  }

  // 1. Google Translate
  try {
    const zh = await tryGoogle(text);
    if (zh) {
      cache.set(key, { text: zh, provider: 'google' });
      return { text: zh, provider: 'google', fromCache: false };
    }
  } catch {
    // Google 失败（限流等），继续降级
  }

  // 2. MyMemory
  try {
    const zh = await tryMyMemory(text);
    if (zh) {
      cache.set(key, { text: zh, provider: 'mymemory' });
      return { text: zh, provider: 'mymemory', fromCache: false };
    }
  } catch {
    // MyMemory 失败，继续降级
  }

  // 3. 本地词典兜底
  const dictZh = translateByDict(text);
  if (dictZh && dictZh !== text) {
    cache.set(key, { text: dictZh, provider: 'dictionary' });
    return { text: dictZh, provider: 'dictionary', fromCache: false };
  }

  cache.set(key, { text: '', provider: 'none' });
  return { text: '', provider: 'none', fromCache: false };
}

/**
 * 批量翻译（串行，带间隔避免限流）
 */
export async function translateBatch(texts: string[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (const text of texts) {
    const zh = await translateToChinese(text);
    results.set(text, zh);
    // 间隔 300ms，避免触发限流
    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}
