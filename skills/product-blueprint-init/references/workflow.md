# 初始化流程

## 选择工具与目标

使用 `product-blueprint` CLI。通过 `--help` 和 `schema` 查询当前协议，确认支持源码状态、`implementation.sourceSnapshot`、reviewPoints／coverage、严格验收和 delivery v3；版本号相同不代表协议相同。具体字段以 `schema --analysis`、`schema --changes`、`schema --verification`、`schema --delivery` 为准，不在 Skill 内复制另一套 Schema。

全局命令缺失或协议过旧时，可使用已知工具源码的绝对入口 `node /工具目录/bin/product-blueprint.mjs`；在工具仓库内也可用 `pnpm blueprint`。无法找到可用工具时说明需更新工具，保留现有文件，不自行改模板或手填基线。

读取项目介绍、清单与配置，确定产品名称、目标用户、项目根目录和输出位置：

- 同一任务的恢复或自动续跑：先按 [验收参考](verification.md) 的结束与恢复规则核对已有进度和交付；完成后不重建。
- 其他已有目标蓝图：先 `document status /文档 --json`，转维护工作流，保留定义、编号、分组与历史。
- 只有其他产品的示例：保留示例，新产品书使用独立且未占用的目录。
- 新项目只有需求：根据需求建立草稿，不编造源码引用或完成记录。

只有目标无法确定或需要覆盖现有内容时澄清，不要求用户先解释尚不了解的产品功能。

先按 [业务流程核验](flow-verification.md) 查询语言能力、声明文本上下文、恢复当前分析与建立实际连接；以该参考的 v2／v3 协议为准。

## 扫描与完整读取

默认处理项目内全部自有源码；用户明确限定范围时按该范围处理，不擅自缩小到入口文件。JS、JSX、TS、TSX 及相关配置的实际支持范围以扫描清单为准；不支持的语言、解析失败和读取失败记录为缺口。

```sh
product-blueprint analysis scan /项目 --config 范围.json --json
```

范围配置示例：`{"include":["."],"exclude":["明确排除的路径/**"]}`。保存返回的会话路径与快照指纹，核对 manifest 中默认及用户排除项。

1. 分页读取 `analysis list --session SESSION --kind contexts --json`，通过 `analysis read` 读取清单、配置等上下文并取得凭据。
2. 每轮从 offset 0 请求 `analysis list --session SESSION --status pending --limit 50 --json`；处理后 pending 集合缩小，不递增 offset 跳过剩余单元。
3. 用 `analysis read ID --session SESSION --json` 实际阅读每个单元，跟随 `nextOffset` 直到 null。源码输出及凭据需进入当前分析上下文。
4. 按当前 Schema 提交每个单元的职责、输入输出、条件、调用、副作用、异常和未知，并用 coverage 逐项说明其 reviewPoints。完整覆盖嵌套单元的凭据可复用，但嵌套函数有自己的位置与独立分析，不能沿用父函数摘要。

按索引中实际解析的调用追踪行为。动态调用、外部服务、未解析调用和框架宿主行为保留未知，不猜测内部路径。配置用于说明运行条件，测试用于验收；二者不能冒充产品实现。

同一快照可保存进度并恢复，但先运行当前版本 `analysis check`，检查 reviewedCount、位置审阅与 gaps，不能因 recordedCount 等于 unitCount 就跳过阅读。旧浅摘要需回到源码补做，索引升级或源码／解析配置变化后重新扫描，旧凭据不能用于新快照。仍有 pending、未读完分段或未提交记录时继续处理，不能把耗时或上下文不足说成不可消除缺口。

## 逐函数审阅质量

reviewPoints 是最低位置清单，不是语义分析答案。先读完整函数，再逐项解释具体条件、输入与返回、调用影响、写入、抛错、捕获与最终清理；同时核对清单之外的闭包输入、异步边界、重试／并发、部分成功和异常传播。数组为空必须确实没有相应行为，不能因难以判断就填写空数组。

每条位置说明都对应本函数的实际行为，不能只抄源码、把同一段职责重复到所有位置、用脚本批量生成套话，或把 unresolvedCalls 清空来隐藏未知。脚本可以整理已经完成的记录，不代替阅读和分析。工具只能拦住缺项，无法保证解释正确。

把产品规则、步骤、异常反查到真正实现该行为的函数及其分支；常量、重导出、哈希或通用辅助函数不能单独支撑不相关业务结论。沿实际调用关系核对入口到结果和失败路径，必要时重读相关函数。与产品有关的 Skill／工作流、HTML/CSS、配置另行读取，不以 JS/TS 函数计数声称整个仓库已理解。

## 归纳产品内容

建模前读 [内容审阅](content-review.md)，整理图表时读 [图表说明](diagrams.md)。从用户入口到业务结果组织功能、规则、依赖、正常与异常路径；读取项目提供的 Skill 或文档工作流，避免只整理内部工具函数。

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

先修复可解决的读取与依据缺项。只有已核实且无法消除的文件读取、语言支持或环境问题，或用户明确接受部分范围时，才可在预检和保存同时使用 `--allow-partial-analysis` 交付标明具体缺口的草稿；这不允许绕过源码过期检查或登记完成。

定义初次保存为草稿只是中间状态。随后按 [验收与交付检查](verification.md) 判断已有功能，完成核验、登记和最终交付。
