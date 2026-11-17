//! MCP servers as tools, through the SDK's `McpManager`.
//!
//! The servers are the person's: they are listed in `<home>/mcp.json` and connected once; the tool
//! catalog stays fixed for the connection (the SDK's rule), so a change needs `hivecode` to be
//! started again. Tools are offered as `<server>__<tool>`. Remote annotations never grant
//! permission, so every MCP tool counts as mutating: `plan` refuses it, `approval` asks.
//! A call whose outcome is unknown (connection lost mid-call) is reported as such and never retried.
use hive_agent_core::{Error as SdkError, Tool, mcp::McpManager, provider::CancellationToken};
use hivecode_host::{BoxFuture, Result, ToolSet};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, sync::Arc};

const MAX_RESULT_CHARS: usize = 60_000;
const MAX_WIRE_NAME: usize = 64;

pub struct McpTools {
    manager: Arc<McpManager>,
    /// wire name -> (server, tool)
    routes: HashMap<String, (String, String)>,
    definitions: Vec<Tool>,
}

/// Replaces `${NAME}` with the environment variable, so secrets need not live in `mcp.json`.
/// An unset variable becomes an error rather than an empty credential.
pub fn expand_env(
    text: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> std::result::Result<String, String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find('}')
            .ok_or_else(|| format!("unterminated ${{ in `{text}`"))?;
        let name = &after[..end];
        out.push_str(&env(name).ok_or_else(|| format!("environment variable {name} is not set"))?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// The `servers` of `mcp.json` with `${VAR}` expanded inside `env` and `headers` values.
pub fn load_config(
    path: &Path,
    env: &dyn Fn(&str) -> Option<String>,
) -> std::result::Result<Value, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let mut doc: Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let servers = doc
        .get_mut("servers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("{}: expected {{\"servers\": {{...}}}}", path.display()))?;
    for (name, server) in servers.iter_mut() {
        for key in ["env", "headers"] {
            if let Some(map) = server.get_mut(key).and_then(Value::as_object_mut) {
                for (k, v) in map.iter_mut() {
                    if let Some(text) = v.as_str() {
                        *v = json!(
                            expand_env(text, env)
                                .map_err(|e| format!("server `{name}`, {key}.{k}: {e}"))?
                        );
                    }
                }
            }
        }
    }
    Ok(Value::Object(servers.clone()))
}

fn wire(server: &str, tool: &str) -> Option<String> {
    let name = format!("{server}__{tool}");
    (name.len() <= MAX_WIRE_NAME
        && tool
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && !tool.is_empty())
    .then_some(name)
}

impl McpTools {
    /// Connects the configured servers and reads their catalog. Returns the tool set and the
    /// SDK's report (`added`, `failed`, ...); a server that does not connect is reported, not fatal.
    pub async fn connect(servers: Value) -> Result<(Self, Value)> {
        let manager = Arc::new(McpManager::new());
        let report = manager.apply(servers, 0).await?;
        let (mut routes, mut definitions) = (HashMap::new(), vec![]);
        for tool in manager.catalog().as_array().into_iter().flatten() {
            let (Some(server), Some(name)) = (tool["server"].as_str(), tool["tool"].as_str())
            else {
                continue;
            };
            let Some(wire) = wire(server, name) else {
                continue;
            };
            if routes.contains_key(&wire) || !tool["inputSchema"].is_object() {
                continue;
            }
            let mut parameters = tool["inputSchema"].clone();
            if let Some(schema) = parameters.as_object_mut() {
                // The engine compiles each schema itself; the draft marker adds nothing.
                schema.remove("$schema");
            }
            definitions.push(Tool {
                name: wire.clone(),
                description: format!(
                    "[MCP server «{server}»] {}",
                    tool["description"].as_str().unwrap_or_default()
                ),
                parameters,
                allow_repeated_results: false,
            });
            routes.insert(wire, (server.to_owned(), name.to_owned()));
        }
        Ok((
            Self {
                manager,
                routes,
                definitions,
            },
            report,
        ))
    }

    pub async fn close(&self) {
        self.manager.close_all().await;
    }
}

impl ToolSet for McpTools {
    fn definitions(&self) -> Vec<Tool> {
        self.definitions.clone()
    }

    fn mutates(&self, _: &str, _: &Value) -> bool {
        true
    }

    fn execute<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            let Some((server, tool)) = self.routes.get(name) else {
                return Ok(json!({"ok": false, "error": format!("unknown MCP tool: {name}")}));
            };
            let request = match self.manager.start_call(
                server,
                tool,
                arguments,
                json!({"source": "hivecode"}),
            ) {
                Ok(request) => request,
                Err(error) => return Ok(json!({"ok": false, "error": error.to_string()})),
            };
            let outcome = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    request.cancel();
                    return Err("cancelled".into());
                }
                outcome = request.result() => outcome,
            };
            Ok(match outcome {
                Ok(value) => {
                    // The SDK reports a tool that ran and failed as `{"error": {"code": "MCP_TOOL_ERROR", ..}}`.
                    let failed =
                        value["isError"] == true || value["error"]["code"] == "MCP_TOOL_ERROR";
                    let text = serde_json::to_string(&value).unwrap_or_default();
                    if text.chars().count() > MAX_RESULT_CHARS {
                        let cut: String = text.chars().take(MAX_RESULT_CHARS).collect();
                        json!({"ok": !failed, "result_text": format!("{cut}…(truncated)"), "truncated": true})
                    } else {
                        json!({"ok": !failed, "result": value})
                    }
                }
                Err(SdkError::McpOperationUncertain) => json!({"ok": false, "error":
                    "MCP_OPERATION_UNCERTAIN: the connection to the server was lost while the action ran and it is not known whether it happened. Do not repeat it without checking its effect (for example by looking up the result) or without the person's confirmation."}),
                Err(error) => json!({"ok": false, "error": error.to_string()}),
            })
        })
    }
}
