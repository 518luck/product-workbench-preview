# 维护流程

先运行 `analysis capabilities --json`，确认 `runtime.observationBinding` 为 `step-and-criterion`、`runtime.commandIsolation` 为 `temporary-project-copy`，并确认 `runtime.verificationPlan` 为 3、`runtime.resultScope` 为 `distinct-source-location-per-step`、`runtime.failureBinding` 为 `rejection-or-same-invocation-branch`；`schema --verification-plan` 应要求观测的 step 与 criterion。缺少这些能力时按下述方式换用或更新工具，不删除字段、改用返回类型或弱化断言来兼容旧协议。

## 读取当前状态

先按 [产物目录](artifacts.md) 定位已有产品书并固定 WORK，后续命令显式使用同一文档路径；扫描配置、批次和辅助脚本放在 WORK，或通过标准输入提交。

使用支持 `document status`、`implementation.sourceSnapshot` 和 reviewPoints／coverage 的 CLI，按 `--help`、`schema --analysis`、`schema --changes` 查询实际协议。全局命令缺失或协议过旧时可使用已知工具源码入口；没有可用工具时保留现有记录，说明需更新，不手填基线。

读取 `document get /文档 --json`、`feature list` 及目标 `feature get ID --related`。保存 documentHash，核对用户原文、当前 revision、flowRevision、批注与验收历史。

运行 `document status /文档 --json`，即使没有草稿或批注也检查外部源码变化：

| 源码状态    | 含义与处理                                     |
| ----------- | ---------------------------------------------- |
| current     | 记录范围内指纹一致，仍需按本次需求读取相关材料 |
| changed     | 核对新增、修改和删除的文件，追踪业务影响       |
| unverified  | 缺少验收基线，不能声称当前源码已核验           |
| unavailable | 解决项目路径或读取问题，无法解决时注明范围     |

Git 提交号只作辅助；未提交修改同样需要检查。区分重构、修复、业务变化与未知，不根据提交本身新增需求，也不将源码提示直接变成定义版本变化。

## 分析需求与源码

确认现有会话与当前源码及解析配置一致。恢复时先运行当前版本 `analysis check`，依据 reviewedCount 与具体 gaps 判断，不能只看 recordedCount。相同快照补做 pending 中的缺失或浅摘要；源码、索引或配置改变后重新 `analysis scan /项目 --config 已确认范围.json --json`，保留明确扫描范围并核对排除项。

读取 contexts 和当前范围内所有待处理单元，不能只读 diff 就声称全量核验：

- 每轮 pending 分页从 offset 0 取剩余项，避免处理后集合变化造成跳项。
- `analysis read` 跟随 `nextOffset` 读完全部分段，提交各单元独立的职责、输入输出、条件、调用、副作用、异常和未知记录，用 coverage 解释每个 reviewPoint；完整嵌套凭据可复用，位置说明和分析仍独立。
- 动态及外部关系保留未知；配置说明运行条件，测试是验收依据，二者不冒充产品实现。

对照用户需求、实际入口及调用关系，确认受影响功能、规则、流程与依赖。`observed` 记录已有行为，`requested` 保留需求原文；推断和未知明确标注在备注，不写成已确认事实。

位置清单只是最低检查：完整函数中的闭包输入、调用后果、异步边界、异常传播、部分成功与并发／清理仍须逐项审阅。空数组需要真实依据，不用脚本、复制源码或通用摘要凑齐位置。将业务规则和异常反查到真正实现行为的函数及分支，常量／通用辅助函数不能独自支持不相关结论；相关 Skill、HTML/CSS 和非函数材料另行读取，函数覆盖不代表整个仓库已理解。

## 构建明确变更

使用最小 operations，并按最终保存内容绑定 `analysis trace`：叶子 JSON Pointer、最终 value、有效源码记录或明确需求原文；清空和删除使用对应空值／null 依据。

| 操作           | 适用情况                                              |
| -------------- | ----------------------------------------------------- |
| feature.update | 名称、分组、规则、流程、验收条件等指定字段            |
| feature.define | 用户明确授权改写 description 原文                     |
| feature.sync   | 已整理的 flow／stepDetails 与保存后定义一致时声明同步 |
| feature.delete | 明确授权删除，且同批清理最终引用                      |

产品、依赖和图表变化也可能影响其他功能，按实际业务影响填写 `affectedFeatureIds`。保留未指定字段、备注、原文与历史，扫描未发现不代表可以删除。

业务含义改变时产生新定义版本，旧实现核对失效并转为待确认；改名和分组只改变编辑版本，不能取消已完成状态。语义未变的源码重构不递增定义版本；待核验提示保持可见，不替换 `implementation.sourceSnapshot`。

## 预览与保存

```sh
product-blueprint analysis check --session SESSION --json
product-blueprint apply /文档 --input 批次.json --analysis-session SESSION --dry-run --json
```

展示业务差异、原文保留／改写、受影响功能、版本与草稿状态，以及具体缺口。用户确认后提交同一批次；已有明确授权覆盖相同内容时继续，用户要求先预览时在此结束。

缺口默认阻止保存。先修复可解决项；只有用户接受明确的草稿范围后才在预检和保存启用 `--allow-partial-analysis`，不携带 complete 操作。尚未分析完属于未完成工作，不称为无法核验。

出现 `CONFLICT` 或 `ANALYSIS_STALE` 后重新读文档／源码，评估实际差异，不能盲目换哈希重试。授权内容未变可继续；发生新的业务选择时先确认。

## 读回并结束

核对保存字段、版本与 HTML。JSON 已保存但渲染失败时单独 `render`，不重复业务变更。交付阅读链接及简短变更说明，缺口写入相应功能。

本流程到文档更新即结束：不执行项目验收、不登记完成、不删除待实现批注、不用当前指纹覆盖旧基线。`document check` 不是要求所有需求草稿变成完成的理由。用户另行授权实现时，再进入实现与验收流程。

## 阅读与记录的质量边界

源码正文和配置原文必须进入 AI 的当前分析上下文。脚本调用 read 后丢弃正文，再按文件名或语法类型填摘要，不算逐函数审阅。脚本只整理和提交已完成的分析，不自动生成业务解释。工具会跨记录比较模板与真实源码行为；同义包装函数可以共享准确说明，行为不同的函数不能只替换编号、函数名或源码前缀；职责和逐位置说明都会比较，无关汉字、标签及随机串不算业务解释。恢复旧记录需通过当前质量检查，位置和数量齐全仍不证明语义正确。
