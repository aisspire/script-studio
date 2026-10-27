use crate::{model::*, platform, runtime::Runtime};
use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

pub async fn action(rt: &Arc<Runtime>, value: Value) -> Result<Value> {
    match value["action"].as_str().ok_or("缺少动作名称。")? {
        "status" => {
            let s = rt.state.lock().unwrap();
            Ok(
                json!({"instance":rt.instance,"ready":true,"closing":s.closing,"activeRuns":s.runs.iter().filter(|r| r.state.active()).count()}),
            )
        }
        "snapshot" => Ok(rt.snapshot()),
        "reload" => Ok(rt.reload()),
        "save" => rt.save(
            serde_json::from_value(value["config"].clone()).map_err(|e| e.to_string())?,
            value["revision"].as_str().ok_or("缺少配置修订版本。")?,
        ),
        "run.start" => rt.start(value["scriptId"].as_str().ok_or("缺少脚本 ID。")?),
        "run.terminal" => rt.open_terminal(value["scriptId"].as_str().ok_or("缺少脚本 ID。")?),
        "run.stop" => rt.stop(value["runId"].as_str().ok_or("缺少运行 ID。")?),
        "run.logs" => rt.logs(
            value["runId"].as_str().ok_or("缺少运行 ID。")?,
            value["cursor"].as_u64().unwrap_or(0),
        ),
        "file.pick" => {
            use std::sync::atomic::Ordering;
            if rt.state.lock().unwrap().closing {
                return Err("后台正在退出。".into());
            }
            if rt.picker.swap(true, Ordering::SeqCst) {
                return Err("文件选择器已经打开。".into());
            }
            let picker = rt.clone();
            let result = tokio::task::spawn_blocking(move || {
                platform::pick_file(|| picker.state.lock().unwrap().closing)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
            rt.picker.store(false, Ordering::SeqCst);
            let path = result?;
            Ok(json!({"path":path}))
        }
        "shutdown" => {
            rt.close().await?;
            Ok(json!({"instance":rt.instance,"stopped":true}))
        }
        _ => Err("不支持的动作。".into()),
    }
}
pub fn envelope(result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    }
}
fn authorized(rt: &Runtime, headers: &HeaderMap) -> bool {
    headers.get("host").and_then(|v| v.to_str().ok())
        == Some(rt.origin.trim_start_matches("http://"))
        && headers
            .get("origin")
            .is_none_or(|v| v.to_str().ok() == Some(rt.origin.as_str()))
        && headers.get("authorization").and_then(|v| v.to_str().ok())
            == Some(format!("Bearer {}", rt.token).as_str())
}
async fn api(
    State(rt): State<Arc<Runtime>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Response {
    if !authorized(&rt, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(envelope(Err(
                "调用身份或来源无效，请从工具启动链接重新打开。".into(),
            ))),
        )
            .into_response();
    }
    let result = action(&rt, value).await;
    let status = if result.is_ok() {
        StatusCode::OK
    } else {
        StatusCode::BAD_REQUEST
    };
    (
        status,
        [("Cache-Control", "no-store")],
        Json(envelope(result)),
    )
        .into_response()
}
async fn assets(State(rt): State<Arc<Runtime>>, req: Request) -> Response {
    if req.headers().get("host").and_then(|h| h.to_str().ok())
        != Some(rt.origin.trim_start_matches("http://"))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let path = req.uri().path();
    if path == "/guide" {
        return (
            [
                ("Content-Type", "text/plain; charset=utf-8"),
                ("Cache-Control", "no-store"),
            ],
            include_str!("../USER_GUIDE.md"),
        )
            .into_response();
    }
    let path = if path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };
    if path.split('/').any(|s| s.starts_with('.')) || path.contains(['%', '\\']) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let root = std::env::var_os("SCRIPT_STUDIO_UI_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .unwrap_or_default()
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("dist")
        });
    let root = match root.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                "界面资源未构建，请先构建或使用完整目录包。",
            )
                .into_response()
        }
    };
    let file = match root.join(path).canonicalize() {
        Ok(p) if p.starts_with(&root) && p.is_file() => p,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let mime = match file.extension().and_then(|v| v.to_str()) {
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("html") => "text/html; charset=utf-8",
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    match tokio::fs::read(file).await {
        Ok(bytes) => ([("Content-Type",mime),("Content-Security-Policy","default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"),("Cache-Control","no-store"),("Referrer-Policy","no-referrer"),("X-Content-Type-Options","nosniff")],bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
pub fn router(rt: Arc<Runtime>) -> Router {
    Router::new()
        .route("/api", post(api))
        .fallback(get(assets))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
        .with_state(rt)
}

// Private loopback client used by the stdio bridge; no system proxy or CORS path.
pub async fn call(origin: &str, token: &str, value: Value) -> Result<Value> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let port = origin
        .strip_prefix("http://127.0.0.1:")
        .ok_or("实例地址须为回环 HTTP 地址。")?
        .parse::<u16>()
        .map_err(|_| "实例端口无效。")?;
    if port == 0
        || !(32..=128).contains(&token.len())
        || !token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("实例调用身份无效。".into());
    }
    let request = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        let header = format!("POST /api HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len());
        stream
            .write_all(header.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
        let mut response = Vec::new();
        stream
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut response)
            .await
            .map_err(|e| e.to_string())?;
        if response.len() > 16 * 1024 * 1024 {
            return Err("实例响应超出限制。".into());
        }
        let split = response
            .windows(4)
            .position(|v| v == b"\r\n\r\n")
            .ok_or("实例 HTTP 响应无效。")?;
        let result: Value =
            serde_json::from_slice(&response[split + 4..]).map_err(|e| e.to_string())?;
        if result["ok"] == true {
            Ok(result["value"].clone())
        } else {
            Err(result["error"].as_str().unwrap_or("实例动作失败。").into())
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(15), request)
        .await
        .map_err(|_| "实例响应超时。".to_string())?
}
