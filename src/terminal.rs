use crate::{model::*, platform};
use std::process::Stdio;

const SNAPSHOT_ENV: &str = "SCRIPT_STUDIO_TERMINAL_SNAPSHOT";

// The helper uses the same structured argv as managed runs. Script paths and
// arguments never pass through PowerShell's command parser.
pub fn run() -> Result<i32> {
    let snapshot = std::env::var(SNAPSHOT_ENV).map_err(|_| "缺少外部终端启动配置。")?;
    let script: Script = serde_json::from_str(&snapshot).map_err(|e| e.to_string())?;
    Config {
        version: 1,
        groups: vec![],
        scripts: vec![Script {
            group_id: None,
            ..script.clone()
        }],
    }
    .validate()?;
    let status = platform::command(&script)?
        .env_remove(SNAPSHOT_ENV)
        .envs(&script.env)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|e| format!("无法启动，请检查解释器与文件路径：{e}"))?;
    let code = status.code().unwrap_or(1);
    println!("\n脚本已结束，退出码 {code}。可继续使用此终端。");
    Ok(code)
}

#[cfg(windows)]
pub fn open(script: &Script) -> Result<()> {
    use std::{mem::size_of, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
    // Validate paths and CMD arguments before opening a window.
    platform::command(script)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let invocation = format!(
        "try {{ & '{}' terminal-run }} finally {{ Remove-Item Env:{SNAPSHOT_ENV} -ErrorAction SilentlyContinue }}",
        exe.to_string_lossy().replace('\'', "''")
    );
    let cwd = script
        .cwd
        .as_deref()
        .unwrap_or_else(|| script.path.parent().unwrap());
    let mut command: Vec<u16> = format!("powershell.exe -NoProfile -NoExit -Command {invocation}")
        .encode_utf16()
        .chain([0])
        .collect();
    let cwd: Vec<u16> = cwd.as_os_str().encode_wide().chain([0]).collect();
    let mut env: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case(SNAPSHOT_ENV))
        .collect();
    env.push((
        SNAPSHOT_ENV.into(),
        serde_json::to_string(script)
            .map_err(|e| e.to_string())?
            .into(),
    ));
    env.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::<u16>::new();
    for (key, value) in env {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    // STARTF_USESTDHANDLES stays unset: Windows attaches fresh console handles
    // instead of inheriting the backend's authenticated stdio pipes.
    unsafe {
        let startup = STARTUPINFOW {
            cb: size_of::<STARTUPINFOW>() as u32,
            ..std::mem::zeroed()
        };
        let mut process: PROCESS_INFORMATION = std::mem::zeroed();
        if CreateProcessW(
            std::ptr::null(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
            block.as_ptr().cast(),
            cwd.as_ptr(),
            &startup,
            &mut process,
        ) == 0
        {
            return Err(format!(
                "无法打开外部 PowerShell 终端：{}",
                std::io::Error::last_os_error()
            ));
        }
        // These processes are external; closing handles does not stop them.
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn open(_: &Script) -> Result<()> {
    Err("外部终端启动目前仅支持 Windows。".into())
}
