//! `hivecode` — Rust command line, built on the Hive Agents SDK.
//!
//! Stage 1 of the port (see docs/rust-port.md): one agent, one turn, real tools. The provider is
//! taken from flags/environment; the key is read from `HIVECODE_API_KEY`, never from argv.
mod commands;
mod cron;
mod tui;
mod tui_settings;
mod ui;
use hivecode_host::{Host, HostConfig, Mode};
use hivecode_store::{RunDoc, Store};
use hivecode_swarm::{Swarm, SwarmConfig, profiles};
use hivecode_tools::{AdrTools, GitTools, IndexTools, McpTools, VerifyTools, load_config};
use hivecode_workspace::{Integration, Workspaces};
use serde_json::json;
use std::path::PathBuf;
use ui::{Report, Terminal, Ui};

const USAGE: &str = "uso: hivecode provider list|presets|add|use|remove|key   hivecode mcp list|add|remove|enable|disable|test   hivecode onboard   hivecode cron add|list|enable|disable|run\n     hivecode doctor   hivecode init [--write]\n     hivecode [tui] [--model M] [--base-url URL] [--provider NOMBRE] [--preset ID] [--root DIR] [--mode ...]   (la TUI)\n     hivecode history [--limit N] [--json] [--db DIR]\n     hivecode rollback <id-de-corrida> [--db DIR]\n     hivecode run [--headless] [--model M] [--base-url URL] [--preset ID] \
[--root DIR] [--db DIR] [--resume ID | --recover ID] [--mode plan|approval|auto] [--context-window TOKENS] [--swarm] [--no-web] [--allow PROGRAMA]... <tarea>\n  \
clave del proveedor: variable HIVECODE_API_KEY\n";

#[derive(Clone)]
struct Args {
    headless: bool,
    model: Option<String>,
    base_url: Option<String>,
    preset: Option<String>,
    root: Option<PathBuf>,
    db: Option<PathBuf>,
    resume: Option<String>,
    /// Continue an interrupted run (implies `resume`): its unfinished turn is discarded and the task redone.
    recover: bool,
    allow: Vec<String>,
    no_web: bool,
    swarm: bool,
    mode: Option<Mode>,
    context_window: Option<u64>,
    /// A provider from `config.json` (the active one when omitted).
    provider_name: Option<String>,
    prompt: String,
}

fn parse(mut args: impl Iterator<Item = String>, need_task: bool) -> Result<Args, String> {
    let mut parsed = Args {
        headless: false,
        model: None,
        base_url: None,
        preset: None,
        root: None,
        db: None,
        resume: None,
        recover: false,
        allow: vec![],
        no_web: false,
        swarm: false,
        mode: None,
        context_window: None,
        provider_name: None,
        prompt: String::new(),
    };
    let mut words = vec![];
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or(format!("{name} necesita un valor"));
        match arg.as_str() {
            "--headless" => parsed.headless = true,
            "--no-web" => parsed.no_web = true,
            "--swarm" => parsed.swarm = true,
            "--model" => parsed.model = Some(value("--model")?),
            "--base-url" => parsed.base_url = Some(value("--base-url")?),
            "--preset" => parsed.preset = Some(value("--preset")?),
            "--provider" => parsed.provider_name = Some(value("--provider")?),
            "--root" => parsed.root = Some(value("--root")?.into()),
            "--resume" => parsed.resume = Some(value("--resume")?),
            "--recover" => {
                parsed.resume = Some(value("--recover")?);
                parsed.recover = true;
            }
            "--db" => parsed.db = Some(value("--db")?.into()),
            "--allow" => parsed.allow.push(value("--allow")?),
            "--context-window" => {
                parsed.context_window = Some(
                    value("--context-window")?
                        .parse()
                        .map_err(|_| "--context-window: número de tokens")?,
                );
            }
            "--mode" => {
                let text = value("--mode")?;
                parsed.mode = Some(Mode::parse(&text).ok_or("--mode: plan, approval o auto")?);
            }
            flag if flag.starts_with("--") => return Err(format!("opción desconocida: {flag}")),
            _ => words.push(arg),
        }
    }
    parsed.prompt = words.join(" ");
    if need_task && parsed.prompt.trim().is_empty() && !parsed.recover {
        return Err("falta la tarea".into());
    }
    Ok(parsed)
}

/// The mode lives in `<home>/execution_mode`, shared with the TS version; no file means `plan`.
pub(crate) fn home() -> PathBuf {
    std::env::var_os("HIVE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".hivecode")))
        .unwrap_or_else(|| PathBuf::from(".hivecode"))
}
fn saved_mode() -> Mode {
    std::fs::read_to_string(home().join("execution_mode"))
        .ok()
        .and_then(|text| Mode::parse(&text))
        .unwrap_or_default()
}

pub(crate) fn db_dir() -> PathBuf {
    std::env::var_os("HIVE_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HIVE_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".hivecode")))
                .unwrap_or_else(|| PathBuf::from(".hivecode"));
            home.join("data").join("rust")
        })
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next();
    // Without a command (or with `tui`) hivecode is the terminal UI.
    let tui_mode = matches!(first.as_deref(), None | Some("tui"))
        || first
            .as_deref()
            .is_some_and(|f| f.starts_with("--") && f != "--version");
    if tui_mode {
        let rest: Vec<String> = match first.as_deref() {
            Some("tui") | None => args.collect(),
            Some(flag) => std::iter::once(flag.to_owned()).chain(args).collect(),
        };
        match parse(rest.into_iter(), false) {
            Ok(base) => {
                if let Err(error) = tui::serve(base).await {
                    eprintln!("error: {error}");
                    std::process::exit(1);
                }
            }
            Err(message) => {
                eprintln!("{message}\n{USAGE}");
                std::process::exit(2);
            }
        }
        return;
    }
    match first.as_deref() {
        Some("run") => {}
        Some(
            command @ ("history" | "rollback" | "provider" | "mcp" | "doctor" | "init" | "onboard"
            | "cron"),
        ) => {
            let rest: Vec<String> = args.collect();
            let outcome = match command {
                "history" => history(&rest),
                "provider" => commands::provider(rest),
                "mcp" if rest.first().is_some_and(|a| a == "test") => {
                    commands::mcp_test(rest[1..].to_vec()).await
                }
                "mcp" => commands::mcp(rest),
                "onboard" => commands::onboard(),
                "cron" => cron::command(rest).await,
                "doctor" => commands::doctor(),
                "init" => commands::init(rest),
                _ => rollback(&rest).await,
            };
            if let Err(error) = outcome {
                eprintln!("error: {error}");
                std::process::exit(1);
            }
            return;
        }
        Some("--version" | "-V") => {
            println!("hivecode {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        _ => {
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    }
    let args = match parse(args, true) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            std::process::exit(2);
        }
    };
    let ui: std::sync::Arc<dyn Ui> = std::sync::Arc::new(Terminal {
        headless: args.headless,
    });
    if let Err(error) = run(args, ui, Default::default()).await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

async fn run(
    mut args: Args,
    ui: std::sync::Arc<dyn Ui>,
    cancel: hivecode_host::CancellationToken,
) -> hivecode_host::Result<()> {
    let settings = settings(&args)?;
    let (model, provider) = (settings.model.clone(), settings.provider.clone());
    // A run id sorts by start time and is unique even if the process id is reused.
    let started_ms = now_ms();
    let session = format!("run-{started_ms:013}-{}", std::process::id());
    // One database per process: the SDK sessions and hivecode's own history, reports and patches.
    let db = args.db.clone().unwrap_or_else(db_dir);
    let persistent = Store::open(&db)?;
    // Resuming continues the lead's conversation and the delegations of an earlier run; the work is
    // new (its own copy of the project, its own budget). The project is the earlier run's.
    let resumed = match args.resume.as_deref() {
        None => None,
        Some(id) => {
            let earlier = persistent
                .run(id)?
                .ok_or_else(|| format!("no existe la corrida {id} (mira hivecode history)"))?;
            if earlier.swarm && !args.swarm {
                args.swarm = true; // the lead has the same tools as before, or the session would not reopen
            } else if !earlier.swarm && args.swarm {
                return Err(format!("la corrida {id} se hizo sin --swarm: reanúdala igual").into());
            }
            if args.recover && earlier.status != "running" {
                return Err(format!(
                    "la corrida {id} no está interrumpida (estado: {}); para continuarla usa --resume",
                    earlier.status
                )
                .into());
            }
            if earlier.rolled_back {
                ui.note(&format!(
                    "⚠ la corrida {id} se deshizo: el líder aún recuerda cambios que ya no están"
                ));
            }
            Some(earlier)
        }
    };
    // What the lead is asked to do. After a recovery it is the interrupted run's own task, with a note
    // that its work is still in the project: the discarded turn is not in the lead's memory.
    let objective = match (&resumed, args.recover) {
        (Some(earlier), true) => earlier.objective.clone(),
        _ => args.prompt.clone(),
    };
    let task_prompt = if args.recover {
        let extra = if args.prompt.trim().is_empty() {
            String::new()
        } else {
            format!(
                "\nIndicaciones nuevas de la persona: {}",
                args.prompt.trim()
            )
        };
        format!(
            "La corrida anterior se interrumpió a mitad de un turno y ese turno se descartó: no recuerdas lo que hacías en él. \
             Lo que ya habías hecho en el proyecto se conservó tal cual estaba. Mira primero el estado actual \
             (git_status y git_diff) y continúa desde ahí, sin rehacer lo que ya está.{extra}\n\nTarea original:\n{objective}"
        )
    } else {
        args.prompt.clone()
    };
    let lead_session = resumed
        .as_ref()
        .map(|r| {
            if r.lead_session.is_empty() {
                r.id.clone()
            } else {
                r.lead_session.clone()
            }
        })
        .unwrap_or_else(|| session.clone());
    let mode = args.mode.unwrap_or_else(saved_mode);
    // A task that may change files works in its own git worktree and is integrated at the end;
    // `plan` only reads, so it uses the project directly.
    let session_id = session.clone();
    let project = match (&args.root, &resumed) {
        (Some(root), _) => std::fs::canonicalize(root)?,
        (None, Some(earlier)) => std::fs::canonicalize(&earlier.project)?,
        (None, None) => std::fs::canonicalize(std::env::current_dir()?)?,
    };
    let workspaces = Workspaces::in_temp_dir();
    if args.recover
        && let Some(earlier) = &resumed
    {
        // The SDK's explicit recovery: the unfinished turn of the lead (and of every worker it had)
        // is abandoned and the conversation goes back to what was committed before it. The
        // interrupted process must be gone; what its tools already did to the project is not undone.
        let store = persistent.sessions();
        let mut abandoned = hivecode_host::discard_unfinished(&store, "bee", &lead_session)?;
        for record in persistent.records_for(&lead_session).load() {
            let agent = record.worker.replace('#', "-");
            abandoned |=
                hivecode_host::discard_unfinished(&store, &agent, &record.session).unwrap_or(false);
        }
        persistent.record_run(&RunDoc {
            status: "abandoned".into(),
            ..earlier.clone()
        })?;
        ui.note(&format!(
            "· corrida {} descartada{}",
            earlier.id,
            if abandoned {
                " (se abandonó su turno inconcluso)"
            } else {
                " (no tenía un turno inconcluso)"
            }
        ));
    }
    // A recovered run keeps working in the copy the interrupted run left, with what it had done.
    let kept_copy = match (&resumed, args.recover) {
        (Some(earlier), true) => {
            let old = workspaces.assignment(&earlier.id, &project, mode != Mode::Plan);
            (old.isolated && old.worktree.is_dir()).then_some(old)
        }
        _ => None,
    };
    if args.recover && kept_copy.is_none() && mode != Mode::Plan {
        ui.note(
            "⚠ la copia de trabajo de la corrida interrumpida ya no existe: se empieza de cero",
        );
    }
    let reusing = kept_copy.is_some();
    let assignment =
        kept_copy.unwrap_or_else(|| workspaces.assignment(&session, &project, mode != Mode::Plan));
    if reusing {
        ui.note(&format!(
            "· se reutiliza la copia de trabajo de la corrida interrumpida: {}",
            assignment.worktree.display()
        ));
    } else if assignment.isolated {
        workspaces.prepare(&assignment, "HEAD").await.map_err(|e| {
            format!("{e}\n(los modos approval y auto necesitan un repositorio git con al menos un commit)")
        })?;
        ui.note(&format!(
            "· copia de trabajo: {}",
            assignment.worktree.display()
        ));
    }
    // The person's MCP servers (`<home>/mcp.json`). One that does not connect is reported and skipped.
    let servers = load_config(&home().join("mcp.json"), &|name| std::env::var(name).ok())?;
    let mcp = if servers.as_object().is_some_and(|s| !s.is_empty()) {
        let (tools, report) = McpTools::connect(servers).await?;
        if let Some(failed) = report["failed"].as_object() {
            for (name, why) in failed {
                ui.note(&format!("⚠ MCP «{name}» no conectó: {why}"));
            }
        }
        Some(std::sync::Arc::new(tools))
    } else {
        None
    };
    type Sets = Vec<std::sync::Arc<dyn hivecode_host::ToolSet>>;
    let tools_for = {
        let mcp = mcp.clone();
        move |root: &std::path::Path| -> Sets {
            let mut sets: Sets = vec![
                std::sync::Arc::new(GitTools::new(root)),
                std::sync::Arc::new(VerifyTools::new(root)),
                std::sync::Arc::new(IndexTools::new(root)),
                std::sync::Arc::new(AdrTools::new(root)),
            ];
            if let Some(mcp) = &mcp {
                sets.push(mcp.clone());
            }
            sets
        }
    };
    let mut extra_tools = tools_for(&assignment.worktree);
    let window = settings.window;
    let max_tool_calls = std::env::var("HIVECODE_AGENT_MAX_STEPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);
    let web = (!args.no_web).then(web_policy);
    // The record exists from the start: a run that is cut leaves it as "running", which is how
    // `hivecode history` knows it was interrupted and `--recover` finds it.
    let _ = persistent.record_run(&RunDoc {
        id: session_id.clone(),
        project: project.display().to_string(),
        objective: objective.chars().take(2000).collect(),
        mode: mode.as_str().to_owned(),
        swarm: args.swarm,
        lead_session: lead_session.clone(),
        resumed_from: resumed.as_ref().map(|r| r.id.clone()),
        started_ms,
        status: "running".into(),
        ..Default::default()
    });
    let mut system =
        "Eres hivecode, un agente de código. Trabaja dentro del proyecto con las herramientas \
         disponibles y responde de forma breve y exacta."
            .to_owned();
    let mut allowed_tools = None;
    let sessions = persistent.sessions();
    let store = Some(sessions.clone());
    let mut budget = None;
    // One budget for the whole run (the lead and every worker draw from it). It is on for the swarm,
    // where nothing else bounds the total, and for a plain run when a limit is asked for. The provider
    // must report token usage: the SDK stops a run whose usage it cannot account for.
    let limits = budget_limits();
    if args.swarm || limits.1 {
        let shared = sessions.clone();
        let id = format!("hivecode.run.{session}");
        hivecode_host::open_budget(&shared, &id, &limits.0)?;
        budget = Some(hivecode_host::Budget {
            objective_id: id,
            depth: 0,
        });
    }
    if args.swarm {
        // BEE leads; workers run in their own sessions of the same store.
        let shared = sessions.clone();
        let lead = profiles::find(profiles::LEAD).expect("the lead profile exists");
        system = lead.prompt.to_owned();
        let mut names: Vec<String> = lead.tools.iter().map(|t| t.to_string()).collect();
        if let Some(mcp) = &mcp {
            names.extend(
                hivecode_host::ToolSet::definitions(mcp.as_ref())
                    .into_iter()
                    .map(|t| t.name),
            );
        }
        allowed_tools = Some(names);
        let swarm = Swarm::new(SwarmConfig {
            store: shared.clone(),
            budget: budget.clone(),
            provider: provider.clone(),
            model: model.clone(),
            context_window: window,
            max_tool_calls,
            web: web.clone(),
            allowed_programs: args.allow.clone(),
            mode,
            session: session.clone(),
            root: assignment.worktree.clone(),
            workspaces: Workspaces::in_temp_dir(),
            tools_for: std::sync::Arc::new(tools_for),
            approve: {
                let ui = ui.clone();
                std::sync::Arc::new(move |name, arguments| ui.approve(name, arguments))
            },
            lifecycle: Some({
                let ui = ui.clone();
                std::sync::Arc::new(move |event| ui.swarm(event))
            }),
            findings: Some(persistent.findings_for(&project.display().to_string())),
            records: Some(persistent.records_for(&lead_session)),
            observe: Some({
                let ui = ui.clone();
                std::sync::Arc::new(move |worker, event| ui.event(Some(worker), event))
            }),
        });
        extra_tools.push(std::sync::Arc::new(swarm));
    }
    let budget_for_report = budget.clone().zip(store.clone());
    let host = Host::open(HostConfig {
        db: db.clone(),
        root: assignment.worktree.clone(),
        provider,
        model,
        system: Some(system),
        agent: "bee".into(),
        session: lead_session.clone(),
        max_turns: 24,
        allowed_programs: args.allow,
        mode,
        context_window: window,
        extra_tools,
        store,
        budget,
        allowed_tools,
        web,
        max_tool_calls,
    })
    .map_err(|e| -> hivecode_host::Error {
        let text = e.to_string();
        if text.contains("SESSION_CONFIG_MISMATCH") {
            "la corrida se hizo con otras opciones (modelo, --swarm, --no-web, servidores MCP o --context-window): repítelas igual para reanudarla".into()
        } else if text.contains("SESSION_INTERRUPTED") {
            "esa corrida se interrumpió a mitad de un turno y necesita recuperación explícita (todavía no está en hivecode)".into()
        } else {
            e
        }
    })?;
    // The swarm runs through the harness: it weighs the task, picks the route and verifies the
    // result. A plain run is one agent, one turn.
    let (answer, route) = if args.swarm {
        let mut lead = HostLead {
            host: &host,
            ui: ui.clone(),
            cancel: cancel.clone(),
        };
        let outcome = hivecode_harness::run(
            &task_prompt,
            &hivecode_harness::Options {
                workspace: assignment.worktree.clone(),
                mode,
                swarm: true,
                verify: true,
            },
            &mut lead,
            &mut |gate, text| ui.gate(gate, text),
        )
        .await?;
        {
            ui.note(&format!(
                "· ruta {} ({:?}), {} ciclo(s) de reparación",
                outcome.route.as_str(),
                outcome.status,
                outcome.repair_cycles
            ));
        }
        let route = json!({
            "route": outcome.route.as_str(), "signals": outcome.signals,
            "status": format!("{:?}", outcome.status).to_lowercase(),
            "repair_cycles": outcome.repair_cycles,
        });
        (outcome.response, Some(route))
    } else {
        let answer = host
            .run(
                &task_prompt,
                &mut |event| ui.event(None, &event),
                &mut |name, arguments| ui.approve(name, arguments),
                &cancel,
            )
            .await?;
        (answer, None)
    };
    if let Some(mcp) = &mcp {
        mcp.close().await;
    }
    let integration = workspaces.integrate(&assignment).await;
    let patch = match &integration {
        Integration::Integrated { diff } => Some(diff.clone()),
        _ => None,
    };
    // How risky the changes were, by the project's own architecture decisions (`adrs/`).
    let risks: Vec<serde_json::Value> = match &patch {
        Some(diff) => {
            let adrs = hivecode_adr::load(&project);
            hivecode_adr::files_in_diff(diff)
                .iter()
                .map(|file| hivecode_adr::assess(&adrs, file))
                .filter(|a| a.risk >= hivecode_adr::Risk::High)
                .map(|a| {
                    json!({"path": a.file, "risk": a.risk.as_str(), "reason": a.reason,
                    "adr": a.adr.map(|f| f.display().to_string())})
                })
                .collect()
        }
        None => vec![],
    };
    for risk in &risks {
        ui.note(&format!(
            "⚠ riesgo {}: {} — {}",
            risk["risk"].as_str().unwrap_or(""),
            risk["path"].as_str().unwrap_or(""),
            risk["reason"].as_str().unwrap_or("")
        ));
    }
    let (status, note) = match &integration {
        Integration::Integrated { .. } => ("integrated", String::new()),
        Integration::Noop => ("noop", String::new()),
        Integration::Conflict { error, .. } => ("conflict", error.clone()),
        Integration::Failed { error } => ("failed", error.clone()),
    };
    // Only a finished integration removes the copy; otherwise it stays for inspection.
    if matches!(
        integration,
        Integration::Integrated { .. } | Integration::Noop
    ) {
        workspaces.cleanup(&assignment).await?;
    } else {
        ui.note(&format!(
            "⚠ no se pudo integrar ({status}): {note}\n  el trabajo queda en {}",
            assignment.worktree.display()
        ));
    }
    let used = budget_for_report
        .and_then(|(b, store)| hivecode_host::budget_snapshot(&store, &b.objective_id).ok());
    // The run is recorded, and what it integrated is kept so `hivecode rollback` can undo it. A
    // failure to record never turns a finished run into an error.
    let has_patch = match &patch {
        Some(diff) => persistent
            .save_patch(&session_id, &project.display().to_string(), diff)
            .unwrap_or(false),
        None => false,
    };
    let recorded = persistent.record_run(&RunDoc {
        id: session_id.clone(),
        project: project.display().to_string(),
        objective: objective.chars().take(2000).collect(),
        mode: mode.as_str().to_owned(),
        swarm: args.swarm,
        lead_session: lead_session.clone(),
        resumed_from: resumed.as_ref().map(|r| r.id.clone()),
        started_ms,
        finished_ms: now_ms(),
        status: route
            .as_ref()
            .and_then(|r| r["status"].as_str())
            .unwrap_or("completed")
            .to_owned(),
        route: route
            .as_ref()
            .and_then(|r| r["route"].as_str())
            .map(str::to_owned),
        repair_cycles: route
            .as_ref()
            .and_then(|r| r["repair_cycles"].as_u64())
            .unwrap_or(0) as u32,
        integration: status.to_owned(),
        budget: used.clone(),
        response: answer.chars().take(2000).collect(),
        has_patch,
        rolled_back: false,
    });
    if let Err(error) = recorded {
        ui.note(&format!("⚠ no se pudo guardar el historial: {error}"));
    }
    ui.done(&Report {
        run_id: session_id,
        answer,
        integration: status.to_owned(),
        budget: used,
        harness: route,
        undoable: has_patch,
        risks,
        objective: objective.chars().take(120).collect(),
        changed: patch
            .as_deref()
            .map(hivecode_adr::files_in_diff)
            .unwrap_or_default(),
    });
    Ok(())
}

/// `web_fetch` is on by default (public hosts only, as the SDK enforces); `web_search` needs a
/// Brave key in `HIVECODE_BRAVE_API_KEY` (there is no scraping fallback).
fn web_policy() -> serde_json::Value {
    let mut policy = json!({});
    if let Ok(key) = std::env::var("HIVECODE_BRAVE_API_KEY")
        && !key.is_empty()
    {
        policy["search"] = json!({"kind": "brave", "api_key": key});
    }
    policy
}

/// The run budget from `HIVECODE_BUDGET_*` (model calls, tool calls, total output tokens, minutes);
/// the flag says whether any of them was set.
fn budget_limits() -> (hivecode_host::BudgetLimits, bool) {
    let env = |name: &str| std::env::var(name).ok().and_then(|v| v.parse::<u64>().ok());
    let mut limits = hivecode_host::BudgetLimits::default();
    let mut any = false;
    if let Some(v) = env("HIVECODE_BUDGET_MODEL_CALLS") {
        limits.max_model_calls = v as u32;
        any = true;
    }
    if let Some(v) = env("HIVECODE_BUDGET_TOOL_CALLS") {
        limits.max_tool_calls = v as u32;
        any = true;
    }
    if let Some(v) = env("HIVECODE_BUDGET_OUTPUT_TOKENS") {
        limits.max_total_output_tokens = v;
        any = true;
    }
    if let Some(v) = env("HIVECODE_BUDGET_MINUTES") {
        limits.max_run_ms = Some(v * 60_000);
        any = true;
    }
    (limits, any)
}

/// Runs the lead agent for the harness, showing what it does.
struct HostLead<'h> {
    host: &'h Host,
    ui: std::sync::Arc<dyn Ui>,
    cancel: hivecode_host::CancellationToken,
}
impl hivecode_harness::Lead for HostLead<'_> {
    fn invoke<'a>(
        &'a mut self,
        prompt: String,
    ) -> hivecode_host::BoxFuture<'a, hivecode_host::Result<String>> {
        Box::pin(async move {
            let ui = self.ui.clone();
            let approve_ui = self.ui.clone();
            self.host
                .run(
                    &prompt,
                    &mut |event| ui.event(None, &event),
                    &mut |name, arguments| approve_ui.approve(name, arguments),
                    &self.cancel,
                )
                .await
        })
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// `--db DIR` (anywhere in the arguments) or the default database; the rest, in order.
fn split_db(args: &[String]) -> (PathBuf, Vec<String>) {
    let mut db = None;
    let mut rest = vec![];
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--db" {
            db = iter.next().map(PathBuf::from);
        } else {
            rest.push(arg.clone());
        }
    }
    (db.unwrap_or_else(db_dir), rest)
}

/// `hivecode history`: the newest runs first.
fn history(args: &[String]) -> hivecode_host::Result<()> {
    let (db, rest) = split_db(args);
    let json_out = rest.iter().any(|a| a == "--json");
    let limit = rest
        .iter()
        .position(|a| a == "--limit")
        .and_then(|i| rest.get(i + 1))
        .map(|v| v.parse::<usize>().map_err(|_| "--limit: un número"))
        .transpose()?
        .unwrap_or(20);
    let runs = Store::open(&db)?.runs(limit)?;
    if json_out {
        println!("{}", serde_json::to_string(&runs)?);
        return Ok(());
    }
    if runs.is_empty() {
        println!("Sin corridas todavía.");
    }
    for run in runs {
        let marks = format!(
            "{}{}{}",
            if run.status == "running" {
                format!(" ⚠ interrumpida: hivecode run --recover {}", run.id)
            } else {
                String::new()
            },
            if run.rolled_back {
                " ↩ deshecha"
            } else if run.has_patch {
                " ⟲ se puede deshacer"
            } else {
                ""
            },
            run.route
                .as_deref()
                .map(|r| format!(" · {r}"))
                .unwrap_or_default()
        );
        let objective: String = run
            .objective
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(70)
            .collect();
        println!(
            "{}  {:<10} {:<10}{marks}\n    {objective}",
            run.id, run.status, run.integration
        );
    }
    Ok(())
}

/// `hivecode rollback <run>`: undoes what a run integrated into its project.
async fn rollback(args: &[String]) -> hivecode_host::Result<()> {
    let (db, rest) = split_db(args);
    let id = rest
        .first()
        .ok_or("indica la corrida: hivecode rollback <id> (mira hivecode history)")?;
    let store = Store::open(&db)?;
    let (project, _) = undo_run(&store, id).await?;
    println!("Deshecha la corrida {id} en {project}.");
    Ok(())
}

/// Undoes what a run integrated (the CLI and the TUI share this). Returns the project and how many
/// files the patch touched.
pub(crate) async fn undo_run(store: &Store, id: &str) -> hivecode_host::Result<(String, usize)> {
    let run = store
        .run(id)?
        .ok_or_else(|| format!("no existe la corrida {id}"))?;
    if run.rolled_back {
        return Err(format!("la corrida {id} ya se deshizo").into());
    }
    let patch = store.patch(id)?.ok_or_else(|| {
        format!("la corrida {id} no dejó cambios que deshacer (no integró nada, o eran demasiado grandes para guardarse)")
    })?;
    Workspaces::in_temp_dir()
        .revert(std::path::Path::new(&patch.project), &patch.diff)
        .await?;
    store.mark_rolled_back(id)?;
    let files = hivecode_adr::files_in_diff(&patch.diff).len();
    Ok((patch.project, files))
}

/// What a run needs from the providers: flags win over the environment, which wins over the
/// provider in `config.json` (the active one, or `--provider`).
struct Settings {
    model: String,
    provider: serde_json::Value,
    window: Option<u64>,
}

fn settings(args: &Args) -> hivecode_host::Result<Settings> {
    let env = |name: &str| std::env::var(name).ok();
    let config = hivecode_config::Config::load(&home())?;
    let resolved = config.resolve(args.provider_name.as_deref())?;
    let configured = resolved.as_ref().map(|r| &r.provider);
    let model = args
        .model
        .clone()
        .or_else(|| env("HIVECODE_MODEL"))
        .or_else(|| configured.and_then(|p| p.model.clone()))
        .ok_or("indica el modelo con --model o HIVECODE_MODEL, o configura un proveedor: hivecode provider add")?;
    let mut provider = json!({});
    if let Some(preset) = args
        .preset
        .clone()
        .or_else(|| configured.and_then(|p| p.preset.clone()))
    {
        provider["preset"] = json!(preset);
    }
    if let Some(url) = args
        .base_url
        .clone()
        .or_else(|| env("HIVECODE_BASE_URL"))
        .or_else(|| configured.and_then(|p| p.base_url.clone()))
    {
        provider["base_url"] = json!(url);
    }
    // The keyring is asked only when the environment has no key.
    if let Some((key, _)) = hivecode_config::find_key(
        resolved.as_ref(),
        hivecode_config::default_secrets(&env).as_ref(),
        &env,
    ) {
        provider["api_key"] = json!(key);
    }
    let window = args
        .context_window
        .or_else(|| env("HIVECODE_CONTEXT_WINDOW").and_then(|v| v.parse().ok()))
        .or_else(|| configured.and_then(|p| p.context_window));
    Ok(Settings {
        model,
        provider,
        window,
    })
}
