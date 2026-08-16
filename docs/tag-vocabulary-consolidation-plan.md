# 修改计划：标签词表漂移修复 + Markdown 渲染一致性

> 状态：阶段一已实施（代码完成、测试通过，待评审）；阶段二待启动
> 阶段一：标签词表漂移修复（已实施）
> 阶段二：Markdown 渲染一致性（研究完成，方案待确认）

---

# 阶段一：标签词表漂移修复

## 1. 问题描述

`@license` 标签目前会被吞进描述文本里：

- [DocCommentParser.ts:812-813](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/src/parser/DocCommentParser.ts#L812-L813) 的 `METADATA_TAG_PATTERN` 缺少 `license` / `prop`。
- 该正则用于在 `parseJavadoc`（[DocCommentParser.ts:828-853](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/src/parser/DocCommentParser.ts#L828-L853)）中定位「描述」与「标签」的切分点：首个被匹配的元数据标签行之前的文本视为 description，之后的交给 `parseTagTable` 解析为结构化标签。
- 当注释里只有 `@license MIT`（或 `@prop ...`）而没有其他受支持元数据标签时，`METADATA_TAG_PATTERN` 匹配不到任何切分点 → `splitIndex = -1` → 整段注释（含 `@license MIT`）全部落入 description，标签完全丢失。
- 文件头若含其他标签（如 `@author`）也无法兜底：`@license` 行若位于首个被识别标签之前，同样会被并入描述。

`TagParser.ts` 侧（`TAG_LINE_PATTERN` / `SupportedTag` / `isSupportedTag`）是**支持** `license`、`prop`、`property` 的，问题只出在 `DocCommentParser` 的词表与它们不同步。

## 2. 根因分析：四处标签词表漂移

当前标签词表被复制在 4 个位置：

| # | 位置 | 形态 |
|---|------|------|
| 1 | `DocCommentParser.ts:812` `METADATA_TAG_PATTERN` | 正则 |
| 2 | `TagParser.ts:26-56` `SupportedTag` | TS 类型联合 |
| 3 | `TagParser.ts:66-67` `TAG_LINE_PATTERN` | 正则 |
| 4 | `TagParser.ts:444-480` `isSupportedTag` | switch 分支 |

四处实际差异（以 TagParser 三处为准）：

- **缺 `license`**：仅 #1 缺失 → 直接导致本 Bug（@license 吞进描述）。
- **缺 `prop` 且 `property` 实际也不匹配**：#1 写的是 `properties?`，正则语义为 `propertie` + 可选 `s`，只能匹配 `propertie`/`properties`，**匹配不到 `property`（propert+y）也匹配不到 `prop`** → `@prop` / `@property` 同样会被吞进描述。
- **多出 `properties`**：#1 独有的非标准复数，TagParser 不处理（tokenizer 按未知标签静默丢弃），仅充当切分点。

## 3. 修改方案

### 3.1 新增共享词表模块 `src/parser/tagConstants.ts`

收敛为单一事实来源，所有正则与类型判断都由它派生：

```ts
/**
 * tagConstants.ts - Javadoc/JSDoc 受支持标签的单一事实来源
 *
 * 背景：标签词表曾分散在 DocCommentParser.METADATA_TAG_PATTERN 与
 * TagParser 的 SupportedTag / TAG_LINE_PATTERN / isSupportedTag 四处，
 * 因不同步导致 @license / @prop 被吞进描述文本。此处收敛为一份共享常量，
 * 正则与类型判断均由此派生，杜绝再次漂移。
 */

/** 受支持的 Javadoc/JSDoc 标签全量词表（含别名；全部为小写字母，可直接嵌入正则） */
export const SUPPORTED_TAGS = [
  "param", "return", "returns", "throws", "exception",
  "since", "author", "license", "deprecated", "see",
  "doc", "example", "type", "typedef", "property", "prop",
  "template", "yields", "yield", "summary", "description",
  "desc", "todo", "emits", "fires", "listens",
  "readonly", "async", "override",
] as const;

export type SupportedTag = (typeof SUPPORTED_TAGS)[number];

/** O(1) 成员判断（替代手写 switch，杜绝枚举漂移） */
export const SUPPORTED_TAG_SET: ReadonlySet<string> = new Set(SUPPORTED_TAGS);

// 词表均为小写字母，直接 join 即可安全嵌入正则（无需转义）
const TAG_ALTERNATION = SUPPORTED_TAGS.join("|");

/** 行首 @元数据标签切分点（DocCommentParser 用）：行首锚定 + 多行模式，区分大小写（与现状一致） */
export const METADATA_TAG_PATTERN = new RegExp(`^@(?:${TAG_ALTERNATION})\\b`, "m");

/** 行首 @标签行解析（TagParser 用）：忽略大小写 + 捕获标签名与内容 */
export const TAG_LINE_PATTERN = new RegExp(
  `^\\s*\\*?\\s*@(?<tag>${TAG_ALTERNATION})\\b\\s*(?<content>.*)$`,
  "i",
);
```

要点：

- 由词表全量枚举生成正则，等价于原先 `returns?` / `yields?` / `properties?` 简写（`\b` 保证 `return` 不会误匹配 `returns`、`desc` 不会误匹配 `description` 等）。
- `METADATA_TAG_PATTERN` 不传 `i` 标志、`TAG_LINE_PATTERN` 传 `i` 标志，与现状保持一致。

### 3.2 改造 `TagParser.ts`

- 删除本地 `SupportedTag` 联合类型 → `import type { SupportedTag } from "./tagConstants.js"`。
- 删除本地 `TAG_LINE_PATTERN` 常量 → `import { TAG_LINE_PATTERN, SUPPORTED_TAG_SET } from "./tagConstants.js"`。
- `isSupportedTag`（第 444-480 行）的 switch 整体替换为一行：

  ```ts
  function isSupportedTag(value: string): value is SupportedTag {
    return SUPPORTED_TAG_SET.has(value);
  }
  ```

- 其余（`SPDX_LICENSE_PATTERN`、`UNKNOWN_TAG_PATTERN`、switch 解析逻辑等）保持不变。

### 3.3 改造 `DocCommentParser.ts`

- 删除 `private static readonly METADATA_TAG_PATTERN`（原第 812-813 行）及其说明注释，改为 `import { METADATA_TAG_PATTERN } from "./tagConstants.js"`。
- 原 `cleaned.search(DocCommentParser.METADATA_TAG_PATTERN)` 改为 `cleaned.search(METADATA_TAG_PATTERN)`。
- `SPDX_LICENSE_PATTERN`（原第 822-823 行）保留不动。
- **新增文件头判定修复**（实施中发现的相邻缺陷）：仅含 `@license` 等元数据、无描述文本的文件头，原先因 `hasFileHeader` 要求 `description` 非空而被整体丢弃（`docLicense` 为 undefined）。修复为：新增 `DocCommentParser.hasAnyTags(tags)` 静态辅助方法，`hasFileHeader` 判定改为「注释非空 且（有描述文本 或 含任意结构化标签）」，与 SPDX 行提取到 license 的既有语义保持一致。

### 3.4 行为变化说明

| 场景 | 修改前 | 修改后 |
|------|--------|--------|
| 注释仅含 `@license MIT` | 吞进 description，license 丢失 | 提取为 `tags.license` / `doc.docLicense`（**Bug 修复**） |
| 注释含 `@prop` / `@property` 且为首个元数据行 | 吞进 description | 作为切分点并解析进 `tags.properties`（**Bug 修复**） |
| `@properties`（非标准复数）出现在任何受支持标签之前 | 作为切分点后被静默丢弃 | 保留在描述文本中 |

其中 `@properties` 的行为变化属可接受边缘差异：它既非 Javadoc 也非 JSDoc 标准标签（标准为 `@property` / `@prop`），收敛后与「不受支持的 @xxx 视为正文」的既有语义保持一致；若确认需要支持，可后续在共享词表显式声明并补充 switch 处理（不在本次范围）。

## 4. 测试计划（阶段一）

在现有 `test/tagParser.test.ts` 与 `test/parser.test.ts` 中补充回归用例（不改动既有用例，全部应继续通过）：

1. `test/parser.test.ts`（集成层，Bug 回归重点）：
   - 文件头仅含 `@license MIT`（类声明场景）→ `doc.docLicense === "MIT"` 且 `doc.classComment` 不含 `@license`（覆盖 hasFileHeader 修复）。
   - `@file` 描述 + `@license` 文件头 → license 提取、描述不吞标签。
   - 字段注释含 `@property {string} name 描述` 与 `@prop {number} size 大小` → `tags.properties` 解析正确、字段描述不吞标签。
2. `test/tagParser.test.ts`（单元层，防回归）：
   - `@property` / `@prop` 的 `{type} name - desc` 解析（此前无直接覆盖）。

实施后全量 10 个套件、170 个用例全部通过。`pnpm run lint` 因仓库缺少 eslint 配置文件（既有问题，无 `.eslintrc.*` / `eslint.config.*`）无法运行，与本次改动无关。

## 5. 验证步骤（阶段一）

```bash
pnpm run compile   # tsc 类型检查
pnpm run lint      # eslint
pnpm test:parser   # jest parser（含新增回归用例）
pnpm test          # 全量测试
```

## 6. 影响范围与风险（阶段一）

- **改动面**：`DocCommentParser.ts`、`TagParser.ts` 两个解析文件 + 新增纯常量模块 `tagConstants.ts`，另含 `hasFileHeader` 判定一处小幅行为修复（见 3.3），不涉及 `types.ts`、UI 与渲染层。
- **正则等价性**：由共享词表生成的 alternation 与原先手写简写语义等价（`\b` 兜底前缀），唯一例外是 `properties`（见 3.4）。
- **依赖**：`tagConstants.ts` 为无副作用纯常量，被两个解析文件引用，无运行时影响。
- **hasFileHeader 行为面**：仅影响"首个注释只含元数据标签（无描述文本）"的文件头——此前整体丢弃，现提升为文件级标签。全量测试无回归。
- **明确不纳入本次范围**：两份 `SPDX_LICENSE_PATTERN`（DocCommentParser 与 TagParser）写法略异但不属标签词表，保持不动；`@properties` 支持与否留待后续决策。

---

# 阶段二：Markdown 渲染一致性（研究结论与方案）

## 7. 问题描述（阶段二）

用户反馈：注释的 markdown 渲染与 markdown 文件预览之间代码复用不佳；部分渲染在 fallback 之后没有"恢复"，或存在隐式 fallback，导致**同一 markdown 内容在三处渲染效果不一致**。

## 8. 现状调研结论

### 8.1 三条渲染路径与三个异步增强器

核心转换函数已共享：`markdownToHtml`（[sidebar.js:2572](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L2572)）与行内转换 `applyInlineMarkdown`（[sidebar.js:3106](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L3106)）。但在其上存在**三条消费路径**：

| 路径 | 入口 | 差异 |
|------|------|------|
| P1 注释渲染 | `renderClassDoc` → `renderCommentBody`/`renderClassComment`（[3315](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L3315)） | `markdownToHtml(x, {})`，`trackLines=false`，imageMap 恒为 `{}` |
| P2 Markdown 文件预览 | `renderMarkdown`（[817](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L817)） | `trackLines=true`，imageMap 由扩展注入（相对路径图片可显示） |
| P3 放大预览 | `buildPreviewContent`（[2132](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L2132)） | 按元素类型**从零重建**，不经过 `markdownToHtml` |

三个异步增强器（KaTeX / Mermaid / highlight.js）的回调（`__renderMath`[159](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L159)、`__renderMermaid`[242](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L242)、`__highlightCode`[267](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L267)）**全部只作用在 `root`**，并分别在三处被重复调用（[830-832](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L830-L832)、[1038-1040](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L1038-L1040)、[1078-1080](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L1078-L1080)）。

### 8.2 代码复用不佳的具体点

1. **内容型标签 section 各自为政**：`renderCommentBody`（[3315](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L3315)）内 @summary / @description / @doc（[renderDocSection:2521](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L2521)）/ @example（[renderExampleSection:2534](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L2534)）/ @see 各自独立调用 `markdownToHtml` 并手拼不同包裹结构（`jsdoc-summary` / `jsdoc-description` / `doc-section` / `example-section` / `other-tag`），与 P2 整页 markdown 渲染的类名与结构体系不一致。
2. **imageMap 口径差异**：P1 恒传 `{}`，注释内相对路径图片无法解析（P2 可显示）。行为差异是设计使然，但口径未在代码中固化说明。
3. **增强器调用点重复**：三处 `if (window.__renderMath)...` 顺序重复，且都硬编码 `root`（见 8.3）。

### 8.3 fallback 缺失 / 不一致的具体点（即用户所述"fallback 后的恢复没做"）

1. **vendor 脚本无 `onerror`**：KaTeX / Mermaid / highlight.js 以 `defer` + `onload` 加载本地 vendor 文件（[SidebarProvider.ts:1261-1268](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/src/SidebarProvider.ts#L1261-L1268)）。加载失败时回调静默跳过，**无清理、无提示、无恢复**。
2. **KaTeX 缺失 → 隐式 fallback 残留原始文本**：`$...$` / `$$...$$` 以原文留在 `.md-math-inline` / `.md-math-block` 内（`applyInlineMarkdown` 仅把它包进 span），观感与渲染成功时完全不同。
3. **Mermaid 缺失 → 隐式 fallback 裸露源码**：`.md-mermaid` 容器内 `<pre class="mermaid">源码</pre>` 原文裸露（该 pre 无代码高亮样式），观感不一致。
4. **highlight.js 缺失**：代码块不高亮——属"一致的降级"，可接受。
5. **P3 放大预览缺 math 处理**：mermaid 有专门重建与源码 fallback（[renderMermaidInPreview:2218-2229](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L2218-L2229)）、代码块重新高亮、图片自然尺寸、表格克隆；**唯独数学公式落入兜底「克隆原容器」分支（[2187-2189](file:///Users/frank/Code/Fork/code-comment-visualization-plugin/media/sidebar.js#L2187-L2189)）**。而 KaTeX 渲染后 root 中的 `$...$` 已被替换为 KaTeX DOM，克隆结果取决于触发时机，且 `__renderMath` 只作用 `root` → 放大预览中的数学公式与侧栏内渲染不一致。

### 8.4 影响

- 触发条件：vendor 本地资源加载失败（webview URI 异常、文件缺失、CSP 拦截）、或放大预览触发时机在 KaTeX 渲染前后不同。
- 观感差异集中在：数学公式、Mermaid 图表两类内容，在"侧栏 vs 放大预览 vs 资源缺失时"三态不一致。

## 9. 方案（阶段二，建议分三步落地）

### 9.1 统一异步增强器调用

- 新增 `applyAsyncEnhancers(container)` 帮助函数，收敛三处重复调用（830-832 / 1038-1040 / 1078-1080）。
- 回调改为以参数容器为准（默认 `root`），为 P3 放大预览复用铺路。

### 9.2 统一 fallback 表现（回应用户"要不然就不 fallback / 明确 fallback"）

推荐方案（一致性优先，不追求"永不 fallback"）：

- **KaTeX**：`__renderMath` 未加载时，把 `.md-math-block` / `.md-math-inline` 降级为"代码样式源码文本 + 注释说明"（与 Mermaid 的源码 fallback 风格一致），保证加载成功/失败观感统一、且用户知道这是未渲染的公式源码。
- **Mermaid**：`__renderMermaid` 未加载时，`.md-mermaid` 内源码降级为与 `renderMermaidInPreview` 一致的 `md-code-block` 样式，统一"源码文本"形态。
- **onerror 提示（可选）**：为 vendor 脚本补 `onerror`，侧栏顶部显示一次"公式/图表组件未加载"提示，避免静默失败。
- 明确不做的：不引入 CDN 远程回退（破坏离线可用性设计）。

### 9.3 补齐 P3 放大预览 math 并收敛 section 渲染

- `buildPreviewContent` 增加 `.md-math-block` / `.md-math-inline` 分支：读取原始公式源码 → 在预览层触发 KaTeX 渲染（或按 9.2 统一降级）。
- 收敛内容型标签 section：抽出统一的 `renderMarkdownSection({ className, title, html })` 包装函数，消除 @doc / @example / @see 等各自拼 HTML 的重复；行级预览（method-desc-preview / field-description）保持 `applyInlineMarkdown` 共享。
- 文档固化 P1/P2 的 imageMap 口径差异（注释相对路径图片不支持，属设计行为）。

## 10. 测试计划（阶段二）

- 手工验证清单：`$公式$` / `$$公式$$`、mermaid 块、代码块在 P1/P2/P3 三处观感一致；断网/删 vendor 文件模拟加载失败，验证降级形态统一。
- 现有 jest 测试不受影响（阶段二改动全在 `media/sidebar.js` 前端渲染层，无单测覆盖，暂以手工清单验证为主）。

## 11. 验证步骤（阶段二）

```bash
pnpm run compile
pnpm run lint
# 扩展调试（F5）手工走查：注释/预览/放大预览三处渲染与降级形态
```

## 12. 影响范围与风险（阶段二）

- **改动面**：仅 `media/sidebar.js`（与可选 `src/SidebarProvider.ts` 的 script 标签 onerror），不涉及解析层与数据模型。
- **风险**：渲染层改动可能影响滚动锚点（KaTeX/Mermaid 渲染后高度变化会失效锚点缓存）——9.1/9.3 的实现需沿用现有 `invalidateScrollAnchors` 约定；P3 math 重建需与 `renderMathInElement` 的作用域配合，避免重复渲染。
- **取舍**：9.2 采用"统一降级表现"而非"永不 fallback"，因为 vendor 本地加载失败属于 webview 环境的客观风险，彻底消灭 fallback 不现实；核心诉求是**失败时观感可预期、且三处一致**。

---

# 附录：版本号

- 阶段一落地后参照仓库惯例（如 commit `3c4832a`）版本升至 `0.9.104`；阶段二按其完成情况再评估升版。
