//! `adr_check` and `adr_search`: what the project decided, before changing something that was decided.
//! Read-only. The ADRs are the Markdown files of the project's `adrs/` folder (see `hivecode-adr`).
use hive_agent_core::{Tool, provider::CancellationToken};
use hivecode_host::{BoxFuture, Result, ToolSet};
use serde_json::{Value, json};
use std::path::PathBuf;

const MAX_PATHS: usize = 50;

pub struct AdrTools {
    root: PathBuf,
}
impl AdrTools {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

impl ToolSet for AdrTools {
    fn definitions(&self) -> Vec<Tool> {
        vec![
            Tool {
                name: "adr_check".into(),
                description: "How risky it is to change these files according to the project's architecture decision records (adrs/*.md): a risk level and the ADR behind it. Ask before editing a file a decision may cover.".into(),
                parameters: json!({"type":"object","properties":{
                    "paths":{"type":"array","minItems":1,"maxItems":MAX_PATHS,"items":{"type":"string","maxLength":4096},"description":"Files relative to the project."}
                },"required":["paths"],"additionalProperties":false}),
                allow_repeated_results: false,
            },
            Tool {
                name: "adr_search".into(),
                description: "Search the project's architecture decision records by a word or phrase in their title or text.".into(),
                parameters: json!({"type":"object","properties":{
                    "query":{"type":"string","minLength":1,"maxLength":200},
                    "limit":{"type":"integer","minimum":1,"maximum":20}
                },"required":["query"],"additionalProperties":false}),
                allow_repeated_results: false,
            },
        ]
    }

    fn mutates(&self, _: &str, _: &Value) -> bool {
        false
    }

    fn execute<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
        _: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            let adrs = hivecode_adr::load(&self.root);
            if name == "adr_search" {
                let query = arguments["query"].as_str().unwrap_or_default();
                let limit = arguments["limit"].as_u64().unwrap_or(5) as usize;
                let found: Vec<Value> = hivecode_adr::search(&adrs, query, limit)
                    .into_iter()
                    .map(|a| json!({"file": a.file.strip_prefix(&self.root).unwrap_or(&a.file).display().to_string(),
                        "title": a.title, "status": a.status.as_str()}))
                    .collect();
                return Ok(json!({"ok": true, "total_adrs": adrs.len(), "matches": found}));
            }
            let paths: Vec<&str> = arguments["paths"]
                .as_array()
                .map(|p| p.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if paths
                .iter()
                .any(|p| p.starts_with('/') || p.split(['/', '\\']).any(|s| s == ".."))
            {
                return Ok(json!({"ok": false, "error": "paths must be relative to the project"}));
            }
            let files: Vec<Value> = paths
                .iter()
                .map(|p| {
                    let a = hivecode_adr::assess(&adrs, p);
                    json!({"path": p, "risk": a.risk.as_str(), "reason": a.reason,
                        "adr": a.adr.map(|f| f.strip_prefix(&self.root).unwrap_or(&f).display().to_string())})
                })
                .collect();
            let note = if adrs.is_empty() {
                Some("This project has no adrs/ folder: only schema files are rated above low.")
            } else {
                None
            };
            Ok(json!({"ok": true, "files": files, "note": note}))
        })
    }
}
