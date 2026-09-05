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
│   └── db.ts             # SQLite 状态机、运行/阶段记录与业务数据
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
8. **SQLite 状态机** - 关键词只有一个当前状态；需求库和淘汰池保存决策详情，重复出现累计信号
9. **Markdown 报告** - 时间戳命名，每次运行独立文件
10. **Telegram 推送 + 定时模式** - 每日快报推送到手机，cron 自动运行
11. **发现证据历史** - `signals` 保存来源、词根、强度和时间，不再只保留关键词最新快照
12. **预算调度** - `api_usage` 记录 SerpAPI 调用，按月度预算和保留额度硬限流
13. **验证历史与置信度** - `validations` 保存每个维度的成功、无数据、失败、降级和缓存结果
14. **自动观察复查** - `scheduled_reviews` 按原因创建复查任务，支持原子领取、退避和预算延后
15. **游戏候选池** - `games` 先保存游戏实体、发布时间和生命周期，再决定是否扩词
16. **不丢词队列** - Steam 全量发现结果先入库，批次上限只限制分析消费
17. **发售前发现** - 同时扫描 Steam Upcoming、Popular Upcoming 和 New Releases
18. **建站机会卡** - 分别输出需求、增长、内容空间、竞争可进入度、窗口和置信度

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

# 游戏优先雷达：发现游戏 → 机会初筛 → SERP 对手分析 → 攻略需求扩词
npm run games

# 所有发现都会入库，本轮只分析 10 款
npm run games -- --limit 10

# 只找 AI 工具类词
npm run find:ai

# 指定词根数量
npx tsx src/index.ts --seeds=8

# 定时模式（每天自动运行）
npm run watch

# 查看词库（新词库 + 需求库 + 淘汰池 + 运行记录）
npm run list

# 手动执行到期观察任务
npm run review

# 最多处理 10 个到期任务
npm run review -- --limit 10
```

## 游戏优先流程

游戏站机会不再从通用词根碰运气，而是按以下顺序处理：

```text
Steam Upcoming / Popular Upcoming / New Releases
  → games 候选池（完整入库）
  → pending/retry 持久化队列
  → Google Suggest 真实需求
  → 主词/guide/wiki 三组 SERP 对手分析
  → 机会评分和快照
  → 高价值长尾进入 words 验证队列
```

生命周期包括 `upcoming`、`prelaunch`、`launched` 等状态；发售前 14 天和发售后首周优先级最高。已分析游戏会按生命周期在 1 天或 7 天后重新进入分析队列，`game_snapshots` 会保留每次评分，为后续计算 1/3/7 天速度和结果回测提供数据。

管理面板的“🎮 游戏机会”页展示各维度评分、关键词数量和主要 SERP 对手。竞争数据查询失败时保持中性分，不会把未知误判为蓝海。

## 人工筛选（新词库 → 需求库）

每天 find 会把新词自动写入新词库（`words` 表）。人工筛选环节是哥飞方法论的关键：
四问过滤（用户意图？量级够吗？品牌冲突？竞品现状？）后，决定词的去向。

```bash
# ✅ 通过筛选：把词移入需求库，附主题分类和入选理由
npm run accept -- "coding agent" -t "AI 工具" -n "编码代理需求真实，竞争低"

# ⛔ 淘汰：记入淘汰池并切换为 rejected 状态
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
5. `reject` 淘汰 → 淘汰池留档；删除淘汰记录后才会重新进入审核或恢复归档状态

关键词状态由 `words.workflow_status` 唯一表示：

```text
discovered → review → accepted → building → launched
                 ├─→ rejected
                 └─→ retry_wait
accepted/building/launched → archived
```

已进入需求库且尚未归档的词不能直接淘汰，避免同一个词同时处于开发和淘汰状态。

## 运行可靠性

- 每次任务启动即创建 `running` 记录，空结果也会保存
- 最终状态区分 `succeeded`、`partial` 和 `failed`
- `run_steps` 单独记录数据源、分析器、SQLite、报告和 Telegram 的执行结果
- SQLite 核心存储优先；报告或通知失败不会阻止其他输出
- 定时任务带防重入锁，上一轮未结束时跳过重复调度
- 外环验证区分成功、无数据、失败和缓存命中；失败词进入 `retry_wait`

## 证据优先级与 API 预算

外环不再单纯按出现次数排队。最近 30 天内的跨源数量、信号次数、最强来源、发现新鲜度和累计出现次数会共同形成 `priority_score`。管理面板可以切换到“证据优先级”排序，并显示最近信号数和来源数。

SerpAPI 普通自动任务只会使用 `SERPAPI_MONTHLY_BUDGET - SERPAPI_RESERVE` 的额度：

```env
SERPAPI_MONTHLY_BUDGET=100
SERPAPI_RESERVE=15
```

所有实际调用写入 `api_usage`；缓存命中不记额度。达到自动使用上限后，Trends 会降级，外环会暂停付费验证，但 Suggest、Steam 等免费发现流程仍会继续。

## 验证历史与置信度

每次验证都会追加到 `validations`，不会覆盖旧结果。综合置信度使用固定权重：

| 维度 | 权重 |
|---|---:|
| 搜索量与趋势 | 40% |
| SERP 竞争 | 25% |
| 域名状态 | 25% |
| 翻译 | 10% |

缺失维度按 0 计算，因此单个成功结果不会被归一化成 100%。缓存、无数据、本地词典降级和请求失败具有不同可信度。最近一次验证失败时，会保留仍在有效期内的上次成功结果作为参考，但综合置信度最高限制为 69%，不会触发“立即注册”。

管理面板会显示置信度和最后验证时间；点击“🔎证据”可查看各维度历史。无法确认的域名会标记为 `uncertain`，不再被当成可注册域名。

## 自动观察复查

以下情况会自动创建观察任务：

- 验证服务失败：1 天后复查
- 搜索量暂无数据：7 天后复查
- 只有量级、缺少完整验证：3 天后复查
- 置信度不足：3 天后复查
- 高置信度但条件尚未成熟：7 天后复查

未解决任务按 1/3/7/14 天逐步退避，默认最多尝试 4 次，之后标记为 `exhausted`，避免无限消耗额度。SerpAPI 自动预算不足时任务只会延后，不消耗尝试次数。

任务领取使用数据库状态 `active → running`，多个常驻进程不会正常领取同一个任务；崩溃遗留超过一小时的 `running` 任务会自动释放。人工通过或淘汰关键词会取消其未完成任务。

```env
REVIEW_CRON=0 10 * * *
REVIEW_BATCH=5
```

`find --watch` 和 `radar --watch` 都会按 `REVIEW_CRON` 自动处理到期任务。管理面板的“观察任务”页可查看原因、状态、下次时间和尝试次数。

运行核心回归测试：

```bash
npm run test:workflow
```

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
| notifier | `notify(result, ctx)` | 独立输出（核心存储优先） | sqlite-storage/markdown-report/telegram |
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


## Google Trends RSS 定时发现

独立来源 `trending-now` 使用官方 RSS `https://trends.google.com/trending/rss?geo=US`，
无需 Google 登录、SerpAPI 或新增的非官方 Trends 客户端。默认美国，每轮结束后等待约 25–35 分钟；
`npm run watch`（game/all）和 `radar --watch` 自动带起，也可单独运行：

```bash
npm ci
npm run trending                 # 单次；尊重已有冷却，不强制重复请求
npm run trending:watch           # 常驻，只采集/分类/入队，不发送 Telegram
npm run trending -- --list       # 查看分类、理由、未知词、峰值档位（不联网）
npm run review                  # 用已有验证流程处理到期候选（可能消耗配置的 API 预算）
npm run test:trending
npm run build
```

配置见 `.env.example` 中 `TRENDING_NOW_*`。默认 `US`；可选 `US,GB,JP,CA,AU`，
每个地区通常每轮一次 HTTP 请求，多地区串行、至少相隔3秒。分类规则目前侧重英文，
日本等地区仍能采集与存档，但自动分类召回率较低。所有进程应共用同一个 `DATA_DB_PATH`，
否则各自的冷却记录不能互通。必须在持续开机的电脑或服务器上运行常驻命令；提交 GitHub 不会自动启动任务。

处理步骤：

1. 解析 RSS 关键词、搜索量档位、发布时间、相关新闻标题/来源/链接。
2. 精确匹配已有 Steam 游戏池，或用游戏媒体域名、游戏平台和发售信息筛选相关词。
3. `known-game` 是已知游戏名；`game-related` 仅为游戏相关候选，不能当作已核实游戏实体。
   主播、赛事、每日答案等进入 `unknown`/`noise`，保留供人工检查。分类置信度是规则分数，未经统计校准，
   与现有建站评分/验证置信度不同。无 AI 调用，也没有自动把新闻标题猜成游戏名。
4. 对发布时间在最近24小时的候选，按规范化关键词+地区去重；新词、档位较上次入队翻倍、
   或隔日重新出现时写入原词库、信号表及有批次限制的完整复查队列。相关实体和建站价值仍需核实，
   不能仅凭 RSS 分类结果注册域名。已人工通过/淘汰/归档的词不会重新入队。

数据库新增 `trending_history`（首次/最近观察、峰值、上次入队、分类证据）、
`trending_snapshots`（全部主题快照，保留30天）、`trending_rss_cache` 和 `trending_poll_state`。
未知词不会因无法分类而丢弃。已存在的业务表不做破坏性修改。

限流处理：同一 SQLite 的原子领取防止重叠；失败后约1、2、4小时指数退避，基准上限24小时；
尊重更长的 `Retry-After`。403/429 立即停止本轮剩余地区，不换接口重试。重启仍遵守持久化冷却。
只有服务器返回 ETag/Last-Modified 才发送条件请求，不能假设 Google 总是支持304。

数据边界：RSS 仅是有限热词池，不保证包含网页游戏分类全部趋势；不能靠本地分类找回缺失条目。
搜索量是档位下限，不是精确计数；档位翻倍不是 Google 官方涨幅；RSS 发布时间不等于趋势开始时间；
从列表消失也不能直接判定热度结束。采集过程不使用付费 API、不抓取相关新闻正文，不发通知。
