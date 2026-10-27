# Script Studio

Windows 本地脚本管理器。分组、收藏、配置和运行历史由独立工具保存，通过本地网页使用，也可作为 Oriel 额外插件展示。Rust 后台托管执行，Vue 3 页面采用浅深主题。

## 构建与运行

使用已安装的 Windows Rust、Node.js 22.12+ 和 npm，依赖版本见 manifest 与 lockfile。

```powershell
npm ci --include=optional
.\build.cmd
.\release\ScriptStudio-0.1.0-windows\Open-ScriptStudio.cmd
```

打包脚本不安装系统工具、不修改全局执行策略。默认构建 Release；`-DebugBuild` 选择调试程序，`-Offline` 使用 Cargo 本地缓存。已有刚构建的前端产物时可用 `-SkipFrontend`。产物是完整目录包，应整体移动。

后台命令：

```powershell
.\script-studio.exe serve --open
.\script-studio.exe serve --data-dir C:\Temp\ScriptStudio-test --open
.\script-studio.exe request --data-dir C:\Temp\ScriptStudio-test --json '{"action":"status"}'
```

`serve` 保持前台运行，`--open` 打开系统浏览器。只启动后台时 stdout 首行返回实例描述；需要重新打开时再次执行 `serve --open`，核验并复用同一数据目录的实例。PowerShell 5 对原生命令 JSON 引号的转交存在版本差异，自动调用优先使用受认证的 HTTP 或 stdio 接口。

## 接入 Oriel

将完整目录包放入工作台设置显示的默认插件读取目录，或配置额外读取目录，然后“重新加载接入”。通过既有 `stdio-v1` 和应用展示布局接入，无需修改宿主路由或重新编译宿主。

扫描不会启动后台，显式打开才启动；切换页面不停止任务。完整退出 Oriel 会清理已接入实例的全部托管 Windows 脚本，包括该实例其他页面启动的任务。独立使用时关闭页面继续运行，通过设置的“退出后台”或 Ctrl+C 完整退出。

## 验证

```powershell
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
$env:CARGO_TARGET_DIR = "$PWD\target\windows"
cargo build --locked
npm run build
npm run test:runtime
npm run test:commands
npm run test:terminal
npm run test:ui
npm run test:layout
npm run test:bundle
```

`test:runtime` 只运行生成的隔离 fixture，Windows 下覆盖 Job Object、PowerShell、CMD 和可用 WSL；`test:commands` 在已有 Windows PowerShell 中实际执行复制命令的隔离 fixture，检查路径及参数转交；`test:ui` 使用已有 Edge 的独立测试 Profile，不安装浏览器；`test:bundle` 检查目录包移动及 PowerShell 包装入口。测试数据及截图位于本仓库 target 下。可用 `SCRIPT_STUDIO_BIN`、`SCRIPT_STUDIO_EDGE`、`SCRIPT_STUDIO_BUNDLE` 指定已构建产物。

Windows 与 WSL 使用各自的 node_modules。共享工作区缺少 Linux 原生绑定时，在临时目录复制当前源码、manifest 和 lockfile，运行 `npm ci --offline --include=optional`、`npm run build`；缓存不完整时仅在临时目录按相同锁文件获取依赖，不改写工作区依赖。

`test:layout` 可在 Windows 或 Linux 运行，检查面板尺寸与键盘边界，以及隔离后台重启、端口变化后的偏好恢复和无效文件保护；需先构建本平台后台。实际网格布局、拖拽与窄窗交互由 Windows `test:ui` 检查。

## 文档

- [使用说明](USER_GUIDE.md)：运行配置、停止范围、WSL 包装与故障恢复。
- [设计基线](docs/design.md)：首版产品行为与边界。
- [实现契约](docs/implementation.md)：存储、HTTP、stdio 及执行器。
- [验证记录](verification.md)：本轮实际结果及缺口。

`test:terminal` 使用生成的隔离脚本验证外部终端的参数、工作目录、环境变量、控制台句柄及退出归属，结束后清理本次创建的测试进程。

首版面向 Windows；Linux 构建仅用于隔离验证共享逻辑，不作为跨平台交付承诺。Ctrl 点击运行支持外部 PowerShell 终端；脚本正文编辑、定时调度和内嵌交互终端留待后续需求。
