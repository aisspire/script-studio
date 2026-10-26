mod model;
mod platform;
mod runtime;
mod server;
mod store;

use model::*;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    path::PathBuf,
};
use tokio::io::AsyncWriteExt;

fn arg<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.windows(2).find(|p| p[0] == key).map(|p| p[1].as_str())
}
fn directory(args: &[String]) -> Result<PathBuf> {
    let dir = if let Some(path) = arg(args, "--data-dir") {
        PathBuf::from(path)
    } else {
        #[cfg(windows)]
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or("缺少 LOCALAPPDATA，请指定 --data-dir。")?;
        #[cfg(not(windows))]
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .ok_or("请指定 --data-dir。")?;
        base.join("ScriptStudio")
    };
    if !dir.is_absolute() {
        return Err("--data-dir 需要绝对路径。".into());
    }
    Ok(dir)
}
#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("Script Studio：{e}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => serve(directory(&args)?, &args).await,
        Some("request") => {
            let desc = existing(&directory(&args)?).await?;
            let request = serde_json::from_str(arg(&args, "--json").ok_or("缺少 --json。")?)
                .map_err(|e| e.to_string())?;
            let result = server::call(
                desc["origin"].as_str().unwrap(),
                desc["token"].as_str().unwrap(),
                request,
            )
            .await?;
            println!("{}", serde_json::to_string(&result).unwrap());
            Ok(())
        }
        _ => {
            println!("Script Studio {}\n  serve [--open] [--data-dir ABSOLUTE] [--oriel-stdio]\n  request [--data-dir ABSOLUTE] --json JSON",env!("CARGO_PKG_VERSION"));
            Ok(())
        }
    }
}
async fn existing(directory: &std::path::Path) -> Result<Value> {
    let value: Value =
        serde_json::from_slice(&store::bytes(&directory.join("instance.json"), 65536)?)
            .map_err(|e| e.to_string())?;
    if value["version"] != env!("CARGO_PKG_VERSION")
        || value["protocol"] != 1
        || value["ready"] != true
    {
        return Err("已有实例版本不同，请正常退出后重试。".into());
    }
    let origin = value["origin"].as_str().ok_or("实例缺少地址。")?;
    let token = value["token"].as_str().ok_or("实例缺少身份。")?;
    let status = server::call(origin, token, serde_json::json!({"action":"status"})).await?;
    if status["instance"] != value["instance"] || status["closing"] == true {
        return Err("已有实例身份不匹配或正在退出。".into());
    }
    // Reconstruct pageUrl from the authenticated origin/token rather than trusting a stored URL.
    let page_url = format!("{origin}/#token={token}");
    let mut value = value;
    value["pageUrl"] = Value::String(page_url);
    Ok(value)
}
async fn serve(directory: PathBuf, args: &[String]) -> Result<()> {
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("instance.lock"))
        .map_err(|e| e.to_string())?;
    let stdio = args.iter().any(|v| v == "--oriel-stdio");
    if fs2::FileExt::try_lock_exclusive(&lock).is_err() {
        let desc = existing(&directory).await?;
        if args.iter().any(|v| v == "--open") {
            platform::open_browser(desc["pageUrl"].as_str().unwrap())?;
        }
        if stdio {
            return proxy(desc).await;
        }
        println!("{desc}");
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let origin = format!(
        "http://{}",
        listener.local_addr().map_err(|e| e.to_string())?
    );
    let rt = runtime::Runtime::new(directory.clone(), origin, format!("{}{}", id(), id()))?;
    let mut shutdown = rt.shutdown.subscribe();
    let descriptor = rt.descriptor();
    store::atomic(
        &directory.join("instance.json"),
        &serde_json::to_vec(&descriptor).unwrap(),
    )?;
    write_stdout(&descriptor).await?;
    if args.iter().any(|v| v == "--open") {
        if let Err(e) = platform::open_browser(descriptor["pageUrl"].as_str().unwrap()) {
            eprintln!("{e}");
        }
    }
    if stdio {
        let (mut requests, mut eof) = input_lines();
        let ended = rt.clone();
        tokio::spawn(async move {
            let _ = eof.changed().await;
            if let Err(e) = ended.close().await {
                eprintln!("{e}");
            }
        });
        let handler = rt.clone();
        tokio::spawn(async move {
            while let Some(line) = requests.recv().await {
                let result = match serde_json::from_str::<Value>(&line) {
                    Ok(v) => server::action(&handler, v).await,
                    Err(e) => Err(e.to_string()),
                };
                if write_stdout(&server::envelope(result)).await.is_err() {
                    break;
                }
            }
            let _ = handler.close().await;
        });
    }
    let stopped = rt.clone();
    axum::serve(listener, server::router(rt))
        .with_graceful_shutdown(async move {
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = shutdown.changed() => {} }
            if let Err(e) = stopped.close().await {
                eprintln!("{e}");
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    let _ = fs::remove_file(directory.join("instance.json"));
    drop(lock);
    Ok(())
}
async fn write_stdout(value: &Value) -> Result<()> {
    let mut stdout = tokio::io::stdout();
    stdout
        .write_all(format!("{value}\n").as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdout.flush().await.map_err(|e| e.to_string())
}
fn input_lines() -> (
    tokio::sync::mpsc::Receiver<String>,
    tokio::sync::watch::Receiver<bool>,
) {
    let (tx, rx) = tokio::sync::mpsc::channel(64);
    let (eof, ended) = tokio::sync::watch::channel(false);
    std::thread::spawn(move || {
        use std::io::{BufRead, Read};
        let stdin = std::io::stdin();
        let mut reader = std::io::BufReader::new(stdin.lock());
        loop {
            let mut line = String::new();
            match reader
                .by_ref()
                .take(4 * 1024 * 1024 + 1)
                .read_line(&mut line)
            {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 4 * 1024 * 1024 => break,
                Ok(_) => {
                    if tx.try_send(line).is_err() {
                        break;
                    }
                }
            }
        }
        eof.send_replace(true);
    });
    (rx, ended)
}
async fn proxy(desc: Value) -> Result<()> {
    write_stdout(&desc).await?;
    let origin = desc["origin"].as_str().unwrap().to_owned();
    let token = desc["token"].as_str().unwrap().to_owned();
    let (mut input, mut eof) = input_lines();
    let o = origin.clone();
    let t = token.clone();
    tokio::spawn(async move {
        let _ = eof.changed().await;
        let _ = server::call(&o, &t, serde_json::json!({"action":"shutdown"})).await;
    });
    loop {
        tokio::select! {
            line = input.recv() => {
                let Some(line) = line else { break; };
                let result = match serde_json::from_str::<Value>(&line) { Ok(v) => server::call(&origin,&token,v).await, Err(e) => Err(e.to_string()) };
                write_stdout(&server::envelope(result)).await?;
            },
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    let _ = server::call(&origin, &token, serde_json::json!({"action":"shutdown"})).await;
    Ok(())
}
