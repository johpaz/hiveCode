//! The settings commands: `provider`, `mcp`, `doctor` and `init`.
use crate::{db_dir, home, tui};
use hivecode_config::{Config, KeySource, McpFile, ProviderConfig, default_secrets, find_key};
use serde_json::json;
use std::path::PathBuf;

type Res = hivecode_host::Result<()>;

/// `--name value` anywhere in the arguments, each removed from `args`. Repeated flags give every value.
fn take_all(args: &mut Vec<String>, name: &str) -> Result<Vec<String>, String> {
    let mut values = vec![];
    while let Some(i) = args.iter().position(|a| a == name) {
        if i + 1 >= args.len() {
            return Err(format!("{name} necesita un valor"));
        }
        values.push(args.remove(i + 1));
        args.remove(i);
    }
    Ok(values)
}
fn take(args: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
    let mut all = take_all(args, name)?;
    match all.len() {
        0 => Ok(None),
        1 => Ok(all.pop()),
        _ => Err(format!("{name} solo se admite una vez")),
    }
}
fn pairs(values: Vec<String>, flag: &str) -> Result<Vec<(String, String)>, String> {
    values
        .into_iter()
        .map(|v| {
            v.split_once('=')
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .ok_or(format!("{flag} va como CLAVE=VALOR"))
        })
        .collect()
}

pub fn provider(mut args: Vec<String>) -> Res {
    let home = home();
    let sub = if args.is_empty() {
        "list".to_owned()
    } else {
        args.remove(0)
    };
    match sub.as_str() {
        "list" => {
            let config = Config::load(&home)?;
            if config.providers.is_empty() {
                println!(
                    "Sin proveedores. Añade uno: hivecode provider add NOMBRE --preset nvidia --model MODELO"
                );
                return Ok(());
            }
            let env = |n: &str| std::env::var(n).ok();
            for (name, p) in &config.providers {
                let resolved = config.resolve(Some(name))?;
                let key = match find_key(resolved.as_ref(), default_secrets(&env).as_ref(), &env) {
                    Some((_, KeySource::Env(var))) => format!("✓ clave en ${var}"),
                    Some((_, KeySource::Keyring)) => "✓ clave en el llavero".to_owned(),
                    None => "? sin clave (hivecode provider key NOMBRE)".to_owned(),
                };
                println!(
                    "{} {name:<14} {} · {} · {key}",
                    if config.active.as_deref() == Some(name) {
                        "●"
                    } else {
                        " "
                    },
                    p.preset.as_deref().or(p.base_url.as_deref()).unwrap_or("?"),
                    p.model.as_deref().unwrap_or("(sin modelo)"),
                );
            }
        }
        "presets" => {
            for preset in hive_agent_core::provider::presets() {
                println!("{:<16} {:<18} {}", preset.id, preset.kind, preset.base_url);
            }
        }
        "add" => {
            let name = (!args.is_empty()).then(|| args.remove(0)).ok_or("uso: hivecode provider add NOMBRE [--preset P] [--base-url U] [--model M] [--context-window N] [--key-env VAR]")?;
            let preset = take(&mut args, "--preset")?;
            if let Some(id) = &preset
                && !hive_agent_core::provider::presets()
                    .iter()
                    .any(|p| p.id == id)
            {
                return Err(
                    format!("preset desconocido `{id}` (hivecode provider presets)").into(),
                );
            }
            let provider = ProviderConfig {
                preset,
                base_url: take(&mut args, "--base-url")?,
                model: take(&mut args, "--model")?,
                context_window: take(&mut args, "--context-window")?
                    .map(|v| v.parse())
                    .transpose()
                    .map_err(|_| "--context-window: número de tokens")?,
                key_env: take(&mut args, "--key-env")?,
            };
            if let Some(extra) = args.first() {
                return Err(format!("argumento inesperado: {extra}").into());
            }
            let mut config = Config::load(&home)?;
            config.add(&name, provider)?;
            config.save(&home)?;
            println!(
                "Proveedor `{name}` guardado{}. La clave va aparte: hivecode provider key {name}",
                if config.active.as_deref() == Some(&name) {
                    " y activo"
                } else {
                    ""
                }
            );
        }
        "use" | "remove" | "key" => {
            let name = args
                .first()
                .cloned()
                .ok_or(format!("uso: hivecode provider {sub} NOMBRE"))?;
            let mut config = Config::load(&home)?;
            match sub.as_str() {
                "use" => {
                    config.use_provider(&name)?;
                    config.save(&home)?;
                    println!("Activo: {name}");
                }
                "remove" => {
                    config.remove(&name)?;
                    config.save(&home)?;
                    let _ = default_secrets(&|n| std::env::var(n).ok()).delete(&name);
                    println!("Proveedor `{name}` eliminado, y su clave del llavero.");
                }
                _ => {
                    config.resolve(Some(&name))?;
                    // The key is read from stdin so it never shows up in the process list or the history:
                    //   printf %s "$CLAVE" | hivecode provider key NOMBRE
                    let mut line = String::new();
                    std::io::stdin().read_line(&mut line)?;
                    let key = line.trim();
                    if key.is_empty() {
                        return Err("no llegó ninguna clave por la entrada estándar: printf %s \"$CLAVE\" | hivecode provider key NOMBRE".into());
                    }
                    default_secrets(&|n| std::env::var(n).ok()).set(&name, key).map_err(|e| format!("no pude guardar la clave en el llavero ({e}); usa la variable HIVECODE_API_KEY, o --key-env en el proveedor"))?;
                    println!("Clave de `{name}` guardada en el llavero del sistema.");
                }
            }
        }
        other => {
            return Err(format!(
                "subcomando desconocido: provider {other} (list, presets, add, use, remove, key)"
            )
            .into());
        }
    }
    Ok(())
}

pub fn mcp(mut args: Vec<String>) -> Res {
    let home = home();
    let sub = if args.is_empty() {
        "list".to_owned()
    } else {
        args.remove(0)
    };
    let mut file = McpFile::load(&home)?;
    match sub.as_str() {
        "list" => {
            if file.names().is_empty() {
                println!(
                    "Sin servidores MCP. Añade uno: hivecode mcp add NOMBRE --command CMD [--arg A]..."
                );
            }
            for name in file.names() {
                let server = file.get(&name).cloned().unwrap_or_default();
                let target = server["url"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        format!(
                            "{} {}",
                            server["command"].as_str().unwrap_or("?"),
                            server["args"]
                                .as_array()
                                .map(|a| a
                                    .iter()
                                    .filter_map(|x| x.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" "))
                                .unwrap_or_default()
                        )
                    });
                println!(
                    "{} {name:<14} {}",
                    if server["enabled"] == false {
                        "○"
                    } else {
                        "●"
                    },
                    target.trim()
                );
            }
            return Ok(());
        }
        "add" => {
            let name = (!args.is_empty()).then(|| args.remove(0)).ok_or("uso: hivecode mcp add NOMBRE (--command CMD [--arg A]... [--env K=V]... | --url URL [--header K=V]...)")?;
            let command = take(&mut args, "--command")?;
            let url = take(&mut args, "--url")?;
            match (command, url) {
                (Some(command), None) => {
                    let (a, e) = (
                        take_all(&mut args, "--arg")?,
                        pairs(take_all(&mut args, "--env")?, "--env")?,
                    );
                    file.add_command(&name, &command, &a, &e)?;
                }
                (None, Some(url)) => {
                    let h = pairs(take_all(&mut args, "--header")?, "--header")?;
                    file.add_http(&name, &url, &h)?;
                }
                _ => return Err("indica --command o --url (uno de los dos)".into()),
            }
            if let Some(extra) = args.first() {
                return Err(format!("argumento inesperado: {extra}").into());
            }
            println!(
                "Servidor MCP `{name}` guardado. Se conecta la próxima vez que arranque hivecode."
            );
        }
        "remove" | "enable" | "disable" => {
            let name = args
                .first()
                .cloned()
                .ok_or(format!("uso: hivecode mcp {sub} NOMBRE"))?;
            match sub.as_str() {
                "remove" => file.remove(&name)?,
                "enable" => file.set_enabled(&name, true)?,
                _ => file.set_enabled(&name, false)?,
            }
            println!("Hecho: mcp {sub} {name}");
        }
        other => {
            return Err(format!(
                "subcomando desconocido: mcp {other} (list, add, remove, enable, disable)"
            )
            .into());
        }
    }
    file.save(&home)?;
    Ok(())
}

enum Level {
    Ok,
    Warn,
    Bad,
}
fn show(level: Level, name: &str, detail: &str) -> bool {
    let mark = match level {
        Level::Ok => "✓",
        Level::Warn => "—",
        Level::Bad => "✗",
    };
    println!("{mark} {name:<16} {detail}");
    !matches!(level, Level::Bad)
}
fn on_path(bin: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
}

/// `hivecode doctor`: what is ready and what is missing, each with its remedy. Exit code 1 if
/// something that hivecode needs is missing.
pub fn doctor() -> Res {
    let mut healthy = true;
    let home = home();
    println!("hivecode {}\n", env!("CARGO_PKG_VERSION"));

    healthy &= match std::fs::create_dir_all(&home).and_then(|()| {
        let probe = home.join(".doctor");
        std::fs::write(&probe, "x")?;
        std::fs::remove_file(probe)
    }) {
        Ok(()) => show(Level::Ok, "directorio", &home.display().to_string()),
        Err(e) => show(
            Level::Bad,
            "directorio",
            &format!("{} no es escribible: {e}", home.display()),
        ),
    };
    healthy &= if on_path("git") {
        show(
            Level::Ok,
            "git",
            "instalado (los modos approval y auto trabajan en copias de git)",
        )
    } else {
        show(
            Level::Bad,
            "git",
            "no está instalado: sin él solo funciona el modo plan",
        )
    };
    let db = db_dir();
    healthy &= match hivecode_store::Store::open(&db) {
        Ok(_) => show(Level::Ok, "base de datos", &db.display().to_string()),
        Err(e) => show(
            Level::Bad,
            "base de datos",
            &format!(
                "{}: {e} (¿hay otra instancia de hivecode abierta?)",
                db.display()
            ),
        ),
    };

    match Config::load(&home) {
        Err(e) => healthy &= show(Level::Bad, "proveedores", &e.to_string()),
        Ok(config) => match config.resolve(None) {
            Ok(Some(resolved)) => {
                let env = |n: &str| std::env::var(n).ok();
                let key = find_key(Some(&resolved), default_secrets(&env).as_ref(), &env);
                healthy &= match key {
                    Some((_, KeySource::Env(var))) => show(
                        Level::Ok,
                        "proveedor",
                        &format!("{} (clave en ${var})", resolved.name),
                    ),
                    Some((_, KeySource::Keyring)) => show(
                        Level::Ok,
                        "proveedor",
                        &format!("{} (clave en el llavero)", resolved.name),
                    ),
                    None => show(
                        Level::Bad,
                        "proveedor",
                        &format!(
                            "{} no tiene clave: printf %s \"$CLAVE\" | hivecode provider key {}",
                            resolved.name, resolved.name
                        ),
                    ),
                };
                if resolved.provider.model.is_none() {
                    show(
                        Level::Warn,
                        "modelo",
                        "el proveedor no fija modelo: pásalo con --model o HIVECODE_MODEL",
                    );
                }
            }
            Ok(None) => {
                let via_env = std::env::var("HIVECODE_API_KEY").is_ok()
                    && std::env::var("HIVECODE_MODEL").is_ok();
                if via_env {
                    show(
                        Level::Ok,
                        "proveedor",
                        "por variables de entorno (HIVECODE_API_KEY, HIVECODE_MODEL)",
                    );
                } else {
                    healthy &= show(
                        Level::Bad,
                        "proveedor",
                        "ninguno configurado: hivecode provider add NOMBRE --preset nvidia --model MODELO",
                    );
                }
            }
            Err(e) => healthy &= show(Level::Bad, "proveedor", &e.to_string()),
        },
    }

    match McpFile::load(&home) {
        Ok(file) => {
            show(
                if file.names().is_empty() {
                    Level::Warn
                } else {
                    Level::Ok
                },
                "servidores MCP",
                &format!("{} configurados", file.names().len()),
            );
        }
        Err(e) => healthy &= show(Level::Bad, "servidores MCP", &e.to_string()),
    }
    match tui::find_tui() {
        Ok(path) => {
            show(Level::Ok, "TUI", &path.display().to_string());
        }
        Err(e) => {
            show(
                Level::Warn,
                "TUI",
                &format!("{e}; `hivecode run` funciona igual"),
            );
        }
    }
    let mode = std::fs::read_to_string(home.join("execution_mode"))
        .unwrap_or_else(|_| "plan (por defecto)".into());
    show(Level::Ok, "modo", mode.trim());
    println!("\nVerificación de proyectos (lo que `hivecode` ejecuta al terminar un cambio):");
    for (bin, what) in [
        ("cargo", "Rust"),
        ("bun", "JavaScript/TypeScript"),
        ("npm", "JavaScript/TypeScript (npm)"),
        ("python3", "Python"),
        ("go", "Go"),
    ] {
        let there = on_path(bin);
        let detail = if there {
            what.to_owned()
        } else {
            format!("no está: no se comprobarán proyectos de {what}")
        };
        show(if there { Level::Ok } else { Level::Warn }, bin, &detail);
    }
    if healthy {
        println!("\nTodo lo necesario está listo.");
        Ok(())
    } else {
        Err("hay problemas que resolver (marcados con ✗)".into())
    }
}

/// `hivecode init [--root DIR] [--write]`: what hivecode sees in the project. With `--write` it saves
/// the checks it found as `.hivecode/verify.json`, which then wins over detection.
pub fn init(mut args: Vec<String>) -> Res {
    let write = args
        .iter()
        .position(|a| a == "--write")
        .map(|i| args.remove(i))
        .is_some();
    let root = take(&mut args, "--root")?
        .map(PathBuf::from)
        .unwrap_or_else(|| ".".into());
    let root = std::fs::canonicalize(&root)?;
    println!("Proyecto: {}", root.display());
    let git = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(&root)
        .output();
    match git {
        Ok(o) if o.status.success() => {
            println!("✓ repositorio git con commits (los modos approval y auto funcionan)")
        }
        Ok(_) => println!(
            "✗ no es un repositorio git con al menos un commit: approval y auto no pueden crear copias de trabajo"
        ),
        Err(_) => println!("✗ git no está instalado"),
    }
    let mut index = hivecode_index::Index::new(&root);
    index.sync();
    let (files, symbols) = index
        .files()
        .fold((0, 0), |(f, s), file| (f + 1, s + file.symbols.len()));
    println!("✓ índice de código: {files} archivos, {symbols} símbolos");

    struct Env;
    impl hivecode_verify::Env for Env {
        fn which(&self, bin: &str) -> bool {
            on_path(bin)
        }
        fn probe(&self, argv: &[&str]) -> bool {
            hivecode_verify::RealEnv.probe(argv)
        }
    }
    let plan = hivecode_verify::plan(&root, &Env);
    if plan.ecosystems.is_empty() {
        println!(
            "— no reconozco el ecosistema: no se ejecutará nada al terminar un cambio (declara los comandos en .hivecode/verify.json)"
        );
    } else {
        println!(
            "✓ ecosistemas: {} · pruebas: {}",
            plan.ecosystems.join(", "),
            if plan.has_tests { "sí" } else { "no hay" }
        );
        println!("{}", hivecode_verify::describe(&plan));
    }
    if write {
        let path = root.join(".hivecode/verify.json");
        if path.exists() {
            println!("\nYa existe {}: no se toca.", path.display());
            return Ok(());
        }
        let mut declared = serde_json::Map::new();
        for check in plan.checks.iter().filter(|c| c.skip.is_none()) {
            let key = match check.label {
                hivecode_verify::Label::Tests => "test",
                hivecode_verify::Label::Build => "build",
                hivecode_verify::Label::Types => "typecheck",
            };
            declared.entry(key).or_insert_with(|| json!(check.command));
        }
        std::fs::create_dir_all(path.parent().expect("has a parent"))?;
        std::fs::write(&path, serde_json::to_string_pretty(&declared)?)?;
        println!(
            "\nEscrito {}: edítalo si algún comando no es el que quieres.",
            path.display()
        );
    }
    Ok(())
}

/// `hivecode mcp test NAME`: connects to one configured server for a moment and says what it offers,
/// or why it did not connect. A server marked disabled is tested anyway (that is why one tests it).
pub async fn mcp_test(args: Vec<String>) -> Res {
    let name = args
        .first()
        .cloned()
        .ok_or("uso: hivecode mcp test NOMBRE")?;
    let servers = hivecode_tools::load_config(&McpFile::path(&home()), &|n| std::env::var(n).ok())?;
    let mut server = servers
        .get(&name)
        .cloned()
        .ok_or_else(|| format!("no hay servidor MCP `{name}` (hivecode mcp list)"))?;
    server["enabled"] = json!(true);
    let started = std::time::Instant::now();
    let (tools, report) =
        hivecode_tools::McpTools::connect(json!({ name.clone(): server })).await?;
    let result = match report["failed"][&name].as_str() {
        Some(why) => Err(format!("{name} no conectó: {why}")),
        None => {
            let defs = hivecode_host::ToolSet::definitions(&tools);
            println!(
                "✓ {name} conectado en {} ms · {} herramientas",
                started.elapsed().as_millis(),
                defs.len()
            );
            for tool in &defs {
                let short = tool
                    .name
                    .strip_prefix(&format!("{name}__"))
                    .unwrap_or(&tool.name);
                let description = tool
                    .description
                    .split_once("»] ")
                    .map_or(tool.description.as_str(), |(_, d)| d)
                    .trim();
                println!(
                    "  {short} — {}",
                    description.chars().take(90).collect::<String>()
                );
            }
            Ok(())
        }
    };
    tools.close().await;
    result.map_err(Into::into)
}

/// `hivecode onboard`: the first-use wizard. It asks for a provider (from the SDK's catalog), a
/// model and, if wanted, the key, and leaves them saved and active. The questions go to stderr and
/// the answers are read line by line from stdin, so it also works piped (`printf '...' | hivecode onboard`).
/// The key is read as typed (there is no terminal control here): to keep it off the screen use
/// `hivecode provider key` or the environment.
pub fn onboard() -> Res {
    use std::io::BufRead;
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let mut ask = |question: &str, default: Option<&str>| -> std::io::Result<String> {
        match default {
            Some(d) => eprint!("{question} [{d}]: "),
            None => eprint!("{question}: "),
        }
        let line = lines.next().transpose()?.unwrap_or_default();
        let line = line.trim();
        Ok(if line.is_empty() {
            default.unwrap_or_default().to_owned()
        } else {
            line.to_owned()
        })
    };
    let presets = hive_agent_core::provider::presets();
    eprintln!(
        "Catálogo de proveedores: {}\n",
        presets.iter().map(|p| p.id).collect::<Vec<_>>().join(", ")
    );
    let preset = ask("Proveedor del catálogo (o Enter para usar una URL)", None)?;
    if !preset.is_empty() && !presets.iter().any(|p| p.id == preset) {
        return Err(
            format!("`{preset}` no está en el catálogo (hivecode provider presets)").into(),
        );
    }
    let base_url = if preset.is_empty() {
        let url = ask("URL base (compatible con OpenAI)", None)?;
        if url.is_empty() {
            return Err("hace falta un proveedor del catálogo o una URL".into());
        }
        Some(url)
    } else {
        None
    };
    let name = ask(
        "Nombre para este proveedor",
        Some(if preset.is_empty() { "local" } else { &preset }),
    )?;
    let model = ask("Modelo", None)?;
    if model.is_empty() {
        return Err("hace falta el modelo".into());
    }
    let window = ask(
        "Ventana de contexto en tokens (Enter si no la sabes)",
        Some(""),
    )?;
    let context_window = if window.is_empty() {
        None
    } else {
        Some(
            window
                .parse::<u64>()
                .map_err(|_| "la ventana de contexto es un número de tokens")?,
        )
    };
    let key = ask("Clave del proveedor (Enter para ponerla después)", Some(""))?;

    let provider = ProviderConfig {
        preset: (!preset.is_empty()).then_some(preset),
        base_url,
        model: Some(model),
        context_window,
        key_env: None,
    };
    let home = home();
    let mut config = Config::load(&home)?;
    config.add(&name, provider)?;
    config.use_provider(&name)?;
    config.save(&home)?;
    println!("Proveedor `{name}` guardado y activo.");
    if key.is_empty() {
        println!(
            "Falta la clave: printf %s \"$CLAVE\" | hivecode provider key {name}   (o la variable HIVECODE_API_KEY)"
        );
    } else {
        default_secrets(&|n| std::env::var(n).ok())
            .set(&name, &key)
            .map_err(|e| format!("no pude guardar la clave ({e}); usa HIVECODE_API_KEY, o HIVECODE_SECRETS_FILE=/ruta"))?;
        println!("Clave guardada.");
    }
    println!("\nSiguiente: hivecode doctor   ·   hivecode init   ·   hivecode   (la TUI)");
    Ok(())
}

/// `hivecode skill list | show NOMBRE | match TEXTO | check`.
pub fn skill(mut args: Vec<String>) -> hivecode_host::Result<()> {
    let sub = if args.is_empty() {
        "list".to_owned()
    } else {
        args.remove(0)
    };
    let project = std::env::current_dir()?;
    let (skills, problems) = hivecode_skills::catalog(&crate::home(), &project);
    match sub.as_str() {
        "list" => {
            for s in &skills {
                let origin = match s.source {
                    hivecode_skills::Source::Bundled => "",
                    hivecode_skills::Source::User => " [tuya]",
                    hivecode_skills::Source::Project => " [proyecto]",
                };
                println!(
                    "{:<28} {:<12} {}{origin}",
                    s.name,
                    s.category,
                    s.description.chars().take(70).collect::<String>()
                );
            }
            println!(
                "\n{} skills. Las tuyas van en {}/skills/<nombre>/SKILL.md y las del proyecto en .hivecode/skills/.",
                skills.len(),
                crate::home().display()
            );
        }
        "show" => {
            let name = args.first().ok_or("uso: hivecode skill show NOMBRE")?;
            let s = skills
                .iter()
                .find(|s| &s.name == name)
                .ok_or(format!("no hay una skill `{name}` (hivecode skill list)"))?;
            println!("{}", hivecode_skills::render(s));
            if !s.triggers.is_empty() {
                println!("Se activa con: {}", s.triggers.join(" · "));
            }
        }
        "match" => {
            let text = args.join(" ");
            if text.trim().is_empty() {
                return Err("uso: hivecode skill match TEXTO DE LA TAREA".into());
            }
            let chosen = hivecode_skills::select(&skills, &text);
            if chosen.is_empty() {
                println!("Ninguna skill aplica a esa tarea.");
            }
            for s in chosen {
                println!(
                    "{} (afinidad {}) — {}",
                    s.name,
                    hivecode_skills::score(s, &text),
                    s.description
                );
            }
        }
        "check" => {
            for p in &problems {
                println!("✗ {p}");
            }
            println!(
                "{} skills cargadas, {} con problemas.",
                skills.len(),
                problems.len()
            );
            if !problems.is_empty() {
                return Err("hay skills que no cargan".into());
            }
        }
        other => {
            return Err(format!(
                "subcomando desconocido: skill {other} (list, show, match, check)"
            )
            .into());
        }
    }
    Ok(())
}

/// Aggregates runs by route (`conversation`, `scoped`, `feature`, or `plain` for a run without the harness).
pub fn run_stats(runs: &[hivecode_store::RunDoc]) -> serde_json::Value {
    use serde_json::{Value, json};
    use std::collections::BTreeMap;
    #[derive(Default)]
    struct Group {
        runs: u64,
        completed: u64,
        failed: u64,
        interrupted: u64,
        integrated: u64,
        rolled_back: u64,
        repairs: u64,
        repaired_runs: u64,
        secs: u64,
        counted: u64,
        model_calls: u64,
        tool_calls: u64,
        output_tokens: u64,
        budgeted: u64,
    }
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for run in runs {
        let g = groups
            .entry(run.route.clone().unwrap_or_else(|| "plain".into()))
            .or_default();
        g.runs += 1;
        match run.status.as_str() {
            "completed" | "ready" => g.completed += 1,
            "running" => g.interrupted += 1,
            _ => g.failed += 1,
        }
        g.integrated += u64::from(run.integration == "integrated");
        g.rolled_back += u64::from(run.rolled_back);
        g.repairs += u64::from(run.repair_cycles);
        g.repaired_runs += u64::from(run.repair_cycles > 0);
        if run.finished_ms >= run.started_ms && run.finished_ms > 0 {
            g.secs += (run.finished_ms - run.started_ms) / 1000;
            g.counted += 1;
        }
        if let Some(b) = &run.budget {
            g.budgeted += 1;
            g.model_calls += b["model_calls"].as_u64().unwrap_or(0);
            g.tool_calls += b["tool_calls"].as_u64().unwrap_or(0);
            g.output_tokens += b["output_tokens"].as_u64().unwrap_or(0);
        }
    }
    let avg = |total: u64, n: u64| {
        if n == 0 {
            Value::Null
        } else {
            json!((total as f64 / n as f64 * 10.0).round() / 10.0)
        }
    };
    let by_route: serde_json::Map<String, Value> = groups
        .iter()
        .map(|(route, g)| {
            (
                route.clone(),
                json!({
                    "runs": g.runs, "completed": g.completed, "failed": g.failed, "interrupted": g.interrupted,
                    "integrated": g.integrated, "rolled_back": g.rolled_back,
                    "runs_needing_repair": g.repaired_runs, "repair_cycles": g.repairs,
                    "avg_seconds": avg(g.secs, g.counted),
                    "avg_model_calls": avg(g.model_calls, g.budgeted),
                    "avg_tool_calls": avg(g.tool_calls, g.budgeted),
                    "avg_output_tokens": avg(g.output_tokens, g.budgeted),
                    "runs_with_budget": g.budgeted,
                }),
            )
        })
        .collect();
    json!({"runs": runs.len(), "by_route": by_route, "roles": role_stats(runs)})
}

/// Fewest runs of a role before its tool usage says anything about what it should start with.
pub const MIN_SAMPLE: u64 = 10;

/// What each role actually called, against the tools its profile starts with: a tool that is loaded in
/// every turn of a role and never called costs its description each time (candidates to drop); one called
/// in most runs belongs in the core. It only reports: changing a profile stays a decision.
fn role_stats(runs: &[hivecode_store::RunDoc]) -> serde_json::Value {
    use serde_json::json;
    use std::collections::{BTreeMap, BTreeSet};
    // role -> (runs that used it, tool -> (runs that called it, calls))
    type Calls<'a> = BTreeMap<&'a str, (u64, u64)>;
    let mut roles: BTreeMap<&str, (u64, Calls)> = BTreeMap::new();
    for run in runs.iter().filter(|r| r.status != "running") {
        for (role, tools) in &run.tool_usage {
            let entry = roles.entry(role).or_default();
            entry.0 += 1;
            for (tool, calls) in tools {
                let t = entry.1.entry(tool).or_default();
                t.0 += 1;
                t.1 += u64::from(*calls);
            }
        }
    }
    let out: serde_json::Map<String, serde_json::Value> = roles
        .into_iter()
        .map(|(role, (n, tools))| {
            let loaded: BTreeSet<&str> = hivecode_swarm::profiles::find(role).map(|p| p.tools.into_iter().collect()).unwrap_or_default();
            let called: BTreeSet<&str> = tools.keys().copied().collect();
            let mut used: Vec<_> = tools.iter().map(|(t, (r, c))| (*t, *r, *c)).collect();
            used.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)).then(a.0.cmp(b.0)));
            (
                role.to_owned(),
                json!({
                    "runs": n,
                    "enough": n >= MIN_SAMPLE,
                    "used": used.iter().map(|(t, r, c)| json!({"tool": t, "runs": r, "calls": c})).collect::<Vec<_>>(),
                    "unused": loaded.difference(&called).collect::<Vec<_>>(),
                }),
            )
        })
        .collect();
    serde_json::Value::Object(out)
}

pub fn print_stats(report: &serde_json::Value) {
    print_routes(report);
    print_roles(report);
}

fn print_roles(report: &serde_json::Value) {
    let Some(roles) = report["roles"].as_object().filter(|r| !r.is_empty()) else {
        return;
    };
    println!("\nUso de herramientas por rol (corridas con --swarm):");
    for (role, r) in roles {
        let used: Vec<String> = r["used"]
            .as_array()
            .into_iter()
            .flatten()
            .take(8)
            .map(|u| {
                format!(
                    "{} ({} corr./{} llam.)",
                    u["tool"].as_str().unwrap_or(""),
                    u["runs"],
                    u["calls"]
                )
            })
            .collect();
        println!(
            "  {role}: {} corrida(s) · usa: {}",
            r["runs"],
            used.join(", ")
        );
        let unused: Vec<&str> = r["unused"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .collect();
        if r["enough"] == true {
            if !unused.is_empty() {
                println!(
                    "    cargadas y nunca llamadas (candidatas a quitar): {}",
                    unused.join(", ")
                );
            }
        } else {
            println!(
                "    muestra corta (<{MIN_SAMPLE} corridas): no hay evidencia para cambiar lo que carga este rol"
            );
        }
    }
}

fn print_routes(report: &serde_json::Value) {
    if report["runs"] == 0 {
        println!("Sin corridas todavía.");
        return;
    }
    println!("{} corridas", report["runs"]);
    let num = |v: &serde_json::Value| v.as_f64().map_or("—".to_owned(), |n| format!("{n}"));
    for (route, g) in report["by_route"].as_object().into_iter().flatten() {
        println!(
            "\n{route}: {} corridas — {} completadas, {} fallidas, {} interrumpidas · {} integradas, {} deshechas",
            g["runs"],
            g["completed"],
            g["failed"],
            g["interrupted"],
            g["integrated"],
            g["rolled_back"]
        );
        println!(
            "  reparación: {} corridas la necesitaron ({} ciclos) · promedio: {} s, {} llamadas al modelo, {} de herramientas, {} tokens de salida",
            g["runs_needing_repair"],
            g["repair_cycles"],
            num(&g["avg_seconds"]),
            num(&g["avg_model_calls"]),
            num(&g["avg_tool_calls"]),
            num(&g["avg_output_tokens"])
        );
        if g["runs_with_budget"].as_u64().unwrap_or(0) < g["runs"].as_u64().unwrap_or(0) {
            println!(
                "  (el presupuesto solo se mide en corridas con --swarm o con límites HIVECODE_BUDGET_*: {} de {})",
                g["runs_with_budget"], g["runs"]
            );
        }
    }
}
