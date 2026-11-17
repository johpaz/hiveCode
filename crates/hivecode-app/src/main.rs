//! `hivecode` — Rust command line, built on the Hive Agents SDK.
//!
//! Stage 1 of the port (see docs/rust-port.md): one agent, one turn, real tools. The provider is
//! taken from flags/environment; the key is read from `HIVECODE_API_KEY`, never from argv.
use hivecode_host::{Event, Host, HostConfig, Mode};
use serde_json::json;
use std::{io::Write, path::PathBuf};

const USAGE: &str = "uso: hivecode run [--headless] [--model M] [--base-url URL] [--preset ID] \
[--root DIR] [--db DIR] [--mode plan|approval|auto] [--allow PROGRAMA]... <tarea>\n  \
clave del proveedor: variable HIVECODE_API_KEY\n";

struct Args {
    headless: bool,
    model: Option<String>,
    base_url: Option<String>,
    preset: Option<String>,
    root: PathBuf,
    db: Option<PathBuf>,
    allow: Vec<String>,
    mode: Option<Mode>,
    prompt: String,
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut parsed = Args {
        headless: false,
        model: None,
        base_url: None,
        preset: None,
        root: std::env::current_dir().map_err(|e| e.to_string())?,
        db: None,
        allow: vec![],
        mode: None,
        prompt: String::new(),
    };
    let mut words = vec![];
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or(format!("{name} necesita un valor"));
        match arg.as_str() {
            "--headless" => parsed.headless = true,
            "--model" => parsed.model = Some(value("--model")?),
            "--base-url" => parsed.base_url = Some(value("--base-url")?),
            "--preset" => parsed.preset = Some(value("--preset")?),
            "--root" => parsed.root = value("--root")?.into(),
            "--db" => parsed.db = Some(value("--db")?.into()),
            "--allow" => parsed.allow.push(value("--allow")?),
            "--mode" => {
                let text = value("--mode")?;
                parsed.mode = Some(Mode::parse(&text).ok_or("--mode: plan, approval o auto")?);
            }
            flag if flag.starts_with("--") => return Err(format!("opción desconocida: {flag}")),
            _ => words.push(arg),
        }
    }
    parsed.prompt = words.join(" ");
    if parsed.prompt.trim().is_empty() {
        return Err("falta la tarea".into());
    }
    Ok(parsed)
}

/// The mode lives in `<home>/execution_mode`, shared with the TS version; no file means `plan`.
fn home() -> PathBuf {
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

fn db_dir() -> PathBuf {
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
    match args.next().as_deref() {
        Some("run") => {}
        Some("--version" | "-V") => {
            println!("hivecode {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        _ => {
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    }
    let args = match parse(args) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            std::process::exit(2);
        }
    };
    if let Err(error) = run(args).await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

async fn run(args: Args) -> hivecode_host::Result<()> {
    let model = args
        .model
        .or_else(|| std::env::var("HIVECODE_MODEL").ok())
        .ok_or("indica el modelo con --model o HIVECODE_MODEL")?;
    let mut provider = json!({});
    if let Some(preset) = &args.preset {
        provider["preset"] = json!(preset);
    }
    if let Some(url) = args
        .base_url
        .or_else(|| std::env::var("HIVECODE_BASE_URL").ok())
    {
        provider["base_url"] = json!(url);
    }
    if let Ok(key) = std::env::var("HIVECODE_API_KEY") {
        provider["api_key"] = json!(key);
    }
    let session = format!("cli-{}", std::process::id());
    let host = Host::open(HostConfig {
        db: args.db.unwrap_or_else(db_dir),
        root: args.root,
        provider,
        model,
        system: Some(
            "Eres hivecode, un agente de código. Trabaja dentro del proyecto con las herramientas \
             disponibles y responde de forma breve y exacta."
                .into(),
        ),
        agent: "bee".into(),
        session,
        max_turns: 24,
        allowed_programs: args.allow,
        mode: args.mode.unwrap_or_else(saved_mode),
    })?;
    let headless = args.headless;
    let mut out = std::io::stdout();
    let answer = host
        .run(
            &args.prompt,
            &mut |event| {
                if headless {
                    let line = match event {
                        Event::Text(text) => json!({"type": "text", "text": text}),
                        Event::ToolStart { name, arguments } => {
                            json!({"type": "tool_start", "name": name, "arguments": arguments})
                        }
                        Event::ToolDone { name, ok } => {
                            json!({"type": "tool_done", "name": name, "ok": ok})
                        }
                        Event::ToolDenied { name, reason } => {
                            json!({"type": "tool_denied", "name": name, "reason": reason})
                        }
                    };
                    let _ = writeln!(out, "{line}");
                } else if let Event::ToolDenied { name, reason } = &event {
                    eprintln!("✗ {name}: {reason}");
                } else if let Event::Text(text) = event {
                    let _ = write!(out, "{text}");
                    let _ = out.flush();
                } else if let Event::ToolStart { name, .. } = event {
                    eprintln!("· {name}");
                }
            },
            &mut |name, arguments| ask(name, arguments),
            &Default::default(),
        )
        .await?;
    if headless {
        println!("{}", json!({"type": "done", "content": answer}));
    } else {
        println!();
    }
    Ok(())
}

/// Approval prompt on the terminal. Without a terminal there is nobody to ask, so it declines.
fn ask(name: &str, arguments: &serde_json::Value) -> bool {
    use std::io::{BufRead, IsTerminal};
    if !std::io::stdin().is_terminal() {
        return false;
    }
    let shown: String = arguments.to_string().chars().take(300).collect();
    eprint!("¿Permitir {name} {shown}? [s/N] ");
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).is_ok()
        && matches!(
            line.trim().to_lowercase().as_str(),
            "s" | "si" | "sí" | "y" | "yes"
        )
}
