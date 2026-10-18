# 核验范围与执行

使用 `analysis capabilities` 核对 business.coverage:2、delivery.modes 包含 source 和 verified，并读取当前 Schema。工具不足时由 AI 定位可用工具或更新，不弱化断言兼容旧版本。

先读取所选 feature 的规则、流程、依赖、checks、批注和 definition revision，运行 document status。源码变化不自动表示新需求，也不能只查看草稿。

单功能只分析其实际入口、调用、持久化、异常和相关上下文，使用明确的 include/contexts 扫描范围；记录核验范围，不把局部分析称为全仓完成。全部功能先全仓业务对账，按用户目标与结果反查遗漏，再补齐完整分析。相同快照和已核验的不受影响分析可复用；不能手填新基线。

先用 feature assess 对照当前定义保存实现判断，随后按 layered-verification.md 保存 verification plan。`verification plan` 不带 input 可查询当前方案及工具检查结果；只取所选 featureId 的结果，不能混用其他版本或请求。按 verification.md 执行并登记。未实现内容如实列出，不在核验流程中补代码。

核验已保存的定义，批注是待实现想法，不能拿它们擅自改写验收目标。业务定义若有歧义，先确认；若与代码不同，报告差异，交由用户在页面修改或选择实现。

如果由实现 Skill 调用，沿用传入的书路径、所选 featureIds 和目标 revision；源码改变后重新核验。范围内全部通过才返回可清理的本次批注名单，实际清理由实现 Skill 原子提交；失败和新增批注保留。

核验后只保存自己的核验/实现状态及生成页面，不强制全书 document check。全部严格交付才用 mode verified；mode source 不能支持运行验收通过的结论。

当前协议还须支持 business.coverage:2 与 delivery.modes:[source,verified]。business check 的 valid 包含排除审阅，不能只查看 coverageValid；完整交付以 document check 的 completion 为准。
