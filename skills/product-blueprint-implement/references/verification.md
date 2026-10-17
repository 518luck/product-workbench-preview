# 验收与完成登记

## 核对当前依据

完成前要求：定义和流程已经保存并一致，当前核验范围内的源码分析与依据有效，产品源码和字段依据有效。测试单元可记为 `role:verification`，但完成还需要该功能的产品实现依据；纯需求记录不能完成。

整体分析存在其他语言／语义／适配能力缺口时，只有工具确认其全部位于本功能核验范围外，才可凭独立真实执行登记完成；保留全书缺口，不声称整体严格通过。漏读、漏记录或缺少本功能验收的字段依据不能豁免。普通功能验收和严格流程追踪分阶段执行；已有独立验收的功能可先登记完成，流程尚未追踪时显示未核验，不能冒充全流程通过。引用带 flow 的执行时仍须满足相应流程检查。

业务含义与定义不一致时回到实现流程，先整理定义。源码改变时重新扫描及分析，不用旧会话或旧测试给新版本登记完成。

## 执行真实验收

先按 [分层验收](layered-verification.md) 保存当前版本的逐业务步骤方案，再读取 `verification run --help`、`schema --verification` 及 `schema --changes`，选择目标项目适当的测试、命令和界面交互，覆盖当前功能的正常与适用异常路径。

```sh
product-blueprint verification run ID /文档 --analysis-session SESSION --input 命令.json --json
```

输入携带 scope 绑定方案和场景，命令与参数由当前 Schema 定义，工具不经过 shell 执行；超时等限制以帮助为准。实际运行后记录结果，不只生成“通过”的验收 JSON。只有 `valid:true` 的记录才能提供 `executionId`。

逐条核对业务条件与真实断言／交互的关系；同一次执行可支持多个条件，无须逐条件重复回归。文件存在、协议夹具或命令退出成功不能替代所声明的业务行为验收；声明 AI 自主协作能力时需实际执行相应工作流。

失败或无法核验时记录具体检查和阻碍，保留草稿及批注；修复本次授权范围内的问题后重验，不将失败写成 passed。

## 保存完成与批注清理

1. 读回 feature 和 documentHash，确认 revision 仍是实际验收版本，flowRevision 已同步。
2. 按 Schema 构造 `feature.complete`：当前 revision、真实 verifiedAt、非空且全部 passed 的行为 checks 及各自 executionId。verifiedAt 不早于执行结束时间；可选 commit 须真实取得。
3. 将本次确实已处理且验收通过的批注 id 放入 `resolvedAnnotationIds`，不重复；没有批注时省略。未处理、失败、含歧义及处理期间新增的批注不加入名单。
4. 完成批次只含同步／完成操作，不包含业务字段修改或 `affectedFeatureIds`，避免使刚验收的定义版本变化。预检和保存均带 `--require-verification --analysis-session SESSION`，不得使用 `--allow-partial-analysis`。
5. 工具自动将当前源码指纹、根目录、扫描范围和清单写入 `implementation.sourceSnapshot`；不手填或仅替换指纹。旧验收与历史基线保留，缺少基线的手动记录不冒充真实执行。

文档、功能、版本、源码不匹配，命令失败／超时或输出被修改时不得完成。完成与批注清理一起提交；任何阶段失败都不另行删除批注。

## 读回与交付

读回 feature，再运行 `document status`。核对本次功能源码状态为 `current`、implementedRevision 等于 revision、验收历史保留、指定批注已清理且其余批注仍在。其他未核验功能的旧基线保持原状，不批量替换来消除提示。

确认 HTML 已更新。JSON 已保存而渲染失败时仅 `render`；遇到文档冲突重新核对版本与批注，源码过期则重新扫描及验收，不能盲目替换哈希或重复登记。

交付阅读链接、已实现或已核验的行为、相关验收结论与具体剩余事项。任务包含完整交付审阅时，按 `schema --delivery` 刷新当前 review 并执行 `document check`；仅实现指定功能不要求把其他需求草稿全部完成。技术日志与执行编号保留在记录中，按用户需要展开。
