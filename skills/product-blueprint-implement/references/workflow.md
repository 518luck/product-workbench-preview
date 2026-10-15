# 实现流程

## 检查工具与待办

使用 CLI 帮助与 Schema 确认支持 `document status`、`implementation.sourceSnapshot`、`feature.complete.resolvedAnnotationIds` 和严格验收。全局工具不支持时可使用已知工具源码入口；找不到可用工具时说明需更新，保留原文与批注，不绕过 CLI 直接清空 JSON。

1. 先运行 `document status /文档 --json` 比较当前源码与验收基线。检查范围内全部功能，即使它们显示完成且没有批注；提交号不能替代文件内容比较。
2. 读取 `document get` 和未按 draft 过滤的 `feature list`。候选包括草稿、`annotationCount > 0` 及源码状态 `changed`／`unverified`／`unavailable` 的功能。
3. 在用户指定范围内用 `feature get ID --related` 读取定义、批注、规则、流程、依赖与验收，固定当前 revision、批注 id、原文和 definitionRevision。

用户要求实现整个项目蓝图时自动发现明确待办，无须逐项复制指令。但草稿可能只是未核验，源码变动可能是重构；它们不构成任意开发授权。未保存到 JSON 的浏览器输入不可读取，不能声称已处理。

## 读取源码与定位影响

`current` 只表示记录范围内指纹一致；`changed` 需要追踪影响；`unverified` 缺少基线；`unavailable` 需要解决路径或读取问题。缺少基线时先核验已有代码，不伪造一致。

用变更清单定位入口、调用与依赖，再完整读取本次已确认扫描范围。`analysis scan /项目 --config 已确认范围.json --json` 后：

- 分页读取 contexts，取得相应凭据；每轮 pending 从 offset 0 获取剩余项。
- 逐项 `analysis read`，跟随 `nextOffset` 读完分段，再保存独立职责、输入输出、条件、调用、副作用、异常与未知记录。
- 配置、测试和产品代码按实际用途分类；未解析或外部调用保留未知，不自动填充通用摘要换取检查通过。

相同快照可以恢复；源码、清单或解析配置改变时重新扫描，不复用旧快照凭据。

## 明确并保存目标

将当前代码、定义与批注对照，先确定业务含义：

| 情况                               | 后续处理                               |
| ---------------------------------- | -------------------------------------- |
| 代码与定义一致，只需核验或源码重构 | 保留定义版本，实际验收后刷新该版本记录 |
| 明确、已授权的待实现需求           | 整理并保存具体定义，再实现             |
| 已实现且符合授权需求的新增行为     | 更新相关蓝图并核验，不重复开发         |
| 有歧义、与原需求冲突或超出范围     | 先确认，保留批注及未决事项             |

保留稳定编号、用户原文、备注和历史。批注保留在 annotations 中，不直接拼进 description；批注针对旧版本时先比较当前定义。仅图表有缺口时补图，不扩充业务需求。

使用明确 operations 和实际 `affectedFeatureIds`，为需求字段绑定批注或需求原文来源。`feature.update` 更新指定业务字段；确有改写原文的授权时才用 `feature.define`。

```sh
product-blueprint analysis check --session SESSION --json
product-blueprint apply /文档 --input 批次.json --analysis-session SESSION --dry-run --json
product-blueprint apply /文档 --input 批次.json --analysis-session SESSION --json
```

明确且已授权的内容通过预检后直接保存，保存后的 revision 才是实现目标，不重复请求内容确认。

## 实现并准备核验

遵循目标项目的开发约定实现功能及必要的业务测试，使权限、存储、网络和异常行为对应蓝图要求。修改的是蓝图描述的目标项目；固定模板不承担目标业务实现。

代码改变后重新扫描，完整读取当前范围所有单元与上下文并刷新分析记录；将最终实现绑定到步骤、规则、异常和验收字段，不把 requested 直接改名成 observed。

如最终行为需要改变已保存定义，先在授权范围内保存新版本，歧义先确认；整理完整流程，再用 `feature.sync` 声明流程与当前定义一致。业务变更和该功能的完成登记分批处理。

随后按 [验收与完成登记](verification.md) 执行实际检查、保存完成记录及处理批注。
