use crate::model::*;
use std::{
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

pub fn effective_runner(s: &Script) -> Result<Runner> {
    if s.runner != Runner::Auto {
        return Ok(s.runner.clone());
    }
    match s
        .path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "ps1" => Ok(Runner::Powershell),
        "cmd" | "bat" => Ok(Runner::Cmd),
        "py" => Ok(Runner::Python),
        "js" | "mjs" | "cjs" => Ok(Runner::Node),
        "exe" => Ok(Runner::Direct),
        _ => Err("此文件类型需要选择自定义解释器或直接执行。".into()),
    }
}
pub fn command(s: &Script) -> Result<Command> {
    if !s.path.is_file() {
        return Err("脚本文件不存在或不是普通文件，请编辑路径。".into());
    }
    let cwd = s
        .cwd
        .as_deref()
        .unwrap_or_else(|| s.path.parent().unwrap_or(Path::new(".")));
    if !cwd.is_dir() {
        return Err("工作目录不存在。".into());
    }
    let runner = effective_runner(s)?;
    let mut cmd = match runner {
        Runner::Direct => Command::new(&s.path),
        Runner::Powershell => {
            let mut c = Command::new("powershell.exe");
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&s.path);
            c
        }
        Runner::Python => {
            let mut c = Command::new("python");
            c.args(["-u"]).arg(&s.path);
            c
        }
        Runner::Node => {
            let mut c = Command::new("node");
            c.arg(&s.path);
            c
        }
        Runner::Custom => {
            let mut c = Command::new(&s.program);
            c.args(&s.interpreter_args).arg(&s.path);
            c
        }
        Runner::Cmd => {
            let mut c = Command::new("cmd.exe");
            c.envs(&s.env).env("SCRIPT_STUDIO_CMD_PATH", &s.path);
            let mut invocation = String::from("\"\"%SCRIPT_STUDIO_CMD_PATH%\"");
            for (i, arg) in s.args.iter().enumerate() {
                if arg.contains(['"', '\r', '\n']) {
                    return Err("CMD 参数不支持双引号或换行，请使用 PowerShell 包装脚本。".into());
                }
                let key = format!("SCRIPT_STUDIO_CMD_ARG_{i}");
                c.env(&key, arg);
                invocation.push_str(&format!(" \"%{key}%\""));
            }
            invocation.push('"');
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.args(["/D", "/V:OFF", "/S", "/C"]).raw_arg(invocation);
            }
            #[cfg(not(windows))]
            c.args(["/D", "/V:OFF", "/S", "/C"]).arg(invocation);
            c.current_dir(cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            return Ok(c);
        }
        Runner::Auto => unreachable!(),
    };
    cmd.args(&s.args)
        .envs(&s.env)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(cmd)
}

pub struct Owned {
    pub child: Child,
    #[cfg(windows)]
    job: Handle,
    #[cfg(unix)]
    pgid: i32,
}
#[cfg(windows)]
struct Handle(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for Handle {}
#[cfg(windows)]
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
impl Owned {
    pub fn spawn(mut command: Command) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x00000004 | 0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动，请检查解释器与文件路径：{e}"))?;
        #[cfg(windows)]
        {
            use std::{mem::size_of, os::windows::io::AsRawHandle};
            use windows_sys::Win32::{
                Foundation::*,
                System::{Diagnostics::ToolHelp::*, JobObjects::*, Threading::*},
            };
            let result = (|| unsafe {
                let raw_job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if raw_job.is_null() {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let job = Handle(raw_job);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                    || AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0
                {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let snapshot = Handle(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0));
                if snapshot.0 == INVALID_HANDLE_VALUE {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let mut entry: THREADENTRY32 = std::mem::zeroed();
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                let mut found = Thread32First(snapshot.0, &mut entry) != 0;
                while found {
                    if entry.th32OwnerProcessID == child.id() {
                        let thread =
                            Handle(OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID));
                        if thread.0.is_null() || ResumeThread(thread.0) == u32::MAX {
                            return Err(std::io::Error::last_os_error().to_string());
                        }
                        return Ok(job);
                    }
                    found = Thread32Next(snapshot.0, &mut entry) != 0;
                }
                Err("无法恢复挂起的脚本进程。".into())
            })();
            match result {
                Ok(job) => Ok(Self { child, job }),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    Err(format!("无法托管进程，已取消启动：{e}"))
                }
            }
        }
        #[cfg(not(windows))]
        {
            let pgid = child.id() as i32;
            let _ = &mut child;
            Ok(Self { child, pgid })
        }
    }
    pub fn empty(&self) -> Result<bool> {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::*;
            let mut a: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            if QueryInformationJobObject(
                self.job.0,
                JobObjectBasicAccountingInformation,
                &mut a as *mut _ as *mut _,
                std::mem::size_of_val(&a) as u32,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(a.ActiveProcesses == 0)
        }
        #[cfg(unix)]
        {
            Ok(unsafe { libc::kill(-self.pgid, 0) } != 0)
        }
    }
    pub fn stop(&mut self) -> Result<()> {
        #[cfg(windows)]
        unsafe {
            if windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job.0, 1) == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pgid, libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let until = Instant::now() + Duration::from_secs(8);
        while !self.empty()? {
            if Instant::now() >= until {
                return Err("未确认所属进程树完全退出。".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        // The live group/Job belongs to this run. Never rediscover ownership by PID.
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pgid, libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Decoder {
    pending: Vec<u8>,
    encoding: Encoding,
}
impl Decoder {
    pub fn new(encoding: Encoding) -> Self {
        Self {
            pending: vec![],
            encoding,
        }
    }
    pub fn push(&mut self, bytes: &[u8], final_chunk: bool) -> String {
        self.pending.extend_from_slice(bytes);
        #[cfg(windows)]
        if self.encoding == Encoding::System {
            return self.system(final_chunk);
        }
        let _ = &self.encoding;
        let mut text = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    text.push_str(s);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    text.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    self.pending.drain(..valid);
                    match e.error_len() {
                        Some(n) => {
                            text.push('\u{fffd}');
                            self.pending.drain(..n);
                        }
                        None => {
                            if final_chunk {
                                text.push_str(&String::from_utf8_lossy(&self.pending));
                                self.pending.clear();
                            }
                            break;
                        }
                    }
                }
            }
        }
        text
    }
    #[cfg(windows)]
    fn system(&mut self, final_chunk: bool) -> String {
        use windows_sys::Win32::Globalization::*;
        let cp = unsafe { GetOEMCP() };
        if cp == 65001 {
            self.encoding = Encoding::Utf8;
            return self.push(&[], final_chunk);
        }
        let mut len = self.pending.len();
        if !final_chunk {
            let mut i = 0;
            while i < len {
                if unsafe { IsDBCSLeadByteEx(cp, self.pending[i]) } != 0 {
                    if i + 1 == len {
                        len -= 1;
                        break;
                    }
                    i += 2;
                } else {
                    i += 1;
                }
            }
        }
        if len == 0 {
            return String::new();
        }
        let mut wide = vec![0u16; len * 2];
        let n = unsafe {
            MultiByteToWideChar(
                cp,
                0,
                self.pending.as_ptr(),
                len as i32,
                wide.as_mut_ptr(),
                wide.len() as i32,
            )
        };
        let text = if n > 0 {
            String::from_utf16_lossy(&wide[..n as usize])
        } else {
            String::from_utf8_lossy(&self.pending[..len]).into_owned()
        };
        self.pending.drain(..len);
        text
    }
}

pub fn pick_file(cancelled: impl Fn() -> bool) -> Result<Option<String>> {
    #[cfg(windows)]
    {
        use std::io::Read;
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Script Studio'; $d.CheckFileExists = $true; $d.Filter = 'Scripts|*.ps1;*.cmd;*.bat;*.py;*.js;*.cjs;*.mjs;*.sh;*.exe|All files|*.*'; if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Write($d.FileName) }"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut process = Owned::spawn(command)?;
        let status = loop {
            if cancelled() {
                process.stop()?;
                return Err("文件选择已随后台退出取消。".into());
            }
            if let Some(status) = process.child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        if !status.success() {
            return Err("无法打开文件选择器，请手动填写绝对路径。".into());
        }
        let mut output = Vec::new();
        if let Some(stdout) = process.child.stdout.take() {
            stdout
                .take(65536)
                .read_to_end(&mut output)
                .map_err(|e| e.to_string())?;
        }
        let path = String::from_utf8(output).map_err(|e| e.to_string())?;
        Ok((!path.is_empty()).then_some(path))
    }
    #[cfg(not(windows))]
    {
        let _ = cancelled;
        Err("文件选择仅支持 Windows，请填写绝对路径。".into())
    }
}
pub fn open_browser(url: &str) -> Result<()> {
    #[cfg(windows)]
    let mut c = Command::new("rundll32.exe");
    #[cfg(windows)]
    c.arg("url.dll,FileProtocolHandler");
    #[cfg(not(windows))]
    let mut c = Command::new("xdg-open");
    c.arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn exit_code(status: Option<ExitStatus>) -> Option<i32> {
    status.and_then(|s| s.code())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_decoder_keeps_partial_characters_and_replaces_invalid_bytes() {
        let mut d = Decoder::new(Encoding::Utf8);
        assert_eq!(d.push(&[0xe4], false), "");
        assert_eq!(d.push(&[0xb8, 0xad, 0xff], false), "中�");
        assert_eq!(d.push(&[0xe4], true), "�");
    }
}
