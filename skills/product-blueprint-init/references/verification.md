# 验收与交付检查

## 按功能判断实际状态

读回保存后的定义版本与流程，对照产品源码和实际验收条件逐项判断：

| 情况                                           | 处理                                       |
| ---------------------------------------------- | ------------------------------------------ |
| 已有实现与当前定义一致、流程完整且实际核验通过 | 同步流程并登记当前版本完成                 |
| 新需求或代码缺少具体行为                       | 保留草稿，记录缺少的步骤／规则和查找依据   |
| 已有实现，但验收失败或环境无法核验             | 保留草稿，记录具体检查、失败证据或环境障碍 |

首次整理不表示尚未实现；未核验也不等于未实现。不用同一段分析进度备注代替逐功能判断。

完成必须有当前分析快照的有效 `observed` 产品源码依据；需求和测试源码不能单独证明产品已实现。有分析缺口时不得登记完成。与已核验业务无关的宿主未知项按 [内容审阅](content-review.md) 保留并说明，不自动判定所有功能未实现。

## 执行验收并登记完成

先读 `verification run --help`、`schema --verification` 和 `schema --changes`，按目标项目选择合适的现有测试、命令及界面交互。每个业务条件应有正常与适用异常路径的实际断言；同一执行记录可支持多个条件，无须逐条件重跑整套回归。

1. 保存业务定义与完整流程，再确认本次目标 revision。若流程已与定义一致，可用 `feature.sync` 声明同步；该操作不会生成流程。
2. 在当前源码快照下，通过以下命令实际运行验收。输入按 Schema 提供命令和参数，不经过 shell；超时等限制以当前帮助为准。

   ```sh
   product-blueprint verification run ID /文档 --analysis-session SESSION --input 命令.json --json
   ```

3. 只有返回 `valid:true` 才引用 `executionId`。将具体行为条件及对应编号写入 `implementation.checks`；`verifiedAt` 不早于实际执行结束时间，可选提交号也须真实取得。
4. 读回 revision 和 documentHash，使用独立后续批次提交 `feature.sync`／`feature.complete`，预检和保存均带 `--require-verification --analysis-session SESSION`。完成批次不携带业务修改或 `affectedFeatureIds`，避免递增刚验收的版本。
5. 工具自动将当前源码指纹、范围及清单写入 `implementation.sourceSnapshot`。不手填基线，不复用其他文档、功能、版本或快照的执行记录。源码或定义改变后重新分析并验收。

失败、超时或被修改的执行结果不能支持完成；旧手动记录保留但不冒充真实执行。命令通过只证明执行结果，仍须审阅断言是否覆盖业务。文件存在和协议夹具不能替代真实 AI 协作验收。

## 最终交付检查

1. 运行 `document status /文档 --json`，确认本次已核验功能为 `current`。旧记录缺少基线时是 `unverified`；路径或读取问题需如实保留。
2. 用浏览器核验实际 HTML 的流程、图表、正常／异常情景及详情入口。结构与来源检查不能代替业务审阅。
3. 按 `schema --delivery` 保存同目录 `delivery-review.json`，使用 v2 绑定最终 documentHash；记录核心旅程、各功能当前 revision、状态判断、规则／依赖、验收映射及图表取舍。草稿有具体 reason 和 evidence，详细映射按 [内容审阅](content-review.md) 填写。
4. 运行 `document check /文档 --analysis-session SESSION --input delivery-review.json --json`；只有 `valid:true` 才宣称初始化完成。失败继续补齐，无法消除时只交付明确的部分进度。
5. 按 SKILL.md 的交付格式直接打开实际产品书，提供可点击链接、产品定位与核心旅程。技术记录保存在文件中。

若 JSON 已保存而 HTML 生成失败，仅运行 `render` 恢复，不重复新增或完成登记。源码在交付期间变化时重新核验，不用新指纹替换旧基线来消除提示。
