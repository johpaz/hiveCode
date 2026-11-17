//! hivecode's settings, in files the person can read and edit.
//!
//! - `<home>/config.json`: the providers the person set up and which one is active. It holds no key.
//! - the key of a provider: the environment (`HIVECODE_API_KEY`, or the variable the provider names in
//!   `key_env`) first, then the system keyring (service `hivecode`, account = provider name).
//! - `<home>/mcp.json`: the MCP servers (same format the SDK's `McpManager` takes).
//!
//! Files are written aside and renamed, so a crash never leaves a half-written settings file.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderConfig {
    /// A catalog preset of the SDK (`nvidia`, `openrouter`, `anthropic`, ...): sets the URL and the
    /// quirks of that provider's API.
    pub preset: Option<String>,
    /// Overrides the preset's URL (a proxy, a local server).
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub context_window: Option<u64>,
    /// Name of an environment variable that holds this provider's key.
    pub key_env: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub active: Option<String>,
    pub providers: BTreeMap<String, ProviderConfig>,
}

/// A provider with everything resolved except its key.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub name: String,
    pub provider: ProviderConfig,
}

fn write_atomic(path: &Path, text: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

impl Config {
    pub fn path(home: &Path) -> PathBuf {
        home.join("config.json")
    }

    pub fn load(home: &Path) -> Result<Self> {
        match std::fs::read_to_string(Self::path(home)) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| format!("{}: {e}", Self::path(home).display()).into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, home: &Path) -> Result<()> {
        write_atomic(&Self::path(home), &serde_json::to_string_pretty(self)?)
    }

    /// Adds or replaces a provider. The first one added becomes the active one.
    pub fn add(&mut self, name: &str, provider: ProviderConfig) -> Result<()> {
        if !valid_name(name) {
            return Err(
                "the name may only have letters, digits, `_`, `-` and `.` (up to 64)".into(),
            );
        }
        if provider.preset.is_none() && provider.base_url.is_none() {
            return Err("a provider needs a --preset or a --base-url".into());
        }
        self.providers.insert(name.to_owned(), provider);
        self.active.get_or_insert_with(|| name.to_owned());
        Ok(())
    }

    pub fn remove(&mut self, name: &str) -> Result<()> {
        self.providers
            .remove(name)
            .ok_or_else(|| format!("no provider `{name}`"))?;
        if self.active.as_deref() == Some(name) {
            self.active = self.providers.keys().next().cloned();
        }
        Ok(())
    }

    pub fn use_provider(&mut self, name: &str) -> Result<()> {
        if !self.providers.contains_key(name) {
            return Err(format!("no provider `{name}` (hivecode provider list)").into());
        }
        self.active = Some(name.to_owned());
        Ok(())
    }

    /// The provider asked for by name, else the active one.
    pub fn resolve(&self, name: Option<&str>) -> Result<Option<Resolved>> {
        let Some(name) = name.or(self.active.as_deref()) else {
            return Ok(None);
        };
        let provider = self
            .providers
            .get(name)
            .ok_or_else(|| format!("no provider `{name}` (hivecode provider list)"))?;
        Ok(Some(Resolved {
            name: name.to_owned(),
            provider: provider.clone(),
        }))
    }
}

/// Where keys are kept.
pub trait Secrets: Send + Sync {
    fn get(&self, name: &str) -> Option<String>;
    fn set(&self, name: &str, key: &str) -> Result<()>;
    fn delete(&self, name: &str) -> Result<()>;
}

/// The system keyring (Secret Service, Keychain, Credential Manager).
pub struct Keyring;
impl Keyring {
    const SERVICE: &'static str = "hivecode";
}
impl Secrets for Keyring {
    fn get(&self, name: &str) -> Option<String> {
        keyring::Entry::new(Self::SERVICE, name)
            .ok()?
            .get_password()
            .ok()
    }
    fn set(&self, name: &str, key: &str) -> Result<()> {
        Ok(keyring::Entry::new(Self::SERVICE, name)?.set_password(key)?)
    }
    fn delete(&self, name: &str) -> Result<()> {
        match keyring::Entry::new(Self::SERVICE, name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Keys in a file only the owner can read (`0600`): for machines with no system keyring (a server, a
/// container). Chosen with `HIVECODE_SECRETS_FILE=/path`; the keyring stays the default.
pub struct FileSecrets {
    path: PathBuf,
}
impl FileSecrets {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    fn read(&self) -> BTreeMap<String, String> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }
    fn write(&self, keys: &BTreeMap<String, String>) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(keys)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Before the rename: the file never exists, even for an instant, readable by others.
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}
impl Secrets for FileSecrets {
    fn get(&self, name: &str) -> Option<String> {
        self.read().get(name).cloned()
    }
    fn set(&self, name: &str, key: &str) -> Result<()> {
        let mut keys = self.read();
        keys.insert(name.to_owned(), key.to_owned());
        self.write(&keys)
    }
    fn delete(&self, name: &str) -> Result<()> {
        let mut keys = self.read();
        keys.remove(name);
        self.write(&keys)
    }
}

/// The secret store this process uses: the file named by `HIVECODE_SECRETS_FILE`, else the keyring.
pub fn default_secrets(env: &dyn Fn(&str) -> Option<String>) -> Box<dyn Secrets> {
    match env("HIVECODE_SECRETS_FILE").filter(|p| !p.is_empty()) {
        Some(path) => Box::new(FileSecrets::new(path)),
        None => Box::new(Keyring),
    }
}

/// Keys held in memory: for tests, and for callers that must never touch the real keyring.
#[derive(Default)]
pub struct MemorySecrets(std::sync::Mutex<BTreeMap<String, String>>);
impl Secrets for MemorySecrets {
    fn get(&self, name: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(name)
            .cloned()
    }
    fn set(&self, name: &str, key: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name.to_owned(), key.to_owned());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(name);
        Ok(())
    }
}

/// Where a provider's key was found, never the key itself.
#[derive(Debug, PartialEq, Eq)]
pub enum KeySource {
    Env(String),
    Keyring,
}

/// The key of a provider and where it came from: `HIVECODE_API_KEY`, the provider's own `key_env`
/// variable, then the keyring. The keyring is only asked when the environment has nothing.
pub fn find_key(
    resolved: Option<&Resolved>,
    secrets: &dyn Secrets,
    env: &dyn Fn(&str) -> Option<String>,
) -> Option<(String, KeySource)> {
    let nonempty = |v: Option<String>| v.filter(|k| !k.is_empty());
    if let Some(key) = nonempty(env("HIVECODE_API_KEY")) {
        return Some((key, KeySource::Env("HIVECODE_API_KEY".into())));
    }
    let resolved = resolved?;
    if let Some(var) = &resolved.provider.key_env
        && let Some(key) = nonempty(env(var))
    {
        return Some((key, KeySource::Env(var.clone())));
    }
    secrets
        .get(&resolved.name)
        .filter(|k| !k.is_empty())
        .map(|k| (k, KeySource::Keyring))
}

// ── MCP servers ─────────────────────────────────────────────────────────────────────────────────

pub struct McpFile {
    servers: Map<String, Value>,
}

impl McpFile {
    pub fn path(home: &Path) -> PathBuf {
        home.join("mcp.json")
    }

    pub fn load(home: &Path) -> Result<Self> {
        let path = Self::path(home);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    servers: Map::new(),
                });
            }
            Err(e) => return Err(e.into()),
        };
        let doc: Value =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let servers = doc["servers"]
            .as_object()
            .cloned()
            .ok_or_else(|| format!("{}: expected {{\"servers\": {{...}}}}", path.display()))?;
        Ok(Self { servers })
    }

    pub fn save(&self, home: &Path) -> Result<()> {
        write_atomic(
            &Self::path(home),
            &serde_json::to_string_pretty(&json!({"servers": self.servers}))?,
        )
    }

    pub fn names(&self) -> Vec<String> {
        self.servers.keys().cloned().collect()
    }
    pub fn get(&self, name: &str) -> Option<&Value> {
        self.servers.get(name)
    }

    fn check_name(&self, name: &str) -> Result<()> {
        // The SDK's rule for a server name: it becomes part of every tool name (`<server>__<tool>`).
        if name.is_empty()
            || name.len() > 64
            || name.contains("__")
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        {
            return Err(
                "the name may only have letters, digits, `_` and `-` (up to 64), and no `__`"
                    .into(),
            );
        }
        Ok(())
    }

    /// A server run as a command. `env` values may be `${VAR}`: expanded when the server is started,
    /// so a secret does not have to live in the file.
    pub fn add_command(
        &mut self,
        name: &str,
        command: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<()> {
        self.check_name(name)?;
        let mut server = json!({"command": command, "args": args});
        if !env.is_empty() {
            server["env"] = Value::Object(env.iter().map(|(k, v)| (k.clone(), json!(v))).collect());
        }
        self.servers.insert(name.to_owned(), server);
        Ok(())
    }

    pub fn add_http(&mut self, name: &str, url: &str, headers: &[(String, String)]) -> Result<()> {
        self.check_name(name)?;
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("the URL must start with http:// or https://".into());
        }
        let mut server = json!({"transport": "http", "url": url});
        if !headers.is_empty() {
            server["headers"] =
                Value::Object(headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect());
        }
        self.servers.insert(name.to_owned(), server);
        Ok(())
    }

    pub fn set_enabled(&mut self, name: &str, enabled: bool) -> Result<()> {
        let server = self
            .servers
            .get_mut(name)
            .ok_or_else(|| format!("no MCP server `{name}`"))?;
        server["enabled"] = json!(enabled);
        Ok(())
    }

    pub fn remove(&mut self, name: &str) -> Result<()> {
        self.servers
            .remove(name)
            .map(|_| ())
            .ok_or_else(|| format!("no MCP server `{name}`").into())
    }
}
