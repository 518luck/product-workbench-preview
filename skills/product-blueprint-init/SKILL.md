---
name: product-blueprint-init
description: 从目标项目源码或新产品需求首次建立产品书；支持按项目配置仅做全局业务发现，完整初始化生成并打开可编辑页面。已有产品书的功能核验使用 product-blueprint-verify，实现保存后的修改使用 product-blueprint-implement。
---

# 初始化产品书

为人与 AI 建立共享的产品上下文：从目标项目的使用者、实际操作、业务对象、规则和结果归纳功能，不预设数量、名称和分组。保存产品 JSON、生成 HTML，自动启动本机编辑服务并打开页面。

初始化负责源码理解和产品书生成。完成表示当前定义已实现；草稿必须列明实际缺失项；无法判断标待确认。运行验收独立显示为未核验，初始化不默认执行整套运行验收或冒充严格验收通过。

## 配置与阶段

先定位目标项目 PROJECT，执行 `workflow plan PROJECT --skill init --json`，读取项目根目录 `.blueprint-workflow.json` 的 Skill 开关和 stages。配置只控制任务，启用不表示自动执行。

- valid:false：报告关闭项、缺失依赖或未提供的独立阶段，不擅自开启其他流程。
- executionMode:discovery-only：只读取并执行 [独立全局发现](references/discovery.md)，保存候选目录后结束。不进入下方完整流程，不创建或改写产品书，不运行全量函数分析和验收。
- executionMode:legacy-full：进入下方兼容的完整初始化流程。

当前只有 discover 支持独立任务；单独 analyze/compose 及跳阶段组合会被明确阻止。没有配置文件时保留完整流程默认行为；用户明确指定本轮阶段时，由 AI 用 workflow get/set 保存配置后重新计划，不让用户手写命令。调整配置使用当前 configHash，冲突后重新读取，不能覆盖他人设置。已有产品书也可以单独做全局发现，不因此转成核验或重建旧书。

## 完整流程

1. 读取 [产物目录](references/artifacts.md)，定位目标项目。新产品书默认 `.blueprint/`，保留其他产品示例。已有本项目产品书时不覆盖重建；继续同一初始化任务可恢复，其余核验转核验 Skill。
2. 读取 [初始化流程](references/workflow.md) 与 [业务发现](references/business-discovery.md)，先建立全仓操作和早期业务地图，再沿业务路径展开源码，并完整补齐约定范围的函数与上下文分析。 先检查早期地图的 coverageValid，修正遗漏操作、错误排除和断开的结果依据，再投入全量记录；不要用大批模板记录补齐数字后再发现业务方向错误。
3. 按 [内容审阅](references/content-review.md) 和 [图表](references/diagrams.md) 保存功能、规则、流程、依赖与图表。CLI、网页或 API 即使支撑上层旅程，只要交付了可独立使用的目标与结果，也应纳入产品能力；“支撑”不是自动排除理由。Skill 数量、目录或顶层旅程不能决定整本书的功能数量。
4. 按 [实现情况](references/implementation-status.md) 对照源码保存判断。初始化只记录已有实现，不开发缺失功能，不制造验收执行编号。
5. 按 [初始化交付检查](references/verification.md) 执行 `document check --mode source`。只有当前结果 `completion.canDeliver:true` 才交付。失败则依 `completion.nextAction` 补齐；保存进度和局部检查通过均不算初始化完成。
6. 启动并验证本机编辑服务，打开真实返回的可编辑链接。用户随后在页面修改定义或批注。用户要求继续核验时调用核验 Skill；未选择核验时完成初始化后结束。

所有 CLI、服务和浏览器操作由 AI 完成，不让用户复制命令。未读、未分析或未审阅属于继续完成的工作；真实能力限制依检查结果明确部分交付。保留稳定编号、用户原文和历史，不改固定页面模板。

## 交付

成功只回复以下内容，具体旅程由目标项目决定：

```markdown
[打开产品书（可编辑、可保存）]({{已验证的服务网址}})

产品定位与核心业务旅程

{{目标用户和产品作用}}

核心流程：{{实际核心流程}}

- {{旅程名称}}：{{目标与结果}}
```

初始化的源码检查通过不表示运行验收通过。检查为 incomplete 或 canDeliver:false 时继续处理，不为了使用成功模板而提前结束。只有当前工具记录能证实的权限拒绝、目标文件不可访问或语言/环境能力限制，才属于客观阻碍；漏读、漏记录、未审阅、时间或上下文不足继续补齐。客观阻碍仍须报告“初始化未完成”及实际影响，不使用成功交付模板。

恢复时重新执行当前文档的 `document check --mode source`，核对返回的 documentHash、snapshotHash 与 `completion.canDeliver`，再检查服务。只有该字段为 true 且服务指向同一文档，才可结束已完成的同一任务；HTML 存在、端口可访问或旧回复声称成功都不是完成依据。保留服务运行。
