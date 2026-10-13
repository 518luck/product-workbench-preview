# 需求与源码差异

1. `document get /文档 --json`，再 `feature list` 与目标 `feature get ID --related`。保存 documentHash，读取原始定义、当前 revision、flowRevision、完成与历史验收。先说明本次用户要求和已有代码的差异，不用新描述覆盖原文。
2. 核验或新建 `analysis scan /项目 --json`。显式扫描范围继续沿用用户确认的配置；列出默认／用户排除项。相同快照可断点继续；新源码、新增／删除文件、解析配置变化使旧会话失效，重新扫描并完整读取当前范围内所有待处理单元。不要只读 diff 就声称全量核验。
3. 分页读取 contexts 并取得读取凭据；每轮 `analysis list --status pending` 从 offset 0 取剩余单元。逐项 `analysis read`，跟随 nextOffset 读完，记录 schema 要求的八项分析。调用目标依 TypeScript 符号索引，动态或外部关系保留未知；配置读取不计函数分析，测试是验收依据。根据函数间实际调用与业务入口确认需求影响，必要时读取相关蓝图功能与依赖。
4. 使用最小明确 operations。只改名称／分组用 feature.update；改业务规则、步骤、异常和验收也用 update；用户明确改写原文才用 define；删除只能基于明确授权，用同批清理最终引用。未指定字段、旧历史和未扫描功能保持原状。产品、依赖或图表变化可能影响其他功能，逐项列出真实受影响的 affectedFeatureIds。
5. `analysis trace` 绑定最终 changed 字段的 value。步骤、规则、异常和依赖分别用叶子 JSON Pointer 关联；清空值或删除用相应空值／null 依据。请求中的未来行为用 requested + 需求原文，不把它记成 observed。需要同步流程时，flow 和 stepDetails 已整理完毕，再附 feature.sync；它仅声明保存后的定义版本已同步，不负责生成流程。
6. `analysis check`；`apply /文档 --input 批次.json --analysis-session SESSION --dry-run --json`。展示定义保留／改写、规则差异、受影响功能、版本与草稿状态，以及缺口。缺口默认拒绝；用户接受草稿范围后才用 --allow-partial-analysis，该批次不得含 complete。
7. 用户确认具体预览后提交。若 CONFLICT 或 ANALYSIS_STALE，不自动用新哈希重试：重新读文档／源码，重新评估并预览实际差异。已授权且内容没变可继续提交；内容改变则展示新结果等待确认。记录与流程依据变化时重新检查。
8. 保存后读回字段、版本及 HTML 状态。生成失败但文档已保存时单独 render。改名和分组不得使已有完成状态失效，业务变化必须回草稿；历史验收保留并且不能给新版本冒用。此流程只维护文档，不运行项目代码或登记完成。
