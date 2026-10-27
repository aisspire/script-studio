use crate::{
    model::*,
    platform::{self, Decoder, Owned},
    store::Store,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub const LOG_LIMIT: u64 = 10 * 1024 * 1024;
const HISTORY_LIMIT: usize = 100;
pub struct State {
    pub store: Store,
    pub runs: Vec<Run>,
    pub warnings: Vec<String>,
    active: HashMap<String, Arc<AtomicBool>>,
    pub closing: bool,
}
pub struct Runtime {
    pub instance: String,
    pub origin: String,
    pub token: String,
    pub state: Mutex<State>,
    pub shutdown: tokio::sync::watch::Sender<bool>,
    pub picker: AtomicBool,
}
impl Runtime {
    pub fn new(directory: PathBuf, origin: String, token: String) -> Result<Arc<Self>> {
        let store = Store::open(directory)?;
        let (runs, warnings) = store.load_runs();
        let (shutdown, _) = tokio::sync::watch::channel(false);
        let rt = Arc::new(Self {
            instance: id(),
            origin,
            token,
            state: Mutex::new(State {
                store,
                runs,
                warnings,
                active: HashMap::new(),
                closing: false,
            }),
            shutdown,
            picker: AtomicBool::new(false),
        });
        rt.trim();
        Ok(rt)
    }
    pub fn descriptor(&self) -> Value {
        json!({"protocol":1,"version":env!("CARGO_PKG_VERSION"),"ready":true,"instance":self.instance,"origin":self.origin,"token":self.token,"pageUrl":format!("{}/#token={}",self.origin,self.token)})
    }
    pub fn snapshot(&self) -> Value {
        let s = self.state.lock().unwrap();
        let runs: Vec<Value> = s.runs.iter().map(|r| json!({"id":r.id,"scriptId":r.script_id,"snapshot":{"name":r.snapshot.name,"path":r.snapshot.path,"runner":r.snapshot.runner},"startedAt":r.started_at,"endedAt":r.ended_at,"state":r.state,"exitCode":r.exit_code,"error":r.error,"logTruncated":r.log_truncated})).collect();
        json!({"instance":self.instance,"config":s.store.config,"revision":s.store.revision,"configError":s.store.error,"dataDirectory":s.store.directory,"runs":runs,"warnings":s.warnings,"closing":s.closing})
    }
    pub fn save(&self, config: Config, revision: &str) -> Result<Value> {
        let mut s = self.state.lock().unwrap();
        if s.closing {
            return Err("后台正在退出。".into());
        }
        if s.runs
            .iter()
            .any(|r| r.state.active() && !config.scripts.iter().any(|x| x.id == r.script_id))
        {
            return Err("请先停止运行中的脚本，再移除登记。".into());
        }
        s.store.save(config, revision)?;
        drop(s);
        Ok(self.snapshot())
    }
    pub fn reload(&self) -> Value {
        self.state.lock().unwrap().store.reload();
        self.snapshot()
    }
    pub fn start(self: &Arc<Self>, script_id: &str) -> Result<Value> {
        let mut s = self.state.lock().unwrap();
        if s.closing {
            return Err("后台正在退出。".into());
        }
        if s.store.error.is_some() {
            return Err("请先修复配置并重新加载，再运行脚本。".into());
        }
        if s.runs
            .iter()
            .any(|r| r.script_id == script_id && r.state.active())
        {
            return Err("此脚本已经在运行。".into());
        }
        let script = s
            .store
            .config
            .scripts
            .iter()
            .find(|x| x.id == script_id)
            .cloned()
            .ok_or("脚本不存在，请重新加载。")?;
        let command = platform::command(&script)?;
        let run = Run {
            id: id(),
            script_id: script.id.clone(),
            snapshot: script,
            started_at: now(),
            ended_at: None,
            state: RunState::Running,
            exit_code: None,
            error: None,
            log_truncated: false,
        };
        s.store.save_run(&run)?;
        let cancel = Arc::new(AtomicBool::new(false));
        s.active.insert(run.id.clone(), cancel.clone());
        s.runs.insert(0, run.clone());
        drop(s);
        let rt = self.clone();
        let run_id = run.id.clone();
        let worker_id = run_id.clone();
        let encoding = run.snapshot.encoding;
        if let Err(e) = thread::Builder::new()
            .name(format!("run-{run_id}"))
            .spawn(move || rt.execute(worker_id, command, encoding, cancel))
        {
            self.finish(&run_id, RunState::Failed, None, Some(e.to_string()));
            return Err(e.to_string());
        }
        Ok(json!({"runId":run_id}))
    }
    pub fn open_terminal(&self, script_id: &str) -> Result<Value> {
        let s = self.state.lock().unwrap();
        if s.closing {
            return Err("后台正在退出。".into());
        }
        if s.store.error.is_some() {
            return Err("请先修复配置并重新加载，再运行脚本。".into());
        }
        if s.runs
            .iter()
            .any(|r| r.script_id == script_id && r.state.active())
        {
            return Err("此脚本已经在运行。".into());
        }
        let script = s
            .store
            .config
            .scripts
            .iter()
            .find(|x| x.id == script_id)
            .ok_or("脚本不存在，请重新加载。")?;
        crate::terminal::open(script)?;
        Ok(json!({"opened":true}))
    }
    pub fn stop(&self, run_id: &str) -> Result<Value> {
        let mut s = self.state.lock().unwrap();
        if let Some(cancel) = s.active.get(run_id) {
            cancel.store(true, Ordering::SeqCst);
        } else if s.runs.iter().any(|r| r.id == run_id) {
            return Ok(json!({"stopped":true}));
        } else {
            return Err("运行记录不存在。".into());
        }
        let record = if let Some(run) = s.runs.iter_mut().find(|r| r.id == run_id) {
            run.state = RunState::Stopping;
            Some(run.clone())
        } else {
            None
        };
        if let Some(run) = record {
            if let Err(e) = s.store.save_run(&run) {
                warn(&mut s, format!("停止已请求，记录写入失败：{e}"));
            }
        }
        Ok(json!({"stopping":true}))
    }
    fn finish(&self, id: &str, state: RunState, exit_code: Option<i32>, error: Option<String>) {
        let mut s = self.state.lock().unwrap();
        let record = s.runs.iter_mut().find(|r| r.id == id).map(|run| {
            run.state = state;
            run.ended_at = Some(now());
            run.exit_code = exit_code;
            if error.is_some() {
                run.error = error;
            }
            run.clone()
        });
        if let Some(run) = record {
            if let Err(e) = s.store.save_run(&run) {
                warn(&mut s, format!("运行结果写入失败：{e}"));
            }
        }
        s.active.remove(id);
        drop(s);
        self.trim();
    }
    fn trim(&self) {
        let mut s = self.state.lock().unwrap();
        let mut completed: Vec<_> = s
            .runs
            .iter()
            .filter(|r| !r.state.active())
            .map(|r| (r.id.clone(), r.ended_at.unwrap_or(r.started_at)))
            .collect();
        // A long-running task that just completed must not expire by its old start time.
        completed.sort_by_key(|(_, ended)| std::cmp::Reverse(*ended));
        let remove: Vec<String> = completed
            .into_iter()
            .skip(HISTORY_LIMIT)
            .map(|(id, _)| id)
            .collect();
        for id in &remove {
            for extension in ["json", "jsonl"] {
                let path = s
                    .store
                    .directory
                    .join("runs")
                    .join(format!("{id}.{extension}"));
                if let Err(e) = fs::remove_file(path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        warn(&mut s, format!("历史清理失败：{e}"));
                    }
                }
            }
        }
        s.runs.retain(|r| !remove.contains(&r.id));
    }
    pub fn logs(&self, run_id: &str, cursor: u64) -> Result<Value> {
        let s = self.state.lock().unwrap();
        let run = s
            .runs
            .iter()
            .find(|r| r.id == run_id)
            .ok_or("运行记录已不存在。")?;
        let truncated = run.log_truncated;
        let path = s
            .store
            .directory
            .join("runs")
            .join(format!("{run_id}.jsonl"));
        drop(s);
        let f = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({"chunks":[],"cursor":0,"truncated":truncated}))
            }
            Err(e) => return Err(e.to_string()),
        };
        let len = f.metadata().map_err(|e| e.to_string())?.len();
        if cursor > len || len > LOG_LIMIT {
            return Err("日志游标或文件大小无效，请重新选择运行记录。".into());
        }
        let mut reader = BufReader::new(f);
        reader
            .seek(SeekFrom::Start(cursor))
            .map_err(|e| e.to_string())?;
        let mut chunks = vec![];
        let mut next = cursor;
        while next - cursor < 128 * 1024 {
            let mut line = Vec::new();
            let n = reader
                .by_ref()
                .take(128 * 1024)
                .read_until(b'\n', &mut line)
                .map_err(|e| e.to_string())?;
            if n == 0 || line.last() != Some(&b'\n') {
                break;
            }
            let chunk: LogChunk =
                serde_json::from_slice(&line).map_err(|_| "日志游标不在有效记录边界。")?;
            chunks.push(chunk);
            next += n as u64;
        }
        Ok(json!({"chunks":chunks,"cursor":next,"truncated":truncated}))
    }
    pub async fn close(self: &Arc<Self>) -> Result<()> {
        {
            let mut s = self.state.lock().unwrap();
            s.closing = true;
            for cancel in s.active.values() {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        let rt = self.clone();
        let result = tokio::task::spawn_blocking(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if rt.state.lock().unwrap().active.is_empty() {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err("退出清理超时，请查看运行诊断。".into());
                }
                thread::sleep(Duration::from_millis(20));
            }
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        self.shutdown.send_replace(true);
        result
    }
    fn execute(
        self: Arc<Self>,
        run_id: String,
        command: std::process::Command,
        encoding: Encoding,
        cancel: Arc<AtomicBool>,
    ) {
        let mut process = match Owned::spawn(command) {
            Ok(p) => p,
            Err(e) => {
                self.finish(&run_id, RunState::Failed, None, Some(e));
                return;
            }
        };
        let (tx, rx) = mpsc::sync_channel(64);
        for (stream, output) in [
            (
                "stdout",
                process
                    .child
                    .stdout
                    .take()
                    .map(|r| Box::new(r) as Box<dyn Read + Send>),
            ),
            (
                "stderr",
                process
                    .child
                    .stderr
                    .take()
                    .map(|r| Box::new(r) as Box<dyn Read + Send>),
            ),
        ] {
            let tx = tx.clone();
            let encoding = encoding.clone();
            thread::spawn(move || {
                if let Some(mut reader) = output {
                    let mut decoder = Decoder::new(encoding);
                    let mut buf = [0u8; 8192];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                let text = decoder.push(&buf[..n], false);
                                if !text.is_empty()
                                    && tx
                                        .send(Some(LogChunk {
                                            stream: stream.into(),
                                            text,
                                        }))
                                        .is_err()
                                {
                                    return;
                                }
                            }
                            Err(e) => {
                                let _ = tx.send(Some(LogChunk {
                                    stream: "system".into(),
                                    text: format!("输出读取失败：{e}\n"),
                                }));
                                break;
                            }
                        }
                    }
                    let text = decoder.push(&[], true);
                    if !text.is_empty() {
                        let _ = tx.send(Some(LogChunk {
                            stream: stream.into(),
                            text,
                        }));
                    }
                }
                let _ = tx.send(None);
            });
        }
        drop(tx);
        let path = self
            .state
            .lock()
            .unwrap()
            .store
            .directory
            .join("runs")
            .join(format!("{run_id}.jsonl"));
        let mut writer = LogWriter::new(path);
        let mut eof = 0;
        let mut status = None;
        let mut error = None;
        let mut stopped = false;
        loop {
            for _ in 0..64 {
                match rx.try_recv() {
                    Ok(Some(chunk)) => self.append(&run_id, &mut writer, chunk),
                    Ok(None) => eof += 1,
                    Err(_) => break,
                }
            }
            if cancel.load(Ordering::SeqCst) {
                stopped = true;
                if let Err(e) = process.stop() {
                    error = Some(e);
                }
                break;
            }
            match process.child.try_wait() {
                Ok(Some(s)) => status = Some(s),
                Ok(None) => {}
                Err(e) => {
                    error = Some(e.to_string());
                    let _ = process.stop();
                    break;
                }
            }
            match process.empty() {
                Ok(true) if status.is_some() && eof >= 2 => break,
                Err(e) => {
                    error = Some(e);
                    let _ = process.stop();
                    break;
                }
                _ => {}
            }
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(Some(chunk)) => self.append(&run_id, &mut writer, chunk),
                Ok(None) => eof += 1,
                Err(_) => thread::sleep(Duration::from_millis(10)),
            }
        }
        let deadline = Instant::now() + Duration::from_millis(500);
        while eof < 2 && Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(Some(chunk)) => self.append(&run_id, &mut writer, chunk),
                Ok(None) => eof += 1,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                _ => {}
            }
        }
        if let Some(file) = &mut writer.file {
            if let Err(e) = file.sync_all() {
                error.get_or_insert(format!("日志同步失败：{e}"));
            }
        }
        let state = if error.is_some() {
            RunState::Failed
        } else if stopped {
            RunState::Stopped
        } else if status.is_some_and(|s| s.success()) {
            RunState::Succeeded
        } else {
            RunState::Failed
        };
        drop(process);
        self.finish(&run_id, state, platform::exit_code(status), error);
    }
    fn append(&self, run_id: &str, writer: &mut LogWriter, chunk: LogChunk) {
        if writer.truncated {
            return;
        }
        let result = writer.write(chunk);
        if writer.truncated || result.is_err() {
            let mut s = self.state.lock().unwrap();
            if let Some(run) = s.runs.iter_mut().find(|r| r.id == run_id) {
                run.log_truncated = true;
                if let Err(e) = result {
                    run.error = Some(format!("日志写入失败：{e}"));
                }
            }
        }
    }
}
fn warn(state: &mut State, message: String) {
    if state.warnings.len() == 20 {
        state.warnings.remove(0);
    }
    state.warnings.push(message);
}
struct LogWriter {
    file: Option<File>,
    bytes: u64,
    truncated: bool,
    open_error: Option<String>,
}
impl LogWriter {
    fn new(path: PathBuf) -> Self {
        match OpenOptions::new().create_new(true).write(true).open(path) {
            Ok(file) => Self {
                file: Some(file),
                bytes: 0,
                truncated: false,
                open_error: None,
            },
            Err(e) => Self {
                file: None,
                bytes: 0,
                truncated: false,
                open_error: Some(e.to_string()),
            },
        }
    }
    fn write(&mut self, chunk: LogChunk) -> Result<()> {
        if let Some(e) = self.open_error.take() {
            self.truncated = true;
            return Err(e);
        }
        let mut data = serde_json::to_vec(&chunk).map_err(|e| e.to_string())?;
        data.push(b'\n');
        if self.bytes + data.len() as u64 > LOG_LIMIT {
            self.truncated = true;
            return Ok(());
        }
        if let Some(file) = &mut self.file {
            if let Err(e) = file.write_all(&data) {
                self.truncated = true;
                return Err(e.to_string());
            }
            self.bytes += data.len() as u64;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn log_cap_does_not_write_partial_records() {
        let dir = std::env::temp_dir().join(id());
        fs::create_dir(&dir).unwrap();
        let path = dir.join("log");
        let mut writer = LogWriter::new(path.clone());
        writer.bytes = LOG_LIMIT - 1;
        writer
            .write(LogChunk {
                stream: "stdout".into(),
                text: "large".into(),
            })
            .unwrap();
        assert!(writer.truncated);
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        fs::remove_dir_all(dir).unwrap();
    }
}
