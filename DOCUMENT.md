# 产品蓝图文档与变更约定

`product-document.json` 是权威业务文档。HTML 展示和编辑它，CLI 负责读取、校验与保存；AI 在外部理解需求、实现代码和验收。生成 HTML 可独立阅读，但保存到项目需要本机服务或 CLI。

CLI 0.2.1 的分析会话是独立辅助记录，不嵌入业务文档。现有 feature 写命令和 apply 可用 --analysis-session 检查源码读取与字段依据；不指定时保留手工维护行为。完整协议见 [ANALYSIS.md](ANALYSIS.md)，通过 schema --analysis 获取记录规范。分析模式不迁移已有数据，也不改变草稿／完成两种状态。

## 文档结构

文档格式由 `schema/product-document.schema.json` 描述，运行 `product-blueprint schema` 可以读取。顶层字段为：

- `schemaVersion: 1`：文档格式版本。
- `product`：产品名称、背景、角色及仓库信息。
- `features`：以稳定功能编号为键的功能对象。
- `dependencies`：工具与服务的职责、用途及故障影响。
- `diagrams`：可选的 `architecture` 和 `entities` 项目图表。

`examples/minimal-product.json` 展示通用最小输入。既有用户数据、备注和未知历史字段保留；普通更新只改指定字段。字符串按文字展示，包含 HTML 标签也不会执行。

功能键必须等于功能的 `id`，不能用名称代替持续身份。以“模块 → 子模块 → 独立业务能力 → 操作步骤”划分业务；接口、文件或保存前检查不应单独成为一个功能。一个功能应说明目标、使用者、规则、异常与验收要求。

新定义可以没有分析结果：`rules: []`、`flow: []`、`stepDetails: []`、`dependencies: []`。CLI 创建初始版本 `revision: 1`、`editRevision: 1`、`flowRevision: 0`、`implementedRevision: null`。不为缺少证据的内容编造规则或依赖。

`groupPath` 使用名称数组，例如 `["调查表", "管理"]`；页面用 `/` 编辑，留空表示未分组，支持最多 5 层。分组依据业务含义，不照搬代码文件夹。目录展开与折叠只是阅读状态，不写入业务文档。

## 图表数据

产品概览包含背景与功能、系统架构图、数据关系图；功能页包含业务流程图、时序图、数据流图。功能的 `sequence`、`dataflow` 和项目图表都可选；缺失显示空状态，不从其他项目借用内容。

业务流程使用 `flow` 与等长的 `stepDetails`。步骤详情记录参与者、说明、规则、依赖、结果、异常、验收与系统交互。依赖通过稳定编号引用 `dependencies` 中的对象。

关系图包含 `title`、`nodes`、`edges`。节点使用稳定 `id`，边的 `from` / `to` 引用节点，`label` 表示关系含义。节点可附带说明、规则、字段和依赖。模板按宽度排布；旧坐标字段保留但不控制当前布局。

时序数据包含 `roles`、`base`、`normal`，可选 `error`、`success`、`failure`。消息数组为 `[发送者序号, 接收者序号, 文字, 所属步骤序号, 线条类型]`。窄屏使用交互列表，避免隐藏参与者或缩小文字。

AI 只维护语义数据，不改写模板、CSS、SVG 路径、页面事件或布局坐标。模板不自动附加演示页脚；内容来源和待确认事项记录在对应功能内。

## 读取和明确变更

`document get` 按 `all`、`product`、`dependencies`、`diagrams` 读取，结果为 `{ documentHash, section, data }`。`feature list` 返回 `{ documentHash, features }`，其中 `features` 是摘要数组，可按分组和草稿／完成筛选；`feature get` 返回 `{ documentHash, feature }`，启用 `--related` 时还返回 `relatedDependencies`。任何 CLI 写入都必须提交读取结果的整份文档哈希。

单功能命令使用 `--input 文件` 或 `--input -`：

| 命令                  | 输入与作用                                                                    |
| --------------------- | ----------------------------------------------------------------------------- |
| `feature create ID`   | `{ "title": "功能名称", "description": "用户定义", ... }`；不传编号和版本字段 |
| `feature update ID`   | 指定要更新的字段；不接受 `description` 或版本字段                             |
| `feature define ID`   | `{ "description": "明确修改后的用户定义" }`                                   |
| `feature delete ID`   | 无输入；明确删除，最终引用必须仍有效                                          |
| `feature sync ID`     | 无输入；声明当前业务流程已与保存后的定义同步                                  |
| `feature complete ID` | `{ "revision": 当前定义版本, "implementation": 验收记录 }`                    |

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

- 功能：`feature.create`（`id`、`data`）、`feature.update`（`id`、`changes`）、`feature.define`（`id`、`description`）、`feature.delete`、`feature.sync`、`feature.complete`（`id`、`revision`、`implementation`）。
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

同一批次每个功能最多递增一次定义版本及编辑版本。只改名称和分组不影响定义版本或完成状态。业务变化保留原流程与旧验收记录，但当前功能回到草稿；普通更新不能直接设置版本或完成状态。流程同步绑定同批保存后的最终定义版本。

功能只有两个状态：

- **草稿**：当前定义还未实现并验证，或业务内容发生新修改。
- **完成**：登记的 `implementedRevision` 与当前 `revision` 一致。

完成登记要求当前业务流程存在且 `flowRevision` 等于当前定义版本，并要求有效的外部验收记录。`sequence` 和 `dataflow` 可选。验收记录为：

```json
{
  "revision": 3,
  "verifiedAt": "2026-10-13T08:00:00Z",
  "checks": [{ "name": "管理员可以发布调查表，普通用户不能发布", "result": "passed" }],
  "commit": "对应提交（如有）"
}
```

记录保存在 `implementation`。登记不同的新验收记录时，将旧记录追加到 `implementationHistory`，一般业务编辑不能覆盖这些历史记录。`checks` 必须是非空数组且全部通过，时间必须有效，记录版本和完成命令版本都须对应当前定义版本。CLI 检查结构与版本，不执行项目测试，也不能证明验收真实发生。“执行中”“失败”“需要补充”属于外部执行记录，不增加功能状态。

业务文档先保存，再基于保存后的版本实现代码并实际验收；验收后重新读取并登记完成。不用旧定义的测试结果为新定义登记完成。新建功能或产生新定义版本的批次不能同时登记该功能完成；已有已保存版本可以在不修改业务内容的批次中同步并登记验收。

## 保存、并发与失败恢复

`--dry-run` 显示字段、删除、版本和状态变化，不写文档及 HTML。外部 AI 将预览交给用户确认，再提交正式批次；CLI 不需要交互式确认。

CLI 与页面服务共享保存逻辑。使用文档真实路径的队列及文件锁，整批先在内存合并并校验，提交前比较原始内容，再原子替换文件。哈希过时、其他写入占锁或任一步校验失败时不保存。若已存在锁文件，不擅自删除其他进程的锁；应先确认对应进程已经结束。

页面编辑用 `expectedRevision` 和 `expectedEditRevision` 防止旧页面覆盖新内容；CLI 用整份文档哈希保护背景、依赖和跨功能变更。CLI 修改后，旧页面保存应报告冲突并保留用户输入，刷新后才能基于新版本继续。

默认保存后生成同目录 `index.html`，可用 `--output` 指定路径、`--no-render` 暂不更新快照。JSON 保存与 HTML 更新分别报告结果：JSON 已保存但 HTML 更新失败时，文档内容仍有效，运行 `render` 重试；不要重新提交旧哈希批次。生成失败保留已有 HTML。

JSON 错误结果的 `code` 区分 `INVALID_ARGUMENT`（参数或输入操作错误）、`VALIDATION_FAILED`（结构或业务约束失败）、`CONFLICT`（哈希或版本冲突）、`RENDER_FAILED`（生成失败）；找不到目标为 `NOT_FOUND`，文件访问失败为 `IO_ERROR`。退出码为：成功 0、一般失败 1、参数错误 2、冲突 3、文档已保存而 HTML 失败 4。部分失败结果中 `documentSaved: true`、`htmlUpdated: false`，并附带已保存的结果和文档哈希。

用户可在页面新增功能、改写定义、修改名称及分组；页面不生成分析结果、不调用 AI 或执行代码。现有用户文档与备注是用户内容，开发、格式化、测试和打包都不得覆盖。所有测试使用临时文档，工具包只包含程序和通用资源。
