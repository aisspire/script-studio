use crate::model::*;

#[cfg(any(windows, test))]
const SNAPSHOT_ENV: &str = "SCRIPT_STUDIO_TERMINAL_SNAPSHOT";
#[cfg(any(windows, test))]
const BOOTSTRAP: &str = include_str!("terminal-bootstrap.ps1");

#[cfg(any(windows, test))]
fn snapshot(launch: &crate::platform::Launch, program: Result<String>) -> Result<String> {
    let (program, error) = match program {
        Ok(program) => (program, None),
        Err(error) => (String::new(), Some(error)),
    };
    let arguments = launch.native_arguments();
    if program.encode_utf16().count() + arguments.encode_utf16().count() + 4 > 32767 {
        return Err("启动命令超出 Windows 长度限制，请减少参数。".into());
    }
    // Windows environment keys are case-insensitive; PowerShell 5.1 JSON cannot
    // deserialize keys differing only by case. Preserve Command::envs' last value.
    let env: std::collections::BTreeMap<_, _> = launch
        .env
        .iter()
        .map(|(key, value)| (key.to_ascii_uppercase(), value))
        .collect();
    let value = serde_json::to_string(&serde_json::json!({
        "program": program, "arguments": arguments, "cwd": launch.cwd,
        "env": env, "error": error,
    }))
    .map_err(|e| e.to_string())?;
    if value.encode_utf16().count() >= 32767 {
        return Err("外部终端启动配置超出环境变量长度限制，请减少参数或环境变量。".into());
    }
    Ok(value)
}

#[cfg(windows)]
fn system_directory(windows: bool) -> Result<std::path::PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows_sys::Win32::System::SystemInformation::{
        GetSystemDirectoryW, GetWindowsDirectoryW,
    };
    let mut buffer = vec![0u16; 32768];
    let len = unsafe {
        if windows {
            GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
        } else {
            GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
        }
    } as usize;
    if len == 0 || len >= buffer.len() {
        return Err(format!(
            "无法读取 Windows 系统目录：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(OsString::from_wide(&buffer[..len]).into())
}

#[cfg(windows)]
fn resolve_program(launch: &crate::platform::Launch) -> Result<String> {
    use std::path::{Path, PathBuf};
    let program = Path::new(&launch.program);
    let absolute = |path: PathBuf| {
        let path = if path.is_absolute() {
            path
        } else {
            launch.cwd.join(path)
        };
        path.is_file().then(|| path.to_string_lossy().into_owned())
    };
    // Match Rust's executable search: explicit child PATH, application directory,
    // system directories, parent PATH. Never resolve PowerShell aliases/functions.
    let resolved = if program.file_name() != Some(program.as_os_str()) {
        let with_exe = PathBuf::from(format!("{}.exe", launch.program));
        if program
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            absolute(program.into())
        } else {
            absolute(with_exe).or_else(|| absolute(program.into()))
        }
    } else {
        let mut directories = vec![];
        if let Some((_, path)) = launch
            .env
            .iter()
            .rev()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        {
            directories.extend(std::env::split_paths(path));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                directories.push(dir.into());
            }
        }
        directories.push(system_directory(false)?);
        directories.push(system_directory(true)?);
        if let Some(path) = std::env::var_os("PATH") {
            directories.extend(std::env::split_paths(&path));
        }
        let name = if program.extension().is_none() {
            format!("{}.exe", launch.program)
        } else {
            launch.program.clone()
        };
        directories
            .into_iter()
            .filter(|dir| !dir.as_os_str().is_empty())
            .find_map(|dir| absolute(dir.join(&name)))
    };
    resolved.ok_or_else(|| {
        format!(
            "找不到解释器或程序：{}。请检查程序路径及 PATH。",
            launch.program
        )
    })
}

#[cfg(windows)]
pub fn open(script: &Script) -> Result<()> {
    use std::{mem::size_of, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
    let launch = crate::platform::launch(script)?;
    let snapshot = snapshot(&launch, resolve_program(&launch))?;
    let shell = system_directory(false)?.join("WindowsPowerShell/v1.0/powershell.exe");
    // The script is embedded and fixed. All user values travel only in JSON.
    // No installed executable or script is needed after this console is created.
    let mut command: Vec<u16> = format!(
        "\"{}\" -NoProfile -NoExit -Command \"& {{ {} }}\"",
        shell.display(),
        BOOTSTRAP
    )
    .encode_utf16()
    .chain([0])
    .collect();
    let cwd: Vec<u16> = launch.cwd.as_os_str().encode_wide().chain([0]).collect();
    let mut env: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case(SNAPSHOT_ENV))
        .collect();
    env.push((SNAPSHOT_ENV.into(), snapshot.into()));
    env.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::<u16>::new();
    for (key, value) in env {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    // STARTF_USESTDHANDLES stays unset and backend handles are not inherited.
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
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn open(_: &Script) -> Result<()> {
    Err("外部终端启动目前仅支持 Windows。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::launch;
    fn fixture() -> Script {
        Script {
            id: id(),
            name: "终端".into(),
            description: String::new(),
            path: std::env::current_exe().unwrap(),
            group_id: None,
            favorite: false,
            runner: Runner::Direct,
            program: String::new(),
            interpreter_args: vec![],
            args: vec![],
            cwd: None,
            env: Default::default(),
            encoding: Encoding::Utf8,
        }
    }
    #[test]
    fn snapshot_preserves_data_and_reports_missing_program_without_leaking_config() {
        let mut script = fixture();
        script.args = vec!["".into(), "a\"b".into(), "中文 &|<>%!^'$()".into()];
        script.env.insert("VALUE".into(), "saved\nvalue".into());
        let launch = launch(&script).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&snapshot(&launch, Ok("program.exe".into())).unwrap()).unwrap();
        assert_eq!(value["program"], "program.exe");
        assert_eq!(value["env"]["VALUE"], "saved\nvalue");
        assert_eq!(value["arguments"], launch.native_arguments());
        assert!(value.get("id").is_none());
        let value: serde_json::Value =
            serde_json::from_str(&snapshot(&launch, Err("missing".into())).unwrap()).unwrap();
        assert_eq!(value["error"], "missing");
    }
    #[test]
    fn oversized_launch_is_rejected_before_opening_console() {
        let mut script = fixture();
        script.args.push("x".repeat(32767));
        assert!(snapshot(&launch(&script).unwrap(), Ok("program.exe".into())).is_err());
        script.args.clear();
        script.env.insert("LARGE".into(), "中".repeat(32767));
        assert!(snapshot(&launch(&script).unwrap(), Ok("program.exe".into())).is_err());
    }
    #[test]
    fn snapshot_merges_windows_environment_keys_before_json_transfer() {
        let mut script = fixture();
        script.env.insert("PATH".into(), "first".into());
        script.env.insert("Path".into(), "last".into());
        let launch = launch(&script).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&snapshot(&launch, Ok("program.exe".into())).unwrap()).unwrap();
        assert_eq!(value["env"].as_object().unwrap().len(), 1);
        assert_eq!(value["env"]["PATH"], "last");
    }
    #[test]
    fn embedded_bootstrap_has_no_installation_dependency_or_command_line_quotes() {
        assert!(!BOOTSTRAP.contains('"'));
        assert!(!BOOTSTRAP.contains("terminal-run"));
        assert!(!BOOTSTRAP.contains("script-studio.exe"));
        assert!(BOOTSTRAP.contains(SNAPSHOT_ENV));
    }
}
