use hivecode_skills::*;
use std::fs;

const TDD: &str = "---\nname: tdd_local\ndescription: Pruebas primero\ncategory: code\ntriggers:\n  - \"test first\"\n  - \"pruebas primero\"\nrules:\n  - \"Escribe la prueba antes\"\nsteps:\n  - step: 1\n    action: red\n    instruction: \"Escribe una prueba que falle\"\n---\n# TDD\nCuerpo.\n";

#[test]
fn the_shipped_skills_all_load_and_spec_kit_is_not_among_them() {
    let skills = bundled();
    assert!(skills.len() >= 30, "{}", skills.len());
    assert!(skills.iter().all(|s| !s.description.is_empty()));
    assert!(skills.iter().all(|s| s.name != "spec-kit"));
    assert!(skills.iter().any(|s| s.name == "test_driven_development"
        && !s.steps.is_empty()
        && !s.triggers.is_empty()));
}

#[test]
fn a_broken_skill_is_reported_with_its_reason() {
    for (text, why) in [
        ("sin encabezado", "encabezado"),
        ("---\nname: x\n", "cerrado"),
        ("---\nname: [\n---\ncuerpo", "YAML"),
        ("---\ndescription: d\n---\ncuerpo", "name"),
        (
            "---\nname: a b\ndescription: d\n---\ncuerpo",
            "identificador",
        ),
        ("---\nname: x\n---\ncuerpo", "description"),
    ] {
        let err = parse(text, Source::User).unwrap_err();
        assert!(err.contains(why), "{text:?} → {err}");
    }
}

#[test]
fn skills_are_chosen_by_whole_word_triggers_and_a_long_phrase_beats_a_short_one() {
    let (skills, _) = {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a")).unwrap();
        fs::write(dir.path().join("a/SKILL.md"), TDD).unwrap();
        load_dir(dir.path(), Source::User)
    };
    assert_eq!(
        select(&skills, "quiero hacer TEST FIRST en este módulo").len(),
        1
    );
    assert_eq!(select(&skills, "haz pruebas primero").len(), 1);
    assert!(
        select(&skills, "pruebas primeroXX").is_empty(),
        "a trigger inside another word is not a match"
    );
    assert!(select(&skills, "añade un botón").is_empty());

    let all = bundled();
    let picked = select(
        &all,
        "quiero desarrollo guiado por tests: pruebas primero y red green refactor",
    );
    assert_eq!(picked[0].name, "test_driven_development");
    assert!(picked.len() <= MAX_SELECTED);
}

#[test]
fn the_prompt_section_is_empty_without_a_match_and_bounded_with_one() {
    let all = bundled();
    assert_eq!(prompt_section(&all, "hola"), "");
    let section = prompt_section(&all, "pruebas primero con red green refactor");
    assert!(
        section.contains("### Skill: test_driven_development")
            && section.contains("Reglas:")
            && section.contains("Pasos:"),
        "{section}"
    );
    assert!(section.chars().count() <= MAX_RENDERED_CHARS + 40);
}

#[test]
fn the_projects_skill_replaces_the_persons_which_replaces_the_shipped_one() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let same = |desc: &str| {
        TDD.replace("tdd_local", "test_driven_development")
            .replace("Pruebas primero", desc)
    };
    fs::create_dir_all(home.path().join("skills/t")).unwrap();
    fs::write(home.path().join("skills/t/SKILL.md"), same("de la persona")).unwrap();
    fs::create_dir_all(project.path().join(".hivecode/skills/t")).unwrap();
    fs::write(
        project.path().join(".hivecode/skills/t/SKILL.md"),
        same("del proyecto"),
    )
    .unwrap();
    fs::create_dir_all(project.path().join(".hivecode/skills/roto")).unwrap();
    fs::write(
        project.path().join(".hivecode/skills/roto/SKILL.md"),
        "nada",
    )
    .unwrap();

    let (skills, problems) = catalog(home.path(), project.path());
    let tdd: Vec<_> = skills
        .iter()
        .filter(|s| s.name == "test_driven_development")
        .collect();
    assert_eq!(tdd.len(), 1);
    assert_eq!(
        (tdd[0].description.as_str(), tdd[0].source),
        ("del proyecto", Source::Project)
    );
    assert_eq!(problems.len(), 1);
    assert!(problems[0].contains("roto"), "{problems:?}");
    let (only_home, _) = catalog(home.path(), tempfile::tempdir().unwrap().path());
    assert_eq!(
        only_home
            .iter()
            .find(|s| s.name == "test_driven_development")
            .unwrap()
            .source,
        Source::User
    );
}
