# 完整初始化兼容流程

只在 workflow plan 返回 legacy-full 时读取本页；discovery-only 使用 discovery.md 后结束。独立发现的成功不是产品书初始化成功。

先运行 `analysis capabilities --json`，确认 business.coverage:3、business.delivery:5、reading.filePacks、reading.groupedClaims 和 SQLite 行存储；delivery.modes 应包含 source 与 verified。读取当前 schema --analysis、schema --business、schema --delivery。不需要为源码初始化执行运行探针或准备整套联调环境。

## 选择工具与目标

使用 `product-blueprint` CLI。通过 `--help` 和 `schema` 查询当前协议，确认支持源码状态、`implementation.sourceSnapshot`、reviewPoints／coverage、严格验收、delivery v5 和 verification plan；版本号相同不代表协议相同。具体字段以 `schema --analysis`、`schema --changes`、`schema --verification`、`schema --delivery` 为准，不在 Skill 内复制另一套 Schema。

全局命令缺失或协议过旧时，可使用已知工具源码的绝对入口 `node /工具目录/bin/product-blueprint.mjs`；在工具仓库内也可用 `pnpm blueprint`。无法找到可用工具时说明需更新工具，保留现有文件，不自行改模板或手填基线。

先按 [产物目录](artifacts.md) 固定 PROJECT、BOOK、ANALYSIS、WORK；首次新建默认 BOOK=`PROJECT/.blueprint/`，CLI 每次显式传入 BOOK。扫描配置和下文命令的输入 JSON 放在 WORK，或使用 `--input -`，不在项目根目录创建中间文件。

读取项目介绍、清单与配置，确定产品名称、目标用户、项目根目录和输出位置：

- 同一任务的恢复或自动续跑：先按 [验收参考](verification.md) 的结束与恢复规则核对已有进度和交付；完成后不重建。
- 其他已有目标蓝图：先 `document status /文档 --json`，转核验工作流，保留定义、编号、分组与历史。
- 只有其他产品的示例：保留示例，新产品书使用约定的 `.blueprint/`；该位置有真实冲突时再确定目标。
- 新项目只有需求：根据需求建立定义，并明确记录尚未实现的具体内容；没有产品实现时不编造源码引用或完成结论。

只有目标无法确定或需要覆盖现有内容时澄清，不要求用户先解释尚不了解的产品功能。

查询 analysis capabilities 和 schema --analysis；显式纳入 Skill、工作流、配置及 HTML/CSS 上下文，按 v2 建立读取和函数分析。运行探针留给后续核验。

## 先发现业务，再完整阅读

先按 [业务发现与核对](business-discovery.md) 读取操作与模块概览、建立业务候选，保存 `business record`。核对使用者、目标和结果，不以函数数量或目录划分功能。随后沿业务路径读取、再按模块完整覆盖剩余函数与上下文，反查遗漏。

使用 `analysis pack 文件相对路径 --session SESSION` 按文件读取，长文件跟随 nextOffset。工具返回一次正文、真实凭据和独立单元范围；完整覆盖的父/文件凭据可供嵌套单元复用，但嵌套函数仍独立记录。提交 `analysis record` 时优先用 claims 将因果相关的位置关联同一语义断言，所有位置恰好覆盖一次。具体格式读 `schema --analysis`，不重抄机器生成的语法事实。

同会话由一个协调者批量提交；有限并行分析只读包，不多层并发抢锁。脚本只整理已完成的分析，不能丢弃正文后生成职责/解释，不能直接调用内部 updater 或自行构造 receipts。

恢复先检查当前快照与分析；recordedCount、fullyReadCount、reviewedCount含义不同，均不证明业务理解正确。源码、解析配置及相关上下文变化使旧依据失效。动态调用和宿主行为保留未知，不能用同名函数连接。

业务地图形成不等于初始化完成；继续完成约定范围阅读、记录和源码实现核对；运行验证交给独立核验流程。未读完、遗漏和错误映射属于待完成工作，不以时间盒或上下文不足豁免。

## 归纳产品内容与业务地图绑定

建模前读 [内容审阅](content-review.md)，整理图表时读 [图表说明](diagrams.md)。从用户入口到业务结果组织功能、规则、依赖、正常与异常路径；按 business-discovery 将业务能力映射到最终 featureIds，绑定当前定义并审阅原始依据；读取项目提供的 Skill 或文档工作流，避免只整理内部工具函数。

证据分为代码已有行为 `observed`、明确需求 `requested`、推断 `inferred` 与未知 `unknown`。推断和未知只放在明确标注的备注里；存在源码但未确认的行为不能写成已有实现。图表适用性逐项判断，不能因为字段可选而全部省略。

## 保存定义与流程

仅在目标不存在时，用 `init /文档目录 --name 实际产品名 --json` 创建空容器。CLI 的 init 不会分析项目或生成业务内容。

读取 `document get /文档 --json` 获取哈希，再构建 `product.update`、`dependency.create`、`feature.create` 等明确 operations。用当前 Schema 的 `flow`、`stepDetails` 等字段，保留稳定编号；业务 JSON 不包含 CSS、SVG 布局或事件代码。

用 `analysis trace --session SESSION --input traces.json --json` 关联最终字段：`target` 为叶子 JSON Pointer，`value` 为最终值；代码引用 record 返回的 `unitId`／`recordHash`，需求引用 `source:user|document` 及原文。

```sh
product-blueprint analysis check --session SESSION --json
product-blueprint apply /文档 --input 批次.json --analysis-session SESSION --dry-run --json
product-blueprint apply /文档 --input 批次.json --analysis-session SESSION --json
```

dry-run 是内部检查。通过后提交同一批次，无须等待内容确认；用户明确只要预览时不提交。哈希冲突后重新读取和评估，不能盲目替换哈希覆盖；出现已有用户内容时按维护边界处理。

先修复可解决的读取与依据缺项。只有已核实且无法消除的文件读取、语言支持或环境问题，或用户明确接受部分范围时，才可在预检和保存同时使用 `--allow-partial-analysis` 交付标明具体缺口的产品书；这不允许绕过源码过期检查或登记完成。

定义初次保存时实现状态待确认。随后按 [验收与交付检查](verification.md) 判断已有功能，完成源码核对和 source 模式交付。

恢复时分别核对源码读取与分析、最终字段依据、真实验收、功能完成登记、流程核验及交付审阅。记录数量齐全或执行成功不表示后续阶段已完成；缺少 trace、实现核对或 delivery-review 时继续补齐；实际验收单独记录。初始化不默认执行运行验收或流程追踪，不因未运行把已实现功能改为草稿。

## 阅读与记录的质量边界

按 [业务发现与核对](business-discovery.md) 区分机器事实、源码已读、逐函数语义、业务地图与运行结果。每个函数仍完整读取并独立记录；语义断言可覆盖相关位置，不能套用一条职责解释全部无关行为。结构检查是底线，最终对照原始证据核对含义。

当前协议还须支持 business.coverage:3 与 delivery.modes:[source,verified]。business check 的 valid 包含排除审阅，不能只查看 coverageValid；完整交付以 document check 的 completion 为准。
