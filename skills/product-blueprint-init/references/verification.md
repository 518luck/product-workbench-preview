# 初始化检查与打开页面

初始化使用源码交付模式，与运行核验分开。先完成当前范围的 analysis check、业务地图绑定与逐项审阅、feature assess、图表取舍和 HTML。recordedCount 齐全不表示 reviewedCount 合格，资源存在不表示功能实现。

保存 delivery-review.json（v5）绑定最终 documentHash，逐功能记录当前 revision、实现状态、具体未实现项、规则/依赖关联及图表适用性，acceptance 使用空数组，不制造运行凭据。

由 AI 执行 `document check BOOK --mode source --analysis-session SESSION --input BOOK/delivery-review.json --json`，保留原始输出和退出码在 WORK。检查 mode 必须为 source；只有当前 `completion.canDeliver:true` 才继续打开页面。`claim:product-book-generated` 只表示产品书生成检查通过，不表示运行验收通过。

如果 canDeliver:false，按 nextAction 与 blockers 继续补齐遗漏。不得为了成功版式、服务已启动、feature assess 显示完成、business record 已保存或取得 executionId 而停止。源码/定义变化后重新检查。真实能力限制只有工具允许的 partial 才可交付，并在产品书明确展示范围。

初始化不调用 verification run、不强制 verification plan、flow sync 或全系统联调。用户要求后续核验时进入 product-blueprint-verify，选择范围；已明确范围时直接传入。运行验收与实现状态保持分离。

## 启动可编辑页面

生成产品书及运行 `render` 不会自动启动服务。完整初始化默认包含启动本机编辑服务，无须用户再复制命令；只预览或用户明确要求静态交付时遵循其要求。

1. 使用当前已核对协议的 CLI，通过宿主支持的持久进程／后台任务运行以下命令。传入本次生成文档的绝对目录或 JSON 路径；在工具源码仓库可使用等价的 `pnpm blueprint serve`。

   ```sh
   product-blueprint serve /本次产品书的绝对目录 --port 0 --json
   ```

2. `--port 0` 让系统选择空闲端口；等待启动成功，读取输出的 `url` 和 `document`。不要拼接默认端口、复用其他项目地址或终止用户已有服务。已有服务只有确认仍在运行且指向同一文档时才复用。
3. 访问实际 `url` 的 `/document/capabilities`，确认 `canSave:true` 且 `documentPath` 指向本次权威产品 JSON，并确认首页正常返回。保存能力核对使用只读请求，不向用户文档写测试数据。
4. 用宿主可用的浏览器或页面打开能力打开该 `url`，已有同一网址的页面可复用，确认页面支持保存定义和批注。直接打开 `index.html` 是只读快照，不能替代此步骤。
5. 交付文字为“打开产品书（可编辑、可保存）”的 Markdown 链接，目标使用实际 `url`，并保持服务任务运行；不要在交付前清理它。服务退出后链接会失效，无法持续运行时说明这一限制，不声称编辑入口可用。

服务启动、能力核对或浏览器打开失败时，按 SKILL.md 分别说明实际结果；保留已生成文件，修复服务问题无需重新初始化。仅在用户要求静态交付或编辑服务暂不可用时提供绝对路径的只读 HTML 备用链接。

## 恢复与结束

核对当前 source 检查、业务地图及服务。成功且仍有效时结束同一初始化任务，不为结束任务另起目标或重跑初始化。未完成时保存进度继续处理，不使用成功回复。服务保留运行。
