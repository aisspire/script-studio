use crate::model::*;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub const MAX_CONFIG: u64 = 2 * 1024 * 1024;
pub fn bytes(path: &Path, limit: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut data = vec![];
    f.take(limit + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > limit {
        return Err("文件超出大小限制。".into());
    }
    Ok(data)
}
pub fn revision(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
pub fn atomic(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("文件没有父目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".{}.tmp", id()));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        f.write_all(data)
            .and_then(|_| f.sync_all())
            .map_err(|e| e.to_string())?;
        drop(f);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            // MoveFileExW replaces atomically on the same volume and flushes the move.
            let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    1 | 8,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        #[cfg(not(windows))]
        fs::rename(&temp, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub struct Store {
    pub directory: PathBuf,
    pub config: Config,
    pub revision: String,
    pub error: Option<String>,
}
impl Store {
    pub fn open(directory: PathBuf) -> Result<Self> {
        fs::create_dir_all(directory.join("runs")).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let mut store = Self {
            directory,
            config: Config::default(),
            revision: revision(&[]),
            error: None,
        };
        store.reload();
        Ok(store)
    }
    pub fn reload(&mut self) {
        let result = self.read_config();
        match result {
            Ok((config, rev)) => {
                self.config = config;
                self.revision = rev;
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
    }
    fn read_config(&self) -> Result<(Config, String)> {
        let path = self.directory.join("config.json");
        let data = match bytes(&path, MAX_CONFIG) {
            Ok(d) => d,
            Err(_) if !path.exists() => return Ok((Config::default(), revision(&[]))),
            Err(e) => return Err(e),
        };
        let c: Config = serde_json::from_slice(&data)
            .map_err(|e| format!("配置无法读取，原文件已保留：{e}"))?;
        c.validate()?;
        Ok((c, revision(&data)))
    }
    pub fn save(&mut self, config: Config, expected: &str) -> Result<()> {
        if let Some(e) = &self.error {
            return Err(format!("配置不可写：{e}"));
        }
        config.validate()?;
        let (_, current) = self.read_config()?;
        if current != expected || expected != self.revision {
            return Err("配置已被其他页面或程序修改，请重新加载后再保存。".into());
        }
        let data = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
        if data.len() as u64 > MAX_CONFIG {
            return Err("配置超过 2 MiB。".into());
        }
        atomic(&self.directory.join("config.json"), &data)?;
        self.config = config;
        self.revision = revision(&data);
        Ok(())
    }
    pub fn save_run(&self, run: &Run) -> Result<()> {
        atomic(
            &self.directory.join("runs").join(format!("{}.json", run.id)),
            &serde_json::to_vec(run).map_err(|e| e.to_string())?,
        )
    }
    pub fn load_runs(&self) -> (Vec<Run>, Vec<String>) {
        let mut runs = vec![];
        let mut warnings = vec![];
        if let Ok(files) = fs::read_dir(self.directory.join("runs")) {
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let parsed = bytes(&path, MAX_CONFIG)
                    .and_then(|d| serde_json::from_slice::<Run>(&d).map_err(|e| e.to_string()));
                match parsed {
                    Ok(mut run)
                        if uuid::Uuid::parse_str(&run.id).is_ok()
                            && path.file_stem().and_then(|s| s.to_str()) == Some(&run.id) =>
                    {
                        if run.state.active() {
                            run.state = RunState::Interrupted;
                            run.ended_at = Some(now());
                            run.error = Some("后台异常结束，此任务不会自动重新执行。".into());
                            if let Err(e) = self.save_run(&run) {
                                warnings.push(e);
                            }
                        }
                        runs.push(run);
                    }
                    _ => warnings.push(format!("运行记录无法读取，已保留：{}", path.display())),
                }
            }
        }
        runs.sort_by_key(|r| std::cmp::Reverse(r.started_at));
        (runs, warnings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn damaged_and_externally_modified_config_is_preserved() {
        let dir = std::env::temp_dir().join(id());
        let mut s = Store::open(dir.clone()).unwrap();
        let rev = s.revision.clone();
        s.save(Config::default(), &rev).unwrap();
        let rev = s.revision.clone();
        fs::write(dir.join("config.json"), "broken").unwrap();
        assert!(s.save(Config::default(), &rev).is_err());
        s.reload();
        assert!(s.error.is_some());
        assert_eq!(
            fs::read_to_string(dir.join("config.json")).unwrap(),
            "broken"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
