# 蓝图数据与修改规范

本文说明人与 AI 共享的产品上下文如何保存、读取和更新，包括蓝图数据结构、CLI 读写、版本与完成状态，以及并发保存和失败恢复。产品目标、以 Skill 为入口的使用流程见 [README.md](README.md)；源码扫描与分析依据见 [ANALYSIS.md](ANALYSIS.md)。

`product-document.json` 是权威业务文档。HTML 展示和编辑它，CLI 负责读取、校验与保存；AI 在外部理解需求、实现代码和验收。生成 HTML 可独立阅读，保存到项目需要本机服务或 CLI。分析会话独立保存，不嵌入业务文档；现有写入命令可通过 `--analysis-session` 启用分析检查。

## 蓝图作为产品上下文

蓝图围绕人能理解的业务能力组织内容。产品背景解释为什么做、给谁用；功能定义解释功能的目的和期望行为；规则、流程、异常和依赖帮助 AI 理解如何运转以及修改会影响什么；验收要求用于判断实现是否符合已确认的定义。

人通过 HTML 阅读功能和作用，也可以在页面或 AI 对话中用自然语言提出新增或修改需求。AI 先读取既有蓝图，再依据需求和实际代码梳理变化；维护 Skill 预览并保存确认后的蓝图，实现 Skill 按保存的定义开发、核验行为并同步蓝图。仅整理需求和文档时停留在维护流程。

首次初始化由初始化 Skill 直接保存产品 JSON 并生成 HTML，完成后让用户阅读产品书，再提出自然语言修改。用户请求初始化已授权生成这份新文档，不需要先确认产品内容；内部 dry-run 仍检查字段、版本和依据。已有目标蓝图进入维护流程，其他产品的示例文档保留；用户明确只要求预览时不提交。

页面保存定义后不会自动运行 Skill。业务变化使旧实现核对失效，新定义与旧图表、旧验收的版本关系保留。AI 对照当前定义判断已实现、具体未实现或待确认，运行验收另行记录；未测试不能代替未实现。静态扫描本身不代替业务审阅。

每次更新都应让下一次阅读的用户和 AI 能理解当前产品：保留用户原文和稳定身份，区分用户期望与代码已有行为，明确受影响功能和待确认事项，并同步变化后的业务规则与流程。以下命令、版本和保存约束用于支持这一过程。

## CLI 路径与输出

以下示例使用安装后的 `product-blueprint`。在工具源码目录中可替换为 `pnpm blueprint`。目录参数和 JSON 完整路径都可以使用，也可用 `--document` 指定；省略时读取当前目录的 `product-document.json`。单功能命令在功能编号后指定文档路径，`apply` 也接受文档路径。

Skill 首次生成默认使用目标项目的 `.blueprint/`，命令显式传递该绝对目录；已有文档继续使用原路径。产品书目录保存产品 JSON、独立 HTML 和最终交付审阅；工具证据保存在 `.blueprint-analysis/`，AI 的中间输入位于其 `work/本次任务编号/`。这些工作输入也可通过 `--input -` 提交，不需要在项目根目录创建批次文件。CLI 的省略路径行为不代替 Skill 的目录约定。

各命令支持 `--json` 结构化输出，失败返回非零退出码；具体参数通过 `--help` 查询。`schema` 输出文档规范，`schema --changes` 输出整批变更规范，`schema --analysis` 输出分析记录规范。`validate` 检查文档格式、稳定编号、引用与版本记录。

## 文档结构

文档格式由 `schema/product-document.schema.json` 描述，运行 `product-blueprint schema` 可以读取。顶层字段为：

- `schemaVersion: 1`：文档格式版本。
- `product`：产品名称、背景、角色及仓库信息。
- `features`：以稳定功能编号为键的功能对象。
- `dependencies`：工具与服务的职责、用途及故障影响。
- `diagrams`：可选的 `architecture` 和 `entities` 项目图表。

`examples/minimal-product.json` 展示通用最小输入。既有用户数据、备注和未知历史字段保留；普通更新只改指定字段。字符串按文字展示，包含 HTML 标签也不会执行。

功能键必须等于功能的 `id`，不能用名称代替持续身份。以“模块 → 子模块 → 独立业务能力 → 操作步骤”划分业务；接口、文件或保存前检查不应单独成为一个功能。一个功能应说明目标、使用者、规则、异常与验收要求。能独立发起、目标或产物不同、授权或停止边界不同的工作流应分别建模；生命周期旅程用于串联功能，不能代替独立功能。验收条件须对应真实业务断言，文件／资源／协议检查不能冒充外部 AI 的实际执行验收。

新定义可以没有分析结果：`rules: []`、`flow: []`、`stepDetails: []`、`dependencies: []`。CLI 创建初始版本 `revision: 1`、`editRevision: 1`、`flowRevision: 0`、`implementedRevision: null`。不为缺少证据的内容编造规则或依赖。

`groupPath` 使用名称数组，例如 `["调查表", "管理"]`；页面用 `/` 编辑，留空表示未分组，支持最多 5 层。分组依据业务含义，不照搬代码文件夹。目录展开与折叠只是阅读状态，不写入业务文档。

功能的可选 `annotations` 保存用户批注，每条记录包含稳定 `id`、原文 `text`、服务端 `createdAt` 和所针对的 `definitionRevision`；编辑后还记录服务端 `updatedAt`，保留编号及创建时间并绑定当前定义版本。批注是修改想法，独立于已确认定义和分析备注 `notes`；保存批注只增加 `editRevision`，不改变定义版本、流程同步或完成状态。现有原文、备注与验收历史保留，保存失败或冲突时保留输入。页面以当前定义及编辑版本提交批注，同编号同内容重试不重复追加；CLI 的 feature get 可以读到已保存批注，feature list 的 annotationCount 标出待处理数量。

批注输入区位于功能定义下方，页面支持新增、编辑和逐条确认删除已保存批注；编辑后点击“保存修改”更新原记录，新增点击“保存批注”，取消编辑不改写已保存内容。编辑和删除同样检查定义及编辑版本，只增加 `editRevision`，不改变定义、流程或完成状态。直接打开 HTML 是只读快照，不能写回 JSON；页面显示持续提示及本机服务启动方式。当前地址提供本机保存能力时才启用保存定义和批注。未提交批注暂存在当前浏览器地址，存储不可用时仅保留在当前页面；外部 AI 无法从产品 JSON 读取这些草稿。实现 Skill 自动查找授权范围内的草稿及已保存批注，包括有批注的已完成功能；需求明确时整理并实现，有歧义时先确认，实际验收成功后同步蓝图并删除对应批注。批注不自动启动 Skill。

## 图表数据

产品概览包含背景与功能、系统架构图、数据关系图；功能页包含业务流程图、时序图、数据流图。功能的 `sequence`、`dataflow` 和项目图表都可选；缺失显示空状态，不从其他项目借用内容。

字段可选用于兼容不适用或依据不足的场景。初始化应逐功能判断时序与数据流，逐项目判断架构与数据关系，有明确依据且帮助理解时默认生成。时序图说明参与者的交互顺序，数据流图说明输入、转换、存储与输出，数据关系图说明对象的包含、引用和版本关系；没有网络服务或数据库也可能适用。跳过时在功能备注或交付报告说明原因，不因可选而静默省略全部图表。`validate` 和 `analysis check` 检查结构与已有依据，不保证这项交付覆盖。

业务流程使用 `flow` 与等长的 `stepDetails`。步骤详情记录参与者、说明、规则、依赖、结果、异常、验收与系统交互。依赖通过稳定编号引用 `dependencies` 中的对象。

关系图包含 `title`、`nodes`、`edges`。节点使用稳定 `id`，边的 `from` / `to` 引用节点，`label` 表示关系含义。节点可附带说明、规则、字段和依赖。模板按宽度排布；旧坐标字段保留但不控制当前布局。

时序数据包含 `roles`、`base`、`normal`，可选 `error`、`success`、`failure`。消息数组为 `[发送者序号, 接收者序号, 文字, 所属步骤序号, 线条类型]`。窄屏使用交互列表，避免隐藏参与者或缩小文字。

AI 只维护语义数据，不改写模板、CSS、SVG 路径、页面事件或布局坐标。相同模板版本与相同文档生成一致的独立 HTML；业务 JSON 不包含界面程序，暂不提供任意页面组件或业务校验脚本插件。模板不自动附加演示页脚；内容来源和待确认事项记录在对应功能内。

## 读取和明确变更

`document get` 可以按分区读取；`feature list` 支持按分组路径和 `draft`／`complete`／`unknown` 筛选；`feature get --related` 附带关联依赖。例如：

```sh
product-blueprint document get ./my-product --section product --json
product-blueprint feature list ./my-product --status draft --json
product-blueprint feature get feature-id ./my-product --related --json
```

`document status` 返回 `{ documentHash, sourceStatus }`，只读比较各功能验收基线与当前源码并列出变更文件。`document get` 按 `all`、`product`、`dependencies`、`diagrams` 读取，结果为 `{ documentHash, section, data }`。`feature list` 返回 `{ documentHash, features }`，其中 `features` 是摘要数组，可按分组和草稿／完成／待确认筛选；`feature get` 返回 `{ documentHash, feature }`，启用 `--related` 时还返回 `relatedDependencies`。任何 CLI 写入都必须提交读取结果的整份文档哈希。

单功能命令使用 `--input 文件` 或 `--input -`：

| 命令                  | 输入与作用                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `feature create ID`   | `{ "title": "功能名称", "description": "用户定义", ... }`；不传编号和版本字段                                 |
| `feature update ID`   | 指定要更新的字段；不接受 `description` 或版本字段                                                             |
| `feature define ID`   | `{ "description": "明确修改后的用户定义" }`                                                                   |
| `feature delete ID`   | 无输入；明确删除，最终引用必须仍有效                                                                          |
| `feature sync ID`     | 无输入；声明当前业务流程已与保存后的定义同步                                                                  |
| `feature complete ID` | `{ "revision": 当前定义版本, "implementation": 验收记录, "resolvedAnnotationIds": 可选的已处理批注编号数组 }` |

命令示例（先读取文档取得 HASH，输入文件按上表及 Schema 准备）：

```sh
product-blueprint feature create feature-id ./my-product --input feature.json --expected-hash HASH --dry-run --json
product-blueprint feature update feature-id ./my-product --input changes.json --expected-hash HASH --json
product-blueprint feature define feature-id ./my-product --input definition.json --expected-hash HASH --json
product-blueprint feature sync feature-id ./my-product --expected-hash HASH --json
product-blueprint feature complete feature-id ./my-product --input verification.json --expected-hash HASH --json
product-blueprint feature delete feature-id ./my-product --expected-hash HASH --dry-run --json
product-blueprint apply ./my-product --input changes.json --dry-run --json
product-blueprint apply ./my-product --input changes.json --json
```

每次单功能写入提供 `--expected-hash HASH`；`apply` 使用输入批次中的 `expectedHash`。为避免普通分析悄悄改写需求，用户原文只能通过明确的 `feature.define` 操作修改。新功能及普通修改中的版本和完成字段由 CLI 管理，不能通过数据字段绕过。

相关修改使用 `apply --input 文件` 或 `apply --input -`，输入为：

```json
{
  "version": 1,
  "expectedHash": "从读取结果取得的文档哈希",
  "operations": [
    {
      "op": "product.update",
      "changes": { "background": "这次明确修改的产品背景" }
    },
    {
      "op": "feature.update",
      "id": "manage",
      "changes": { "rules": ["管理员才可以发布调查表。"] }
    },
    { "op": "feature.sync", "id": "manage" }
  ],
  "affectedFeatureIds": ["manage"]
}
```

允许的操作：

- 功能：`feature.create`（`id`、`data`）、`feature.update`（`id`、`changes`）、`feature.define`（`id`、`description`）、`feature.delete`、`feature.sync`、`feature.complete`（`id`、`revision`、`implementation`，可选 `resolvedAnnotationIds`）。
- 产品：`product.update`（`changes`）。
- 依赖：`dependency.create`（`data`）、`dependency.update`（`id`、`changes`）、`dependency.delete`（`id`）。
- 项目图表：`diagram.set`（`kind: "architecture" | "entities"`、`data`）、`diagram.delete`（`kind`）。

完整规范见 `schema/changes.schema.json`，通过 `schema --changes` 输出。省略的字段保留，数组字段按明确提交的数组替换，保留旧元素上的历史元数据；遗漏某个功能或依赖不表示删除。没有隐式扫描替换整份文档的操作。

`feature.update`、`product.update` 和 `dependency.update` 可以使用 `unset` 明确移除可选字段，例如 `{ "op": "feature.update", "id": "manage", "unset": ["sequence"] }`。功能可移除 `overview`、`notes`、`actors`、`checks`、`impact`、`sequence`、`dataflow`；产品可移除 `background`、`actors`、`repository`；依赖可移除规范中的可选职责与用途字段。必填字段与稳定编号不能移除，同一操作不能同时修改和移除同一字段。删除整张项目图表用 `diagram.delete`，删除整个功能或依赖用对应的明确删除操作。

跨功能业务变化必须在 `affectedFeatureIds` 明确列出受影响功能，以使相应完成状态失效。CLI 检查编号有效，不根据背景或依赖说明猜测业务影响。删除有引用的依赖时，必须在同批清理功能及图表引用；最终文档校验失败则整批不保存。

## 版本与草稿／完成

版本均为非负安全整数，由共享文档操作维护：

- `revision`：业务定义版本。定义、规则、步骤、验收及功能依赖等业务内容变化会递增。
- `editRevision`：保存版本。名称、分组、业务内容、流程同步或验收登记真正变化时递增；旧文档缺省为 0。
- `flowRevision`：最近一次明确同步业务流程所对应的定义版本。
- `implementedRevision`：最近一次通过外部验收的定义版本，未验收为 `null`。

同一批次每个功能最多递增一次定义版本及编辑版本。只改名称和分组不影响定义版本或完成状态。业务变化保留原流程与旧验收记录，但当前定义的实现情况转为待确认；普通更新不能直接设置版本或完成状态。流程同步绑定同批保存后的最终定义版本。

功能只有两个状态：

- **草稿**：当前定义存在明确未实现内容，implementationAssessment 逐项列出 missing。
- **完成**：当前实现核对的全部业务项已实现；旧文档保留同版本 implementedRevision 的完成历史。
- **待确认**：尚不能判断实际实现，或定义变化使旧实现核对失效；不能据此说功能没有实现。

真实验收登记 feature.complete 要求当前业务流程存在且 `flowRevision` 等于当前定义版本，并要求有效的外部验收记录。`sequence` 和 `dataflow` 可选。验收记录为：

```json
{
  "revision": 3,
  "verifiedAt": "2026-10-13T08:00:00Z",
  "checks": [{ "name": "管理员可以发布调查表，普通用户不能发布", "result": "passed" }],
  "commit": "对应提交（如有）"
}
```

完成登记可附带 `resolvedAnnotationIds: ["annotation-id"]`，仅删除本次已实现并验收通过的指定批注。编号必须存在且不重复；定义版本、验收、哈希或其他校验失败时，完成登记与批注删除都不保存。未处理的批注保留，不支持一律清空。批注删除只增加编辑版本，不改变业务定义版本；验收记录必须对应当前定义版本，批注可来自之前的定义版本，AI 需核对需求仍适用。

记录保存在 `implementation`。登记不同的新验收记录时，将旧记录追加到 `implementationHistory`，一般业务编辑不能覆盖这些历史记录。`checks` 必须是非空数组且全部通过，时间必须有效，记录版本和完成命令版本都须对应当前定义版本。旧手动记录仍保留；feature.complete 本身不执行项目测试，实现情况通过 feature assess 单独记录。“执行中”“失败”“需要补充”属于执行记录，不增加功能状态。

## 真实验收与交付检查

`verification run ID /文档 --analysis-session SESSION --input 命令.json --json` 显式执行验收。输入为 `{ "command": "node", "args": ["--test", "acceptance.test.mjs"], "timeoutMs": 60000 }`，在扫描根目录运行，不经过 shell；默认 60 秒，最大 10 分钟。stdout/stderr 合计超出 1 MiB 会停止并报告失败。检查命令由调用方选择，静态扫描不执行它们。

工具在分析会话的 `verifications/` 保存命令、退出码、起止时间、输出及指纹、文档路径、功能编号、定义版本和业务内容指纹、源码指纹。使用返回的 `executionId` 填写 `implementation.checks`：`{ "name": "正常与异常路径验收", "result": "passed", "executionId": "v-工具返回编号" }`，verifiedAt 不早于执行结束。完成批次同时带 `--require-verification --analysis-session SESSION`；缺记录、失败、超时、被修改日志、跨文档／功能／定义／源码复用都拒绝落盘。保留旧兼容入口不表示旧记录有这些证据；任何传入 executionId 的登记都检查其有效性。记录文件不构成针对有文件权限程序的防伪安全边界，退出码通过也不证明测试充分。

初始化最终运行 `document check /文档 --analysis-session SESSION --input delivery-review.json --json`，读取交付审阅协议 `schema --delivery`。review v4 绑定最新 documentHash 与运行前保存的分层方案，逐项记录功能 id、revision、outcome（implemented/requested/unimplemented/unverified）及图表判断；草稿填写具体 reason 与 evidence。图表存在填 `included`，未生成填 `skipped` 及具体原因。检查分析缺项、逐功能状态、完成源码依据和真实执行记录、源码基线以及同目录最新 index.html，成功返回 `valid:true, stage:ready`；失败退出 1，不修改文档。语义正确性仍由真实业务验收与评测判断，不能用高读取率替代。

业务文档先保存，再基于保存后的版本实现代码并实际验收；验收后重新读取并登记完成。不用旧定义的测试结果为新定义登记完成。初始化既有项目时，先保存从源码归纳的定义，再核验已有实现并登记完成，无需重复开发。新建功能或产生新定义版本的批次不能同时登记该功能完成；已有已保存版本可以在不修改业务内容的批次中同步并登记验收。

## 源码变化与验收基线

`document status` 是只读检查，按功能比较 `implementation.sourceSnapshot` 与当前扫描清单，输出 `current`（指纹一致）、`changed`（源码／解析规则变化）、`unverified`（旧记录无基线）或 `unavailable`（目录不可访问或读取缺口）。变更列表区分新增、修改与删除，检测文件内容，不依赖提交号或修改时间；未提交代码也可发现。Git 提交号是验收记录的辅助信息，新提交本身不代表新功能。

使用 `--analysis-session` 登记完成时，工具自动从当前分析会话保存源码指纹、根目录、扫描范围、解析版本及文件内容清单到 `implementation.sourceSnapshot`，保留旧验收与旧基线历史。不能通过验收输入手填基线，不能只替换指纹而省略实际核验；源码在写入前变化仍会拒绝保存。旧记录保持兼容，无基线时明确未核验，不自动补成“源码一致”。

源码变化提示与功能的草稿／完成状态分开：检查不修改 JSON、不重置版本、不认定业务变化。Skill 每次先检查源码，即使功能显示完成且没有批注。AI 阅读当前源码并追踪影响，区分重构、修复和业务变化；行为不变时保留定义版本，实际验收后刷新同版本基线；业务变化按授权同步定义、流程及受影响功能，再核验完成。已存在且符合需求的实现不重复开发；无法判断时说明问题，不能把回归行为直接覆盖为新需求。

本机页面打开或点击“重新核验源码”时比较当前代码并展示变更提示；页面不持续监视文件、不运行模型。独立 HTML 无法访问实时项目源码，只展示保存时记录和未实时核验提示。检查覆盖扫描清单中的源码、类型、配置及已识别的非支持语言文件，范围外、默认排除项和未纳入清单的资源不作一致性保证；无法核验的目录不展示“源码一致”。

## 保存、并发与失败恢复

`--dry-run` 显示字段、删除、版本和状态变化，不写文档及 HTML。首次初始化将它作为内部检查，通过后直接保存新定义并生成 HTML，核验已有功能后通过后续批次登记完成，完成后交付阅读。已有蓝图的维护按相应 Skill 预览确认后保存；用户明确只要求预览时不提交。CLI 不需要交互式确认。

CLI 与页面服务共享保存逻辑。使用文档真实路径的队列及文件锁，整批先在内存合并并校验，提交前比较原始内容，再原子替换文件。哈希过时、其他写入占锁或任一步校验失败时不保存。若已存在锁文件，不擅自删除其他进程的锁；应先确认对应进程已经结束。

页面编辑用 `expectedRevision` 和 `expectedEditRevision` 防止旧页面覆盖新内容；CLI 用整份文档哈希保护背景、依赖和跨功能变更。CLI 修改后，旧页面保存应报告冲突并保留用户输入，刷新后才能基于新版本继续。

默认保存后生成同目录 `index.html`，可用 `--output` 指定路径、`--no-render` 暂不更新快照。JSON 保存与 HTML 更新分别报告结果：JSON 已保存但 HTML 更新失败时，文档内容仍有效，运行 `render` 重试；不要重新提交旧哈希批次。生成失败保留已有 HTML。

JSON 错误结果的 `code` 区分 `INVALID_ARGUMENT`（参数或输入操作错误）、`VALIDATION_FAILED`（结构或业务约束失败）、`CONFLICT`（哈希或版本冲突）、`RENDER_FAILED`（生成失败）；找不到目标为 `NOT_FOUND`，文件访问失败为 `IO_ERROR`。退出码为：成功 0、一般失败 1、参数错误 2、冲突 3、文档已保存而 HTML 失败 4。部分失败结果中 `documentSaved: true`、`htmlUpdated: false`，并附带已保存的结果和文档哈希。

用户可在页面新增功能、改写定义、修改名称及分组；页面不生成分析结果、不调用 AI 或执行代码。现有用户文档与备注是用户内容，开发、格式化、测试和打包都不得覆盖。所有测试使用临时文档，工具包只包含程序和通用资源。

交付审阅 v4 仍记录核心 `journeys`（业务结果、材料依据及有序 featureId／step 映射）、逐功能 `content.rules`／`content.dependencies` 的 included 或带理由的 skipped，以及 `acceptance`。完成功能的 checks 是业务条件；acceptance 用从 0 开始的 criterion、steps，normal／exception 情景、本功能真实 executionId 和具体用例／断言依据建立覆盖。所有条件及正常步骤要有覆盖，已定义异常步骤另有异常检查；仅在时序 error 分支出现的步骤只要求异常覆盖；同一执行可支持多项条件。功能依赖须关联实际使用步骤，规则不能全部埋在描述中。时序图 failure 名称须有 error 分支；跳过理由的 alternative 图表引用须真实存在。旧 v1 审阅需重新核对才能通过严格交付，现有产品 JSON 的读取与保存格式保持兼容。检查器核验结构和执行关联，业务旅程是否完整、规则是否正确、断言是否充分仍需人工或 AI 审阅及实际验收。

业务流程机器核验、分析协议 v2、多语言能力边界、临时副本探针与部分交付详见 [FLOW.md](FLOW.md)。旧执行记录仍可阅读，缺少流程证据时不得称为新协议严格通过；功能完成历史不被自动改写。

## 执行前保存验收范围

`schema --verification-plan` 输出当前方案规范。`verification plan BOOK --analysis-session SESSION --input PLAN` 保存单个功能的方案；省略 input 只读查询。方案的 goal 描述用户目标与结果，steps 覆盖全部真实业务步骤，引用已完整读取的 unitIds 或 contextIds，并选择 source、component、contract 或 end-to-end。scenarios 记录具体业务断言、正常／异常类型、步骤和验收条件编号。运行范围不能在测试后补贴或暗中缩小。

`verification run` 输入的 scope 包含 planId、scenarioId；契约场景还需分别用 side:consumer、side:provider 执行两端测试，均绑定同一份已完整读取的 contractContextId。端到端场景同时携带 flow，必须绑定当前真实流程、同名场景及其声明步骤；普通命令不能替代探针观测。组件／契约执行沿用真实命令和日志指纹，工具核验执行绑定，断言的业务含义和充分性仍由 AI 审阅，不能把空命令或成功文字当作业务通过。

方案和执行绑定文档路径、功能定义、源码、方案内容及核验规则。范围、源码或定义变化使旧证据失效。功能实现通过 feature assess 单独核对；feature.complete 的运行验收登记仍要求真实执行。实现核对不生成运行证据，flow sync 只保存层级、步骤覆盖与实际缺口，不改写功能实现历史。其 valid 仍表示严格流程结论，分层交付结论由 document check v4 给出。

无法运行的具体步骤用 source 加 limitation 保留未核验范围：adapter／environment／external，附与步骤源码相关的真实 analysis-gap，或 verification diagnose 产生的当前功能失败诊断记录。外部边界须同时引用完整读取的上下文和该诊断 executionId，材料内包含具体目标；上下文或任意失败脚本本身不能豁免。诊断输入见 schema --verification 的 $defs.environmentDiagnostic，支持 command／file／tcp。诊断与业务验收分开，失败业务测试不能冒充环境限制。工具核对材料和绑定，AI 仍需实际排查障碍；说明一句“没做完”不能豁免。真实运行限制在验收详情保留；草稿通过实现核对列出实际未实现项，不能用未测试代替未实现。

v4 的 valid:true、stage:ready 表示声明的逐业务步骤方案成立，不宣称整个系统或所有分支被观测。未选择的严格流程列于 diagnostics；所选流程仍严格检查。候选入口必须通过当前业务步骤归类，或对已读取的非业务库导出／声明提供具名源码说明；未归类入口会阻止 ready 和 partial，不能仅写理由跳过 CLI、事件或 Skill 入口。只有真实限制有依据、其余工作已完成且缺口可见时允许 deliverable:true、stage:partial，valid 仍为 false。漏读、漏记录、错映射、遗漏方案与未执行场景即使写入 acknowledgedGaps，也只能 incomplete。v3 仍按旧严格流程模式检查，不自动升级证据或改写用户历史。

## 按定义核对实际实现

`feature assess ID BOOK --analysis-session SESSION --input 核对.json` 将实现情况与运行验收分开。输入规范由 `schema --assessment` 提供，包含 expectedHash、当前 revision 与 items；支持 dry-run 与 no-render。每项 target 覆盖 description、rules、checks 和 flow 的每个位置，state 为 implemented／missing／unknown，detail 解释具体行为或缺失，unitIds／contextIds 引用当前已完整读取和分析的产品依据。CLI 检查位置、版本与依据绑定，业务解释的正确性仍需 AI 对照实际源码审阅。

全部实现为 complete；有明确缺失为 draft，并返回 missing 列表；没有明确缺失但有未知为 unknown。旧文档没有当前实现核对或完成历史时显示待确认，不编造缺失项。普通字段编辑不能写入实现核对。实现核对绑定定义内容、源码基线并保留历史，不生成 executionId、不删除批注、不改写既有验收。定义变化转待确认；改名、分组和批注不影响实现结论。

实现完成可以同时存在未运行验收。严格交付仍检查已声明场景；没有运行且没有真实限制不能严格通过，有明确限制的部分交付保留运行未核验。业务测试证实功能缺失时，对照源码更新为具体 missing；未执行其他分支不直接等同缺失。feature.complete 仍用于真实验收及选择性批注清理，有当前 missing／unknown 核对项时必须先更新核对。

实现核对 items 的 basis 将结论绑定到实际位置：代码为 `{kind:"code",unitId,pointIds,detail}`，上下文为 `{kind:"context",contextId,quote,detail}`。pointIds 引用本单元真实 reviewPoints 并解释行为，quote 必须匹配已完整读取的原文。unitIds／contextIds 可省略并从 basis 派生，提供时须包含全部来源。常量路径、重导出、参数声明或只重复定义不能单独支撑实现；旧核对保留可读，重新交付须补做当前位置依据。

组件／契约场景的 observations 使用 unitId、event、operator、expected 及适用的 factId／pointId；事件为 return／throw／value／branch。返回或结果用 equals 核对标量、type 核对类型；异常用 error／error-name，分支使用本函数的条件位置。每个声明步骤都须有相应结果观测。类型观测仅证明类型，不能说明对象字段、持久化或业务条件均正确。工具复用临时副本探针执行，不要求组件场景同时证明完整调用链。

限定范围分析的 scopeCoverage 差异进入交付与页面范围缺口。默认补齐；确有用户局部范围授权时，review.scope 记录 reason 和 authorization:{source:user,text:原文}，并逐项列入 acknowledgedGaps，仍不能获得全项目 ready。范围声明的真实性由执行者遵守对话授权，工具核验机器遗漏清单。
