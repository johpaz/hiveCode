//! The settings hub of the TUI (`F2`): providers, models, agents and MCP servers.
//!
//! The hub is driven by slash commands (`/provider remove ID`, `/mcp disable ID`, ...) and by two
//! messages (`modal_submit` for the forms this side opens, `provider_activate` for choosing a provider
//! and typing its key). Everything here edits the same files the `hivecode provider|mcp` commands do,
//! then sends the hub a fresh `settings_data`. What the Rust version does not have (skills, GitHub,
//! Telegram) is said in the history instead of being silently ignored.
use crate::tui::TuiUi;
use hivecode_config::{Config, McpFile, ProviderConfig, Secrets, default_secrets, find_key};
use hivecode_swarm::profiles;
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc};

pub struct Settings {
    home: PathBuf,
    secrets: Arc<dyn Secrets>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn field(key: &str, label: &str, placeholder: &str, required: bool) -> Value {
    json!({"key": key, "label": label, "placeholder": placeholder, "required": required})
}

impl Settings {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            secrets: Arc::from(default_secrets(&env)),
        }
    }

    /// The payload of `settings_data`.
    pub fn data(&self) -> Value {
        let config = Config::load(&self.home).unwrap_or_default();
        let providers: Vec<Value> = config
            .providers
            .iter()
            .map(|(name, p)| {
                let resolved = config.resolve(Some(name)).ok().flatten();
                let model = p.model.clone().unwrap_or_default();
                json!({"id": name, "name": name, "model": model,
                    "is_active": config.active.as_deref() == Some(name),
                    "has_key": find_key(resolved.as_ref(), self.secrets.as_ref(), &env).is_some(),
                    "browser_login": false,
                    "models": if model.is_empty() { json!([]) } else { json!([model]) },
                    "model_names": {}})
            })
            .collect();
        let active = config.resolve(None).ok().flatten();
        let (provider, model) = active
            .map(|a| (a.name, a.provider.model.unwrap_or_default()))
            .unwrap_or_default();
        let agents: Vec<Value> = profiles::all()
            .iter()
            .map(|p| {
                let permission = match p.id {
                    "bee" => "orchestrate",
                    "verifier" => "verify",
                    _ if p.writes => "write_workspace",
                    "spider" => "web_automation",
                    _ => "read_only",
                };
                json!({"id": p.id, "name": p.name, "provider": provider, "model": model, "permission_profile": permission})
            })
            .collect();
        let mcp_file = McpFile::load(&self.home).ok();
        let mcp: Vec<Value> = mcp_file
            .iter()
            .flat_map(|f| f.names())
            .filter_map(|name| {
                let server = mcp_file.as_ref()?.get(&name)?.clone();
                let target = server["url"].as_str().map(str::to_owned).unwrap_or_else(|| {
                    format!("{} {}", server["command"].as_str().unwrap_or(""), server["args"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")).unwrap_or_default())
                        .trim()
                        .to_owned()
                });
                Some(json!({"id": name, "name": name, "url": target, "enabled": server["enabled"] != false,
                    "has_headers": server.get("headers").is_some_and(|h| h.as_object().is_some_and(|o| !o.is_empty()))}))
            })
            .collect();
        json!({"providers": providers, "agents": agents, "mcp": mcp, "skills": [],
            "github_connected": false, "github_repo": null, "telegram_active": false})
    }

    fn done(&self, ui: &TuiUi, message: &str) {
        ui.history("system", message);
        ui.settings(self.data());
    }
    fn failed(&self, ui: &TuiUi, error: impl std::fmt::Display) {
        ui.history("system", &format!("(×ᴗ×) {error}"));
    }

    fn change_config(
        &self,
        ui: &TuiUi,
        change: impl FnOnce(&mut Config) -> hivecode_config::Result<String>,
    ) {
        let outcome = Config::load(&self.home).and_then(|mut config| {
            let message = change(&mut config)?;
            config.save(&self.home)?;
            Ok(message)
        });
        match outcome {
            Ok(message) => self.done(ui, &message),
            Err(error) => self.failed(ui, error),
        }
    }
    fn change_mcp(
        &self,
        ui: &TuiUi,
        change: impl FnOnce(&mut McpFile) -> hivecode_config::Result<String>,
    ) {
        let outcome = McpFile::load(&self.home).and_then(|mut file| {
            let message = change(&mut file)?;
            file.save(&self.home)?;
            Ok(message)
        });
        match outcome {
            Ok(message) => self.done(ui, &message),
            Err(error) => self.failed(ui, error),
        }
    }

    /// A slash command from the hub or the input. False when it is not a settings command.
    pub fn command(&self, ui: &TuiUi, input: &str) -> bool {
        let words: Vec<&str> = input.trim_start_matches('/').split_whitespace().collect();
        let arg = |i: usize| words.get(i).copied().unwrap_or_default().to_owned();
        match words.first().copied() {
            Some("provider") => match words.get(1).copied() {
                Some("add") => {
                    let mut presets: Vec<String> = vec!["(ninguno: usar una URL)".into()];
                    presets.extend(hive_agent_core::provider::presets().iter().map(|p| p.id.to_owned()));
                    ui.config_modal("provider_add", "Agregar proveedor", vec![
                        field("name", "Nombre", "nvidia", true),
                        json!({"key": "preset", "label": "Catálogo", "field_type": "select", "options": presets, "required": false}),
                        field("base_url", "URL (si no hay catálogo)", "http://127.0.0.1:11434/v1", false),
                        field("model", "Modelo", "nvidia/nemotron-3.5-super-vl-120b-a12b", true),
                        field("context_window", "Ventana de contexto (tokens)", "1000000", false),
                        json!({"key": "api_key", "label": "Clave", "secret": true, "required": false}),
                    ]);
                }
                Some("remove") => {
                    let name = arg(2);
                    self.change_config(ui, |c| c.remove(&name).map(|()| format!("Proveedor `{name}` eliminado.")));
                    let _ = self.secrets.delete(&name);
                }
                Some("set" | "use") => {
                    let name = arg(2);
                    self.change_config(ui, |c| c.use_provider(&name).map(|()| format!("Proveedor activo: {name}.")));
                }
                _ => ui.history("system", "Uso: /provider add|remove ID|set ID"),
            },
            Some("modelo" | "model") => match words.get(1).copied() {
                Some("set") => {
                    let (provider, model) = (arg(2), arg(3));
                    self.change_config(ui, |c| {
                        let p = c.providers.get_mut(&provider).ok_or(format!("no hay proveedor `{provider}`"))?;
                        p.model = Some(model.clone());
                        Ok(format!("{provider}: modelo {model}."))
                    });
                }
                _ => ui.history("system", "En la versión Rust el modelo se fija con /modelo set PROVEEDOR MODELO (no hay catálogo de modelos que sincronizar)."),
            },
            Some("mcp") => match words.get(1).copied() {
                Some("add") => ui.config_modal("mcp_add", "Agregar servidor MCP", vec![
                    field("name", "Nombre", "docs", true),
                    field("command", "Comando (servidor local)", "servidor-docs", false),
                    field("args", "Argumentos (separados por espacios)", "--raiz /proyecto", false),
                    field("url", "URL (servidor remoto)", "https://servicio.example/mcp", false),
                ]),
                Some("remove") => {
                    let name = arg(2);
                    self.change_mcp(ui, |f| f.remove(&name).map(|()| format!("Servidor MCP `{name}` eliminado.")));
                }
                Some(action @ ("enable" | "disable")) => {
                    let (name, on) = (arg(2), action == "enable");
                    self.change_mcp(ui, |f| f.set_enabled(&name, on).map(|()| format!("MCP `{name}`: {}.", if on { "activado" } else { "desactivado" })));
                }
                Some("inspect") => {
                    let name = arg(2);
                    match McpFile::load(&self.home).ok().and_then(|f| f.get(&name).cloned()) {
                        Some(server) => ui.info_modal(&format!("MCP {name}"), &serde_json::to_string_pretty(&server).unwrap_or_default()),
                        None => self.failed(ui, format!("no hay servidor MCP `{name}`")),
                    }
                }
                Some("load") => ui.settings(self.data()),
                _ => ui.history("system", "Uso: /mcp add|remove ID|enable ID|disable ID|inspect ID"),
            },
            Some("agent") => {
                let lines: Vec<String> = profiles::all()
                    .iter()
                    .map(|p| format!("{:<10} {:<12} {} herramientas", p.id, p.name, p.tools.len()))
                    .collect();
                ui.info_modal("Agentes", &format!("Los perfiles son fijos (BEE lidera y delega):\n\n{}", lines.join("\n")));
            }
            Some(unsupported @ ("skill" | "github" | "telegram")) => {
                ui.history("system", &format!("/{unsupported} no está disponible en la versión Rust."));
            }
            _ => return false,
        }
        true
    }

    /// The answer of a form this side opened.
    pub fn modal_submit(&self, ui: &TuiUi, command: &str, values: &HashMap<String, String>) {
        let get = |k: &str| {
            values
                .get(k)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        match command {
            "provider_add" => {
                let Some(name) = get("name") else {
                    return self.failed(ui, "falta el nombre");
                };
                let preset = get("preset").filter(|p| !p.starts_with('('));
                if let Some(id) = &preset
                    && !hive_agent_core::provider::presets()
                        .iter()
                        .any(|p| p.id == id)
                {
                    return self.failed(ui, format!("catálogo desconocido `{id}`"));
                }
                let window = match get("context_window").map(|w| w.parse::<u64>()).transpose() {
                    Ok(w) => w,
                    Err(_) => {
                        return self.failed(ui, "la ventana de contexto es un número de tokens");
                    }
                };
                let provider = ProviderConfig {
                    preset,
                    base_url: get("base_url"),
                    model: get("model"),
                    context_window: window,
                    key_env: None,
                };
                let key = get("api_key");
                self.change_config(ui, |c| {
                    c.add(&name, provider)?;
                    if let Some(key) = &key {
                        self.secrets.set(&name, key)?;
                    }
                    Ok(format!(
                        "Proveedor `{name}` guardado{}.",
                        if key.is_some() {
                            " con su clave"
                        } else {
                            "; falta su clave"
                        }
                    ))
                });
            }
            "mcp_add" => {
                let Some(name) = get("name") else {
                    return self.failed(ui, "falta el nombre");
                };
                match (get("command"), get("url")) {
                    (Some(command), None) => {
                        let args: Vec<String> = get("args")
                            .map(|a| a.split_whitespace().map(str::to_owned).collect())
                            .unwrap_or_default();
                        self.change_mcp(ui, |f| {
                            f.add_command(&name, &command, &args, &[])
                                .map(|()| format!("Servidor MCP `{name}` guardado."))
                        });
                    }
                    (None, Some(url)) => self.change_mcp(ui, |f| {
                        f.add_http(&name, &url, &[])
                            .map(|()| format!("Servidor MCP `{name}` guardado."))
                    }),
                    _ => self.failed(ui, "indica un comando o una URL (uno de los dos)"),
                }
            }
            _ => {}
        }
    }

    /// Choosing a provider in the hub, with the key typed there when it had none.
    pub fn provider_activate(&self, ui: &TuiUi, id: &str, api_key: Option<&str>) {
        let key = api_key
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_owned);
        self.change_config(ui, |c| {
            c.use_provider(id)?;
            if let Some(key) = &key {
                self.secrets.set(id, key)?;
            }
            Ok(format!("Proveedor activo: {id}."))
        });
    }
}
