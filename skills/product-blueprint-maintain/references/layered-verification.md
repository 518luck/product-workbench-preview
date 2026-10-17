# 分层验收与范围

完整读取源码与穷尽运行路径是两件事。保持已确认范围内的逐函数读取、逐位置分析和业务字段依据；运行验收按业务重要性、项目环境与可用能力选择方式，不要求初始化时穷尽每个内部函数的所有分支。

## 执行前保存方案

先读取 `schema --verification-plan`、`verification plan --help`、`schema --verification` 与 `schema --delivery`。当前分层交付为 delivery v4；v3 仍执行旧的严格流程检查，不能仅改版本号消除缺口。

定义和流程保存后，使用 `verification plan BOOK --analysis-session SESSION --input PLAN --json`，为每个功能保存独立方案。命令省略 input 可查询方案及当前执行缺口。

- goal 写具体用户目标及结果。steps 必须覆盖该功能全部业务步骤，每步引用已完整读取和分析的 unitIds 或 contextIds。
- 每步 level 选择 source、component、contract 或 end-to-end。运行步骤通过 scenarioIds 引用实际场景；场景绑定 steps、criteria、正常／异常类型和具体 assertion。先确定正常结果、权限／规则、异常与持久化等关键行为，再选择测试，不能为了通过而只验证哈希、路径等无关辅助函数。
- source 是源码核对，不是运行通过。未来需求或尚未实现的草稿可仅做源码／需求核对；已有实现无法运行时，为具体步骤提供 limitation，说明影响及可核对证据，并把草稿原因写进产品书 notes，不能只写在内部审阅 JSON。
- 优先复用对应业务的现有测试和本机组件测试。组件验证真实模块与其可控依赖；跨服务验证可使用同一份契约，分别执行调用方和服务方测试。测试替身只支持明确声明的边界，不证明线上服务或完整部署已联通。
- end-to-end 场景必须先有 flow record，绑定同名、同类型场景及真实业务步骤；用临时副本探针执行和 flow check 判定。只在确实需要并能运行的关键链路采用，不将所有组件测试强制升级为全系统联调。

方案绑定当前功能定义、源码、核验规则与内容指纹，保存后再运行测试。修改范围或方案后，旧运行不再支持新结论；不能把先前普通执行或另一功能的记录补贴到新方案。

## 实际执行与完成

`verification run FEATURE BOOK --analysis-session SESSION --input COMMAND --json` 的输入增加 `scope:{planId,scenarioId}`。契约场景分别执行两次，scope.side 为 consumer 和 provider，两次都绑定同一份 contractContextId 的当前方案。end-to-end 同时携带方案绑定的 flow。组件和契约结果只支持声明范围，不叫整条链路已观测。

执行记录能证明命令真实运行及绑定有效，不能自动证明自然语言断言充分。逐项检查测试确实调用了目标业务、核对输出和副作用、覆盖适用异常；只打印成功或空命令不能作为业务验收。使用真实 executionId 登记完成，保存后通过 flow sync 同步范围、层级和缺口。维护 Skill 不登记新完成，不清理待实现批注。

功能完成与整条链路观测分开：符合当前定义并通过相应业务验收的功能可以完成；系统级联调不可用时保留具体范围限制，不把独立验收功能一律改草稿。只有代码、没有运行证据时说明“已有实现，运行未核验”，不伪造完成记录。

## 限制与交付

先排查可解决问题，再认定限制。limitation.kind 可为 adapter、environment 或 external；evidence 引用当前 analysis-gap（含实际 language/message）、失败的环境诊断 executionId，或已完整读取的外部边界 contextId。需要环境诊断时，以 purpose:environment 实际执行检查；业务测试失败不能转称环境限制，环境诊断也不能用于登记完成。工具核对证据存在、读取和快照，不自动判定材料语义或环境障碍不可解决，AI 仍须检查实际原因。

source 限制的步骤保持未运行，不添加虚构 acceptance。完整业务验收条件仍需实际证据；无法核验相应功能时保持草稿并在 notes 写具体原因及已有实现范围。源文件漏读、浅记录、缺字段依据、遗漏方案、未执行的声明场景、错误映射与失败断言均是继续完成的工作，不能靠 acknowledgedGaps 获得部分交付。

交付 v4 逐项核对保存的分层方案及实际执行。review.flows 只列本次声明要作严格链路判断的流程；其他入口与流程保留在 diagnostics 和页面范围提示，不冒充已运行或自动升级为通过。已声明的端到端场景仍必须严格通过；全书不要求所有函数和所有分支都具备运行探针。

完整源码分析、业务内容、有效方案、当前验收与 HTML 均符合声明范围时可 ready，结论明确限定于该范围。只有真实限制有依据且在页面可见、其余可完成工作均已补齐时才可 deliverable:true、stage:partial；valid 仍为 false。初始化在严格或合法部分交付后自动启动 serve、核对 canSave 并打开实际页面，最终仍只交付编辑链接、产品定位和核心旅程。
