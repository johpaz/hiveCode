use hivecode_adr::{Relevance, Risk, Status, analyze, assess, files_in_diff, load, parse, search};
use std::path::Path;

fn adr(name: &str, text: &str) -> hivecode_adr::Adr {
    parse(Path::new(name), text)
}

#[test]
fn title_and_status_are_read_and_accepted_is_the_default() {
    let a = adr("0001.md", "# Usar HiveDB\n\n**Status**: Proposed\n\ntexto");
    assert_eq!(
        (a.title.as_str(), a.status),
        ("Usar HiveDB", Status::Proposed)
    );
    assert_eq!(adr("x.md", "sin título ni estado").status, Status::Accepted);
    assert_eq!(adr("x.md", "sin título").title, "Sin titulo");
    assert_eq!(
        adr("x.md", "# T\nStatus: raro").status,
        Status::Accepted,
        "an unknown status is not an invented one"
    );
    assert_eq!(
        adr("x.md", "# T\n**status**: superseded").status,
        Status::Superseded
    );
}

#[test]
fn the_adrs_folder_is_read_in_name_order_and_a_project_without_one_has_none() {
    let dir = tempfile::tempdir().unwrap();
    assert!(load(dir.path()).is_empty());
    std::fs::create_dir(dir.path().join("adrs")).unwrap();
    std::fs::write(dir.path().join("adrs/0002-b.md"), "# B").unwrap();
    std::fs::write(dir.path().join("adrs/0001-a.MD"), "# A").unwrap();
    std::fs::write(dir.path().join("adrs/notas.txt"), "# no").unwrap();
    let titles: Vec<String> = load(dir.path()).into_iter().map(|a| a.title).collect();
    assert_eq!(titles, ["A", "B"]);
}

#[test]
fn a_file_is_matched_by_its_path_its_name_and_a_title_made_after_it() {
    let adrs = vec![
        adr(
            "0001.md",
            "# Persistencia\n\nLa capa de almacenamiento vive en src/store y usa archivos .rs",
        ),
        adr(
            "0002.md",
            "# Queue de trabajos\n\n**Status**: accepted\nLa cola es durable",
        ),
        adr("0003.md", "# Otra cosa\n\nnada que ver"),
    ];
    let m = analyze(&adrs, "src/store/mod.rs");
    assert_eq!(m.len(), 1);
    assert_eq!(
        (m[0].relevance, m[0].reason.as_str()),
        (Relevance::Medium, "ruta coincide: \"src\"")
    );

    let high = analyze(&adrs, "queue.ts");
    assert_eq!(
        high[0].relevance,
        Relevance::High,
        "an accepted ADR titled after the file"
    );
    assert!(high[0].reason.contains("titulo ADR"));

    let text = analyze(&adrs, "lib/durable.js");
    assert!(
        text.iter()
            .any(|m| m.relevance == Relevance::Low && m.reason.contains("durable")),
        "{text:?}"
    );
    assert!(analyze(&adrs, "zz/qq.go").is_empty());
    assert_eq!(search(&adrs, "QUEUE", 5).len(), 1);
    assert!(search(&adrs, "inexistente", 5).is_empty());
}

#[test]
fn risk_follows_the_adrs_and_schema_files_are_never_low() {
    let accepted = adr(
        "a.md",
        "# Autenticación\n\nLos permisos viven en la carpeta auth",
    );
    let proposed = adr(
        "p.md",
        "# Auth\n**Status**: proposed\nmenciona la carpeta auth",
    );
    let adrs = vec![accepted];

    assert_eq!(assess(&adrs, "docs/readme.md").risk, Risk::Low);
    assert_eq!(
        assess(&adrs, "docs/readme.md").reason,
        "Sin ADRs relevantes"
    );
    let medium = assess(&adrs, "src/auth/login.ts");
    assert_eq!(
        medium.risk,
        Risk::High,
        "an accepted ADR names the folder: {medium:?}"
    );
    assert!(medium.reason.contains("Autenticación"));
    assert_eq!(
        assess(&adrs, "src/auth/autenticación.ts").risk,
        Risk::Critical,
        "titled after the file"
    );

    assert_eq!(assess(&[], "db/migrations/001.sql").risk, Risk::High);
    assert_eq!(
        assess(&[], "db/migrations/001.sql").reason,
        "Archivo de schema: siempre alto riesgo"
    );
    assert_eq!(
        assess(&adrs, "src/auth/schema.ts").risk,
        Risk::Critical,
        "schema in a folder an accepted ADR names"
    );

    // A proposal never raises the alarm as high as a decision that was accepted.
    assert_eq!(assess(&[proposed], "src/auth/login.ts").risk, Risk::Medium);
    assert!(Risk::Critical > Risk::High && Risk::High > Risk::Medium && Risk::Medium > Risk::Low);
}

#[test]
fn the_files_a_diff_touches_are_listed_once() {
    let diff = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@\n-x\n+y\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\ndiff --git a/src/a.rs b/src/a.rs\n";
    assert_eq!(files_in_diff(diff), ["src/a.rs", "new.txt"]);
    assert!(files_in_diff("").is_empty());
}
