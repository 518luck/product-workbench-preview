# 首次整理

1. 确认项目根目录和文档位置。只读清单、产品介绍和 package.json，确定真实项目名称、目标用户和背景；名称缺失时根据用户描述确认，不能把“产品蓝图”当作项目名。先检查目标文档是否已存在。
2. 明确扫描范围。默认全量处理项目内的 authored JS／TS；大项目需按用户明确的范围扫描，而不是擅自只取入口文件。`analysis scan /项目 --config 范围.json --json` 的配置可用 `{"include":["."],"exclude":["明确排除的路径/**"]}`。默认排除和原因从 manifest 读取；非支持语言、解析失败、配置读取失败都列入缺口。
3. 保存返回的 session 路径和 snapshotHash。分页读取 `analysis list --session SESSION --kind contexts --json`，通过 `analysis read ID` 完整读取清单与配置。分页读取 `--status pending --limit 50`；处理后 pending 集合变小，因此每轮从 offset 0 获取剩余项，直到 total 为 0。不要一边过滤 pending 一边增加 offset，否则会跳项。
4. 每个单元：`analysis read ID --session SESSION --json`；跟随 nextOffset 分段。读完并理解后，按 `schema --analysis` 提交 record：职责、输入输出、条件、调用、副作用、异常、未知都需明确，有确切理由为空时用 []。查看索引 calls 的实际目标； unresolvedCalls、动态调用、外部服务、框架回调的注册关系不能补写成已解析事实。若上下文过长，保存已完成记录并在同一快照恢复剩余项，不把进度写成业务功能。
5. 从用户入口到业务结果串联记录。将独立业务能力归入模块／子模块，分别整理正常流程和拒绝、失败、重试等异常路径。测试与配置补充验收及运行条件；不要把测试辅助函数作为产品功能。存在源码但未看见行为时写待确认，不能用需求替代“已有实现”。
6. 新项目没有文档时运行 `init /文档目录 --name 实际项目名 --json` 创建空骨架。无源码时仍可创建分析会话，读取可用上下文，并以需求依据建立草稿。不要写入完成状态。
7. `document get /文档 --json` 获取整份哈希；构建明确 operations。产品用 product.update，依赖用 dependency.create，功能用 feature.create。保留稳定编号，用 schema 获取真正的 flow/stepDetails 字段，不用自造格式。业务步骤、规则和异常逐字段绑定依据：`analysis trace --session SESSION --input traces.json --json`。target 是最终字段 JSON Pointer，value 是最终值；code 引用 record 返回的 unitId/recordHash，需求附原文 source:user|document。推断和未知只放到明确标注的 notes 中。
8. `analysis check --session SESSION --json` 后运行 `apply /文档 --input 批次.json --analysis-session SESSION --dry-run --json`。向用户展示产品名称、业务分组、功能定义、正常／异常流程、具体缺口；用户确认后才提交。若缺口不可解决，说明范围并在得到草稿交付确认后启用 `--allow-partial-analysis`。
9. 保存后读回功能与哈希，检查 HTML 更新状态。文档已保存但 HTML 失败时只运行 render 恢复，不能重复新增操作。初始化整理默认交付草稿，代码扫描不等于实际验收完成。

记录／依据 JSON 格式以 CLI 的 schema 为准。每个 Skill 不维护另一份协议；用命令帮助核对支持的参数。固定模板只负责呈现，业务 JSON 不包含 CSS、SVG 布局或事件代码。
