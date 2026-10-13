---
name: product-blueprint-init
description: 从现有 JS／TS 项目逐项读取源码并建立产品蓝图，或依据新项目需求建立草稿。用于首次整理产品背景、业务分级、规则与流程；已有蓝图应保留并转为维护，固定 HTML 由 CLI 生成。
---

# 初始化产品蓝图

使用已安装的 `product-blueprint` CLI 0.2.1+，不在 HTML 中调用模型。先用 `--version`、`analysis --help`、`schema --analysis`、`schema --changes` 获取工具的实际协议。找不到命令时使用用户工具目录下 `node /绝对路径/bin/product-blueprint.mjs`，不要自行改写模板或安装其他工具。

读 [references/workflow.md](references/workflow.md) 执行首次初始化，尤其是扫描范围、逐项读取和交付依据。

- 项目已有 `product-document.json` 时先读取并保留编号、分组、用户定义和历史；不运行 init 覆盖。按维护工作流续写，若已安装可使用 `product-blueprint-maintain`。
- 函数是读取单位，独立业务能力是功能单位。先读所有待处理单元，再从入口、调用、条件、数据和异常归纳业务能力；不按文件名或函数名猜测。
- `analysis read` 的源码输出和凭据必须实际进入当前分析上下文。长单元跟随 `nextOffset` 直到 null；嵌套单元可复用完整覆盖其主体的凭据，仍提交独立职责分析。不要自动填充通用摘要或用未经读取的符号清单替代分析。
- 区分 `observed` 代码已有行为、`requested` 用户需求、`inferred` 推断、`unknown` 未知。测试源码是验收依据；接口签名、配置读取和 Git 提交号不能代替函数阅读。
- 交付前 `analysis check`，再以 `apply --analysis-session ... --dry-run` 预览，展示范围、依据和缺口。得到用户对该具体变更的确认后提交同一批次；文档哈希变化则重新读取、评估及预览。
- 缺口仅在用户接受草稿范围后用 `--allow-partial-analysis` 保存，并展示缺口报告；不宣称全量完成，不登记功能完成。无源码的新项目只写需求草稿，不编造源码引用。

辅助程序只能核验读取覆盖、记录与来源绑定，不能证明理解正确，也不是阻止绕过工具的权限边界。
