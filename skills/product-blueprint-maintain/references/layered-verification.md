# 分层验收与范围

完整读取源码与穷尽运行路径是两件事。保持已确认范围内的逐函数读取、逐位置分析和业务字段依据；运行验收按业务重要性、项目环境与可用能力选择方式，不要求初始化时穷尽每个内部函数的所有分支。

## 执行前保存方案

先读取 `schema --verification-plan`、`verification plan --help`、`schema --verification` 与 `schema --delivery`。当前分层交付为 delivery v4；v3 仍执行旧的严格流程检查，不能仅改版本号消除缺口。

定义和流程保存后，使用 `verification plan BOOK --analysis-session SESSION --input PLAN --json`，为每个功能保存独立方案。命令省略 input 可查询方案及当前执行缺口。

- goal 写具体用户目标及结果。steps 必须覆盖该功能全部业务步骤，每步引用已完整读取和分析的 unitIds 或 contextIds。
- 每步 level 选择 source、component、contract 或 end-to-end。运行步骤通过 scenarioIds 引用实际场景；场景绑定 steps、criteria、正常／异常类型和具体 assertion。先确定正常结果、权限／规则、异常与持久化等关键行为，再选择测试，不能为了通过而只验证哈希、路径等无关辅助函数。
- source 是源码核对，不是运行通过。未来需求或尚未实现的草稿可仅做源码／需求核对；已有实现无法运行时，为具体步骤提供 limitation，说明影响及可核对证据，并把运行限制写进产品书 notes，不能只写在内部审阅 JSON。
- 优先复用对应业务的现有测试和本机组件测试。组件验证真实模块与其可控依赖；跨服务验证可使用同一份契约，分别执行调用方和服务方测试。测试替身只支持明确声明的边界，不证明线上服务或完整部署已联通。
- end-to-end 场景必须先有 flow record，绑定同名、同类型场景及真实业务步骤；用临时副本探针执行和 flow check 判定。只在确实需要并能运行的关键链路采用，不将所有组件测试强制升级为全系统联调。

component／contract 场景同时填写 observations，每项包含 unitId、event、operator、expected，适用时再给 factId／pointId。使用当前步骤的实际产品函数：return／value 的 equals 核对具体标量，type 仅核对类型；throw 用 error 或 error-name 核对实际错误；branch 关联具体条件 pointId。每个声明步骤都有对应结果。不能只检查函数进入、输入值或产品书里的完成标签，不能给所有步骤套一个无关辅助函数。运行时工具自动在临时副本注入探针、收集事件并比较期望，缺失或不符即不通过；不要求组件验证全系统所有调用链。复杂对象或持久化需核对实际字段和副作用，type:object 不足以证明这些业务条件。

方案绑定当前功能定义、源码、核验规则与内容指纹，保存后再运行测试。修改范围或方案后，旧运行不再支持新结论；不能把先前普通执行或另一功能的记录补贴到新方案。

## 实际执行与完成

`verification run FEATURE BOOK --analysis-session SESSION --input COMMAND --json` 的输入增加 `scope:{planId,scenarioId}`。契约场景分别执行两次，scope.side 为 consumer 和 provider，两次都绑定同一份 contractContextId 的当前方案。end-to-end 同时携带方案绑定的 flow。组件和契约结果只支持声明范围，不叫整条链路已观测。

执行记录能证明命令真实运行及绑定有效，不能自动证明自然语言断言充分。逐项检查测试确实调用了目标业务、核对输出和副作用、覆盖适用异常；只打印成功或空命令不能作为业务验收。使用真实 executionId 登记完成，保存后通过 flow sync 同步范围、层级和缺口。维护 Skill 不登记新完成，不清理待实现批注。

功能完成与整条链路观测分开：符合当前定义并通过相应业务验收的功能可以完成；系统级联调不可用时保留具体范围限制，不把独立验收功能一律改草稿。按 [实现情况](implementation-status.md) 单独核对业务实现；当前定义已实现可以显示完成，同时如实保留运行未核验，不伪造执行记录。

## 限制与交付

先排查可解决问题并尝试适用的组件／契约验收，再认定限制。limitation.kind 为 adapter／environment／external。analysis-gap 必须来自当前检查的实际 language/message，并与该步骤的源码文件或语言相关。环境检查由 AI 执行 verification diagnose FEATURE BOOK --analysis-session SESSION --input DIAGNOSTIC；输入见 schema --verification 的 $defs.environmentDiagnostic，可用 {kind:"command",target:"实际可执行文件"}、{kind:"file",target:"实际必要路径"} 或 {kind:"tcp",host:"实际主机",port:端口}。缺失时命令返回非零，但保存真实执行编号；证据引用 {kind:"execution",id:executionId}。外部限制引用 {kind:"context",id:contextId,executionId:诊断编号}，上下文必须完整读取且含诊断的具体目标。仅读 Skill 文档、任意失败脚本、普通日志或 purpose:environment 分类不能作为限制凭据。诊断绑定本功能、定义和源码，不能用于完成业务。工具能证明具体障碍，不能证明所有替代验证都不可行，AI 仍须核对关联与实际原因。

source 限制的步骤保持未运行，不添加虚构 acceptance。完整业务验收条件仍需实际证据；无法运行时保留未验证范围和具体障碍，实现状态依实现核对判断，不因没有执行而改成草稿。源文件漏读、浅记录、缺字段依据、遗漏方案、未执行的声明场景、错误映射与失败断言均是继续完成的工作，不能靠 acknowledgedGaps 获得部分交付。

交付 v4 逐项核对保存的分层方案及实际执行。review.flows 只列本次声明要作严格链路判断的流程，其他流程保留范围提示。候选入口仍必须归类：当前方案／流程的真实源码引用及可达连接自动关联，剩余非业务库入口需按 flow-verification.md 的具名源码说明排除；未归类入口会阻止 ready 和 partial，不能靠 acknowledgedGaps 放过，也不要求为归类穷尽运行。已声明的端到端场景仍必须严格通过；全书不要求所有函数和所有分支都具备运行探针。

完整源码分析、业务内容、有效方案、当前验收与 HTML 均符合声明范围时可 ready，结论明确限定于该范围。只有真实限制有依据且在页面可见、其余可完成工作均已补齐时才可 deliverable:true、stage:partial；valid 仍为 false。初始化在严格或合法部分交付后自动启动 serve、核对 canSave 并打开实际页面，最终仍只交付编辑链接、产品定位和核心旅程。

## 范围与真实能力边界

先检查 scan／check 的 scopeCoverage，发现自有源码被过滤时默认补齐，不通过另建更小会话消除问题。用户明确要求局部范围时，保留对话原文与遗漏清单，review.scope 写 reason 和 authorization:{source:user,text:原文}，范围差异只允许部分交付；不能伪造用户范围授权或用耗时作为理由。

探针实际报告当前步骤函数 unsupported 时，可用 adapter 限制引用该 executionId；业务断言失败不属于适配能力限制。capabilities.runtime.workflowHostObservation:false 表示工具未采集外部工作流宿主事件，仅适用于机器识别并完整读取的工作流入口、且步骤不混入普通函数；证据为 {kind:capability,name:workflow-host-observation,id:实际contextId}。现有指令仍可按原文核对实现，本次真实使用另记范围，不虚构整条流程运行通过。
