//! Embeds every `skills/**/SKILL.md` of the repository, so the binary needs no files beside it.
use std::{fmt::Write, fs, path::Path};

fn collect(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else if path.file_name().is_some_and(|n| n == "SKILL.md") {
            out.push(path);
        }
    }
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../skills");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    collect(&root, &mut files);
    let mut code = String::from("pub const EMBEDDED: &[&str] = &[\n");
    for file in &files {
        println!("cargo:rerun-if-changed={}", file.display());
        let absolute = fs::canonicalize(file).expect("skill path");
        writeln!(
            code,
            "    include_str!({:?}),",
            absolute.display().to_string()
        )
        .unwrap();
    }
    code.push_str("];\n");
    fs::write(
        Path::new(&std::env::var("OUT_DIR").unwrap()).join("bundled.rs"),
        code,
    )
    .unwrap();
}
