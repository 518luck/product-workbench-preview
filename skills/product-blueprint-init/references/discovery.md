# 独立全局业务发现

仅当 `workflow plan PROJECT --skill init` 返回 `executionMode:discovery-only`，或用户明确选择且配置允许 discover 时使用。本任务生成候选业务目录，结束后不自动进入函数深读、产品书生成或运行验收。

## 固定任务与输入

1. 使用目标项目绝对路径 PROJECT。读取 `workflow get PROJECT --json` 和 `workflow plan PROJECT --skill init --json`。valid:false 时说明关闭项或未提供的独立阶段，不自动改成完整初始化。用户明确要求调整开关时，用当前 configHash 执行 `workflow set`，再读取计划。配置损坏不回退默认流程。
2. 确认 `analysis capabilities` 的 workflow.discovery:1。CLI 不调用模型；所有命令由当前 AI 执行。工作文件只放 `PROJECT/.blueprint-analysis/work/本次任务编号/`。本阶段不创建 BOOK、不改已有产品 JSON、HTML、定义或批注，不启动编辑服务。
3. 读取介绍、包入口、目录、公开工作流和必要配置。将实际参考的文本放入扫描 contexts，用 `analysis scan PROJECT` 建立全局机器清单。解析和语言限制如实保留，不把扫描成功解释为全部语义可核验。

## 先形成可检查的目录

分页读取 `business inventory --session SESSION`，汇总全部 operations 和 modules；清单按注册/分发身份保留候选，并不等于功能目录。按使用者、可独立发起的目标和结果归纳候选功能，不以 Skill 数、目录、函数数或命令数定功能数。

从页面、API、命令、库入口、任务和文档工作流分别反查。一个功能可以跨文件并共享 helper；不同的目标与结果分别保留。未知框架的候选继续查其声明、配置和调用位置，不因 certainty:candidate 就标成误识别。无法判断的原样留缺口，不虚构功能凑覆盖。

对每个候选，读取实际注册/分发片段及结果位置，必要时沿调用继续看源码。可用 `analysis read file:相对路径 --session SESSION --offset 起点 --length 长度` 读取片段，或用 `analysis pack` 读小文件。工具核对本阶段所引用的注册前 256 个 UTF-16 字符和结果/上下文原文是否有真实读取凭据；这只是最低范围，理解所需的其他源码仍要读取。片段读取不等于完整函数分析，不生成几千条逐位置 record。

读取 `schema --discovery` 和 `schema --business`。用当前格式组装：

- `version:1`。
- `model`：业务地图输入，包含 capabilities、dispositions 和可选 limitations。能力填写 actor、goal、outcome、operationIds 和真实 results；本阶段不需要 featureIds。不提交最终 business review 或伪造实现/验收记录。
- `modules`：逐个产品源码目录填写 directory、status、capabilityIds、reason。mapped 必须关联该目录真实入口或结果所属能力；internal 说明具体辅助职责；未确定用 pending。不能删目录、批量套话或把所有业务当作某工作流的内部支撑。

公开操作需要进入真实候选能力，或通过 support 关联实际结果。false-positive 只保存待确认判断，不能使覆盖通过。库导出的 internal 归类在这里属于候选目录判断，仍不代表完成了该函数的独立语义分析。

## 保存、恢复与结束

执行 `discovery record --session SESSION --input 输入.json|- --json`，再执行 `discovery check --session SESSION --json`。结果单独保存于当前会话，不覆盖最终业务地图。保存成功不等于检查通过；缺项会保存进度并返回非零。

恢复用当前命令核对配置、源码、规则和来源片段。旧摘要仅用于找线索，不能继承旧业务目录或通过结论。目录发现不要求整仓函数记录；不要为消除尚未展开的函数数量而进入完整初始化。覆盖缺口继续查对应入口/目录，确实无法确认时如实报告本阶段未完成，并保留已得到的候选和具体缺口。

`valid:true`、`stage:ready`、`completion.claim:discovery-ready` 仅表示本阶段候选目录结构、来源和对账通过，语义仍需审阅。initializationComplete、bookGenerated 和 runtimeVerified 仍为 false。

交付简短列出候选功能的使用者、目标和结果，给出模块/入口待确认项；明确“本次仅完成全局业务发现，未生成或重写产品书”。不使用完整初始化的成功模板、不声称已有实现完成或运行通过。后续单功能展开和合并须按配置及当前实际能力选择；本版本的独立 analyze/compose 尚未提供，不改跑全套。
