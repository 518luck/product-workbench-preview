# 产品蓝图

产品蓝图帮助团队把产品背景和行为整理成可持续维护的自然语言文档。已有项目可以从源码梳理实际行为；新项目可以先记录需求，再逐步补全按业务能力划分的功能、规则、步骤、异常、依赖和验收要求。

用户、AI Skills 和 CLI 分工协作：用户在固定 HTML 界面阅读、编辑和确认文档；三个 Skill 分别负责初始化蓝图、维护需求变化、按已确认的蓝图实现功能；CLI 提供文档读写、变更预览、校验、版本与并发保护、JS／TS 源码分析，以及固定模板 HTML 生成。网页不连接 AI，CLI 不调用模型、不执行被扫描项目的代码或测试。AI 在外部理解需求、修改代码并实际验收。

已有项目的分析会话记录源码范围、读取凭据和内容指纹，逐项支持 JS／TS 函数及顶层逻辑分析，并报告解析失败、未覆盖源码和无法确定的调用。工具可以核对分析记录和文档依据是否完整，但不能证明 AI 的理解一定正确；未知或推断内容应明确标注，分析有缺口时可以交付草稿，不能据此登记完成。

功能状态只有“草稿”和“完成”。业务定义变化会产生新版本并回到草稿；完成状态要求业务流程同步到当前定义版本，并有针对该版本的外部验收记录。时序图和数据流图是可选图表。

需要 Node.js 22.14 或更新版本。工具固定依赖 `typescript@6.0.2`，用于静态解析 JavaScript／TypeScript（含 JSX／TSX），不执行被扫描项目。开发使用 pnpm。

## 初始化、阅读与生成

在工具源码目录中使用 `pnpm blueprint`；本机安装后使用 `product-blueprint`：

```sh
pnpm blueprint --help
pnpm blueprint --version
pnpm blueprint init ./my-product --name "我的产品" --json
pnpm blueprint document get ./my-product --section product --json
pnpm blueprint feature list ./my-product --status draft --json
pnpm blueprint validate ./my-product --json
pnpm blueprint render ./my-product --output ./my-product/index.html --json
pnpm blueprint serve ./my-product --port 62040
pnpm blueprint schema
pnpm blueprint schema --changes
```

目录参数和 JSON 完整路径都可以使用，也可用 `--document` 指定；省略时读取当前目录的 `product-document.json`。`document get --section` 支持 `all`、`product`、`dependencies`、`diagrams`。功能列表支持分组路径及 `draft` / `complete` 筛选，功能详情的 `--related` 附带相关依赖。

`init` 创建空文档和同目录的 `index.html`，不会覆盖已有文件。`validate` 检查格式、稳定编号、引用和版本记录。`render` 使用固定模板生成独立 HTML，失败时保留已有 HTML。`serve` 仅监听本机，支持阅读及保存定义。命令帮助说明可用参数；`--json` 输出供 AI 或程序读取的结构化结果，失败返回非零退出码。

`schema` 输出文档 JSON Schema；`schema --changes` 输出整批变更规范。`examples/minimal-product.json` 是通用最小文档，可用于校验和生成。

## 文档维护

读取结果包含 `documentHash`。写入必须携带本次读取的哈希；文档有任何变化就拒绝旧请求，AI 应重新读取和评估。以下命令接受 `--input 文件` 或 `--input -` 从标准输入读取 JSON：

```sh
product-blueprint feature create feature-id --input feature.json --expected-hash HASH --dry-run --json
product-blueprint feature update feature-id --input changes.json --expected-hash HASH --json
product-blueprint feature define feature-id --input definition.json --expected-hash HASH --json
product-blueprint feature sync feature-id --expected-hash HASH --json
product-blueprint feature complete feature-id --input verification.json --expected-hash HASH --json
product-blueprint feature delete feature-id --expected-hash HASH --dry-run --json
product-blueprint apply --input changes.json --dry-run --json
product-blueprint apply --input changes.json --json
```

单功能命令可以在功能编号后指定目录或文档路径；`apply` 也接受目录或文档路径。输入结构及完整操作格式见 [DOCUMENT.md](DOCUMENT.md)。普通 `feature update` 不能改写用户的定义原文；需要明确改写时使用 `feature define`。版本字段由 CLI 管理，不从输入中接受。

`--dry-run` 展示字段差异、删除影响、版本和状态变化，不保存文档或 HTML。外部 AI 先展示预览，由用户在对话中确认后再执行正式写入；CLI 不弹确认框。整批变更先合并、检查最终引用，再原子保存；任一步校验失败都不保存。没有出现在变更中的功能和字段不会被删除，旧的备注与历史字段保留。

成功保存默认更新同目录 `index.html`，可用 `--output 文件.html` 指定输出，或用 `--no-render` 只保存文档。文档是权威来源；如果文档已保存而 HTML 生成失败，结果会分别报告保存和生成状态，重新执行 `render` 即可恢复快照，不要盲目重复提交已经保存的批次。

参数错误、文档校验失败、版本冲突及生成失败使用不同错误类型。CLI 只校验验收记录的结构与版本，不证明其中描述的项目验证真实执行。明确移除可选字段用整批操作的 `unset`，不能靠省略字段删除；新验收替换旧记录时，旧记录保存在 `implementationHistory`。

## AI 的工作流

1. 读取产品信息及目标功能，按需要读取关联依赖；以业务能力划分功能，保留已有编号和用户原文。
2. 用明确操作整理规则、步骤、异常及验收要求；预览变更，用户确认后保存并同步流程。一次批次内同一功能只递增一次版本。
3. 根据保存后的定义版本实现项目代码，在项目中执行实际验收；CLI 不替 AI 执行代码或测试。
4. 重新读取，确认版本仍相同，再登记通过的验收记录。代码验收失败时保留草稿，不登记完成。

功能只有“草稿”和“完成”。业务内容变化会产生新定义版本并回到草稿；名称和分组变化只增加编辑版本，不改变完成状态。完成登记要求验收对应当前定义版本且业务流程已同步；时序图和数据流图可选。跨功能业务变更必须明确列出受影响功能，CLI 不猜测自然语言的影响范围。

## 固定模板与项目内容

| 层         | 负责的内容                                                   | 项目变化时怎样处理                |
| ---------- | ------------------------------------------------------------ | --------------------------------- |
| 固定模板   | 黑白主题、目录、编辑表单、图表布局、节点详情                 | 工具统一升级，AI 不为每个项目重写 |
| 项目文档   | 产品背景、角色、业务分组、定义、规则、依赖、流程、关系、验收 | AI 使用 CLI 读取并提交明确变更    |
| 校验与保存 | 字段、引用、版本、文件锁及原子保存                           | CLI 与本机编辑服务共享            |
| 生成结果   | 可独立阅读的 HTML 快照                                       | 可重新生成，不作为业务数据来源    |

一份 JSON 保存全部业务内容，CLI 可以按功能和分区读取，不要求 AI 处理整份文件。相同模板版本与相同文档生成一致的 HTML。业务 JSON 不包含 CSS、HTML 程序、SVG 路径、坐标或页面事件；暂不提供任意页面组件和业务校验脚本插件。

主要源码：`assets/` 是固定界面，`lib/` 是校验、分析、文档操作、持久化与服务，`bin/` 是命令入口，`schema/` 是机器可读规范，`skills/` 是三个可独立安装的 AI 工作流。`product-document.json` 是当前用户文档，`dist/index.html` 是其生成快照，均不打入工具包。

直接打开 HTML 可以阅读快照。需要修改并保存时使用 `serve`；AI 保存后刷新页面读取新内容。目录可全部展开或折叠，保持独立滚动并隐藏滚动条。文件锁协调 CLI 与页面保存；直接改写 JSON 的外部程序不遵守这把锁，应使用 CLI 提交变更。

## 本机安装与核验

```sh
pnpm install
pnpm check
pnpm format:check
pnpm package:check
pnpm pack --pack-destination /你的输出目录
pnpm add --global /你的输出目录/product-blueprint-0.2.1.tgz
product-blueprint --help
```

包使用文件白名单，只包含命令、程序、固定模板、规范和通用示例，不包含用户文档、生成快照、测试或本机预览启动脚本。包保持 `private: true`，仅用于本机安装，不发布到包管理平台，不修改 shell 配置。若当前环境没有全局命令目录，仍可使用绝对路径调用：

```sh
node /你的路径/product-workbench-preview/bin/product-blueprint.mjs init .blueprint --name "我的产品"
```

测试使用独立临时目录及随机本机端口，覆盖版本冲突、整批原子保存、字段保留、验收登记、生成失败恢复，以及实际打包安装后在不同项目中运行。格式工具仅是开发依赖，格式化排除用户文档、分析会话和生成结果。不包含 MCP，不调用模型。

## 逐函数分析与三个 Skill

```sh
product-blueprint analysis scan /项目目录 --json
product-blueprint analysis list --session /返回的会话目录 --status pending --json
product-blueprint analysis read 单元编号 --session /会话目录 --json
product-blueprint analysis record --session /会话目录 --input 记录.json --json
product-blueprint analysis trace --session /会话目录 --input 依据.json --json
product-blueprint analysis check --session /会话目录 --json
product-blueprint schema --analysis
product-blueprint apply /文档 --input 批次.json --analysis-session /会话目录 --dry-run --json
```

分析会话独立存放在被扫描项目的 `.blueprint-analysis/`。源码读取凭据、摘要及流程依据绑定当前内容指纹；源码或解析配置变化后旧会话不能继续写入。相同快照可以恢复尚未完成的项。普通手工命令仍可使用，不强制分析模式。

AI 必须逐项阅读并提交独立分析，工具核验范围覆盖和记录字段；业务步骤、规则和异常的依据绑定到最终文档字段。检查失败默认拒绝保存，显式 `--allow-partial-analysis` 可以保存草稿并输出缺口报告，但该批次不能登记任何功能完成。工具不能证明模型理解正确，也不是防止其他程序绕过的权限边界。具体输入、分段、类型上下文、排除项与错误码见 [ANALYSIS.md](ANALYSIS.md)。

三个 Skill 的源文件随工具包交付，可将对应文件夹安装到 `$CODEX_HOME/skills`（未设置时为 `~/.codex/skills`），安装前核对已有同名 Skill，保留需要的本机改动：

- [product-blueprint-init](skills/product-blueprint-init/SKILL.md)：从项目源码归纳业务蓝图；无源码时依据需求创建草稿。
- [product-blueprint-maintain](skills/product-blueprint-maintain/SKILL.md)：保留原文、编号和历史，核验差异及影响，确认后更新。
- [product-blueprint-implement](skills/product-blueprint-implement/SKILL.md)：按授权草稿实现，实际验收后登记当前版本完成。

安装后可用 `$product-blueprint-init`、`$product-blueprint-maintain`、`$product-blueprint-implement` 调用。首次扫描不等于已实现及验收，初始化默认交付草稿。固定 HTML 继续由 CLI 生成，Skill 不为不同项目重新设计页面。
