use hivecode_config::{
    Config, FileSecrets, KeySource, McpFile, MemorySecrets, ProviderConfig, Secrets, find_key,
};

fn nvidia() -> ProviderConfig {
    ProviderConfig {
        preset: Some("nvidia".into()),
        model: Some("nvidia/nemotron-3.5-super-vl-120b-a12b".into()),
        context_window: Some(1_000_000),
        ..Default::default()
    }
}

#[test]
fn providers_are_added_used_removed_and_survive_a_restart() {
    let home = tempfile::tempdir().unwrap();
    let mut config = Config::load(home.path()).unwrap();
    assert_eq!(config, Config::default(), "no file means no providers");

    config.add("nvidia", nvidia()).unwrap();
    config
        .add(
            "local",
            ProviderConfig {
                base_url: Some("http://127.0.0.1:11434/v1".into()),
                model: Some("qwen".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        config.active.as_deref(),
        Some("nvidia"),
        "the first one added is the active one"
    );
    config.use_provider("local").unwrap();
    config.save(home.path()).unwrap();

    let again = Config::load(home.path()).unwrap();
    assert_eq!(again, config);
    assert_eq!(again.resolve(None).unwrap().unwrap().name, "local");
    assert_eq!(
        again
            .resolve(Some("nvidia"))
            .unwrap()
            .unwrap()
            .provider
            .context_window,
        Some(1_000_000)
    );
    assert!(again.resolve(Some("nope")).is_err());
    assert!(Config::default().resolve(None).unwrap().is_none());

    let mut again = again;
    again.remove("local").unwrap();
    assert_eq!(
        again.active.as_deref(),
        Some("nvidia"),
        "removing the active provider falls back to another"
    );
    assert!(again.remove("local").is_err());
    assert!(again.use_provider("local").is_err());
}

#[test]
fn bad_providers_and_a_broken_file_are_refused_with_a_reason() {
    let mut config = Config::default();
    assert!(config.add("con espacio", nvidia()).is_err());
    assert!(config.add("", nvidia()).is_err());
    assert!(
        config.add("x", ProviderConfig::default()).is_err(),
        "neither a preset nor a URL"
    );
    let home = tempfile::tempdir().unwrap();
    std::fs::write(Config::path(home.path()), "{ no es json").unwrap();
    let error = Config::load(home.path()).unwrap_err().to_string();
    assert!(error.contains("config.json"), "{error}");
}

#[test]
fn a_key_comes_from_the_environment_first_then_the_providers_variable_then_the_keyring() {
    let secrets = MemorySecrets::default();
    secrets.set("nvidia", "de-el-llavero").unwrap();
    let mut config = Config::default();
    config
        .add(
            "nvidia",
            ProviderConfig {
                key_env: Some("NVIDIA_API_KEY".into()),
                ..nvidia()
            },
        )
        .unwrap();
    let resolved = config.resolve(None).unwrap();
    let env_with = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    };

    let all = env_with(&[("HIVECODE_API_KEY", "global"), ("NVIDIA_API_KEY", "propia")]);
    assert_eq!(
        find_key(resolved.as_ref(), &secrets, &all),
        Some(("global".into(), KeySource::Env("HIVECODE_API_KEY".into())))
    );
    let own = env_with(&[("NVIDIA_API_KEY", "propia")]);
    assert_eq!(
        find_key(resolved.as_ref(), &secrets, &own),
        Some(("propia".into(), KeySource::Env("NVIDIA_API_KEY".into())))
    );
    let none = env_with(&[("HIVECODE_API_KEY", "")]);
    assert_eq!(
        find_key(resolved.as_ref(), &secrets, &none),
        Some(("de-el-llavero".into(), KeySource::Keyring)),
        "an empty variable is not a key"
    );
    secrets.delete("nvidia").unwrap();
    assert_eq!(find_key(resolved.as_ref(), &secrets, &none), None);
    assert_eq!(
        find_key(None, &secrets, &all).map(|k| k.0),
        Some("global".into()),
        "the global variable needs no provider"
    );
}

#[test]
fn mcp_servers_are_listed_added_toggled_and_removed_in_the_format_the_sdk_takes() {
    let home = tempfile::tempdir().unwrap();
    let mut mcp = McpFile::load(home.path()).unwrap();
    assert!(mcp.names().is_empty());
    mcp.add_command(
        "docs",
        "servidor-docs",
        &["--raiz".into(), "/x".into()],
        &[("TOKEN".into(), "${DOCS_TOKEN}".into())],
    )
    .unwrap();
    mcp.add_http(
        "remoto",
        "https://servicio.example/mcp",
        &[("Authorization".into(), "Bearer ${T}".into())],
    )
    .unwrap();
    mcp.set_enabled("remoto", false).unwrap();
    mcp.save(home.path()).unwrap();

    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(McpFile::path(home.path())).unwrap())
            .unwrap();
    assert_eq!(doc["servers"]["docs"]["command"], "servidor-docs");
    assert_eq!(
        doc["servers"]["docs"]["env"]["TOKEN"], "${DOCS_TOKEN}",
        "the reference is kept, not expanded: the secret never reaches the file"
    );
    assert_eq!(doc["servers"]["remoto"]["transport"], "http");
    assert_eq!(doc["servers"]["remoto"]["enabled"], false);

    let mut again = McpFile::load(home.path()).unwrap();
    assert_eq!(again.names(), ["docs", "remoto"]);
    again.remove("docs").unwrap();
    assert!(again.remove("docs").is_err());
    assert!(again.set_enabled("nada", true).is_err());
}

#[test]
fn mcp_names_urls_and_files_that_would_break_the_sdk_are_refused() {
    let mut mcp = McpFile::load(tempfile::tempdir().unwrap().path()).unwrap();
    for bad in ["", "dos__guiones", "con espacio", &"x".repeat(65)] {
        assert!(mcp.add_command(bad, "c", &[], &[]).is_err(), "{bad:?}");
    }
    assert!(mcp.add_http("ok", "ftp://x", &[]).is_err());
    let home = tempfile::tempdir().unwrap();
    std::fs::write(McpFile::path(home.path()), "[]").unwrap();
    assert!(McpFile::load(home.path()).is_err());
}

#[test]
fn a_file_of_secrets_is_private_and_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sub/secrets.json");
    let secrets = FileSecrets::new(&path);
    assert_eq!(secrets.get("nv"), None, "no file, no keys");
    secrets.set("nv", "clave-uno").unwrap();
    secrets.set("otro", "clave-dos").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600,
            "only the owner reads it"
        );
    }
    let again = FileSecrets::new(&path);
    assert_eq!(again.get("nv").as_deref(), Some("clave-uno"));
    again.delete("nv").unwrap();
    assert_eq!(FileSecrets::new(&path).get("nv"), None);
    assert_eq!(
        FileSecrets::new(&path).get("otro").as_deref(),
        Some("clave-dos")
    );
    assert_eq!(
        std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
        1,
        "no temp file is left behind"
    );
    let from_env = hivecode_config::default_secrets(&|n| {
        (n == "HIVECODE_SECRETS_FILE").then(|| path.display().to_string())
    });
    assert_eq!(from_env.get("otro").as_deref(), Some("clave-dos"));
}
