# 源码分析与依据规范

本文说明逐函数分析的读取协议、来源绑定和交付检查。项目介绍与 Skill 入口见 [README.md](README.md)，蓝图格式、文档版本和保存规则见 [DOCUMENT.md](DOCUMENT.md)。

源码分析用于把代码中的实际行为提取为人和 AI 都能理解的产品上下文。初始化 Skill 据此建立产品书，核验 Skill 据此检查已保存定义与实际行为的差异，实现 Skill 据此在代码变化后同步蓝图。函数是读取和核验单位，交付内容仍按产品功能、作用、规则和流程组织。

先通过蓝图理解产品目标和已有功能，再按当前 Skill 协议读取源码与配置、核验实际行为。逐函数记录为业务内容提供依据；面向用户的产品书应说明业务含义，源码范围、凭据和覆盖检查保存在独立分析会话中。快速初始化的能力由 Skill 与 CLI 协作提供，CLI `init` 本身只创建空文档。

当前分析协议为 v2，索引版本为 11。JS/TS 使用固定 TypeScript 6.0.2 Compiler API，其他语言使用随包语法及可选语义工具。扫描不载入或执行项目代码、构建插件或测试。AI 在外部理解和验收；CLI 核验读取协议与记录，不能保证模型理解正确，也不能阻止有文件权限的外部程序直接改写文件。

## 业务发现与紧凑阅读

初始化先形成业务地图，而非先生成全仓逐位置文案。`business inventory --session SESSION` 分页列操作身份、模块概览和上下文；HTTP方法/路径、CLI子命令、事件及工作流分别保留。同 handler 的多个注册不能按函数去重。库导出只是候选，框架/动态分发支持范围由 `analysis capabilities` 的 business.adapters 明确说明。当前业务操作索引为 v2，四种语言共用操作身份、业务地图、来源绑定及审阅协议；`business.boundaries` 列出具体识别范围。

| 语言   | 当前自动提取范围                                                                     | 保留边界                                                                      |
| ------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| JS/TS  | 已有 HTTP 注册/分发、CLI、页面事件及消息/任务候选                                    | 动态目标及未知框架须继续追查                                                  |
| Python | Flask/FastAPI 静态装饰器与显式注册、Click 直接命令、sys.argv 等值分支                | Blueprint/APIRouter 仅组件内路径；挂载、动态方法、跨文件 handler 不冒充已解析 |
| Go     | net/http 的 Handle/HandleFunc、NewServeMux、os.Args 等值/switch 分支、goroutine 候选 | 客户端 Get 不作路由；接口接收者、其他框架及调度关系未穷尽                     |
| C++    | 带 httplib.h 与显式 Server/SSLServer 类型的注册、main 参数的 argv 等值分支           | Client 不作服务端；动态模式、宏/模板包装、跨文件 handler 保留候选或未知       |

这些是静态注册事实，不证明服务已挂载或场景已运行；候选可以用于继续定位，不能直接认作用户能力。新增语言适配没有增加 CLI 依赖。多语言行为读包与已有真实执行探针仍分别验收。

`schema --business` 提供地图与审阅格式。`business record --session SESSION --input FILE` 保存 actor、goal、outcome、operationIds、results；每个操作需归属能力或具体非业务分类。纯需求使用 classification:requested，可无 operationIds，但须引用需求原文，不能支持已实现结论。结果依据绑定真实返回/写入/调用/拒绝位置或工作流原文，不接受虚假位置。

先从使用者、接口和状态/规则三个视角归纳，再沿入口核对结果；最后从全部模块、配置与文档反查遗漏。声明资源存在、结构检查和状态 helper 不能代替业务含义。`business check` 的 coverageValid 是结构结论，不是语义真值。检查还要求每个操作关联真实处理函数/具体分支到结果位置的调用路径，不把回调注册当调用。结果可用 operationIds 限定；via:{flowId,scenarioId} 仅接受当前入口、源码和定义下已通过且精确断言结果位置的工具流程证据。直接调用 HTTP handler 不证明路由被触发。

`analysis pack 文件相对路径 --session SESSION` 只输出一次文件正文、分段凭据及独立单元清单；长文件跟随 nextOffset。完整覆盖的文件读包可支持嵌套函数，但每个函数仍须独立语义记录。参数、调用、分支等机械事实由索引提供，AI 用 claims 说明实际含义并关联 pointIds；旧 coverage 兼容，不再要求每个语法位置都写一句重复说明。

产品定义稳定后给能力填写 featureIds，用 `business record --document BOOK ...` 显式绑定当前功能定义，随后用 `business review` 逐项对原始依据保存 supported/contradicted/unknown。地图或定义变化使旧审阅失效。审阅为 agent-submitted；同权限哈希和日志不能证明独立认证，不宣称机器理解任意自然语言。

新交付审阅使用 v5，把业务操作对账、来源阅读、文档绑定与语义审阅接入分层验收。旧 v3/v4 保留原有检查范围，返回 business.semanticStatus:legacy-unreviewed，不能当作 v5 业务发现通过证明。已实现、源码已读、业务已审阅和运行通过分别记录。

## 命令与处理顺序

```sh
product-blueprint analysis scan /项目目录 --json
product-blueprint analysis list --session /返回的会话目录 --status pending --json
product-blueprint analysis read 单元编号 --session /会话目录 --json
product-blueprint analysis record --session /会话目录 --input 记录.json --json
product-blueprint analysis trace --session /会话目录 --input 依据.json --json
product-blueprint analysis check --session /会话目录 --json
product-blueprint schema --analysis
```

先扫描并建立候选操作与业务地图，再沿业务路径及模块完整读取和分析，最后把业务文档字段关联到分析记录或需求依据。所有单元及上下文处理后执行检查，再用 dry-run 校验文档变更。首次初始化通过后直接保存定义，核验已有实现并登记完成，再生成 HTML 供用户阅读；已有定义由用户在页面修改保存，实现 Skill 处理所选待办。新项目没有源码时按需求创建草稿，不伪造源码引用。

## 扫描范围

`analysis scan [项目] [--config 范围.json] --json` 返回 session、snapshotHash、完整清单、函数／类型／上下文计数、导入关系和 gaps。被排除目录作为一个条目，不枚举其内部。范围配置为：

```json
{
  "include": ["."],
  "exclude": ["明确排除的相对路径或glob"],
  "contexts": ["README.md", "skills/**/SKILL.md", "assets/**/*.html", "assets/**/*.css"]
}
```

配置只接受项目内相对路径，不跟随符号链接。默认扫描整个项目的 JS／TS、Python、Go 和 C／C++ 源码；范围外文件和默认排除都有原因。未匹配的 include 或显式 contexts 是缺口；示例中的文本路径应按项目实际材料调整。contexts 不会把源文件降级为纯文本，也不能隐藏不支持语言的缺口。

默认排除 `.git/.hg/.svn`、`node_modules/vendor/.venv`、`dist/build/coverage/.next/.nuxt`、压缩 JS、source map、tsbuildinfo 和 `.blueprint-analysis`。排除目录不属于声明的分析范围；范围内覆盖不能宣称已理解其他语言或整个仓库。

`.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts` 的函数、方法、构造器、访问器、箭头、匿名回调和嵌套函数都有独立编号；顶层执行语句也必须分析。接口、类型别名、声明签名和声明文件中的类型单独统计，作为可读取的类型上下文，不当作可执行函数。测试文件的单元 role 为 `verification`；其他可执行源码为 `product`。

package.json、tsconfig/jsconfig（含项目内 extends）、工作区及常见构建配置属于 context。配置不执行，不计函数分析，但交付需完整读取。项目的 compilerOptions 用于静态符号解析，未纳入清单的外部解析配置、包或库不会被额外读取。

Python、Go 和 C／C++ 使用随包的 Tree-sitter WASM 解析；Python ast、Go packages／SSA、Clang 编译数据库和可选 LibTooling 补充语义依据，能力及限制见 [FLOW.md](FLOW.md)。类型、类字段及导入声明作为非函数上下文读取；`.pyi` 是类型上下文，不冒充可执行函数。

损坏的 JSON／JSONC、JS／TS 配置、源码语法、非 UTF-8 读取、缺少语义工具或编译参数以及识别出的其他未支持语言会生成 gaps。YAML／TOML 配置作为文字上下文读取，不承诺语法校验。

## 快照与会话

快照哈希绑定规范化项目路径、声明范围、分析协议、解析器及索引规则版本、语法内容、可选语义工具配置、源码／类型／上下文／非支持语言清单及实际内容。Git HEAD 只是补充。未纳入上下文的非源码文档或图片变化不使源码凭据失效；新源码、删除源码、内容及解析配置变化都会使旧会话失效。生成的产品书和分析产物排除在快照之外。

相同快照复用同一会话，但先执行当前版本的 `analysis check`；只有读取、记录及逐位置审阅均有效的记录才可复用，不能只看 recordedCount。旧的浅摘要需重新对照源码补充，不能批量生成空数组或套话。索引算法升级也要求重新扫描，避免恢复旧的符号关系与审阅规则。新快照有独立目录和记录。调用编号同时绑定单元及完整 [start,end) 位置，链式调用即使起点相同也不共享编号；语义工具和运行探针按相同完整位置关联，不凭名字或最短范围猜配。

新会话位于 `项目/.blueprint-analysis/s-哈希/`：小型 `state.json` 描述不可变索引，`state.sqlite` 按行保存索引和可变记录。先读取索引头，正文/详细位置与记录按需加载；更新只在事务内保存变动行。不可变头由描述指纹绑定，正文读取时核对哈希；并发版本变化拒绝覆盖。保留整个会话目录，不能只移动描述文件。旧 JSON 与 `.events.jsonl` 会话继续使用原读写协议，不自动改写用户历史。哈希是本机一致性检查，不提供同权限攻击者下的独立认证。

相同快照恢复直接打开现有索引。源码改变后会建立新快照，机器索引目前仍重建；工具按导入/调用的反向依赖闭包筛选可复用的逐函数分析。仅完整读取、摘要与位置说明合格，且源码、位置、依赖、规则和上下文未变的记录可迁移，生成带旧会话/凭据出处的新绑定。受影响文件、全局/动态边界及 Go/C++ 未细分依赖保守扩大失效；旧浅记录不迁移。`analysis scan` 返回 reuse 与 indexRebuilt。业务地图、trace、流程和验收记录不继承，不由缓存冒充新业务审阅或本轮 AI 已重新阅读全文。

开发微基准使用 `scripts/benchmark-analysis.mjs`，分别记录存储按需读取、冷扫描、相同快照恢复和小修改。它不运行模型，不能作为实际大型项目初始化耗时承诺。

写入使用 Node 内置 SQLite 的本机进程锁协调，并保留兼容锁文件；只恢复可确认 PID 已退出的锁，活锁、异地主机或无法辨认的锁不删除。进程退出自动释放协调锁，多进程恢复时不会互相删掉新锁。分析模式保存文档时保持会话锁，提交前再次核验源码。外部编辑器不获取工具锁；出现冲突应重新读取，不能改哈希强行重试。

## 分页与分段读取

`analysis list --session SESSION --kind units|contexts|files|types|traces --status all|pending|recorded --offset 0 --limit 50`。默认 units，limit 为 1–200，返回 nextOffset。status 只过滤 units。units 包含作用域、文件、范围、内容指纹、role 和静态 calls；contexts 包含配置和类型的读取编号。类型不是 record 单元。

units 同时返回 `reviewPoints`：参数、返回、条件／循环／短路、调用、赋值／删除、throw／catch／finally 等可见语法位置，含 id、field、UTF-16 范围、行列与代码摘要。嵌套函数的位置只属于其自身记录，不重复计入父函数。类型签名不冒充可执行参数。写入位置可能只是局部变量变化，需要解释实际影响，不能仅凭语法认定有外部副作用。

pending 包括未记录或逐位置审阅不合格的单元。处理后集合会缩小，因此每轮从 offset 0 获取剩余项；只读不改变集合时用 nextOffset 分页。不要在变化的 pending 列表上持续递增 offset。

`analysis read ID --session SESSION [--offset 0] [--length 16000]` 返回 code、receipt 和 nextOffset。offset 相对单元起点，默认 length 16000，最大 100000。源码偏移为 **UTF-16 单位**、范围为 `[start,end)`、展示行列为 **1-based**。分段不会切开 Unicode 代理对；非法起点被拒绝。跟随 nextOffset 到 null 才是读完。

`analysis read --session SESSION --input reads.json` 接受 `{"reads":[{"id":"单元编号","offset":0,"length":16000}]}`，每批 1–32 项、总源码不超过 262144 个 UTF-16 单位，返回 items；任一项无效整批不保存凭据。读取和记录采用批次、同一会话由一个写入者协调，可减少进程启动、索引校验和反复解析开销；独立分析质量要求保持不变。

receipt.id 由工具生成，含快照、文件、源码和片段内容指纹；新凭据还保存实际生成时间 createdAt。它证明工具返回过这些内容，不能证明 AI 理解正确。record 的 receiptIds 可以来自多个分段，也可来自包含该嵌套单元完整主体的父函数／顶层单元。覆盖必须没有缺口；每个嵌套函数仍需独立 record 和自己的位置说明。配置／类型上下文读取不计函数记录。

## 函数分析记录

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
    "unknowns": [],
    "claims": [{
      "pointIds": ["从当前单元 reviewPoints 获取的实际编号"],
      "detail": "解释该位置的具体行为、分支结果或失败影响；同一真实语义可关联多个因果相关位置，每个 reviewPoint 恰好覆盖一次。"
    }]
  }]
}
```

八项分析必须明确：responsibility 为非空职责说明，其余七项使用文字数组，无相应行为时用 `[]`。推荐 claims 对因果相关位置合并解释，不重复抄写参数与调用；所有位置仍恰好关联一次，不得缺失、重复、使用其他函数的位置、只复制代码或提交通用套话；位置对应的 field 不能留空。确实没有位置的空函数可提交 claims:[]（旧 coverage 仍可用），不要求伪造调用和异常。工具返回 recordHash，用于 trace 引用；摘要和位置说明均参与哈希，修改后旧依据失效。

位置清单只检查静态可见行为是否被明确处理，不能证明自然语言解释正确，也不穷尽运行时路径。工具拒绝已识别的机械模板及仅加“调用／返回”等前缀的源码复制；这只是质量底线，不能证明任意自然语言说明正确。AI 仍需读完整函数体，核对闭包输入、调用后果、异步边界、异常传播、部分成功、并发与清理。不得用脚本把源码片段自动包成解释、把整份函数摘要重复到每个位置或捏造无异常／无副作用来凑齐计数。相关 Skill、HTML/CSS 及其他非函数材料要另外读取，函数覆盖率不代表这些材料已读。

unresolvedCalls 另外保留索引中未知的外部／动态调用；函数名称不构成调用证据。直接函数、不可变别名、静态命名／命名空间导入及显式构造器可报告 `resolved`；参数回调、可变或重新赋值的绑定、接收者方法分派、框架注册关系保留 `unknown`。candidateTargets 仅表示类型声明提供的候选，不能当作已确认执行目标；本版对方法调用采用保守处理。

## 业务字段依据

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

每个业务步骤、规则、异常及其他变更字段分别用最终叶子字段 JSON Pointer 和值绑定。相同 id 替换现存依据，不保存该依据的旧版本；需要保留独立来源时使用不同 id。数组索引是当前最终文档的位置；重排后重新绑定。删除用 `value: null`，清空数组或文字用实际空值绑定。

| classification | 含义与要求                                     |
| -------------- | ---------------------------------------------- |
| `observed`     | 代码已有行为，必须提供 code 依据               |
| `requested`    | 用户期望行为，必须提供 requirement 依据        |
| `inferred`     | 分析推断，必须用 note 解释并在文档中标注       |
| `unknown`      | 无法确认的内容，必须用 note 解释并在文档中标注 |

需求依据为 `{"kind":"requirement","source":"user"或"document","text":"原文"}`。推断／未知只能写到功能 notes，原文以 `[推断]`／`[未知]`（也支持 `[inferred]`／`[unknown]`、`[待确认]`）明确标注；不能支持已确认规则、步骤或完成。功能 notes 的推断／未知可带 `completionImpact: blocking|informational`，省略为 blocking；只有不影响当前已核验业务定义的边界说明可标 informational，note 说明理由，原未知标记保留。它不能用于其他业务字段或替代 observed 完成依据；影响业务或验收的未知继续阻止完成。工具核验来源结构，不证明需求确实由用户说过，AI 必须遵循实际对话授权。

## 检查与草稿交付

`analysis check --session SESSION --json` 核验快照、每个单元的记录／完整读取／逐位置说明、配置／类型上下文读取，以及已有 trace 来源。`recordedCount` 只表示有存储记录；`reviewedCount` 表示记录、读取及位置审阅全部有效的单元数，另返回 reviewPointCount 和 reviewedPointCount。缺项返回 `valid:false`、带文件／位置的 gaps 及非零退出码；质量缺口 kind 为 review。同一检查也用于严格保存、完成登记和最终交付；旧浅摘要不能绑定有效 observed 依据。检查不根据业务文档猜测功能边界；位置齐全也不等于理解正确，未解析动态关系留在报告及记录中。

`apply` 和所有现有 feature 写命令可以加 `--analysis-session SESSION`。工具在当前文档哈希保护下合并整批变更，核对最终变更字段与有效 trace 的内容指纹。sync／complete 还核验当前定义、步骤、规则、异常、验收和依赖依据：

```sh
product-blueprint apply /文档 --input 批次.json --analysis-session /会话目录 --dry-run --json
product-blueprint apply /文档 --input 批次.json --analysis-session /会话目录 --json
```

先 dry-run 校验，再提交同一批次。首次初始化不等待内容确认，默认直接交付产品书与 HTML，按实际核验结果区分完成和草稿；已有定义由用户在页面修改保存，实现 Skill 处理所选待办。用户明确只要预览时不提交。检查失败默认不保存，先补齐可解决的读取、记录和依据缺项。

`--allow-partial-analysis` 只能和 `--analysis-session` 一起使用，允许草稿缺口交付，返回 analysis.gaps。首次初始化仍有无法消除的分析缺口时，可以直接交付明确标注缺口的草稿，并报告范围；已有蓝图仅处理用户选定范围。源码过期不能豁免，未知不得写成事实。该模式不允许任何 complete 操作，也不能更新仍为完成状态的功能。未参与批次的既有完成功能保持原状。

## 完成登记

分析模式完成登记需要此功能的当前 `product` 源码已有行为依据，定义、步骤、规则、异常等当前字段的 observed 依据，以及完整分析、同步流程和对应当前版本的有效验收记录。requested 只说明期望，不能直接支持完成。纯需求新项目、测试源码本身或未知／推断不能登记完成。静态分析不执行测试；显式 `verification run` 执行调用方提供的验收命令并保留结果。严格完成带 `--require-verification`，完整交付再用 `document check` 检查；协议及兼容说明见 [DOCUMENT.md](DOCUMENT.md)。

仅同步／完成的独立批次可由工具根据 observed 产品源码及其静态可达调用确定核验范围。只有剩余缺口全部是该范围之外的语言／语义／适配能力限制，且本功能有当前有效执行记录时，才允许独立登记完成；漏读、漏记录、缺少字段依据不能豁免。返回 `independentCompletion:true` 并保留整体分析缺口，不代表 `document check` 严格通过，也不能通过 `--allow-partial-analysis` 绕过完成门禁。

不带 `--analysis-session` 的手工维护命令遵循 [DOCUMENT.md](DOCUMENT.md) 的版本与验收规则。初始化既有项目可以在保存定义后，实际核验已有实现，并通过独立后续批次同步流程与登记完成；纯需求新项目保留草稿。宿主／动态调用的未解析项保留在分析报告，有效 observed 依据与实际核验仍须对应当前功能，不自动将全部功能降为草稿。分析进度留在会话报告，实现状态通过 feature assess 区分完成、带具体未实现项的草稿及待确认；运行证据独立，不添加固定 HTML 页脚或 AI 控件。

## 错误与恢复

| 错误码                | 原因                                 | 退出码 |
| --------------------- | ------------------------------------ | ------ |
| `INVALID_ARGUMENT`    | 参数或输入错误                       | 2      |
| `VALIDATION_FAILED`   | 结构或依据错误                       | 1      |
| `CONFLICT`            | 文件锁或文档哈希冲突                 | 3      |
| `ANALYSIS_STALE`      | 源码、配置或索引版本过期，需重新扫描 | 3      |
| `ANALYSIS_INCOMPLETE` | 读取、记录、依据或交付缺口           | 1      |
| `RENDER_FAILED`       | 文档已保存但 HTML 生成失败           | 4      |

文档已保存但 HTML 更新失败时，单独运行 `render` 恢复，不要重复提交已保存操作。详细保存与恢复规则见 [DOCUMENT.md](DOCUMENT.md)。

## 蓝图验收源码基线

在分析会话下执行 `feature.complete`／完成批次时，工具自动将该快照及范围、文件清单保存到 `implementation.sourceSnapshot`，提交前仍比较源码指纹。`document status` 只读比较当前清单与各功能基线，既有已完成功能没有草稿或批注也可能有源码变化。它只识别文件和索引配置变化，不判断业务影响或实际运行验收；AI 需读取当前范围并对照定义、流程、异常和验收。新 Git 提交仅作辅助，未提交修改同样检查；仅 Git 元数据变化且内容一致不判为源码变化。

旧验收记录缺少基线时不能证明当前源码一致，路径不可访问或有读取缺口时报告未核验。基线覆盖现有扫描清单中的源码、类型、上下文及已识别的非支持语言文件；排除项与清单外资源保持明确范围限制。源码变化不会自行改定义版本或清空完成历史。业务不变时实际核验后可刷新同版本基线，业务变化时先保存新定义再验证，不把旧依据用于新源码。

业务流程机器核验、分析协议 v2、多语言能力边界、临时副本探针与部分交付详见 [FLOW.md](FLOW.md)。旧执行记录仍可阅读，缺少流程证据时不得称为新协议严格通过；功能完成历史不被自动改写。

## 分层运行与分析完整性

分层验收不会降低读取与逐位置分析要求。运行前用 verification plan 保存业务步骤范围，命令协议见 FLOW.md；方案保存于分析会话 verificationPlans 集合，绑定定义、源码和核验规则。source 只能说明源码，组件／契约执行不能替代端到端观测。delivery v5 依据声明范围判断，遗漏分析、字段依据和未执行场景仍阻止交付；真实语言／环境限制单独保留，不因其他功能缺口自动抹掉独立验收历史。

源码审阅使用去除引用源码、文件名、标识符及通用过程措辞后的说明检查，拒绝换一套前缀的源码复述；它仍只是质量底线。scan／check 的 scopeCoverage 独立列明被 include/exclude 过滤的自有源码。最终交付检查不允许仅凭范围内 valid 隐去遗漏。

工作流字段可用 `{kind:"context",contextId:"实际编号",quote:"原文"}` 作为 observed 依据，必须是扫描器识别的工作流入口且完整读取、原文匹配；普通 README 或配置不能这样冒充实现。该来源证明指令存在，运行结果仍另行核验。

当前索引规则增加跨记录的解释形状检查，配合逐位置质量检查使用。将读取正文丢弃、按函数名或语法位置生成模板不能视为 AI 已理解源码；读取凭据和质量门禁只证明声明范围内的工具检查，不证明任意自然语言解释正确。旧规则的快照不可直接复用。

## 初始化与运行核验分开

初始化保留完整源码读取、逐函数分析、来源、操作和业务审阅，使用 document check --mode source 交付产品书。source 不要求 verification plan 或运行场景；完成表示代码已实现，运行状态另列。核验 Skill 可独立选择单个/全部功能；实现 Skill 只处理页面已保存的所选修改并复用核验。全书运行验收交付使用 mode verified。

business coverage 协议为 2。coverageValid 仅表示操作和源码连接等结构成立，valid 还要求能力与排除项审阅完成。公开操作不可凭“支撑”排除，support 需 capabilityIds 和真实结果连接；候选假阳性显式标 false-positive，明确声明不能如此排除。读取、分析和审阅分别检查，批量模板理由不能消除缺口。
