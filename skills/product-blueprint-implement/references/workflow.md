# 代码实现与验收登记

1. 读取目标 feature get ID --related 和整份文档哈希，固定用户授权的功能编号及 revision。确认定义、规则、正常／异常流程、验收条件。草稿已经确认时直接在既有授权内实现；仅“整理蓝图”没有实现授权。
2. `analysis scan /项目 --config 已确认范围.json --json`。读取 contexts；每轮分页 pending 从 offset 0 获取剩余项，analysis read 读完所有分段，再 analysis record 保存每个单元的独立分析。源码读取覆盖、测试、配置和未知项各归其用途。analyse/check 的通过不是模型理解保证，按真实调用追踪正常及失败路径。
3. 若定义或流程需要业务调整，先使用明确 operations + affectedFeatureIds，绑定逐字段来源；analysis check，apply --analysis-session SESSION --dry-run，展示具体变化，确认后保存。保存后的 revision 才是实现目标。若仅存在图表缺口且业务定义不变，保持该定义的含义，不自行扩充需求。
4. 按项目自身约定实现并加入有意义的验收测试。函数读写、网络、存储与权限变化应能对应蓝图规则和异常。蓝图固定模板不参与业务实现；需要真正写代码的是被蓝图描述的项目。
5. 用项目实际命令执行验收，记录执行命令、结果与时间，不能只生成验收 JSON。当需要提交号时读当前 Git，不能伪造提交。未通过则保留草稿，修复授权范围内的问题后重验；不把失败记为 passed。
6. 代码改变后重新 scan。完整读取当前快照的所有单元和上下文，逐项刷新记录；相同快照可恢复，新快照不复用旧凭据。将当前实现依据绑定到各步骤、规则、异常和 checks；测试单元 role:verification 作为验收依据，完成登记必须还有此功能的 product 源码依据。新项目纯需求记录没有源码依据时不能完成。
7. 如果业务含义与已保存定义不同，先维护并确认新定义，不将结果登记到旧 revision。核对源码实现和当前版本一致后，整理并保存流程；feature.sync 声明 flowRevision 对应保存后的 revision。业务变化和该功能 complete 不能同批登记。
8. 重新读取 feature 与 documentHash，检查 revision 仍为实际验收版本。构造 feature.complete 的 implementation：当前 revision、真实 verifiedAt、非空且全部 passed 的 checks，可选真实 commit。analysis check 无缺口，预览完成批次；已获授权登记该明确版本时提交，否则展示结果等待确认。--allow-partial-analysis 一律不得用于此步骤。
9. 读回 feature，确认 implementedRevision 等于 revision、验收历史保留、HTML 更新状态明确。若文档已保存而 HTML 失败，单独 render；文档冲突需重新读并核对版本，源码过期需重扫及重验，不能盲目换哈希或重复完成登记。
