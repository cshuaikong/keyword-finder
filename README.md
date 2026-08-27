# 🔑 Keyword Finder - 自动找词工具（v2.0 插件化）

基于哥飞「找新词」方法论 + 插件化架构，自动发现飙升关键词并验证可行性。

## 系统架构（插件化）

```
                    ┌─ core/ 框架层 ─────────────┐
                    │  plugin.ts   插件接口定义   │
                    │  registry.ts 插件注册表     │
                    │  pipeline.ts 流程编排引擎   │
                    │  db.ts       SQLite 数据层  │
                    └────────────────────────────┘
                                 │ 调用
        ┌────────────────────────┼────────────────────────┐
        ↓                        ↓                        ↓
┌─ 数据源插件（并行抓取）──┐  ┌─ 处理插件 ──────────┐  ┌─ 输出插件 ──────────┐
│  trends   词根→飙升词    │  │  ngram     提取器   │  │  markdown-report    │
│  reddit   热帖 RSS       │  │  domain    域名分析 │  │  telegram 快报推送  │
│  hackernews 炫耀帖       │  │  competition 竞品   │  │  sqlite-storage 入库 │
│  github   Trending       │  │  volume-trend 量级 │  └─────────────────────┘
│  sitemap  大站新增页面   │  │  translate  中文    │
└──────────────────────────┘  │  standard-scorer 评分│
                              └──────────────────────┘
```

每个执行环节都是**可插拔插件**：新增数据源 = 新建一个文件；替换提取器 = 替换一个文件；禁用任何环节 = 改 .env 一行配置。

## 项目结构

```
src/
├── index.ts              # 入口：CLI 解析 + 插件注册（薄）
├── config.ts             # 配置（.env 读取）
├── seeds.ts              # 词根库（game/ai/all 共 122 词根）
├── proxy.ts              # 代理引导（国内访问 Google 必需）
├── types.ts              # 领域类型定义
├── core/                 # 框架层（不依赖具体业务）
│   ├── plugin.ts         # 六类插件接口 + RunContext
│   ├── registry.ts       # 插件注册表（按名注册/禁用/查询）
│   ├── pipeline.ts       # 流程编排：词根→抓取→提取→分析→评分→输出
│   ├── cluster.ts        # 关键词聚类（主题簇）
│   ├── summary.ts        # 控制台摘要输出
│   └── db.ts             # SQLite 四表（words/requirements/rejects/runs）
├── plugins/              # 插件层（业务逻辑所在）
│   ├── sources/          # 数据源插件（5 个）
│   ├── extractors/       # 提取器插件（n-gram）
│   ├── analyzers/        # 分析器插件（域名/竞品/量级/翻译）
│   ├── scorers/          # 评分器插件（standard）
│   ├── notifiers/        # 输出插件（报告/推送/入库）
│   └── index.ts          # 内置插件注册清单
└── modules/              # 引擎函数库（被插件薄包装复用）
    ├── http.ts           # 带代理的 HTTP 请求封装
    ├── trends.ts         # Google Trends 查询引擎
    ├── domain.ts         # DNS+RDAP 域名检查引擎
    ├── translate.ts      # 三级降级翻译引擎
    └── assess.ts         # 情报规则引擎（难度/变现/站型/品牌检测）
```

## 核心功能

1. **多数据源发现** - Google Trends 飙升词 + Reddit/HN/GitHub 热帖提取新词 + 游戏大站 sitemap 新增页面反推新词
2. **域名检查** - DNS + RDAP 双重检查，能识别「已注册但没建站」的域名
3. **竞品分析** - 通过 Bing 搜索结果分析竞争强度（低/中/高）
4. **情报增强** - 中文翻译（Google/MyMemory/离线词典三级降级）+ 搜索量级（A-D）+ 趋势方向（上升/平稳/下降/新词）
5. **规则评估** - 自动判断开发难度、变现潜力、建议站型，给出「立即注册/观察/放弃」行动建议
6. **品牌风险检测** - 60+ 商标词库（词边界匹配），品牌词自动标记 ⚠ 并从可注册列表剔除
7. **关键词簇** - 同主题词自动分组，一眼看出哪些词可以做一个站同时覆盖
8. **SQLite 词库** - 每次运行结果自动入库（新词库/淘汰池/运行记录），重复出现的词累计出现次数
9. **Markdown 报告** - 时间戳命名，每次运行独立文件
10. **Telegram 推送 + 定时模式** - 每日快报推送到手机，cron 自动运行

## 快速开始

### 1. 安装依赖

```bash
cd keyword-finder
npm install
```

### 2. 配置代理（国内必须）

编辑 `.env` 文件，填入你的代理地址：

```env
HTTPS_PROXY=http://127.0.0.1:32081
```

常见代理端口：
- BigBear 客户端: `http://127.0.0.1:32081`（已配置）
- Clash: `http://127.0.0.1:7890`
- V2Ray: `http://127.0.0.1:10809`
- SSR: `http://127.0.0.1:1080`

> 提示：如果不知道代理端口，可以在 PowerShell 执行：
> ```powershell
> Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" | Select-Object ProxyServer
> ```
> 系统代理开启时，`ProxyServer` 显示的就是端口。

### 3. 配置 Telegram 推送（可选）

1. Telegram 搜 `@BotFather` → 发 `/newbot` 创建机器人 → 拿到 `BOT_TOKEN`
2. 给你的机器人发一条消息
3. 浏览器访问 `https://api.telegram.org/bot<TOKEN>/getUpdates` → 拿到 `chat_id`
4. 填入 `.env`：

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=987654321
```

### 4. 运行

```bash
# 默认模式（全分类词根 + 全数据源）
npm run find

# 只找游戏类词
npm run find:game

# 只找 AI 工具类词
npm run find:ai

# 指定词根数量
npx tsx src/index.ts --seeds=8

# 定时模式（每天自动运行）
npm run watch

# 查看词库（新词库 + 需求库 + 淘汰池 + 运行记录）
npm run list
```

## 人工筛选（新词库 → 需求库）

每天 find 会把新词自动写入新词库（`words` 表）。人工筛选环节是哥飞方法论的关键：
四问过滤（用户意图？量级够吗？品牌冲突？竞品现状？）后，决定词的去向。

```bash
# ✅ 通过筛选：把词移入需求库，附主题分类和入选理由
npm run accept -- "coding agent" -t "AI 工具" -n "编码代理需求真实，竞争低"

# ⛔ 淘汰：记入淘汰池（附理由），从新词库移除
npm run reject -- "agent that grows" -r "意图抽象，非搜索词"

# 📋 更新建站进度: planned | developing | launched | abandoned
npm run status -- "coding agent" developing

# 查看整体进度（新词库/需求库/淘汰池/运行记录）
npm run list
```

工作流闭环：

1. `npm run watch` 每天自动找词入库（或手动 `npm run find`）
2. `npm run list` 查看新词，人工四问筛选
3. `accept` 通过 → 需求库（记主题/理由）→ 开始建站
4. `status` 跟踪建站进度：规划中 → 开发中 → 已上线 / 已放弃
5. `reject` 淘汰 → 淘汰池留档（再次被发现时会重新评估，淘汰不是永久的）

## 输出

运行后会在 `reports/` 目录生成：
- `report-2026-08-25-1100.md` - Markdown 格式报告（时间戳命名，每次独立）
- `data-2026-08-25-1100.json` - JSON 原始数据

在 `data/` 目录维护：
- `keywords.db` - SQLite 数据库（新词库/需求库/淘汰池/运行记录）
- `sitemap-cache.json` - 游戏大站 sitemap 缓存（用于对比新增页面）

## 插件开发指南

### 新增一个数据源（5 分钟）

1. 在 `src/plugins/sources/` 新建文件，实现 `SourcePlugin` 接口：

```typescript
import type { SourcePlugin } from '../../core/plugin.js';

export const producthuntSource: SourcePlugin = {
  type: 'source',
  name: 'producthunt',
  async fetch(ctx) {
    // 抓取 Product Hunt 首页新品标题
    const items = [/* { title, url, source, score } */];
    return { items };
  },
};
```

2. 在 `src/plugins/index.ts` 的 `builtinPlugins` 列表加入 `producthuntSource`

3. 完成。下次运行自动生效

### 替换提取器（换 AI 语义提取）

新建 `src/plugins/extractors/ai-semantic.ts` 实现 `ExtractorPlugin` 接口，在注册列表中替换掉 `ngramExtractor`，或通过 `.env` 的 `DISABLE_PLUGINS=ngram` 禁用旧的。

### 禁用任何环节

```env
# 禁用 Telegram 推送和 sitemap 数据源
DISABLE_PLUGINS=telegram,sitemap

# 旧配置项（只作用于数据源，向后兼容）
DISABLE_SOURCES=reddit,github
```

### 插件类型一览

| 类型 | 接口 | 职责 | 内置实现 |
|------|------|------|----------|
| source | `fetch(ctx)` | 抓取数据 | trends/reddit/hackernews/github/sitemap |
| extractor | `extract(items, ctx)` | 条目→候选词 | ngram |
| analyzer | `analyze(kw, ctx)` | 一维分析（并行） | domain/competition/volume-trend/translate |
| scorer | `score(kw, analyzed, ctx)` | 综合评分 | standard-scorer |
| notifier | `notify(result, ctx)` | 输出（顺序执行） | markdown-report/telegram/sqlite-storage |
| ai-provider | `complete(prompt, ctx)` | AI 补全（第2期预留） | - |

## 评分规则

| 维度 | 分值 | 说明 |
|------|------|------|
| 趋势分 | 0-30 | Breakout=30，Rising 按增长百分比 |
| 竞争分 | 0-30 | 低竞争=30，中=15，高=5 |
| 域名分 | 0-20 | 域名可注册=20 |
| 词形分 | 0-20 | 2-4 个单词=20；首尾语法词/连续重复词扣分 |

## 词根分类

- **game**: 游戏类（simulator, puzzle, arcade 等）
- **ai**: AI 工具类（generator, converter, editor 等）
- **all**: 全部 122 个词根

## 配置项（.env）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| HTTPS_PROXY | - | 代理地址（国内必须） |
| CRON_SCHEDULE | 0 8 * * * | 定时运行时间 |
| SEEDS_PER_RUN | 5 | 每次选取词根数量 |
| VERIFY_PER_RUN | 20 | 每轮最多验证候选词数 |
| REPORT_DIR | ./reports | 报告输出目录 |
| DATA_DB_PATH | ./data/keywords.db | SQLite 数据库路径 |
| TELEGRAM_BOT_TOKEN | - | Telegram 机器人 token（可选） |
| TELEGRAM_CHAT_ID | - | Telegram 接收者 chat_id（可选） |
| DISABLE_SOURCES | - | 禁用数据源（旧配置，逗号分隔） |
| DISABLE_PLUGINS | - | 禁用任意插件（新配置，逗号分隔） |

## 已知限制

1. **Reddit 限流**：数据中心代理 IP 常被 Reddit 限流（429），每次运行随机选 3 个板块 + 6 秒间隔。失败时会自动跳过，不影响其他数据源。
2. **Google Trends 限流**：同一 IP 短时间内高频查询会被临时拦截（返回 HTML 而非 JSON），工具会自动跳过。每天定时跑一次最稳。
3. **RDAP 被拦截**：rdap.org 对部分代理 IP 返回 403，此时域名检查自动回退为纯 DNS 判断（无法识别「已注册未建站」的域名）。
4. **域名可用性仅供参考**：DNS+RDAP 只能判断大概率，注册前请在 Namecheap/Cloudflare 确认。
