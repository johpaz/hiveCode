//! Talk to hivecode from Telegram: `hivecode telegram allow|deny|list|run`.
//!
//! `run` is a long-polling daemon on the bot configured with `hivecode notify telegram`. A message
//! from an allowed person becomes a task (`hivecode run` in a child process, so it is exactly what they
//! could type in a terminal: same worktree, integration and history) and the answer is sent back.
//!
//! Safety, because whoever can write to the bot drives an agent on this machine:
//! - the person is recognised by their numeric Telegram id, never by @username (which can change hands),
//!   and only ids in the allow list (`hivecode telegram allow ID`) are obeyed; everyone else is ignored;
//!   the one exception is `/myid`, which tells anyone their own id so they can be added;
//! - the mode is `plan` (read-only) unless the operator starts the daemon with `--mode auto`;
//!   `approval` does not exist here: there is nobody to ask;
//! - messages already waiting when the daemon starts are skipped (`--backlog` processes them);
//! - one task at a time, and a task is cut after `--timeout-minutes` (default 30).
use hivecode_config::{Secrets, default_secrets};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio, time::Duration};

const TOKEN: &str = "notify.telegram.token";
const ALLOW: &str = "notify.telegram.allow";
const MAX_REPLY: usize = 3800;

type Res = hivecode_host::Result<()>;

fn secrets() -> Box<dyn Secrets> {
    default_secrets(&|n| std::env::var(n).ok())
}

fn api() -> String {
    std::env::var("HIVECODE_TELEGRAM_API")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://api.telegram.org".into())
        .trim_end_matches('/')
        .to_owned()
}

fn allowed(store: &dyn Secrets) -> Vec<String> {
    store
        .get(ALLOW)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn take(args: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
    match args.iter().position(|a| a == name) {
        None => Ok(None),
        Some(i) if i + 1 < args.len() => {
            let value = args.remove(i + 1);
            args.remove(i);
            Ok(Some(value))
        }
        Some(_) => Err(format!("{name} necesita un valor")),
    }
}

/// An error with the token removed.
fn scrub(error: impl std::fmt::Display, token: &str) -> String {
    error.to_string().replace(token, "***")
}

async fn call(
    client: &reqwest::Client,
    token: &str,
    method: &str,
    body: Value,
) -> Result<Value, String> {
    let response = client
        .post(format!("{}/bot{token}/{method}", api()))
        .json(&body)
        .send()
        .await
        .map_err(|e| scrub(e, token))?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or_default();
    if status.is_success() && value["ok"] == true {
        Ok(value["result"].clone())
    } else {
        Err(format!(
            "Telegram {method}: {status} {}",
            value["description"].as_str().unwrap_or("")
        ))
    }
}

async fn reply(client: &reqwest::Client, token: &str, chat: &Value, text: &str) {
    let text: String = text.chars().take(MAX_REPLY).collect();
    if let Err(why) = call(
        client,
        token,
        "sendMessage",
        json!({"chat_id": chat, "text": text, "disable_web_page_preview": true}),
    )
    .await
    {
        eprintln!("⚠ no se pudo responder: {why}");
    }
}

pub struct Options {
    pub mode: String,
    pub root: PathBuf,
    pub swarm: bool,
    pub timeout: Duration,
}

/// What one message from an allowed person turns into: the child process's outcome as text.
async fn run_task(task: &str, options: &Options) -> String {
    let Ok(exe) = std::env::current_exe() else {
        return "❌ no encuentro el ejecutable de hivecode".into();
    };
    let mut command = tokio::process::Command::new(exe);
    command
        .args(["run", "--headless", "--mode", &options.mode, "--root"])
        .arg(&options.root);
    if options.swarm {
        command.arg("--swarm");
    }
    command
        .arg(task)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return format!("❌ no pude lanzar la tarea: {e}"),
    };
    let output = match tokio::time::timeout(options.timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return format!("❌ la tarea falló: {e}"),
        Err(_) => {
            return format!(
                "⏱ la tarea pasó de {} min y se cortó",
                options.timeout.as_secs() / 60
            );
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let done = stdout.lines().rev().find_map(|l| {
        serde_json::from_str::<Value>(l)
            .ok()
            .filter(|v| v["type"] == "done")
    });
    match (output.status.success(), done) {
        (true, Some(done)) => {
            let mut text = format!(
                "✅ {}",
                done["content"].as_str().unwrap_or("(sin respuesta)")
            );
            if done["integration"] == "integrated" {
                text.push_str(&format!(
                    "\n\n↳ cambios integrados · deshacer: hivecode rollback {}",
                    done["run_id"].as_str().unwrap_or("")
                ));
            }
            text
        }
        _ => {
            let err = String::from_utf8_lossy(&output.stderr);
            format!(
                "❌ {}",
                err.lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("la tarea terminó con error")
            )
        }
    }
}

/// Handles one update; returns whether it was a task (for tests and logs).
async fn handle(
    client: &reqwest::Client,
    token: &str,
    update: &Value,
    allow: &[String],
    options: &Options,
) {
    let message = &update["message"];
    let (Some(text), Some(from)) = (message["text"].as_str(), message["from"]["id"].as_i64())
    else {
        return;
    };
    let chat = &message["chat"]["id"];
    let from = from.to_string();
    let command = text
        .split_whitespace()
        .next()
        .unwrap_or("")
        .split('@')
        .next()
        .unwrap_or("");
    if command == "/myid" {
        reply(client, token, chat, &format!("Tu ID de Telegram es {from}. Pásaselo a quien administra hivecode: hivecode telegram allow {from}")).await;
        return;
    }
    if !allow.contains(&from) {
        eprintln!(
            "· ignorado: mensaje de {from}, que no está en la lista (hivecode telegram allow)"
        );
        return;
    }
    match command {
        "/start" | "/help" => {
            reply(client, token, chat, &format!("hivecode por Telegram. Escribe una tarea y la hago (modo {}{}). /myid muestra tu ID.", options.mode, if options.swarm { ", enjambre" } else { "" })).await
        }
        _ if text.trim().is_empty() => {}
        _ => {
            reply(client, token, chat, "⏳ trabajando…").await;
            let answer = run_task(text.trim(), options).await;
            reply(client, token, chat, &answer).await;
        }
    }
}

pub async fn command(mut args: Vec<String>) -> Res {
    let sub = if args.is_empty() {
        "list".to_owned()
    } else {
        args.remove(0)
    };
    let store = secrets();
    match sub.as_str() {
        "allow" | "deny" => {
            if args.is_empty() {
                return Err(format!(
                    "uso: hivecode telegram {sub} ID_NUMÉRICO… (el ID lo da /myid en el bot)"
                )
                .into());
            }
            let mut ids = allowed(store.as_ref());
            for raw in &args {
                let id = crate::notify::valid_chat(raw)
                    .filter(|i| !i.starts_with('-'))
                    .ok_or(format!(
                        "`{raw}` no es un ID de persona (numérico, positivo; no un @usuario)"
                    ))?;
                if sub == "allow" {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                } else {
                    ids.retain(|i| i != &id);
                }
            }
            if ids.is_empty() {
                store.delete(ALLOW)?
            } else {
                store.set(ALLOW, &ids.join(","))?
            }
            println!(
                "Lista de Telegram: {}",
                if ids.is_empty() {
                    "vacía".to_owned()
                } else {
                    ids.join(", ")
                }
            );
        }
        "list" => {
            let ids = allowed(store.as_ref());
            println!(
                "bot: {}",
                if store.get(TOKEN).is_some() {
                    "configurado (hivecode notify telegram)"
                } else {
                    "sin configurar"
                }
            );
            println!(
                "personas permitidas: {}",
                if ids.is_empty() {
                    "ninguna (hivecode telegram allow ID)".to_owned()
                } else {
                    ids.join(", ")
                }
            );
        }
        "run" => daemon(args, store.as_ref()).await?,
        other => {
            return Err(format!(
                "subcomando desconocido: telegram {other} (allow, deny, list, run)"
            )
            .into());
        }
    }
    Ok(())
}

async fn daemon(mut args: Vec<String>, store: &dyn Secrets) -> Res {
    let once = args
        .iter()
        .position(|a| a == "--once")
        .map(|i| args.remove(i))
        .is_some();
    let backlog = args
        .iter()
        .position(|a| a == "--backlog")
        .map(|i| args.remove(i))
        .is_some();
    let swarm = args
        .iter()
        .position(|a| a == "--swarm")
        .map(|i| args.remove(i))
        .is_some();
    let mode = take(&mut args, "--mode")?.unwrap_or_else(|| "plan".into());
    if !matches!(mode.as_str(), "plan" | "auto") {
        return Err("el modo es `plan` (solo lectura, por defecto) o `auto`: `approval` no tiene a quién preguntar por Telegram".into());
    }
    let root = std::fs::canonicalize(
        take(&mut args, "--root")?
            .map(PathBuf::from)
            .unwrap_or_else(|| ".".into()),
    )?;
    let poll: u64 = take(&mut args, "--poll-seconds")?
        .map(|v| v.parse())
        .transpose()
        .map_err(|_| "--poll-seconds: segundos")?
        .unwrap_or(25);
    let minutes: u64 = take(&mut args, "--timeout-minutes")?
        .map(|v| v.parse())
        .transpose()
        .map_err(|_| "--timeout-minutes: minutos")?
        .unwrap_or(30);
    if let Some(extra) = args.first() {
        return Err(format!("argumento inesperado: {extra}").into());
    }
    let token = store
        .get(TOKEN)
        .ok_or("no hay bot: hivecode notify telegram TOKEN CHAT_ID")?;
    let allow = allowed(store);
    if allow.is_empty() {
        eprintln!(
            "⚠ la lista está vacía: nadie será obedecido (hivecode telegram allow ID). /myid sí responde."
        );
    }
    let options = Options {
        mode,
        root,
        swarm,
        timeout: Duration::from_secs(minutes * 60),
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(poll + 15))
        .build()?;
    let me = call(&client, &token, "getMe", json!({})).await?;
    eprintln!(
        "hivecode telegram: @{} escuchando (modo {}, {} persona(s) permitida(s)). Ctrl+C para salir.",
        me["username"].as_str().unwrap_or("?"),
        options.mode,
        allow.len()
    );

    let mut offset: i64 = 0;
    if !backlog {
        // Skip what piled up while nobody was listening: an old "borra todo" must not run on startup.
        if let Ok(old) = call(
            &client,
            &token,
            "getUpdates",
            json!({"offset": -1, "timeout": 0}),
        )
        .await
        {
            offset = old
                .as_array()
                .and_then(|a| a.last())
                .and_then(|u| u["update_id"].as_i64())
                .map_or(0, |id| id + 1);
        }
    }
    loop {
        let updates = tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            updates = call(&client, &token, "getUpdates", json!({"offset": offset, "timeout": poll, "allowed_updates": ["message"]})) => updates,
        };
        match updates {
            Ok(updates) => {
                for update in updates.as_array().cloned().unwrap_or_default() {
                    offset = offset.max(update["update_id"].as_i64().unwrap_or(0) + 1);
                    // Always re-read the list: `hivecode telegram allow/deny` takes effect without a restart.
                    handle(&client, &token, &update, &allowed(store), &options).await;
                }
                if once {
                    return Ok(());
                }
            }
            Err(why) => {
                eprintln!("⚠ {why}; reintento en 5 s");
                if once {
                    return Err(why.into());
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
    Ok(())
}
