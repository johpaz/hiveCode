//! Outbound notifications: a Telegram bot message and/or a webhook when a task ends.
//!
//! `hivecode notify telegram TOKEN CHAT_ID | webhook URL | status | test | remove telegram|webhook`.
//! The token and the webhook URL (which often carries a secret) go to the secret store (keyring, or
//! the `0600` file of `HIVECODE_SECRETS_FILE`), never to `config.json` or a log. Errors are scrubbed of
//! them before they are shown. This is one-way: hivecode tells you, it does not take orders from the chat.
use hivecode_config::{Secrets, default_secrets};
use std::time::Duration;

const TOKEN: &str = "notify.telegram.token";
const CHAT: &str = "notify.telegram.chat";
const WEBHOOK: &str = "notify.webhook.url";
/// Telegram refuses messages over 4096 characters.
const MAX_TEXT: usize = 4000;

type Res = hivecode_host::Result<()>;

fn secrets() -> Box<dyn Secrets> {
    default_secrets(&|n| std::env::var(n).ok())
}

/// The Telegram API root; overridable so tests (and a self-hosted Bot API server) can point elsewhere.
fn telegram_api() -> String {
    std::env::var("HIVECODE_TELEGRAM_API")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://api.telegram.org".into())
        .trim_end_matches('/')
        .to_owned()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

/// An error with every secret removed from its text.
fn scrub(error: impl std::fmt::Display, secrets: &[&str]) -> String {
    let mut text = error.to_string();
    for secret in secrets.iter().filter(|s| s.len() >= 6) {
        text = text.replace(secret, "***");
    }
    text
}

/// `123456789:ABC…` as BotFather issues them.
pub fn valid_token(token: &str) -> bool {
    match token.split_once(':') {
        Some((id, rest)) => {
            id.len() >= 5
                && id.chars().all(|c| c.is_ascii_digit())
                && rest.len() >= 30
                && rest
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        }
        None => false,
    }
}

/// A numeric chat id (`123`, `-100123…` for groups); `tg:` is accepted as a prefix.
pub fn valid_chat(chat: &str) -> Option<String> {
    let id = chat.strip_prefix("tg:").unwrap_or(chat);
    let digits = id.strip_prefix('-').unwrap_or(id);
    (digits.len() >= 3 && digits.chars().all(|c| c.is_ascii_digit())).then(|| id.to_owned())
}

async fn bot_name(token: &str) -> Result<String, String> {
    let url = format!("{}/bot{token}/getMe", telegram_api());
    let response = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| scrub(e, &[token]))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    if status.is_success() && body["ok"] == true {
        return Ok(body["result"]["username"]
            .as_str()
            .unwrap_or("?")
            .to_owned());
    }
    if status.as_u16() == 401 || status.as_u16() == 404 {
        return Err("Telegram rechazó el token (pide uno nuevo en @BotFather)".into());
    }
    Err(format!(
        "Telegram respondió {status}: {}",
        body["description"].as_str().unwrap_or("sin detalle")
    ))
}

async fn send_telegram(token: &str, chat: &str, text: &str) -> Result<(), String> {
    let url = format!("{}/bot{token}/sendMessage", telegram_api());
    let body = serde_json::json!({"chat_id": chat, "text": text, "disable_web_page_preview": true});
    let response = client()?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| scrub(e, &[token]))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let detail: serde_json::Value = response.json().await.unwrap_or_default();
    Err(format!(
        "Telegram respondió {status}: {}",
        detail["description"].as_str().unwrap_or("sin detalle")
    ))
}

async fn send_webhook(url: &str, text: &str) -> Result<(), String> {
    let body = serde_json::json!({"source": "hivecode", "text": text});
    let response = client()?
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| scrub(e, &[url]))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("el webhook respondió {}", response.status()))
    }
}

/// Sends `text` to every configured destination; returns `(destination, outcome)` for each. With none
/// configured, an empty list: not an error, a task must never fail because nobody asked to be told.
pub async fn send(text: &str) -> Vec<(&'static str, Result<(), String>)> {
    let secrets = secrets();
    let text: String = text.chars().take(MAX_TEXT).collect();
    let mut sent = Vec::new();
    if let (Some(token), Some(chat)) = (secrets.get(TOKEN), secrets.get(CHAT)) {
        sent.push(("telegram", send_telegram(&token, &chat, &text).await));
    }
    if let Some(url) = secrets.get(WEBHOOK) {
        sent.push(("webhook", send_webhook(&url, &text).await));
    }
    sent
}

/// What a finished run says, in a few lines.
pub fn run_message(
    label: &str,
    objective: &str,
    status: &str,
    integration: &str,
    run_id: &str,
    detail: &str,
) -> String {
    let icon = if status == "completed" || status == "ready" {
        "✅"
    } else {
        "❌"
    };
    let first = objective
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(160)
        .collect::<String>();
    let mut text = format!(
        "{icon} hivecode · {label}\n{first}\nestado: {status} · cambios: {integration}\n{run_id}"
    );
    if !detail.trim().is_empty() {
        text.push_str("\n\n");
        text.push_str(&detail.chars().take(1500).collect::<String>());
    }
    text
}

/// Sends and reports on stderr what failed (a failed notification never fails the task).
pub async fn announce(text: &str) {
    for (to, outcome) in send(text).await {
        if let Err(why) = outcome {
            eprintln!("⚠ no se pudo avisar por {to}: {why}");
        }
    }
}

pub async fn command(mut args: Vec<String>) -> Res {
    let sub = if args.is_empty() {
        "status".to_owned()
    } else {
        args.remove(0)
    };
    let store = secrets();
    match sub.as_str() {
        "telegram" => {
            let (token, chat) = match args.as_slice() {
                [t, c] => (t.trim().to_owned(), c.trim().to_owned()),
                _ => return Err("uso: hivecode notify telegram TOKEN_DE_BOTFATHER CHAT_ID (tu ID numérico: escribe /myid a @userinfobot)".into()),
            };
            if !valid_token(&token) {
                return Err(
                    "el token no tiene el formato de BotFather (123456789:ABC-DEF…)".into(),
                );
            }
            let chat = valid_chat(&chat).ok_or("el chat debe ser un ID numérico (no un @usuario): Telegram identifica a las personas por su ID")?;
            let username = bot_name(&token).await?;
            store.set(TOKEN, &token)?;
            store.set(CHAT, &chat)?;
            println!(
                "Telegram listo: bot @{username} → chat {chat}. Prueba con `hivecode notify test`."
            );
            println!(
                "(Escríbele antes algo al bot: Telegram no deja que un bot inicie la conversación.)"
            );
        }
        "webhook" => {
            let url = args.first().ok_or("uso: hivecode notify webhook URL")?;
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err("la URL debe empezar por http:// o https://".into());
            }
            store.set(WEBHOOK, url)?;
            println!("Webhook guardado (la URL no se muestra: suele llevar un secreto).");
        }
        "remove" => match args.first().map(String::as_str) {
            Some("telegram") => {
                store.delete(TOKEN)?;
                store.delete(CHAT)?;
                println!("Telegram eliminado.");
            }
            Some("webhook") => {
                store.delete(WEBHOOK)?;
                println!("Webhook eliminado.");
            }
            _ => return Err("uso: hivecode notify remove telegram|webhook".into()),
        },
        "status" => {
            let telegram = store.get(TOKEN).is_some() && store.get(CHAT).is_some();
            let chat = store.get(CHAT).unwrap_or_default();
            println!(
                "telegram: {}",
                if telegram {
                    format!("configurado (chat {chat})")
                } else {
                    "no".into()
                }
            );
            println!(
                "webhook:  {}",
                if store.get(WEBHOOK).is_some() {
                    "configurado"
                } else {
                    "no"
                }
            );
        }
        "test" => {
            let results = send("🔔 hivecode: prueba de notificación").await;
            if results.is_empty() {
                return Err(
                    "no hay destinos: hivecode notify telegram … o hivecode notify webhook …"
                        .into(),
                );
            }
            let mut failed = false;
            for (to, outcome) in results {
                match outcome {
                    Ok(()) => println!("✓ {to}"),
                    Err(why) => {
                        failed = true;
                        println!("✗ {to}: {why}");
                    }
                }
            }
            if failed {
                return Err("alguna notificación falló".into());
            }
        }
        other => {
            return Err(format!(
                "subcomando desconocido: notify {other} (telegram, webhook, status, test, remove)"
            )
            .into());
        }
    }
    Ok(())
}
