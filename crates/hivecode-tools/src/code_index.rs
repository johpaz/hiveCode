//! `outline`, `find_symbol`, `dependents` and `tests_for`: questions about the code that the index
//! answers without reading a file. Same names, parameters and result fields as the TS tools in
//! `tools/core/code-index.ts`. Every answer says whether the file changed since it was indexed
//! (`stale`) so the reader knows to confirm on disk before editing.
use hive_agent_core::{Tool, provider::CancellationToken};
use hivecode_host::{BoxFuture, Result, ToolSet};
use hivecode_index::{FileEntry, Index, Symbol, is_test_path};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Mutex};

const MAX_SYMBOL_HITS: usize = 30;
const MAX_LIST: usize = 25;

pub struct IndexTools {
    index: Mutex<Index>,
}
impl IndexTools {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            index: Mutex::new(Index::new(root)),
        }
    }
}

fn row(symbol: &Symbol) -> Value {
    let mut out = json!({"name": symbol.name, "kind": symbol.kind,
        "lines": format!("{}-{}", symbol.start_line, symbol.end_line)});
    if symbol.exported {
        out["exported"] = json!(true);
    }
    if !symbol.signature.is_empty() {
        out["signature"] = json!(symbol.signature);
    }
    out
}
fn failure(message: impl Into<String>) -> Value {
    json!({"ok": false, "error": message.into()})
}
fn path_schema() -> Value {
    json!({"type":"object","properties":{"path":{"type":"string","maxLength":4096,"description":"File path, relative to the workspace"}},"required":["path"],"additionalProperties":false})
}

impl ToolSet for IndexTools {
    fn definitions(&self) -> Vec<Tool> {
        let tool = |name: &str, description: &str, parameters: Value| Tool {
            name: name.into(),
            description: description.into(),
            parameters,
            allow_repeated_results: false,
        };
        vec![
            tool(
                "outline",
                "List what a source file declares (functions, classes, methods, types) with the line range of each, plus what it imports and exports, from the project index. Cheaper than reading the file: use it to decide WHICH lines to read, then fs_read with offset/limit.",
                path_schema(),
            ),
            tool(
                "find_symbol",
                "Find where a function, class, method, type or constant is defined, by name (exact first, then partial), with file and line range, from the project index. Use it instead of grepping the repo for a definition.",
                json!({"type":"object","properties":{
                    "name":{"type":"string","minLength":1,"maxLength":200,"description":"Symbol name, e.g. 'buildContextPacket' or 'Store.load'"},
                    "kind":{"type":"string","maxLength":40,"description":"Only this kind: function, class, method, interface, type, const, enum, fn, struct, trait..."}
                },"required":["name"],"additionalProperties":false}),
            ),
            tool(
                "dependents",
                "Which files import a given file, and which files it imports, from the project index. Use it to see what a change can break before reading the callers. File level, not per call site.",
                path_schema(),
            ),
            tool(
                "tests_for",
                "Which test files cover a source file (tests that import it or sit beside it), from the project index. For a test file, the source files it imports. Use it to know what to run after a change.",
                path_schema(),
            ),
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
            // Parsing is synchronous file I/O; keep it off the async threads.
            let result = tokio::task::block_in_place(|| {
                let mut index = self.index.lock().map_err(|_| "index lock poisoned")?;
                index.sync();
                Ok::<_, &str>(answer(&index, name, &arguments))
            })?;
            Ok(result)
        })
    }
}

fn answer(index: &Index, name: &str, arguments: &Value) -> Value {
    let text = |key: &str| {
        arguments[key]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    match name {
        "find_symbol" => {
            let Some(wanted) = text("name") else {
                return failure("name is required");
            };
            let hits = index.find_symbol(wanted, text("kind"));
            let matches: Vec<Value> = hits
                .iter()
                .take(MAX_SYMBOL_HITS)
                .map(|(file, symbol)| {
                    let mut value = row(symbol);
                    value["path"] = json!(file.path);
                    value["stale"] = json!(index.is_stale(file));
                    value
                })
                .collect();
            let mut out =
                json!({"ok": true, "name": wanted, "total": hits.len(), "matches": matches});
            if hits.len() > MAX_SYMBOL_HITS {
                out["note"] = json!(format!(
                    "Showing {MAX_SYMBOL_HITS} of {}; give a fuller name or a kind.",
                    hits.len()
                ));
            } else if hits.is_empty() {
                out["note"] =
                    json!("No symbol by that name in the index; fs_grep finds exact strings.");
            }
            out
        }
        "outline" | "dependents" | "tests_for" => {
            let Some(target) = text("path") else {
                return failure("path is required");
            };
            let Some(file) = index.find(target) else {
                return failure(match name {
                    "outline" => format!(
                        "{target} is not in the index (new, ignored or not a source file); use fs_read."
                    ),
                    "dependents" => {
                        format!("{target} is not in the index; use fs_grep for its name.")
                    }
                    _ => format!("{target} is not in the index."),
                });
            };
            let base = json!({"ok": true, "path": file.path, "stale": index.is_stale(file)});
            let mut out = base;
            let cut = |items: &[String]| json!(items.iter().take(MAX_LIST).collect::<Vec<_>>());
            match name {
                "outline" => {
                    out["symbols"] = json!(file.symbols.iter().map(row).collect::<Vec<_>>());
                    out["imports"] = cut(&file.imports);
                    out["exports"] = cut(&file.exports);
                }
                "dependents" => {
                    out["imported_by"] = cut(&file.imported_by);
                    out["imported_by_total"] = json!(file.imported_by.len());
                    out["imports"] = cut(&file.imports);
                    out["imports_total"] = json!(file.imports.len());
                    if !file.relations_complete {
                        out["note"] = json!("Imports of this file type are not fully indexed.");
                    }
                }
                _ => tests_for(index, file, &mut out),
            }
            out
        }
        other => failure(format!("unknown index tool: {other}")),
    }
}

fn tests_for(index: &Index, file: &FileEntry, out: &mut Value) {
    if is_test_path(&file.path) {
        let covers: Vec<&String> = file.imports.iter().filter(|p| !is_test_path(p)).collect();
        out["kind"] = json!("test");
        out["covers"] = json!(covers.iter().take(MAX_LIST).collect::<Vec<_>>());
        out["covers_total"] = json!(covers.len());
    } else {
        let tests = index.tests_for(file);
        out["kind"] = json!("source");
        if tests.is_empty() {
            out["note"] = json!(
                "No test imports or sits beside this file; its behaviour may be covered indirectly."
            );
        }
        out["tests"] = json!(tests);
    }
}
