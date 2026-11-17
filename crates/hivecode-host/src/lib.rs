//! Agent-loop host for hivecode.
//!
//! The SDK engine is sans-I/O: it says what to do next (call the model, run a tool, finish) and
//! the host does it. This crate is that host for hivecode. It owns the durable session, the
//! provider and the sandboxed tools, and drives one turn at a time, reporting progress through a
//! callback so a terminal UI, a headless NDJSON stream or a test can all render it.
pub use hive_agent_core::provider::CancellationToken;
use hive_agent_core::{
    Action, Tool,
    durable_handle::DurableEngineHandle,
    provider::{ModelEvent, NativeProvider},
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

/// A session store several hosts can share (the lead and its workers use one).
pub type Store = Arc<Mutex<Option<SessionStore>>>;

/// Opens the HiveDB session store at `path`. Open it once per process and share it.
pub fn open_store(path: &std::path::Path) -> Result<Store> {
    Ok(Arc::new(Mutex::new(Some(SessionStore::open(
        path,
        "hivecode".to_owned(),
    )?))))
}

pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Tools the host offers besides the SDK's own (`fs_*`, `command_run`, ...). The host advertises
/// their definitions, asks `mutates` before running one (the mode decides), and runs them.
pub trait ToolSet: Send + Sync {
    fn definitions(&self) -> Vec<Tool>;
    /// Whether this call changes anything (it may depend on the arguments, e.g. `git_branch`).
    fn mutates(&self, name: &str, arguments: &Value) -> bool;
    fn execute<'a>(
        &'a self,
        name: &'a str,
        arguments: Value,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Value>>;
}

/// The shared budget an agent draws from: an SDK objective in the store, and the agent's depth in it
/// (0 for the lead, 1 for workers).
#[derive(Debug, Clone)]
pub struct Budget {
    pub objective_id: String,
    pub depth: u32,
}

/// Limits for a whole run (the lead and every worker together). The SDK defaults (8 model calls, 16
/// tool calls) are made for a chat turn, not for code work, so hivecode sets its own.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetLimits {
    pub max_model_calls: u32,
    pub max_tool_calls: u32,
    /// Output tokens one model call may use.
    pub max_output_tokens: u64,
    /// Output tokens for the whole run.
    pub max_total_output_tokens: u64,
    /// Wall-clock limit for the whole run, in milliseconds.
    pub max_run_ms: Option<u64>,
}
impl Default for BudgetLimits {
    fn default() -> Self {
        Self {
            max_model_calls: 400,
            max_tool_calls: 2000,
            max_output_tokens: 32_768,
            max_total_output_tokens: 1_000_000,
            max_run_ms: None,
        }
    }
}

/// Opens (or reopens) the root budget `id` in the store and returns its snapshot.
pub fn open_budget(store: &Store, id: &str, limits: &BudgetLimits) -> Result<Value> {
    let policy = serde_json::from_value(json!({
        "max_model_calls": limits.max_model_calls,
        "max_tool_calls": limits.max_tool_calls,
        "max_depth": 2,
        "max_output_tokens": limits.max_output_tokens,
        "max_total_output_tokens": limits.max_total_output_tokens,
        "max_run_ms": limits.max_run_ms,
    }))?;
    let guard = store.lock().map_err(|_| "store lock poisoned")?;
    let store = guard.as_ref().ok_or("the store is closed")?;
    Ok(store.open_objective(id, policy)?)
}

/// Abandons an unfinished turn of a session (the SDK's explicit recovery): the conversation goes back to
/// what was committed before the turn, and the abandoned turn stays on record. Returns whether there
/// was anything to abandon. It does not undo effects of the tools the turn already ran, and the
/// original process must have stopped.
pub fn discard_unfinished(store: &Store, agent: &str, session: &str) -> Result<bool> {
    let guard = store.lock().map_err(|_| "store lock poisoned")?;
    let store = guard.as_ref().ok_or("the store is closed")?;
    match store.recover(agent, session) {
        Ok(_) => Ok(true),
        Err(e) => {
            let text = e.to_string();
            // Nothing to recover: the session is not mid-turn, or it never existed.
            if text.contains("does not need recovery") || text.contains("does not exist") {
                Ok(false)
            } else {
                Err(e.into())
            }
        }
    }
}

/// What the run has used so far (the SDK's own snapshot: calls granted, tokens, whether it stopped).
pub fn budget_snapshot(store: &Store, id: &str) -> Result<Value> {
    let guard = store.lock().map_err(|_| "store lock poisoned")?;
    let store = guard.as_ref().ok_or("the store is closed")?;
    Ok(store.inspect_objective(id)?)
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
    /// The model's context window in tokens. When known, the SDK keeps each request inside it by
    /// dropping the oldest whole turns (nothing is summarised by a model, nothing is deleted from
    /// the stored history). Unknown means no limit is enforced.
    pub context_window: Option<u64>,
    /// Tool calls allowed in one turn (`HIVECODE_AGENT_MAX_STEPS` in the TS version).
    pub max_tool_calls: u32,
    /// The SDK's web policy (`web_fetch`, and `web_search` when a search backend is given), e.g.
    /// `{"search": {"kind": "brave", "api_key": "..."}}`. None leaves the web tools out. By default
    /// only public hosts are reachable; `allow_private_hosts` opens loopback and the LAN.
    pub web: Option<Value>,
    /// Share an already open store instead of opening `db`.
    pub store: Option<Store>,
    /// Draw from a shared budget (see [`open_budget`]). None leaves only the agent's own limits.
    pub budget: Option<Budget>,
    /// When set, only these tool names are offered (a profile's allowlist). The engine rejects any
    /// call to a tool it was not given, so this is also what is enforced.
    pub allowed_tools: Option<Vec<String>>,
    /// Extra tool sets, after the SDK's own.
    pub extra_tools: Vec<Arc<dyn ToolSet>>,
}

/// Share of the window the request may fill; the rest is for the answer.
const INPUT_SHARE_PERCENT: u64 = 80;

/// The SDK loop policy for these settings.
pub fn loop_policy(window: Option<u64>, max_tool_calls: u32) -> Value {
    let mut policy = json!({"max_tool_calls": max_tool_calls});
    if let Some(window) = window {
        policy["input_token_budget"] = json!({
            "encoding": "o200k_base",
            "framing": "openai_chat_json",
            "max_tokens": window * INPUT_SHARE_PERCENT / 100,
        });
        policy["context_overflow"] = json!("drop_oldest_turns");
    }
    policy
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
    extra: Vec<Arc<dyn ToolSet>>,
    mode: Mutex<Mode>,
    budget: Option<Budget>,
}

impl Host {
    pub fn open(config: HostConfig) -> Result<Self> {
        let mut tools_config = json!({"root": config.root});
        if !config.allowed_programs.is_empty() {
            tools_config["command"] = json!({"allowed_programs": config.allowed_programs});
        }
        if let Some(web) = &config.web {
            tools_config["web"] = web.clone();
        }
        let tools = NativeTools::from_json(tools_config)?;
        let provider = NativeProvider::from_json(&config.provider.to_string())?;
        let mut definitions = tools.tool_definitions();
        for set in &config.extra_tools {
            definitions.extend(set.definitions());
        }
        if let Some(allowed) = &config.allowed_tools {
            definitions.retain(|tool| allowed.contains(&tool.name));
        }
        let store = match config.store {
            Some(store) => store,
            None => open_store(&config.db)?,
        };
        let engine = json!({
            "op": "create",
            "model": config.model,
            "system": config.system,
            "tools": definitions,
            "max_turns": config.max_turns,
            "policy": loop_policy(config.context_window, config.max_tool_calls),
        });
        let handle = DurableEngineHandle::open(
            store,
            config.agent,
            config.session,
            &engine.to_string(),
            false,
        )?;
        Ok(Self {
            handle: Arc::new(handle),
            provider,
            tools,
            extra: config.extra_tools,
            mode: Mutex::new(config.mode),
            budget: config.budget,
        })
    }

    /// The whole stored conversation, including turns the context window leaves out of requests.
    pub async fn messages(&self) -> Result<Vec<Value>> {
        let all = self.dispatch(json!({"op": "messages"})).await?;
        Ok(all.as_array().cloned().unwrap_or_default())
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
        let mut begin = json!({"op": "begin_run", "prompt": prompt});
        if let Some(budget) = &self.budget {
            begin["objective_id"] = json!(budget.objective_id);
            begin["objective_depth"] = json!(budget.depth);
        }
        let mut frame = self.dispatch(begin).await?;
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
                    let extra = self
                        .extra
                        .iter()
                        .find(|set| set.definitions().iter().any(|t| t.name == call.name));
                    let changes = match extra {
                        Some(set) => set.mutates(&call.name, &call.arguments),
                        None => mutates(&call.name),
                    };
                    let denied = if !changes {
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
                        let outcome = match extra {
                            Some(set) => {
                                set.execute(&call.name, call.arguments.clone(), cancel)
                                    .await
                            }
                            None => self
                                .tools
                                .execute_tool(&call.name, call.arguments.clone(), cancel)
                                .await
                                .map_err(Into::into),
                        };
                        let result = match outcome {
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
