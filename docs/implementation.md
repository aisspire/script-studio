# 实现契约 v1

## 存储与身份

默认 Windows 数据目录 `%LOCALAPPDATA%\ScriptStudio`；`--data-dir` 需要绝对路径。数据目录锁使同一配置只运行一个后台，复用前核验版本、回环地址和实例身份。实例描述包含随机 token，只保存在本地实例文件和启动结果中。

配置版本 1 包含 groups 与 scripts。分组与脚本采用 UUID，身份与名称分离。保存先验证引用、字段及数量，再核对原文件内容的 SHA-256 revision，原子替换后更新内存。文件最大 2 MiB；无法读取、未知版本或配置损坏时保留原文件并阻止保存和新运行，已有任务仍可停止。

脚本字段：id、name、description、path、groupId、favorite、runner、program、interpreterArgs、args、cwd、env、encoding。path/cwd 使用绝对路径；cwd 空值取脚本父目录。自定义解释器命令为 program、interpreterArgs、path、args。解释器是否存在及脚本是否可执行在运行时检查。

runs 中每次运行独立存储 JSON 快照和 JSONL 输出。状态为 running、stopping、succeeded、failed、stopped、interrupted；时间采用 Unix 毫秒。后台恢复将活动记录标记为 interrupted，保留诊断，不恢复进程、不重跑脚本。快照接口只发送运行摘要；完整启动配置保留在运行文件。

## 私有 HTTP 接口

只监听随机 IPv4 回环端口。POST /api 校验精确 Host、同来源或无 Origin 及实例 Bearer 身份，不提供 CORS。页面从 fragment 读取 token 后移入 sessionStorage 并清除 fragment。静态资源只在 dist 内查找，拒绝越界、隐藏文件及符号链接逃逸；文档与输出只作为文本显示。

请求使用 `{action,...}`，结果为 `{ok:true,value}` 或 `{ok:false,error}`。

| 动作 | 输入及结果 |
| --- | --- |
| status | 紧凑就绪信息：instance、ready、closing、activeRuns |
| snapshot | 配置、revision、可写诊断、数据目录、运行摘要、警告 |
| reload | 显式重新读配置，不启动或重启任务 |
| save | config、revision；原子保存后返回 snapshot |
| file.pick | 后台打开一个 Windows 文件选择器，返回 path 或 null；退出取消辅助进程 |
| run.start | scriptId；只运行已保存配置，返回 runId |
| run.stop | runId；幂等停止本运行的进程树 |
| run.logs | runId、cursor（JSONL 字节偏移）；返回 chunks、下一 cursor、truncated |
| shutdown | 拒绝新运行、清理任务、持久化结果并退出 |

每次日志查询读取约 128 KiB 完整记录，客户端按游标增量获取。stdout/stderr 独立流式读取，UTF-8 解码跨块保留残字节；系统编码采用 Windows OEM 代码页。内存输出通道有界，达到磁盘日志上限后继续排空，不把输出背压当成取消机制。

## 进程与退出

Windows 挂起启动，加入启用 KILL_ON_JOB_CLOSE 的 Job 后恢复，失败时取消启动。每个运行独立持有 Job 与进程句柄；根进程退出码和 Job 内存活进程分别判断。停止确认进程树清空后才移除活动登记，不根据持久化 PID、进程名或端口接管外部进程。

CMD 的路径和参数通过专用环境值一次展开，禁用延迟展开，含双引号或换行参数明确拒绝。其他解释器使用结构化参数传递。PowerShell 执行策略参数仅作用于当前进程。

## Oriel stdio-v1

随包 oriel.ps1 前台运行 `serve --oriel-stdio`，保留 stdin/stdout。首行 `{protocol:1,version,ready:true,instance,origin,token,pageUrl}`，随后每行一个 JSON 动作与结果信封。stdout 不混入脚本输出或诊断；日志写入运行记录，诊断使用 stderr。

stdin EOF 独立触发清理，正在执行的业务动作不阻止退出请求。宿主通过已认证的 POST /api shutdown 退出；已有实例接入核验后桥接到同一接口。完全退出清理该实例所有托管任务；不提供多宿主共享仲裁。

## 构建和检查

精确依赖版本沿用既有工作区技术版本，独立维护 Cargo.lock 和 package-lock.json。build.ps1 默认 Release，提供 DebugBuild、Offline、SkipFrontend；生成完整相对路径目录包。验证入口和实际结果见 README.md 与 verification.md。
