## Overview

Soliterra 是一个本地部署的条目平台（一切皆条目：一个 .md = 一个条目，树由文件夹表达，类型由标签表达），其 web 界面刻意不做成 SaaS 后台，而是做成**一间书房式的文献阅览室**。样式基准取自 `zgggy.github.io`（个人文学站「杉杪」）：白纸画布、衬线主导、发丝线分隔、卡片即纸面——一套「个人数字书房」的视觉语言，天然适配档案与长文阅读，也与本项目的正典气质（伪文献、编年史、名词索引）相称。

整个界面只有三种「面」：**纸面**（`{colors.surface}` 白卡）、**线**（`{colors.line}` 1px 发丝）、**墨**（`{colors.text}` #050505）。唯一的彩色是链接/双链的 `{colors.link}`（#057dbc）与少量语义徽章色。没有渐变背景，没有彩色按钮，没有装饰性插画——情绪由排版和留白承担。

三面字体分工：**衬线做叙事**（display + 正文长文），**无衬线做结构**（UI 元数据、导航、徽章、按钮），**等宽做机器话**（元数据行、代码、词条 ID）。参考站用 `Iowan Old Style / Baskerville / Songti SC` 系衬线承担全部正文，本设计照搬这一决定，并按「档案平台」的需要补一层语义色与状态徽章。

**Key Characteristics:**
- **四条核心样式铁律**（全站一切组件的判准）：
  1. **纯色带边框的矩形**——一切「面」（卡片、书、按钮、徽章、底座）都是实色填充 + 1px 边框的直角矩形；
  2. **按钮线条图标无背景**——图标按钮 = 线条 SVG + currentColor，无底无框，hover 只变字色（muted → text），不加底色；
  3. **浅色分割线**——1px `{colors.line}` 是唯一的分隔与抬升手段；
  4. **排版即布局**——对齐、字号层级、大写字距、muted/ink 双色完成全部信息分组，不靠色块与阴影。
- 单色墨系基底 + 唯一链接蓝 `{colors.link}`；彩色只出现在状态徽章与警报条。
- 三面字体系统：衬线 display/正文 · 无衬线 UI · 等宽数据（与参考站的 serif-only 略有扩展，因为平台要显示元数据行与词条 ID）。
- 方角几何：`{rounded.none}` 0px 用于卡片、按钮、输入框；只有头像、主题切换、状态点用 `{rounded.full}`。
- 卡片即纸面：`{colors.surface}` + 1px `{colors.line}` 边框 + 极轻的 `0 18px 36px rgba(0,0,0,.04)` 投影；不用重投影。
- **无 header**：世界内唯一的顶部元素是**时间轴**（sticky、通栏、surface 底 + 底部发丝线）——「正在打开的文档」由时间轴旗标的极性翻转高亮体现；首页顶部只有一行极简 masthead（wordmark + 主题钮）。参考站的磨砂顶栏语言保留给 masthead。
- **交互原语（push / paper-dialog / fab / 卡片集）**：
  - **push**（推挤面板）：**五个面板**（目录/世界/书籍 = 左；关系/工具 = 右）——把正文挤开（左开正文右推、右开正文左推），300ms 同模态曲线，**两两互斥**、正文恒 ≥ 半屏；时间轴与 fab 不参与推挤；目录/书籍/关系面板带 **10×60 宽度把手**（骑在边界线正中），世界固定宽、工具固定半屏；
  - **paper-dialog**（中央纸面）：仅剩 ask-dialog / ⌘K 搜索 / git 历史 / 仪表盘 / 地图占位等**瞬时层**（世界/设置/书籍/工具的历史纸面方案已并入 push 面板）；
  - **fab 簇**：左下 `+`（世界）`格`（全部书籍）`☰`（目录），右下 `✎`（开始编辑↔保存并退出）`⛶`（关系）`工`（工具）——六钮同型：40×40、到屏边 8px、间距 8px、左右对称，图标为 1.3px 细线 SVG；
  - **readlater-fan**（底部卡片集）：稍后阅读 = 屏幕底部中央的**扇形卡片集**——rest 聚拢成扇（±9° / 间距 26px / 只露上半 70px），hover 整集转**横排展开**（gap 8、尽量不重叠、总宽距两侧钮群 ≥40px），单卡 hover 上升 + 右上 `×` 移除。
- **首页 = 世界列表**：横排竖卡 + 「+ 新建」卡，滚轮左右滚动，卡片 hover 3D 倾斜（±6deg，不加影不加圆角）；不是 banner 三栏、不是全屏大图。
- footer 是**一行居中的灰字题记**，无链接列、无图标——与你的「卷旨/题记」习惯完全同构。
- **书**：书卡 = 2:3 封面竖矩形 + 书名 + 标签行（全部书籍面板内）；书架 Dock / 书脊 / 底座方案**已整体废弃**。

## Colors

### Brand & Accent
- **Ink**（`{colors.accent}` — `#050505`）：品牌唯一「重色」。用于标题、激活态边框、主按钮填充。暗色模式翻转为 `#e8e8e8`。

### Surface
- **Canvas**（`{colors.bg}` — `#ffffff`）：页面底。
- **Canvas Soft**（`{colors.bg-soft}` — `#f4f4f2`）：次级面——按钮 hover、激活筛选项、行 hover、代码底。比纯白低一档暖灰，是全站唯一的「填充色」。
- **Surface**（`{colors.surface}` — `#ffffff`）：卡片纸面，永远比 canvas 多一道 1px 边框。
- **Line**（`{colors.line}` — `#d8d8d8`）：全站唯一的「线」——卡片边框、分隔线、输入框边框。
- **Line Strong**（`{colors.line-strong}` — `#050505`）：强调线——激活态、引用块左缘、模态框外框。

### Text
- **Text**（`{colors.text}` — `#050505`）：标题与正文。
- **Muted**（`{colors.text-muted}` — `#666666`）：元数据、题记、副标题、所有 uppercase 眉题。
- **On Accent**（`{colors.on-accent}` — `#ffffff`）：墨色按钮上的字。

### Semantic（平台语义色，克制使用）
- **Link**（`{colors.link}` — `#057dbc`）：正文内链接与 `[[双链]]` 的唯一彩色，带 `underline-offset: 4px`。不用于按钮、不用于导航。
- **Status Canon**（`#2f6f4e`）/ **Draft**（`#8a6d1f`）/ **Disputed**（`#8a4b3f`）：词条状态徽章的字色（徽章底用 `{colors.bg-soft}`，不填充彩色底）。
- **Toast 四色**（借用 Notion/Toast 模式，均为「3px 前缘线 + 同色等宽标签」，不做整块彩底）：
  - **Info**（`#057dbc`）/ **Success**（`#2f6f4e`）/ **Warning**（`#8a6d1f`）/ **Error**（`#a03530`）。
  - 工具批处理结果、lint 计数、稍后阅读变更统一走这四色；`Alert` = Error 色，仍是全站唯一的「红」，只以 3px 前缘线/左边线出现。

### Dark Mode（参考站同款双主题，CSS 变量切换）
`{colors.bg}` `#141414` · `{colors.bg-soft}` `#1e1e1e` · `{colors.surface}` `#1a1a1a` · `{colors.text}` `#e8e8e8` · `{colors.text-muted}` `#999999` · `{colors.line}` `#333333` · `{colors.line-strong}` `#e8e8e8` · 投影 `0 18px 36px rgba(0,0,0,.2)`。主题切换按钮用 ☀/☾ 字形（`::after` content），存 localStorage，首屏用内联脚本防闪烁。

## Typography

### Font Family
三面分工：
1. **Display / 正文衬线** — `'Iowan Old Style', Baskerville, 'Songti SC', Georgia, serif`：h1–h4、词条正文、故事正文、题记。参考站原样采用（本机 Mac 有 Iowan/Baskerville，中文落到 Songti SC）。
2. **UI 无衬线** — `'PingFang SC', 'Noto Sans SC', 'Helvetica Neue', sans-serif`：导航、按钮、徽章、筛选器、元数据。中文场景下 PingFang 即最佳选择，无需引入 webfont，**全站零字体下载**。
3. **等宽** — `'SFMono-Regular', 'IBM Plex Mono', Consolas, monospace`：元数据行（`&` 键值）、词条 ID、`event/rel/term` 围栏、时间轴的年份刻度。

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-hero}` | clamp(1.8rem, 3.4vw, 3.6rem) | 700 | 1.08 | 0 | 首页 banner 的世界名 / 作品名。 |
| `{typography.display-lg}` | clamp(2rem, 3.4vw, 3.4rem) | 700 | 1.08 | 0 | 阅读页文章标题（参考站 modal title 同款）。 |
| `{typography.display-md}` | 1.15rem | 700 | 1.1 | 0 | 卡片标题：词条卡、章节卡（`article-card h3` 实测值）。 |
| `{typography.display-sm}` | 1.02rem | 700 | 1.35 | 0 | 阅读正文内 h2–h4。 |
| `{typography.eyebrow}` | 0.72rem | 400 | 1.35 | 0.08em | 全大写眉题：`个人简介 / 2026-06-06`、词条类型、时代标签。 |
| `{typography.body-serif}` | 1.02rem | 400 | 1.65 | 0 | 阅读正文（参考站 `article-body` 实测 1.02rem）。 |
| `{typography.body-ui}` | 0.94rem | 400 | 1.7 | 0 | 界面默认字号（参考站 body 15px/25.5px）。 |
| `{typography.body-muted}` | 0.88–0.95rem | 400 | 1.6 | 0 | 卡片摘要、描述、footer 题记。 |
| `{typography.meta}` | 0.7rem | 400 | 1.35 | 0.08em | 全大写卡片元数据行（标签左、日期右）。 |
| `{typography.brand-main}` | 0.94rem | 400 | 1 | 0.08em | 顶栏 wordmark，uppercase。 |
| `{typography.brand-sub}` | 0.64rem | 400 | 1 | 0.08em | 顶栏副标 `WORLD ARCHIVE / STORY`，uppercase muted。 |
| `{typography.quote}` | 1rem | 400 | 1.5 | 0 | 中线题记（midline）与 footer 题记。 |
| `{typography.code}` | 0.9rem | 400 | 1.6 | 0 | 等宽：元数据行、围栏块。 |

### 双语排版规则（中 / EN，i18n 见 功能设计 §15.5）

| 维度 | 规则 |
|------|------|
| 字体栈 | 衬线 `'Iowan Old Style', 'Baskerville', 'Songti SC', Georgia, serif`——英文落 Iowan/Baskerville、中文落 Songti，同栈混排自动分流，**不随语言切换字体** |
| 正文行高 | 中文 **1.8**（无升降部、密排易累），英文 **1.65**——`--leading-body` 随 `lang` 属性切换；同栏宽下中文可另降一档字号（−0.5rem）补偿视觉密度 |
| 眉题大写 | `text-transform: uppercase` 只对拉丁字母生效；**中文眉题不做强伪大写**，靠 0.08em 字距 + muted 色 + 小字号完成同一层级感（`[lang="zh"]` 下不加额外字距） |
| 按钮与控件 | 文案 `white-space: nowrap`，容器 `min-width` 固定 + 宽度自适应内容——英文更长（"Start Editing" vs 开始编辑）不换行不溢出；面板行同理 |
| 枚举徽章 | 存储值恒英文 token，显示按 lang 映射（`canon` → 正典 / Canon）；徽章宽度自适应 |
| 缺词 | fallback 链 所选语言 → en → key 原文；渲染层禁止裸 key（开发期 lint 校验） |

### Principles
- **衬线做叙事，无衬线做结构。** 衬线绝不进按钮和导航；无衬线绝不进长文正文。
- **大写 + 0.08em 字距是全站唯一的「装饰」。** 眉题、元数据、wordmark、状态标签全部靠这一个手法统一。
- Display 不压细也不上极粗——700 的 `Songti SC` / `Iowan` 在 3.6rem 下自然成立。
- 数字（年份、字数、词条 ID）一律等宽，让时间轴与统计卡列对齐。

## Layout

### Spacing System
- **Tokens**：`{spacing.tight}` 12px · `{spacing.space}` 20px（区块间距、栅格 gap 的标准值）· `{spacing.card}` 22px（卡片内边距）· `{spacing.page-x}` 24px（页面左右）· `{spacing.page-bottom}` 72px · 移动端 `16px / 18px`。
- 参考站没有 4px 微刻度——它只有 12/20/22/24 四档，刻意少。本设计照搬：**少刻度比多刻度更容易保持一致**。

### Grid & Container
- **容器**：`max-width: 1440px; margin: 0 auto`，masthead、主区、footer 共用同一容器。
- **首页世界列表（横排卡）**——「一行多块」的标准答案一：

  ```css
  .world-row {
    display: flex;              /* 竖卡横排 */
    gap: 20px;
    padding: 0 8vw;             /* 首尾留白，末卡后 8vw 余量 */
    align-items: center;
    overflow-x: auto;           /* 滚轮 deltaY → scrollLeft 左右滚动 */
  }
  ```

  卡 240×340 等高；整行屏幕垂直居中。hover 倾斜：容器 `perspective: 1200px`，卡面按指针偏移 `rotateX/Y ±6deg`（200ms ease-out），边框同步转 `line-strong`。
- **push 面板（推挤分栏）**——「一行多块」的标准答案二。五实例（目录/世界/书格/关系/工具）共用同一结构（`.push-panel` + `.panel-head` + `.panel-scroll`），栅格轨道按激活面板切换：

  ```css
  .world-shell.push-left  { grid-template-columns: minmax(260px, var(--left-w, 33vw)) minmax(0, 1fr) 0; }
  .world-shell.push-right { grid-template-columns: 0 minmax(0, 1fr) minmax(260px, var(--right-w, 50vw)); }
  .world-shell.rel-full   { grid-template-columns: 0 0 minmax(0, 1fr); }   /* 关系全图 */
  ```

  **宽度把手 `panel-resize`**：10×60 矩形（bg-soft + 1px line，**无竖线装饰**），**上下左右居中骑在边界线上**（左面板 `right: -5px` / 右面板 `left: -5px`；`top: 50%`）——**默认隐藏（opacity 0），指针距该边界 ≤40px 才浮现**（JS 文档级 mousemove 切换 `.near-edge`）；拖动改 `--toc-w / --books-w / --rel-w`（sessionStorage）。
- **半屏分栏（push）**——标准答案三：主内容 grid 轨道 `0 ↔ 50vw` 过渡（**300ms `{motion.ease}` = 全站 view 档**），面板进正文让位；**时间轴通栏不推挤**；目录与关系图互斥（正文恒 ≥ 半屏）；`Esc` 收起。
- **目录区（侧栏 + 主列）**——工具箱、书籍「更多」网格等弹层沿用：

  ```css
  .directory-layout {
    display: grid;
    grid-template-columns: minmax(240px, 25%) minmax(0, 1fr);
    gap: 20px;
    align-items: start;
  }
  ```

  左侧 `filter-button` 竖排（激活项 `bg-soft` + `line-strong` 边框 + 展开小字计数），右侧卡列表。
- **卡片列表**：单列 `gap: 12px`；并排升 `repeat(auto-fill, minmax(320px,1fr))`——区块 gap 20px、卡间 12px。
- **中线题记（midline-strip）**：主内容顶部一行居中灰字，`padding: 12px 0`。放轮换卷旨/题记（打开条目时取其首句引言）。

### Responsive Strategy

#### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Wide | ≥ 1320px | 世界列表全卡展示；五 push 面板全尺寸（目录/书籍默认 1/3 屏、关系 1/2 屏、世界 `min(420px,40vw)`）。 |
| Laptop | 1181–1319px | 同上，页边保持 24px。 |
| Tablet | ≤ 1180px | push 面板默认宽度按屏宽比例收缩；目录区塌单栏；时间轴刻度降密。 |
| Mobile | ≤ 720px | 页边 24→16px；卡内边距 22→18px；push 面板改**全屏浮层**（0 圆角 + hairline 顶边）；模态贴边 `calc(100vw - 24px)`。 |

#### Touch Targets
- 筛选按钮实测 87px 高、模态关闭键 2rem、主题切换 28px 圆钮——全部超过 WCAG 44px 最低线（主题钮依赖 28px 视觉 + 热区扩展）。

#### Collapsing Strategy
- **时间轴智能收拢**：下滚 > 80px → 112→56px（旗标压扁只留标题）、右侧稍后阅读区同步收窄；滚回顶部恢复；**200ms `{motion.state}`**。
- 世界列表在窄屏保持横排（本就是横滚交互），单卡缩至 200×280。
- 目录区侧栏 → 顶部横向筛选条（卡片仍单列）。

#### Image Behavior
- 概念图/地图：卡内 `width: 100%` + 1px `{colors.line}` 边框（参考站 `.inline-image` 同款），不圆角、不投影。
- 词条封面图放卡片顶部（4:3）；地图查看器整幅占满阅读列。

### 阅读页（文章/词条/章节共用）
- 参考站用**模态阅读层**（点卡片 → 全屏遮罩 + 居中 980px 纸面）。平台沿用此形态做**词条速览**：`rgba(0,0,0,.48)` 遮罩 + `blur(5px)`，纸面 `min(980px, calc(100vw - 48px))`，`margin: 88px auto 56px`，入场 `translateY(24px) scale(.985) → 0` 的 `cubic-bezier(.22,1,.36,1) 300ms`。
- 章节连读则走独立路由页，右设 floating-toc（≤1180px 隐藏），正文列 `max-width: 42rem`。
- 正文规范：`h2–h4 margin-top 2.1rem`；引用块 = `padding-left: 14px + 2px {colors.line-strong}` 左缘（不做底纹）；`code` 底 `{colors.bg-soft}` 无圆角；图片满列宽带 1px 边。

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Level 0 — Flat | 无边无影 | 页面区块、题记、正文列。 |
| Level 1 — Paper | 1px solid `{colors.line}` + `0 18px 36px rgba(0,0,0,.04)` | 所有 `card-surface`：banner 卡、侧栏卡、词条卡。**全站唯一的标准抬升。** |
| Level 1.5 — Float | 分层微投影 `0 4px 12px rgba(0,0,0,.05), 0 24px 48px rgba(0,0,0,.08)` | 悬浮预览卡、时间轴旗标、Toast——「贴着内容浮起」的中间档（借 Notion 的多停靠点近透明投影做法）。 |
| Level 2 — Modal | 1px solid `{colors.line-strong}` + `0 22px 60px rgba(0,0,0,.18)` | 词条速览模态、命令面板。 |
| Level 3 — Alert | 3px 前缘 `{colors.alert}`（无影） | lint 警报条、剧透折叠条、toast error。 |

投影只有一档、且淡到 4% 透明度——纸感来自「白面 + 发丝线」，不来自影子。

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | 卡片、按钮、输入框、徽章、图片——全站默认。 |
| `{rounded.full}` | 50% / 9999px | 仅三处：主题切换圆钮、用户头像、状态圆点。 |

### Photography Geometry
- 概念图/地图：原比例，1px 边框，0 圆角；卡内封面 4:3 裁切；正文插图满列宽。

## Motion（交互动画系统，v3 定稿）

> 全站动画的**唯一规范**：状态迁移三档时长 + 三条曲线 + reduced-motion 降级。行为级规格与全站登记表见 功能设计 §19。

### Tokens

| Token | 值 | 用途 |
|---|---|---|
| `{motion.quick}` | 150ms | 微反馈：颜色、描边、透明度、勾选、下划线 |
| `{motion.state}` | 200ms | 局部状态：hover 展开/收起、卡片上升、时间轴收拢、旗标宽度 |
| `{motion.view}` | 300ms | 视图级：push 轨道、时间轴取景/放大、纸面上浮、FLIP、遮罩 |
| `{motion.ease}` | `cubic-bezier(.22, 1, .36, 1)` | 默认曲线（state/view 档；与模态同源） |
| `{motion.ease-quick}` | `ease-out` | quick 档微反馈 |
| `{motion.ease-linear}` | `linear` | 仅数据映射类（滚动指示条） |

### 规则

1. **动画只表达状态迁移**——空间连续、因果同一拍、层级浮起；不做装饰动效（无弹跳/过冲；唯一循环 = 强调脉冲 2 次即停）。
2. **只动 `transform` / `opacity`**——位移一律 FLIP 或 translate；不动 `top/left/width/height`（例外：push 的 grid 轨道与时间轴的视野补间，均属「轨道/数据」而非元素位移）。
3. **可打断、从当前值出发**——新目标取消旧补间（CSS transition 天然；JS `animateTo` 先 cancel），无动画队列。
4. **进快出缓**：hover 进 `{motion.state}`；面板类退出 200ms 宽限；同元素各属性不混档。
5. **新交互先登记**——任何新动画必须在 功能设计 §19.4 登记表占一行，时长取三档、曲线取三条之一；否则不写。

### 降级（reduced motion）

- `@media (prefers-reduced-motion: reduce)` 全局兜底（app.css 末尾）：`animation/transition` 全部 0.01ms、延迟清零、`scroll-behavior: auto`；
- JS 补间（时间轴 `animateTo`、书架 FLIP）检测 `matchMedia('(prefers-reduced-motion: reduce)')` → **直接跳终态**；
- 语义不变：只瞬时化，不关闭功能。

### 实现锚点

- CSS：`app.css :root` 的 `--motion-quick/state/view · --ease · --ease-out-quick · --ease-linear`；旧散值已归一（160→200、180→200、280→300、320→300）。
- JS：唯一补间函数 `world.js initTimeline.animateTo(lo, hi, ms=300)`（rAF + easeOutCubic≈`{motion.ease}`，含打断与降级）；书架 FLIP 用 WAAPI `element.animate`。

## Components

### 组件归纳总清单（三层）

> 全部组件分三层：**原语层**（不可再分的样式原子）→ **交互原语层**（可复用的行为模式）→ **功能组件层**（业务单元）。任何新组件必须先归入此表再设计。

**① 原语层（Primitives）** — design.md 各节定义

| 原语 | 定义节 |
|------|--------|
| `panel-surface`（纸面卡：surface + 1px line + 0 圆角 + Level 1 投影 + 22px 内边距） | Cards |
| `hairline`（1px line 分割线） | Elevation |
| `eyebrow`（11px/600/大写/0.08em 眉题） | Typography |
| `icon-button`（线条 SVG + currentColor，无底无框） | Buttons |
| `button-primary` / `button-outline` / `button-ghost` | Buttons |
| `text-input` / `filter-button` / `status-badge` | Inputs / Buttons / Cards |
| `polarity-flip`（打开/激活态：ink 底 ↔ surface 字） | 全站选中语言 |
| `toast` / `alert-row`（3px 前缘语义色） | Semantic / Timeline |
| `reader-modal`（980px 纸面 + Level 2 投影 + 280ms 上浮） | 阅读页 |
| `midline-strip` / `site-footer`（题记行） | Layout / Navigation |

**② 交互原语层（Behavior Patterns）**

| 原语 | 行为 | 实例 |
|------|------|------|
| **`readlater-fan`** | 扇形聚拢（rest）↔ 悬停整集横排展开 ↔ 单卡上升；离开集合矩形收拢（阈值随上升卡自然变高） | 稍后阅读卡片集（底部中央） |
| **`push-panel`** | grid 轨道 0↔宽度推挤（300ms 同模态曲线），**五面板两两互斥**、正文恒 ≥ 半屏，`Esc` 收起；**10×60 把手骑边界线正中**调宽（sessionStorage 记忆） | 目录 · 世界 · 全部书籍（左）；关系（默认 1/2 屏） · 工具（右） |
| **`paper-dialog`**（中央纸面） | 单一构建函数 `openPaperDialog2`：reader-modal 遮罩 + 居中 `line-strong` 纸面 + Level 2 阴影 + 280ms 上浮 | git 历史 · 仪表盘 · 地图占位 · ask-dialog（同族） |
| **`focus-retention`** | hover 进入子项后，指针离开子项但未离整体容器 → 保持状态不退出（120ms 宽限） | 时间轴旗标、底部卡片集、悬浮预览卡 |
| **`zoom-to-fit`** | 取景：`&s` 在屏 **1/3**、`&e` 在屏 **2/3**（从当前视野补间，300ms 同模态曲线）；瞬时事件置于 1/3。**打开条目不取景**（2026-10-06 删除条目点击的自动缩放）——仅「强调」拖拽 / ⌘K / 时代带三处显式手势 | 时间轴取景（焦点取景），关系图适应 |
| **`anchored-zoom`** | 滚轮以指针下的数据点为锚缩放 | 时间轴 |
| **`hover-tilt`** | `perspective: 1200px` + 指针偏移 `rotateX/Y ±6deg`，200ms 回中，不加影不加圆角 | 首页世界卡 |
| **`diff-apply`** | 扫描 → diff-row 预览 → 快照 → 应用 → toast + git 提交 | 全部工具箱工具 |

**③ 功能组件层（Feature Components）**

| 域 | 组件 | 章节 |
|----|------|------|
| 首页 | `world-card` · `new-world-card` · `world-row` | Layout |
| 时间轴 | `chrono-bar` · `event-flag` · `span-bar` · `chrono-marker` · `era-band` | Timeline & Interaction |
| push 面板 | `toc-panel` · `world-panel`（世界+设置合并） · `books-panel`（书格） · `rel-panel` · `tools-panel` | Layout & Panels / 关系图 |
| fab 簇 | `fab-left`（+/格/☰） · `fab-right`（✎/⛶/工） · `panel-resize`（10×60 把手） | Layout & Panels |
| 阅读 | `metadata-chip` · `readlater-fan`（卡片集） · `link-preview-card` · `annotation-row` | Timeline & Interaction |
| 编辑 | `editor-deco`（装饰层） · `editor-toolbar` | Layout & Panels |
| 关系图 | `graph-node` · `graph-edge` · `graph-toolbar` | Timeline & Interaction |
| 工具/校验 | `diff-row` · `lint-panel`（未实现） | Timeline & Interaction |

### Buttons

**`button-primary`** — 墨块主按钮（进入档案库 / 继续阅读 / 保存）。
- Background `{colors.accent}`，text `{colors.on-accent}`，UI 无衬线 0.94rem，padding `12px 24px`，`{rounded.none}`，hover 透明度 .85。

**`button-outline`** — 纸面描边次按钮。
- Background transparent，text `{colors.text}`，1px `{colors.line-strong}`，hover 底 `{colors.bg-soft}`。

**`button-ghost`** — 无边按钮（顶栏动作、页内次操作）。
- transparent + text，hover 底 `{colors.bg-soft}`。

**`filter-button`** — 目录筛选项（参考站原型）。
- `display: grid; width: 100%; padding: 14px 16px; border: 1px solid {colors.line}; border-radius: 0; text-align: left`；hover `{colors.bg-soft}`；**active**：底 `{colors.bg-soft}` + 边 `{colors.line-strong}` + 计数小字 `max-height 0 → 96px` 展开（160ms ease）。

### Cards & Containers

**`card-surface`** — 全站卡片基类。
- `border: 1px solid {colors.line}; background: {colors.surface}; box-shadow: {spacing.shadow}; padding: {spacing.card}`（22px），`{rounded.none}`，`overflow: hidden`。

**`banner-hero-card`** — banner 左卡：世界简介。
- 卡内纵向 `flex; gap: 12px; justify-content: space-between`：顶部 `{typography.eyebrow}`（`世界名 / 条目类型眉题`）→ `display-hero` 世界名 → 底部 muted 一句卷旨。

**`banner-entry-cluster`** — banner 中卡：入口簇（档案 / 故事 / 书籍 / 时间线）。
- 卡内纵向 grid `gap: 20px`，每个入口块是「一行灰字 + 1px 底线分隔」的 `feature-link-block`（`padding: 0 0 18px`），整块可点，hover 变 `{colors.bg-soft}`。

**`banner-stats-card`** — banner 右卡：仪表盘数字。
- 等宽字号的三行统计（词条 / 章节 / 警报），或参考站做法放一整块 `bg-soft` 画布。

**`entry-card`** — 词条卡 / 章节卡（列表主单位）。
- 1px `{colors.line}` 边；卡内 `grid; gap: 8px; padding: 18px`。
- 第一行 `{typography.meta}`：左 `标签`（大写 0.7rem）右 `更新时间`（`grid-template-columns: minmax(0,1fr) auto`）。
- 第二行 `article-card-main`：`display-md` 标题左 + muted 摘要右（`minmax(220px, auto) minmax(0,1fr)`，baseline 对齐；≤1180px 摘要转左对齐堆叠）。
- hover 整卡底变 `{colors.bg-soft}`（180ms）。

**`status-badge`（保留用于列表/卡片；标题区用浅字）** — 词条状态徽章。
- 底 `{colors.bg-soft}`，字 0.7rem 大写 + 0.08em 字距，字色取语义色（canon/draft/disputed），padding `4px 8px`，0 圆角。旁边可配 `{rounded.full}` 4px 状态圆点。

**`alert-row`** — lint 警报条。
- 3px 左缘 `{colors.alert}`，底 `{colors.bg-soft}`，文字 `{colors.text}` 0.94rem，无投影，0 圆角。

### Inputs & Forms

**`text-input` / `search-input`** —
- 底 `{colors.surface}`，1px `{colors.line}`，0 圆角，padding `12px 16px`，UI 无衬线；focus 边转 `{colors.line-strong}`（不发光、不加影）。搜索框占顶栏右侧或 ⌘K 面板内。

### Navigation（无 header 的导航）

> **世界内没有 header**——顶部只有时间轴（见 Timeline 节），导航职责分散给：时间轴（当前文档旗标 + 起止标记 + 创世排恒显示，打开不缩放）、五 push 面板（目录/世界/书籍/关系/工具）与 fab 簇、底部卡片集、`⌘K`（一切检索与动作）。

**`home-masthead`** — 仅首页的极简顶行（参考站磨砂语言的唯一保留处）。
- `position: sticky; top: 0; z-index: 20`；`background: rgba(255,255,255,.92); backdrop-filter: blur(12px)`；`border-bottom: 1px solid {colors.line}`；暗色 `rgba(20,20,20,.92)`。
- 内层 flex 两端对齐、`padding: 8px 24px`、`max-width: 1440px`：左 `brandmark`、右 `theme-toggle`。

**`brandmark`** — 字标组（首页 masthead、世界卡内复用）。
- `inline-flex; align-items: baseline; gap: 12px`：`brandmark-main`（`SOLITERRA`，`{typography.brand-main}` uppercase）+ `brandmark-sub`（`WORLD ARCHIVE`，`{typography.brand-sub}` muted uppercase）。

**`nav-link`** — 导航项（设置面板、⌘K 结果、占位入口）。
- UI 无衬线 0.94rem，`{colors.text-muted}`，hover/active 转 `{colors.text}` + 底部 1px `{colors.line-strong}` 下划线。**不加彩色。** disabled 态保持 muted 不降透明度。

**`theme-toggle`** — 28px 圆钮（首页 masthead + 设置面板行内复用）。
- 1px `{colors.line}`，`{rounded.full}`，transparent，hover 底 `{colors.bg-soft}`；☀/☾ 用 `::after` 注入。

**`site-footer`** — 一行题记 footer（首页底部、世界内主区底部）。
- `max-width: 1440px; padding: 0 24px 48px`，居中一句 muted `0.95rem`。**不做多列链接、不做图标行、不做黑底。** 示例：`- 万物皆条目 · Soliterra -`。git/版本信息降级为题记下一行 `0.7rem` muted 等宽。

### Signature Components

**`midline-strip`** — 中线题记条。
- 全宽居中一行，`padding: 12px 0`，`{typography.quote}` muted。放轮换题记或当前卷旨，是 banner 与内容区之间的「呼吸位」。

**`eyebrow-meta`** — 全大写眉题。
- `0.72rem / 400 / 0.08em / uppercase / muted`，前置一条 `12px` 短横（`- ` 或 `·`）。用于卡顶类型行、章节顶时代行。

**`backlink-row`** — 反向链接行。
- 与 `entry-card` 同边框，但 `padding: 12px 18px` 更薄；行内：类型眉题 + 词条名（衬线）+ 关系词（等宽 muted，如 `-> 引用`）。

**`fence-block`** — `event / rel / term / scene` 围栏渲染。
- 底 `{colors.bg-soft}`，1px `{colors.line}`，0 圆角，无投影；键名用等宽 + muted，值用衬线；顶右角放类型角标（大写 meta）。

**`callout-archive / callout-doubt / callout-author`** — 伪文献/存疑/作者笔记。
- 统一为「左缘 2px + 缩进」：`[!档案]` 左缘 `{colors.line-strong}` + 衬线斜体；`[!存疑]` 左缘虚线 `{colors.line}`；`[!作者]` 底 `{colors.bg-soft}` 且读者视图 `display: none`。**都不用彩色底。**

**`reader-modal`** — 词条速览模态。
- 遮罩 `rgba(0,0,0,.48) + blur(5px)`；纸面 980px、`border: 1px solid {colors.line-strong}`、Level 2 投影；头部 grid `minmax(0,1fr) auto`（眉题时间左、2rem 透明关闭钮右）+ 底部发丝线；标题 `display-lg`；入场 280ms `cubic-bezier(.22,1,.36,1)` 上浮。

**`command-palette`（⌘K）** — 搜索面板，复用 `reader-modal` 的纸面与投影，输入框置顶，结果行为 12px 间距的 `entry-card` 瘦版（只留眉题 + 标题）。

### 布局与面板组件（Layout & Panels，详见 功能设计.md §1/§2/§7/§10/§11）

**`world-row`** — 首页世界列表横排容器。
- flex、gap 20px、`padding: 0 8vw`、`overflow-x: auto`；滚轮 deltaY 映射 `scrollLeft`；整行屏幕垂直居中。

**`world-card`** — 首页世界竖卡（240×340）。
- card-surface 配方；上 62% 封面（无图 → bg-soft + 首字大衬线），下 38% 世界名（display-md）+ 简介（2 行省略）+ 底部等宽元数据（hairline 上隔）；右上角线条 icon-button 菜单。
- **hover 倾斜**：`hover-tilt` 原语（±6deg / 200ms）+ 边框 `line-strong`。

**`new-world-card`** — 「+ 新建世界」卡，同尺寸。
- **虚线** 1px `{colors.line}` 边框 + 居中线条 `+` + `新建世界` eyebrow；hover 转实线 `line-strong` + 倾斜。

**`world-info-panel`（已废弃）** — 原左上世界卡 peek、以及其后的中央纸面方案均不再使用；世界信息现为左 push 面板（见 `world-panel` 节）。
- 纸面内容：`&m` 横幅（140px，无图不渲染）→ 世界名 → 统计行（书籍 · 条目，等宽 0.7rem）→ git 行（0.66rem 等宽）→ 提交行（左计数右按钮）→ `设置 →` → `← 返回世界列表`；行间全部 hairline，行内 padding 12px 22px。

**设置条目（已并入 `world-panel`，无独立面板）** — `.set-row` 行式列表（hairline 分隔）：日/夜三段切换 · 字体族点选 · 字号档位（16/18/20/22）· 行高 · 列宽 · **语言两段切换（中文 / English，即时生效）**。
- 偏好存 `.soliterra/settings.json`（仅 UI 偏好，非内容元数据），全部经 CSS 变量生效。

**`readlater-fan`（稍后阅读卡片集，2026-10-06 二次定型）** — 屏幕底部中央；右侧竖列旧方案整体废弃。
- 卡片 `rlf-card` 108×140（只露上半 70px，`bottom: -70px`）：眉题（entry / 类型）+ 衬线标题（2 行截断）；`transform-origin: 50% 100%`。
- **rest = 扇形**：按序旋转（±9° 渐开）+ 间距 26px 聚拢；**hover 整集 = 横排**：旋转归零、`gap 8px`（放不下才重叠，间距 ≥22px）；总宽 ≤ 视口 − 两侧钮群 − 40px×2。
- **单卡 hover = 上升 28px + z 置顶 + 卡片内部右上角关闭图标**（无底无框线条图标，`rlf-close`；移出稍后阅读）；点击卡片 = 打开条目并**极性翻转**高亮；空列表整集不显示。
- 布局由 JS 计算每卡 `transform`（`layoutFan`），CSS 只做 `{motion.state}` 过渡。

**`fab-right`（右下三钮，z26；操作面板已废弃）** —
- `✎ edit-fab`：铅笔细线图标；点击 = 开始编辑；编辑态**换存盘图标（↓入托盘）**+ ink 激活态，点击 = 保存并退出（写盘不提交）；
- `⛶ rel-fab`：节点连线图标 → 开合关系面板（右 push），active = ink；
- `工 tools-fab`：工具箱图标 → 开合工具面板（右 push），active = ink；右上角 **lint 警报角标 `fab-badge`**（0 隐藏 / warn 黄 / error 红、>9 显 9+，方形骑出按钮边界 5px，1px surface 描边）。
- **旧 `action-bar`（纸面卡 + ⋯ 开关 + 状态区 + 图标行）**、加入稍后按钮、撤销/前进按钮**全部废弃**。

**`toc-panel`** — 目录面板（push 左实例，默认 1/3 屏，10×60 把手可调）。
- 面板 = surface + 右缘 1px line；内为可拖动编辑的条目树：行高 32px、缩进 16px/级、hairline 分隔；文件夹与同名 md **合为一行**（可打开行尾显 `→` 线条箭头）；拖放 = 移动文件（成对联动）、右键 = 新建/重命名/删除；当前条目行极性翻转；独立滚动。

**`rel-panel`** — 关系图（push 右实例，默认 1/2 屏；10×60 把手可调，全图时隐藏）。
- 面板 = surface + 左缘 1px line；顶部工具条（`含反链` 开关 · `展开全图` · 等宽节点计数）+ 图布；**节点 = 44~96px 纯色带边框矩形（0 圆角，非圆）**，当前文档节点极性翻转；边 = 发丝两档（强边 `line-strong` / 弱边 `line`）；拖节点力导向实时重算；hover 浮 LinkPreviewCard（按空间在节点上/下方，含稍后阅读）。

**元数据浅字排版（读态，替代芯片）**：不再显示 `&x` 键名与矩形——**标题区一体化**：
- **标题上方一行**（`entry-meta-top`，全部浅字 muted、可点击编辑）：`&q` 可信度（warn 色，**最前**）→ `&p` 状态（ok 色）→ `&f` 事件（link 色）→ `&t…` 标签 → `&a` 时代 → `&v` 可见性；
- **标题行右侧**（底对齐）：`&s – &e`（等宽浅字，右缘 = h1 块右边界）；
- `&n` 即标题本身；`&m` 封面不入标题区。
- **点芯片 = 值控件**（日期掩码输入 / 标签多选 / 枚举下拉 / 文本），保存写回 `&` 行；编辑态 hover 转**虚线边**提示可点。

**`editor-deco`** — 编辑装饰层（CodeMirror 6 decoration 的视觉规范）。
- `**粗**` → 只显字重 700（吞掉星号）；`[[链接]]` → `{colors.link}` + 4px 下偏移下划线；`#标签` → 标签样式（等宽 muted）；`&` 元数据片段 → 折叠为 `metadata-chip` 占位（点击展开原文编辑）；``` 围栏头 → eyebrow 类型角标；标题按级映射 display 字号字重。
- 底保持 `{colors.canvas}`，**不做富文本 contenteditable**——装饰层只改「显示」，不改「字节」。

**`editor-min`** — 极简编辑器（A 档降级，「更多设置 → 编辑器：极简」）。
- 纯 `<textarea>` 源文编辑：等宽字体、无工具栏无装饰层、眉题注记；保存管线与标准档共用（防抖 500ms + 退出一次写盘）。

### Timeline & Interaction Components（时间轴与悬浮交互，详见 功能设计.md）

**`chrono-bar`** — 顶部时间轴条（sticky 组成员，h112，surface 底 + 底部 1px line）。
- 三层：旗标层（event-flag）/ 轴线 + span 条 / 刻度层 28px（轴线 1px `line-strong` + 等宽年份）。**时代带 `era-band` 已实现**（轴下 h10 交替条带 + 时代名，点击取景；「更多设置」可关）。

**`chrono-marker`（起止标记 + 范围首尾刻度，2026-10-06 现状修订）** — 打开文档的 `&s`/`&e` 时刻 + 数据范围两端。
- 结构：**轴下方一个等宽年份**（`chrono-marker-tick`，0.64rem mono、`{colors.text}`、加粗、无墨线无胶囊）+ 刻度短线（`::before` 8px）；**范围首尾 `.edge` 刻度线加高（12px）**、title「范围起点（最早时间）/范围终点（最晚结束）」；年份取**所在年**（floor，08 月不进位）。常规刻度与彼此就近让位（<24px 不重绘）。
- 打开条目即随之绘制（不再自动取景；§3.6）；无 `&e` 只画 `&s`；创世条目不起止标记。

**`event-flag`** — 悬挂事件旗标。
- 140×52，card-surface 同配方（1px `{colors.line}` / 0 圆角 / Level 1.5 投影）；内容 = 眉题 + 衬线标题（单行省略）+ 等宽日期（模糊段前缀 `≈`）。1px `{colors.line-strong}` 引线垂至轴线（`--lead-x` 补偿让位位移，恒指真实时刻）。
- **打开态极性翻转**（ink 底 / on-accent 字）——与 read-later chip、章节高亮共用同一「正在读」语言。**z=80 恒最上（显式内联置值）且参与碰撞**（第 67 轮）：被它盖住左半的卡片链式左让；它压到创世则它自己右移让位；它本身是创世则创世组含它重排。
- **聚合簇变体（第 66 轮）**：眉题「同时」+ 标题「＋N 条」+ 首条日期；hover 展开换成员名单（前 3 + …）、原生 title = 全名单；**点击 = 取景该时刻**（非打开）；元素复用键 = 首成员 path。

**`span-bar`** — 覆盖范围条，h6，贴时间轴线（`bottom: 0`），`{colors.bg-soft}` 填充 1px `{colors.text}` 边框；**模糊 = 按端渐隐（第 66 轮）：`.fuzzy-s` 左端 mask 渐隐 / `.fuzzy-e` 右端渐隐 / 两端皆有则两端渐隐（替代旧 dashed）；渐隐长度 `min(24px, 33%)`——短条按比例收窄、保留实心核心（第 67 轮）**；**打开态：1px ink 边框，不加粗**。

**`edge-hint`（出界指示，第 66 轮）** — bar 左右缘 10px 处的「◀ N / N ▶」chip：1px `{colors.line}` 框 + surface 底 + 0 圆角 + 0.6rem mono 数字 + 8px 线条 chevron（stroke 1.6）；hover 仅边框/字色加深；z=95（高于卡片 90）；N = 完全在视口外一侧的卡片数；点击平滑取景（最近出界卡落到 1/4 屏或 3/4 屏）；N=0 隐藏。

**`genesis-tail`（创世向左渐隐箭头，第 66 轮）** — 创世组左缘 −26px 处的 8px 线条 chevron（`{colors.text-muted}`、opacity .55）+ 20px hairline（`{colors.line-strong}`，向左 mask 渐隐）；z=5（压在卡片之下）；**仅组左缘在屏内（>6px）时显示**（第 68 轮：创世排不再钉屏内、可自然拖出屏幕，左缘出屏则无箭头可指）；`pointer-events: none`。

**`era-band`** — 时代色带，`{colors.bg}` / `{colors.bg-soft}` 交替段 + `{typography.eyebrow}` 时代名，点击跳转时代。

**`icon-button`** — 线条图标按钮（更多、关闭、筛选等一切图标操作）。
- 线条 SVG（stroke 1.5px，currentColor）+ 无背景 + 无边框 + 0 圆角；hover 仅 `{colors.text-muted}` → `{colors.text}`；激活态可加 1px `{colors.line-strong}` 下划线（不加底色）。**这是「按钮线条图标无背景」铁律的唯一载体。**

### fab 簇与面板（2026-10-06 二次定型；书架 Dock 已废弃）

**`fab-cluster`（六钮三对，2026-10-06 二次定型）** — 左下 `+`（世界）· `格`（全部书籍，四个正方形网格图标）· `☰`（目录，三条横线图标）；右下 `✎`（编辑，铅笔细线 ↔ 编辑态换存盘图标）· `⛶`（关系，节点连线）· `工`（工具箱）。
- 六钮同型：**40×40 · 到屏边 8px · 间距 8px · 左右对称**；图标 = 1.3px 细线 SVG（fill none / stroke currentColor）；`active`（面板开 / 编辑中）= **ink 翻转**。
- **旧 `world-pop`（贴 fab 气泡）与 ⌯ 操作面板方案已废弃**。

**`world-panel`（左 push，固定宽）** — 世界入口的展开形态（`+` 钮开合）。
- 内容自上而下：`&m` 横幅（150px，无图不渲染，失败回退首字大衬线）→ 世界名（衬线 1.5rem）→ 统计行（书籍 · 条目，等宽）→ git 行（分支 · hash · 时间）→ **提交行**（左计数右按钮，无未提交时按钮隐藏）→ **全部设置条目**（日/夜 · 字体 · 字号 · 行高 · 列宽 · 语言 → **「更多设置 ▸」折叠块**：编辑器档位 / 时代带 / 智能收拢 / 目录展开深度）→ 关于行 → `← 返回世界列表` 行。
- **固定宽 `min(420px, 40vw)`，无宽度把手**；设置不再有独立面板。

**`books-panel`（全部书籍，左 push；书架 Dock 已废弃）** — 左下 `格` 钮开合。
- 面板 = `.panel-head`（「全部书籍 + N 本」等宽计数）+ **`.books-filter` 分类 chip 行**（`bf-chip`：全部 + 顶层书 `&t` 去重；激活 = ink 底；计数「N / M 本」）+ `.panel-scroll` 内 **`.books-grid`**：`repeat(auto-fill, minmax(150px, 1fr))` **默认两列**、竖排滚动；**拖动把手加宽 → 列数自动增加**；
- 书卡 `book-card`（2:3 封面 + 书名 + 标签行）+ **hover 倾斜**（`hover-tilt` 原语，容器 `perspective: 1200px`）；
- 点击书卡 → 打开该书首条目并**切换为目录面板**。

**`book-card`** — 全部书籍面板网格项（功能设计 §8.3）。
- 2:3 封面竖矩形（bg-soft + 边框 + 衬线首字）+ 书名（衬线 700）+ 标签行（eyebrow）；**hover 倾斜**（`hover-tilt`）；点击 → 打开该书首条目并切换为目录面板。

**`annotation-row`** — 勘误行（书籍错误 → 正确段落的链接）。
- alert-row 同构：3px `{colors.alert}` 前缘 + `{colors.bg-soft}` 底 + 正文 + 指向 `[[词条#锚]]` 的超链；`disputed`（存疑）态 = 虚线 warning 左缘、不判死。行内配 `已证伪/存疑` 徽章（status-badge）。

**`placeholder-nav`** — 未接入功能的导航项（地图）。
- disabled `nav-link`：`{colors.text-muted}` 字色 + 无背景，不新造样式。

**`scroll-indicator`** 的 **稍后阅读例外**：顶部横线已移除（竖列手动滚动无指示条）。

**`toc-resize`** — 目录宽度把手：瘦高 10px 矩形贴目录右分割线，中央 2px 竖线 hover 显示；拖动调目录宽（260px ~ 50vw，sessionStorage 记忆），**默认 1/3 屏**。

**`event-flag`（尺寸与布局）** — 基础宽 = 每字 14px（**最多 4 字**，不足 4 字按实收窄，超 4 字省略号）；**hover/打开 width:auto 完整标题**（≤240px）+ z=90；**打开中的卡片恒在最上（z=80）**；**正常位置 + 重叠堆叠**：越晚 z 越高，较早卡片依次左让 10px（引线 `--lead-x` 补偿，时刻不变）；**不做自动缩放**；起止标记 = **轴下年份刻度**（`chrono-marker-tick`，墨色加粗，与标尺同款）。

**`link-preview-card`** — 链接悬浮预览卡，360×336，Level 1.5 投影；**证伪链接的卡片顶部加 `lpc-refuted` 块**（3px error 前缘 + 「已证伪——正确信息见本条目」说明）。

- 背景：封面 `blur(14px) opacity(.45)` + 向内容侧渐变到 surface 的遮罩（保证文字可读）。
- 结构：标题（display-md）→ 简介（muted）→ hairline → 正文前 100 字（body-sm 4 行 line-clamp）→ **底部 42px 稍后阅读按钮条**（= 卡高 1/8，hairline 隔开）；打开动效 140ms 淡入 + 4px 上浮（`{motion.quick}`，待实现）。
- 定位：默认在链接上方；越界则翻到下方，**按钮永远贴靠链接一侧**（卡在上→按钮在下，卡在下→按钮在上）。

**`diff-row`** — 工具箱 diff 行，复用 `article-card` 网格；旧文等宽 + line-through muted，新文等宽 text，变更段 bg-soft 高亮。

**`toast`** — 3px 前缘语义色 + bg-soft 底 + 等宽大写标签 + Level 2 投影，四变体 info/success/warning/error。

**`check-row`** — 全站唯一勾选形态：**方形色块 + 紧挨的文字矩形**（同外框内以 1px 竖线分隔）；正方形选中 = ink 填充、未选 = bg-soft，矩形内为文字标签；隐藏原生 checkbox。（工具箱列表/全选、关系图含反链等全部使用。）

**`ask-dialog`** — 样式化输入弹层（**替代一切原生 prompt/confirm**）：窄 modal 纸面 + 单行 `text-input` + 取消/确定；Enter 确定、Esc 取消。所有"填一个值"的交互（提交信息、围栏类型、元数据键、图片路径）一律走它。

**`scroll-indicator`** — **全站滚动条的唯一形态**：内容区顶部 3px **横向进度条**（**左端恒在面板最左；右端 = 文档顶端→屏幕底端已显示的百分比**，2026-10-06 定案），色 = `{colors.text-muted}`，sticky top:0，`pointer-events:none`；**原生滚动条全部隐藏**。附着判据 = bar 实际存在（innerHTML 重写删 bar 后自动重建）。应用区：reader-column / toc-panel / books-grid（面板滚动）/ tools-list / search-results / modal-scroll / 稍后阅读列表（手动模式特制）。

### Examples (illustrative)

**`ex-world-list`** — 首页世界列表（横排竖卡 + 「+」新建卡，hover 倾斜，滚轮横滚）。
- Properties: `cardSize`, `tiltRange`, `gap`, `newCardDashed`

**`ex-readlater-fan`** — 稍后阅读卡片集两态演示（扇形聚拢 ↔ 横排展开 + 单卡上升 + 右上 ×）。
- Properties: `cardSize`, `fanAngle`, `restPitch`, `openGap`, `hoverRise`, `edgeClearance`

**`ex-push-split`** — 推挤分栏演示（左面板开=正文右推 / 右面板开=正文左推，五面板互斥；宽度把手 10×60 骑边界线）。
- Properties: `trackWidth`, `resizeHandle`, `transitionCurve`, `exclusionRule`

**`ex-entry-list`** — 词条/章节列表（侧栏筛选 + 单列卡流）。
- Properties: `sidebarWidth`, `cardChrome`, `cardGap`, `metaTypography`

**`ex-timeline-row`** — 时间线事件行（等宽年份刻度左 + 衬线事件名右 + 发丝分隔）。
- Properties: `lineColor`, `yearTypography`, `eventTypography`, `rowPadding`

**`ex-fab-cluster`** — 左下/右下三钮 fab 簇（40×40 · 8px 边距/间距 · 1.3px 细线图标 · active=ink）。
- Properties: `fabSize`, `iconStroke`, `activePolarity`, `clusterGap`

**`ex-editor-deco`** — 编辑装饰层样张（粗体字重、双链蓝、元数据芯片折叠、围栏角标）。
- Properties: `decoMarks`, `chipChrome`, `canvasColor`

**`ex-entity-header`** — 实体页头（封面图 + 眉题类型 + display-hero 名 + 状态徽章 + 属性网格）。
- Properties: `surface`, `badgeColors`, `attributeGrid`

**`ex-reading-column`** — 章节阅读列（42rem 居中 + 右侧 floating-toc）。
- Properties: `measure`, `bodyTypography`, `tocVisibility`

**`ex-lint-panel`** — 一致性警报面板（alert-row 竖排 + 计数眉题）。
- Properties: `alertEdgeColor`, `rowChrome`, `countTypography`

**`ex-empty-state`** — 空状态卡（居中一句 muted 题记 + 一个 outline 按钮）。
- Properties: `surface`, `quoteTypography`, `buttonVariant`

**`ex-books-panel`** — 全部书籍左 push 面板（双列竖滚网格 + hover 倾斜 + 宽度调列数）。
- Properties: `gridMin`, `columns`, `tiltRange`, `resizable`

**`ex-book-grid`** — 「更多」书目网格（filter-button 分类 + 2:3 封面书卡 + reliability 徽章）。
- Properties: `cardChrome`, `coverRatio`, `badgeColors`, `gridMin`

**`ex-annotation-row`** — 书籍勘误行（3px alert 前缘 + 超链到 `[[词条#锚]]`；存疑态虚线 warning 左缘）。
- Properties: `edgeColor`, `rowChrome`, `linkTypography`

## Do's and Don'ts

### Do
- 用 CSS 变量承载全部颜色与双主题，`dark-mode` 一个 class 翻转整站（参考站 `:root / .dark-mode` 两段变量即可完成）。
- **一切推挤面板走 `push-panel` 原语**（五实例共用 `.push-panel/.panel-head/.panel-scroll`）：轨道推挤、**两两互斥**、正文恒 ≥ 半屏、`Esc` 收起；**时间轴通栏永不被推挤**；宽度把手一律 `panel-resize`（10×60 骑边界线）。
- **「正在打开」一律极性翻转**：时间轴旗标、卡片集卡片、关系图节点、树面板行，同一个 ink↔surface 语言——外加时间轴上的 `chrono-marker` 起止墨线（打开文档的时刻标记）与「打开即显示 / 强调持久」旗标规则。
- **左下/右下 fab 簇严格对称**：六个 40×40、到屏边 8px、间距 8px（左：`+` `格` `☰`；右：`✎` `⛶` `工`），图标一律 1.3px 细线 SVG。
- 世界内**不加 header**：顶部只有时间轴；首页才用磨砂 masthead（sticky + `rgba(.92)` + `blur(12px)` + 底部 1px 线）。
- 一行多块一律 CSS Grid、gap 取 20px（区块）或 12px（卡间），列比写死 `2fr 2fr 1.05fr` / `minmax(240px,25%) 1fr`，塌陷点定在 1180px。
- 卡片永远是「白面 + 1px `#d8d8d8` + 4% 投影 + 0 圆角 + 22px 内边距」这一个配方。
- 大写 + 0.08em 字距做所有元数据；`[[双链]]` 与正文链接用 `#057dbc` + `underline-offset: 4px`。
- footer 只放一句居中题记——平台的诗意靠它落地。

### Don't
- 不引入第二种彩色。状态色只以「bg-soft 底上的字色」出现，警报只以 3px 左缘线出现。
- 不给卡片/按钮/输入加圆角（圆形只留给主题钮与头像）。
- 不上重投影、不做玻璃拟态卡（磨砂只属于顶栏与遮罩）。
- **不用原生滚动条**——一切滚动区走 `scroll-indicator` 顶部百分比条（**滚动时出现，停止 800ms 后淡出**）；封面图加载失败一律回退为**大首字母**（`bindCoverFallbacks`），绝不出现破图占位。
- **卡片不套 box**——卡片内部的分块用 hairlines 分隔（cover 区以 `border-bottom` 与内容分界），不给内部块再画独立完整边框（"大 box 套小 box"禁止）。
- **不用原生弹层**——`window.prompt/confirm/alert` 全站禁用，一律走 `ask-dialog` 等平台组件。
- 不用衬线做按钮和导航，不用无衬线做长文正文。
- 不做黑底大 footer、不做多列链接、不做社交图标行。
- 不在 720px 以下塞侧栏——侧栏转顶部、画布卡直接隐藏。
- **不用圆形节点/圆形卡片**：关系图节点、书、世界卡全是直角矩形（圆形只留给主题钮、头像、关闭钮、状态点）。
- **不做强 WYSIWYG**：编辑样式只靠装饰层（改显示不改字节），不做 contenteditable 双向同步。
- **不给 push 面板加装饰**（无阴影渐变、无箭头鱼骨），轨道推挤本身即交互表达。
- **不硬编码可见文案**——一切 UI 字符串走 `t(key)`，中英双语同源；**不翻译用户内容**（正文、标题、标签值是数据）；枚举徽章用「稳定存储值 + 双语显示映射」。

## 参考站与外部规范（References）

| 来源 | 采纳 | 不采纳 / 备注 |
|------|------|---------------|
| **zgggy.github.io**（主基准，已实测取值） | 磨砂粘性顶栏、三栏 hero 卡片带、`20/12/22` 三档间距、单色墨系 + 4% 轻投影、0 圆角、大写 0.08em 眉题、一行题记 footer、暗色双变量、filter-button 激活态、980px 阅读模态 | 结构不照搬（个人文学站 vs 平台） |
| **getdesign.md · Notion** | ① **分层微投影**（多停靠点近透明 stops）→ 本稿 Level 1.5（悬浮预览卡/旗标/toast）；② **Toast 四语义色 = 3px 前缘线 + 等宽大写标签**；③ **polarity-flip 表达选中态**（打开中的旗标/chip/章节共用）；④ 数据表 mono 大写表头 + 发丝行线（工具箱 diff 表沿用） | 药丸按钮、8/12px 圆角、装饰彩色贴纸——与 0 圆角单色基底冲突 |
| **getdesign.md · Mintlify** | ① 侧栏分组眉题 11px/600 大写；② 文档级 body 行高 1.5 与代码 inline 13px/500；③ 黑白基底 + **手术刀式**单点强调色的克制原则（与本稿同构，可互为佐证） | 薄荷绿强调色、渐变 hero、药丸按钮 |
| **getdesign.md 目录整体** | 确认本稿与 Google DESIGN.md 官方 spec 的 section 结构一致（Overview / Colors / Typography / Layout / Elevation / Shapes / Components / Do's & Don'ts）；550+ 站点可按需再查 | — |

> 结论：外部规范对本稿的**增量**集中在「浮起层」——Level 1.5 分层投影、Toast 语义色、polarity-flip 选中态，三者已并入上文组件与色板；基底（纸白/墨黑/0 圆角/衬线）保持不变。
