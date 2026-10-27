use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiLayout {
    pub version: u32,
    pub sidebar_width: u32,
    pub config_width: u32,
    pub output_height: u32,
}
impl Default for UiLayout {
    fn default() -> Self {
        Self {
            version: 1,
            sidebar_width: 200,
            config_width: 312,
            output_height: 240,
        }
    }
}
impl UiLayout {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || !(160..=360).contains(&self.sidebar_width)
            || !(260..=520).contains(&self.config_width)
            || !(110..=4096).contains(&self.output_height)
        {
            return Err("面板布局版本或尺寸无效。".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Runner {
    #[default]
    Auto,
    Powershell,
    Cmd,
    Python,
    Node,
    Direct,
    Custom,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    #[default]
    Utf8,
    System,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Group {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Script {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub path: PathBuf,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub runner: Runner,
    #[serde(default)]
    pub program: String,
    #[serde(default)]
    pub interpreter_args: Vec<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub encoding: Encoding,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub groups: Vec<Group>,
    pub scripts: Vec<Script>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            groups: vec![],
            scripts: vec![],
        }
    }
}
fn valid_id(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok()
}
fn label(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= 80 && !s.chars().any(char::is_control)
}
fn clean(s: &str) -> bool {
    s.len() <= 32768 && !s.contains('\0')
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err("不支持的配置版本，原文件已保留。".into());
        }
        if self.groups.len() > 200 || self.scripts.len() > 2000 {
            return Err("分组或脚本数量超出上限。".into());
        }
        let mut ids = HashSet::new();
        for g in &self.groups {
            if !valid_id(&g.id) || !ids.insert(&g.id) || !label(&g.name) {
                return Err("分组身份或名称无效。".into());
            }
        }
        let mut scripts = HashSet::new();
        for s in &self.scripts {
            if !valid_id(&s.id) || !scripts.insert(&s.id) || !label(&s.name) {
                return Err("脚本身份或名称无效。".into());
            }
            if s.group_id.as_ref().is_some_and(|g| !ids.contains(g)) {
                return Err("脚本引用的分组不存在。".into());
            }
            if !s.path.is_absolute() || !clean(&s.path.to_string_lossy()) {
                return Err("脚本文件需要有效的绝对路径。".into());
            }
            if s.cwd
                .as_ref()
                .is_some_and(|p| !p.is_absolute() || !clean(&p.to_string_lossy()))
            {
                return Err("工作目录需要有效的绝对路径。".into());
            }
            if s.description.len() > 8192
                || !clean(&s.program)
                || s.args.len() > 128
                || s.interpreter_args.len() > 128
                || s.args.iter().chain(&s.interpreter_args).any(|a| !clean(a))
            {
                return Err("备注、解释器或参数超出限制。".into());
            }
            if s.runner == Runner::Custom && s.program.trim().is_empty() {
                return Err("请填写自定义解释器。".into());
            }
            if s.env.len() > 64
                || s.env.iter().any(|(k, v)| {
                    k.is_empty()
                        || k.starts_with("SCRIPT_STUDIO_CMD_")
                        || k.bytes().enumerate().any(|(i, c)| {
                            !(c.is_ascii_alphabetic() || c == b'_' || i > 0 && c.is_ascii_digit())
                        })
                        || !clean(v)
                })
            {
                return Err("环境变量名称或值无效。".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    Running,
    Stopping,
    Succeeded,
    Failed,
    Stopped,
    Interrupted,
}
impl RunState {
    pub fn active(&self) -> bool {
        matches!(self, Self::Running | Self::Stopping)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub script_id: String,
    pub snapshot: Script,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub state: RunState,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub log_truncated: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LogChunk {
    pub stream: String,
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn references_and_duplicate_identity_are_validated() {
        let mut c = Config::default();
        c.groups.push(Group {
            id: id(),
            name: "开发".into(),
        });
        c.groups.push(c.groups[0].clone());
        assert!(c.validate().is_err());
        c.groups.pop();
        assert!(c.validate().is_ok());
        c.version = 99;
        assert!(c.validate().is_err());
    }
}
