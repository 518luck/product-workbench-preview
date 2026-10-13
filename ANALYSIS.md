# 分析辅助层 v1

CLI 0.2.1 使用固定 TypeScript 6.0.2 Compiler API 静态索引，不载入或执行项目代码、构建插件或测试。AI 在外部理解和验收；CLI 核验读取协议、来源绑定和保存规则，不能保证模型理解正确，也不能阻止有文件权限的外部程序直接改写文件。

## 快照与范围

`analysis scan [项目] [--config 范围.json] --json` 返回 session、snapshotHash、完整清单（被排除目录作为一个条目，不枚举其内部）、函数／类型／上下文计数、导入关系和 gaps。配置为 `{"include":["."],"exclude":["明确排除的相对路径或glob"]}`，只接受项目内相对路径，不跟随符号链接。默认扫描整个项目的 authored JS／TS；范围外文件和默认排除都有原因。未匹配的 include 是缺口。

默认排除 `.git/.hg/.svn`、`node_modules/vendor/.venv`、`dist/build/coverage/.next/.nuxt`、压缩 JS、source map、tsbuildinfo 和 `.blueprint-analysis`。排除目录不属于声明的分析范围；不能把范围内覆盖称为未扫描语言或整个仓库的全量理解。

`.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts` 的函数、方法、构造器、访问器、箭头、匿名回调和嵌套函数都有独立编号；顶层执行语句也必须分析。接口、类型别名、声明签名和声明文件中的类型单独统计，作为可读取的类型上下文，不当作可执行函数。测试文件的单元 role 为 verification；其他可执行源码为 product。

package.json、tsconfig/jsconfig（含项目内 extends）、工作区及常见构建配置是 context。配置不执行，不计函数分析，但交付需完整读取。项目的 compilerOptions 用于静态符号解析，未纳入清单的外部解析配置、包或库不会被偷偷读取。损坏的 JSON／JSONC、JS／TS 配置、源码语法、非 UTF-8 读取以及识别出的其他语言源码会生成 gaps；本版不进行其他语言的语义分析。YAML／TOML 配置作为文字上下文读取，不承诺语法校验。

快照哈希绑定规范化项目路径、声明范围、解析器及索引算法版本、源码／类型／上下文／非支持语言清单及实际内容。Git HEAD 只是补充。非源码文档或图片变化不使源码凭据失效；新源码、删除源码、内容及解析配置变化都会使旧会话失效。相同快照复用同一会话，无需重新处理已完成记录；索引算法升级也要求重新扫描，避免恢复旧的符号关系。新快照有独立目录和记录。

会话位置为 `项目/.blueprint-analysis/s-哈希/state.json`。创建时原子发布，读凭据、record 和 trace 通过文件锁及原子替换保存；已有他人锁不自动清理。分析模式保存文档时保持会话锁，提交前再次核验源码。外部编辑器不获取工具锁；出现冲突应重新读取而不是改哈希强行重试。

## 分页与读取

`analysis list --session SESSION --kind units|contexts|files|types|traces --status all|pending|recorded --offset 0 --limit 50`。默认 units，limit 为 1–200，返回 nextOffset。status 只过滤 units。units 包含作用域、文件、范围、内容指纹、role 和静态 calls；contexts 包含配置和类型的读取编号。类型不是 record 单元。

处理 pending 时集合会随着 record 变小，因此每轮从 offset 0 获取剩余项；只读不改变集合时用 nextOffset 分页。不要在变化的 pending 列表上持续递增 offset。

`analysis read ID --session SESSION [--offset 0] [--length 16000]` 返回 code、receipt 和 nextOffset。offset 相对单元起点，默认 length 16000，最大 100000。源码偏移为 **UTF-16 单位**、范围为 `[start,end)`、展示行列为 **1-based**。分段不会切开 Unicode 代理对；非法起点被拒绝。跟随 nextOffset 到 null 才是读完。

receipt.id 由工具生成，含快照、文件、源码和片段内容指纹。record 的 receiptIds 可以来自多个分段，也可来自包含该嵌套单元完整主体的父函数／顶层单元。覆盖必须没有缺口；每个嵌套函数仍需独立 record。配置／类型上下文读取不计函数记录。

## 分析与依据

输入规范由 `schema --analysis` 输出。record 输入示例：

```json
{
  "records": [{
    "unitId": "从 list 获取的编号",
    "receiptIds": ["从 read 获取的凭据编号"],
    "responsibility": "检查提交权限并保存答案",
    "inputs": ["当前身份和答案"],
    "outputs": ["成功结果或失败原因"],
    "conditions": ["收集期内且身份有效"],
    "calls": ["调用实际已解析的保存函数；动态目标保留未知"],
    "sideEffects": ["写入答案"],
    "exceptions": ["保存失败时返回原因且保留输入"],
    "unknowns": []
  }]
}
```

八项分析必须明确；无相应行为时用 []，不能自动为所有函数填写通用文字。工具返回 recordHash，用于 trace 引用。摘要更改会使引用旧 recordHash 的依据失效。unresolvedCalls 另外保留索引中未知的外部／动态调用；未知不是自动解析成功，函数名称不构成调用证据。直接函数、不可变别名、静态命名／命名空间导入及显式构造器可报告 resolved；参数回调、可变或重新赋值的绑定、接收者方法分派、框架注册关系保留 unknown。candidateTargets 仅表示类型声明提供的候选，不能当作已确认执行目标；本版对方法调用采用保守处理。

trace 输入示例：

```json
{
  "traces": [{
    "id": "submit-rule-1",
    "target": "/features/submit/rules/0",
    "value": "每个用户只能提交一次。",
    "classification": "observed",
    "evidence": [{ "kind": "code", "unitId": "单元编号", "recordHash": "记录返回的哈希" }]
  }]
}
```

每个业务步骤、规则、异常及其他 changed 字段分别用最终叶子字段 JSON Pointer 和值绑定。相同 id 替换现存依据，不保存该依据的旧版本；需要保留独立来源时使用不同 id。数组索引是当前最终文档的位置；重排后重新绑定，不用旧位置猜测对应。删除用 value:null，清空数组或文字用实际空值绑定。

分类为 observed（代码已有，需 code）、requested（用户期望，需 requirement）、inferred（推断）、unknown（未知）。需求依据为 `{"kind":"requirement","source":"user"或"document","text":"原文"}`；不是伪造源码凭据。推断／未知需 note 解释，只能写到功能 notes，原文以 `[推断]`／`[未知]`（也支持 `[inferred]`／`[unknown]`、`[待确认]`）明确标注；不能支持已确认规则、步骤或完成。工具核验来源结构，不证明需求确实由用户说过，AI 必须遵循实际对话授权。

## 检查与保存

`analysis check --session SESSION --json` 核验快照、每个单元的记录／完整读取、配置／类型上下文读取，以及已有 trace 来源。缺项返回 valid:false、gaps 和非零退出码；不扫描业务文档猜测功能边界。分析未缺记录不等于模型理解正确；未解析动态关系留在报告及记录中。

`apply` 和所有现有 feature 写命令可以加 `--analysis-session SESSION`。工具在当前文档哈希保护下合并整批变更，核对最终 changed 字段与有效 trace 的内容指纹。sync／complete 还核验当前定义、步骤、规则、异常、验收和依赖依据。先 `--dry-run`，用户确认后提交同一批次。

检查失败默认不保存。`--allow-partial-analysis` 只能和 --analysis-session 一起使用，允许草稿缺口交付，返回 analysis.gaps；源码过期不能豁免，未知不得写成事实。该模式不允许任何 complete 操作，也不能更新仍为完成状态的功能。未参与批次的既有完成功能保持原状。

完成登记还需要此功能的当前 product 源码已有行为依据，定义、步骤、规则、异常等当前字段的 observed 依据，以及完整分析、同步流程和对应当前版本的有效外部验收记录。requested 只说明期望，不能直接支持完成。纯需求新项目、测试源码本身或未知／推断不能登记完成。测试与实际执行的通过结果在外部验收，CLI 不运行它们。

不带 --analysis-session 的手工维护命令保留原规则。分析进度留在会话报告；蓝图仍只有草稿／完成，不添加固定 HTML 页脚或 AI 控件。文档保存成功但 HTML 更新失败返回不同状态，单独 render 恢复；不要重复提交已保存操作。

主要错误码：INVALID_ARGUMENT（参数／输入错误，退出 2）、VALIDATION_FAILED（结构／依据错误，退出 1）、CONFLICT（文件锁或文档哈希冲突，退出 3）、ANALYSIS_STALE（源码／配置过期，退出 3）、ANALYSIS_INCOMPLETE（读取、记录、依据或交付缺口，退出 1）、RENDER_FAILED（文档已保存但 HTML 失败，退出 4）。
