//! Agent-loop host for hivecode.
//!
//! The SDK engine is sans-I/O: it says what to do next (call the model, run a tool, finish) and
//! the host does it. This crate is that host for hivecode. It owns the durable session, the
//! provider and the sandboxed tools, and drives one turn at a time, reporting progress through a
//! callback so a terminal UI, a headless NDJSON stream or a test can all render it.
use hive_agent_core::{
    Action,
    durable_handle::DurableEngineHandle,
    provider::{CancellationToken, ModelEvent, NativeProvider},
    sessions::SessionStore,
    tools::NativeTools,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;

/// Execution mode (docs/modes.md). `plan` investigates and never writes, `approval` asks before each
/// mutating tool, `auto` runs everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Plan,
    Approval,
    Auto,
}
impl Mode {
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "plan" => Some(Self::Plan),
            "approval" => Some(Self::Approval),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Approval => "approval",
            Self::Auto => "auto",
        }
    }
}

/// Tools that change the project or the machine. Everything else only reads.
pub fn mutates(tool: &str) -> bool {
    !matches!(
        tool,
        "fs_read" | "fs_list" | "fs_glob" | "fs_grep" | "web_fetch" | "web_search"
    )
}

/// Everything needed to open one agent session.
#[derive(Clone)]
pub struct HostConfig {
    /// HiveDB directory holding sessions and checkpoints.
    pub db: PathBuf,
    /// Project directory the file and command tools are confined to.
    pub root: PathBuf,
    /// Native provider config (`kind`, `base_url`, `api_key`, ... or a `preset`).
    pub provider: Value,
    pub model: String,
    pub system: Option<String>,
    pub agent: String,
    pub session: String,
    pub max_turns: u32,
    /// Programs the agent may run (exact names, no shell). Empty disables `command_run`.
    pub allowed_programs: Vec<String>,
    pub mode: Mode,
}

/// Progress of a turn, in the order it happens.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Text(String),
    ToolStart {
        name: String,
        arguments: Value,
    },
    ToolDone {
        name: String,
        ok: bool,
    },
    /// A tool was not run (blocked by the mode or declined by the person).
    ToolDenied {
        name: String,
        reason: String,
    },
}

pub struct Host {
    handle: Arc<DurableEngineHandle>,
    provider: NativeProvider,
    tools: NativeTools,
    mode: Mutex<Mode>,
}

impl Host {
    pub fn open(config: HostConfig) -> Result<Self> {
        let mut tools_config = json!({"root": config.root});
        if !config.allowed_programs.is_empty() {
            tools_config["command"] = json!({"allowed_programs": config.allowed_programs});
        }
        let tools = NativeTools::from_json(tools_config)?;
        let provider = NativeProvider::from_json(&config.provider.to_string())?;
        let store = SessionStore::open(&config.db, "hivecode".to_owned())?;
        let engine = json!({
            "op": "create",
            "model": config.model,
            "system": config.system,
            "tools": tools.tool_definitions(),
            "max_turns": config.max_turns,
        });
        let handle = DurableEngineHandle::open(
            Arc::new(Mutex::new(Some(store))),
            config.agent,
            config.session,
            &engine.to_string(),
            false,
        )?;
        Ok(Self {
            handle: Arc::new(handle),
            provider,
            tools,
            mode: Mutex::new(config.mode),
        })
    }

    pub fn mode(&self) -> Mode {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Takes effect on the next tool call, including inside a turn that is already running.
    pub fn set_mode(&self, mode: Mode) {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner()) = mode;
    }

    async fn dispatch(&self, command: Value) -> Result<Value> {
        let handle = self.handle.clone();
        let reply =
            tokio::task::spawn_blocking(move || handle.dispatch(&command.to_string())).await??;
        Ok(serde_json::from_str(&reply)?)
    }

    /// Run one user turn to completion and return the final answer.
    pub async fn run(
        &self,
        prompt: &str,
        on_event: &mut (dyn FnMut(Event) + Send),
        approve: &mut (dyn FnMut(&str, &Value) -> bool + Send),
        cancel: &CancellationToken,
    ) -> Result<String> {
        let mut frame = self
            .dispatch(json!({"op": "begin_run", "prompt": prompt}))
            .await?;
        loop {
            let action: Action = serde_json::from_value(frame["action"].clone())?;
            match action {
                Action::Model { .. } => {
                    if cancel.is_cancelled() {
                        return Err("turn cancelled".into());
                    }
                    frame = self.dispatch(json!({"op": "claim"})).await?;
                    let Action::Model { request } =
                        serde_json::from_value(frame["action"].clone())?
                    else {
                        continue;
                    };
                    let execution_id = execution_id(&frame)?;
                    let stream = self.provider.start(request, true);
                    let mut reply = None;
                    loop {
                        let event = tokio::select! {
                            biased;
                            _ = cancel.cancelled() => {
                                stream.cancel();
                                return Err("turn cancelled; the model call stays pending".into());
                            }
                            event = stream.next() => event?,
                        };
                        match event {
                            Some(ModelEvent::TextDelta { text }) => on_event(Event::Text(text)),
                            Some(ModelEvent::Reply { reply: value }) => {
                                reply = Some(value);
                                break;
                            }
                            Some(_) => {}
                            None => break,
                        }
                    }
                    let reply = reply.ok_or("the provider closed without a final reply")?;
                    frame = self
                        .dispatch(json!({"op": "advance", "execution_id": execution_id,
                            "outcome": {"type": "model", "reply": reply}}))
                        .await?;
                }
                Action::Tool { call } => {
                    if cancel.is_cancelled() {
                        return Err("turn cancelled before the tool ran".into());
                    }
                    frame = self.dispatch(json!({"op": "claim"})).await?;
                    let execution_id = execution_id(&frame)?;
                    on_event(Event::ToolStart {
                        name: call.name.clone(),
                        arguments: call.arguments.clone(),
                    });
                    let denied = if !mutates(&call.name) {
                        None
                    } else {
                        match self.mode() {
                            Mode::Auto => None,
                            Mode::Plan => Some(
                                "plan mode does not allow changes; describe the change in your plan instead",
                            ),
                            Mode::Approval => (!approve(&call.name, &call.arguments))
                                .then_some("the person declined this tool call"),
                        }
                    };
                    let result = if let Some(reason) = denied {
                        on_event(Event::ToolDenied {
                            name: call.name.clone(),
                            reason: reason.into(),
                        });
                        json!({"ok": false, "error": reason})
                    } else {
                        let result = match self
                            .tools
                            .execute_tool(&call.name, call.arguments.clone(), cancel)
                            .await
                        {
                            Ok(value) => value,
                            Err(error) => json!({"ok": false, "error": error.to_string()}),
                        };
                        on_event(Event::ToolDone {
                            name: call.name.clone(),
                            ok: result["ok"] != false,
                        });
                        result
                    };
                    frame = self
                        .dispatch(json!({"op": "advance", "execution_id": execution_id,
                            "outcome": {"type": "tool", "result": result}}))
                        .await?;
                }
                Action::ToolRejected { .. } => {
                    frame = self.dispatch(json!({"op": "reject"})).await?;
                }
                Action::Complete { content, .. } => {
                    self.dispatch(json!({"op": "commit"})).await?;
                    return Ok(content);
                }
                Action::Stopped { reason, .. } => {
                    self.dispatch(json!({"op": "commit"})).await?;
                    return Err(format!("the SDK stopped the turn: {reason:?}").into());
                }
                Action::Idle => return Err("the SDK did not start the turn".into()),
            }
        }
    }
}

fn execution_id(frame: &Value) -> Result<String> {
    frame["operation"]["execution_id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "the frame carries no execution id".into())
}
