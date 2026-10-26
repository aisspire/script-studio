# Script Studio 开发约定

- Windows 本地脚本工具，保留独立运行方式；Rust 后台负责执行与存储，Vue 页面负责展示。
- 先阅读 README.md、docs/design.md 和 docs/implementation.md；设计要求、实现与验证结果分别记录。
- 本目录是独立 Git 仓库，不是 Oriel 子模块；执行 Git 操作前核对根目录。不自动提交、推送或发布。
- 每次开发结束提供覆盖相关未提交改动的中文 Conventional Commit 草稿。
- 不运行 sudo、系统包安装、全局安装或修改全局配置；缺少工具只报告。使用现有版本和锁文件，不擅自升级依赖。
- 实际进程句柄及 Job Object 决定托管归属；不按历史 PID 或进程名清理外部程序。
- 同脚本单实例，不同脚本可并发。切换页面继续执行，完整退出停止本实例托管的 Windows 进程树。
- WSL 通过 Windows 包装脚本调用；不声称 Windows Job Object 保证清理 Linux 后台任务。
- 测试使用隔离目录和无副作用的 fixture，不运行用户真实脚本。运行配置、历史、日志和实例凭证不提交。
- 界面保持紧凑，支持浅深主题、键盘与窄窗；运行日志不是交互终端。
