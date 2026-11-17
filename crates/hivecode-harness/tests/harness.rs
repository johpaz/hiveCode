use hivecode_harness::{Lead, Options, Status, Tier, checks, passed, run, weight};
use hivecode_host::{BoxFuture, Mode, Result};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

// ── weight ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn questions_are_conversation_and_reading_or_planning_requests_are_told_apart() {
    let q = weight::analyze("¿qué hace el módulo de auth?");
    assert!(!q.mutating);
    let audit = weight::analyze("revisa el proyecto y planea mejoras");
    assert!(!audit.mutating && audit.reading && audit.planning);
    // Repeated letters read the same: «meejoras», «planeea».
    assert!(weight::analyze("planeea meejoras del proyecto").planning);
    assert_eq!(weight::decide(&audit, None).0, Tier::Conversation);
}

#[test]
fn a_detailed_contract_is_bounded_not_big_and_coupling_makes_a_feature() {
    let contract = "Crea un proyecto en el directorio actual con 5 comandos: add, list, update, delete y search. \
        Los datos viven en un archivo JSON. Escribe pruebas. ".repeat(8);
    let s = weight::analyze(&contract);
    assert!(s.mutating && s.greenfield && s.deliverables == 5, "{s:?}");
    assert_eq!(
        weight::decide(&s, None).0,
        Tier::Scoped,
        "length does not make it heavy"
    );

    let migration = weight::analyze("planifica la migración de arquitectura del módulo de auth");
    assert_eq!(migration.coupled, ["arquitectura", "migración"]);
    let (tier, score, signals) = weight::decide(&migration, None);
    assert_eq!((tier, score), (Tier::Feature, 70));
    assert!(signals.iter().any(|s| s.contains("acoplado: migración")));

    let small = weight::analyze("corrige el bug del login");
    assert_eq!(weight::decide(&small, None).0, Tier::Scoped);
}

#[test]
fn the_project_adds_context_the_statement_cannot_know() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..70 {
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join(format!("src/f{i}.py")), "x").unwrap();
    }
    let facts = weight::project_facts(dir.path());
    assert!(facts.files >= 70 && facts.modules == 1 && !facts.has_tests);
    assert_eq!(facts.ecosystems, ["python"]);
    let s = weight::analyze("agrega un endpoint a la api y una pantalla en el frontend");
    let (_, score, signals) = weight::decide(&s, Some(&facts));
    assert!(
        score >= 10 + 25 + 10,
        "two areas, a big project, no tests: {signals:?}"
    );
    assert!(
        weight::describe_facts(&facts, &["pruebas".into()], &[]).contains("ecosistema: python")
    );
}

// ── routing ───────────────────────────────────────────────────────────────────────────────────

type Reply = Box<dyn FnMut(&str, usize) -> String + Send>;
struct Fake {
    prompts: Arc<Mutex<Vec<String>>>,
    reply: Reply,
}
impl Lead for Fake {
    fn invoke<'a>(&'a mut self, prompt: String) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let n = self.prompts.lock().unwrap().len();
            let reply = (self.reply)(&prompt, n);
            self.prompts.lock().unwrap().push(prompt);
            Ok(reply)
        })
    }
}
fn fake(
    reply: impl FnMut(&str, usize) -> String + Send + 'static,
) -> (Fake, Arc<Mutex<Vec<String>>>) {
    let prompts: Arc<Mutex<Vec<String>>> = Arc::default();
    (
        Fake {
            prompts: prompts.clone(),
            reply: Box::new(reply),
        },
        prompts,
    )
}
fn project(verify: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".hivecode")).unwrap();
    std::fs::write(dir.path().join(".hivecode/verify.json"), verify).unwrap();
    std::fs::write(dir.path().join("a.txt"), "x").unwrap();
    dir
}
fn options(dir: &Path, mode: Mode, swarm: bool, verify: bool) -> Options {
    Options {
        workspace: dir.to_owned(),
        mode,
        swarm,
        verify,
    }
}
const SCOPED: &str = "corrige el bug del login";
const FEATURE: &str = "planifica la migración de arquitectura del módulo de auth";

#[tokio::test]
async fn a_conversation_is_one_call_and_a_reading_request_gets_the_reading_guidance() {
    let dir = project("{}");
    let (mut lead, prompts) = fake(|_, _| "respuesta".into());
    let out = run(
        "¿qué hace el módulo de auth?",
        &options(dir.path(), Mode::Auto, true, true),
        &mut lead,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!(
        (out.route, out.status, out.response.as_str()),
        (Tier::Conversation, Status::Completed, "respuesta")
    );
    assert_eq!(
        prompts.lock().unwrap().as_slice(),
        ["¿qué hace el módulo de auth?"],
        "the question goes through untouched"
    );

    let (mut lead, prompts) = fake(|_, _| "informe".into());
    run(
        "revisa el proyecto y planea mejoras",
        &options(dir.path(), Mode::Auto, true, true),
        &mut lead,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    let sent = prompts.lock().unwrap()[0].clone();
    assert!(
        sent.contains("task_delegate_group")
            && sent.contains("roadmap priorizado")
            && sent.contains("Objetivo:"),
        "{sent}"
    );
    let (mut lead, prompts) = fake(|_, _| "informe".into());
    run(
        "revisa el proyecto",
        &options(dir.path(), Mode::Auto, false, true),
        &mut lead,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert!(
        !prompts.lock().unwrap()[0].contains("task_delegate_group"),
        "no workers, no delegation advice"
    );
}

#[tokio::test]
async fn plan_mode_answers_with_a_plan_for_any_change_and_executes_nothing() {
    let dir = project(r#"{"test":"exit 9"}"#);
    for objective in [SCOPED, FEATURE] {
        let (mut lead, prompts) = fake(|_, _| "1. paso".into());
        let out = run(
            objective,
            &options(dir.path(), Mode::Plan, true, true),
            &mut lead,
            &mut |_, _| panic!("no gate in plan mode"),
        )
        .await
        .unwrap();
        assert_eq!(out.status, Status::Ready);
        assert_eq!(
            prompts.lock().unwrap().len(),
            1,
            "one call, no verification, no delegation"
        );
        assert!(prompts.lock().unwrap()[0].starts_with("Modo plan"));
    }
}

#[tokio::test]
async fn a_scoped_change_is_verified_by_running_the_project_and_reported_with_the_evidence() {
    let dir = project(r#"{"test":"echo todo-ok"}"#);
    let (mut lead, prompts) = fake(|_, _| "hecho".into());
    let out = run(
        SCOPED,
        &options(dir.path(), Mode::Auto, true, true),
        &mut lead,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!(
        (out.route, out.status, out.repair_cycles),
        (Tier::Scoped, Status::Completed, 0)
    );
    assert!(
        out.response.starts_with("hecho")
            && out.response.contains("todo en verde")
            && out.response.contains("pruebas ✓"),
        "{}",
        out.response
    );
    let sent = prompts.lock().unwrap()[0].clone();
    assert!(
        sent.contains("al terminar, el harness ejecuta solo (pruebas)")
            && sent.contains("echo todo-ok"),
        "the lead is told what will be checked: {sent}"
    );
}

#[tokio::test]
async fn red_gets_one_repair_cycle_and_green_after_it_is_completed() {
    let dir = project(r#"{"test":"test -f arreglado.flag"}"#);
    let root = dir.path().to_owned();
    let (mut lead, prompts) = fake(move |prompt, _| {
        if prompt.contains("salió en rojo") {
            std::fs::write(root.join("arreglado.flag"), "").unwrap();
        }
        "listo".into()
    });
    let out = run(
        SCOPED,
        &options(dir.path(), Mode::Auto, false, true),
        &mut lead,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!((out.status, out.repair_cycles), (Status::Completed, 1));
    let repair = prompts.lock().unwrap()[1].clone();
    assert!(
        repair.contains("Comprobaciones en rojo")
            && repair.contains("- pruebas:")
            && repair.contains(SCOPED),
        "{repair}"
    );
}

#[tokio::test]
async fn still_red_after_the_repair_is_reported_as_failed_never_as_good() {
    let dir = project(r#"{"test":"echo se-rompe-aqui; exit 1"}"#);
    let (mut lead, prompts) = fake(|_, _| "intento".into());
    let out = run(
        SCOPED,
        &options(dir.path(), Mode::Auto, false, true),
        &mut lead,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!((out.status, out.repair_cycles), (Status::Failed, 1));
    assert_eq!(prompts.lock().unwrap().len(), 2, "exactly one repair");
    assert!(
        out.response.contains("hay comprobaciones en rojo")
            && out.response.contains("se-rompe-aqui"),
        "{}",
        out.response
    );
}

#[tokio::test]
async fn nothing_to_run_is_not_a_failure_and_a_missing_toolchain_is_skipped() {
    let dir = project(r#"{"test":"echo 'Ran 0 tests'; exit 5"}"#);
    let verdict = checks::verify(dir.path()).await;
    assert!(
        verdict.ok,
        "a runner that found no tests did not find broken ones: {verdict:?}"
    );
    assert_eq!(verdict.checks[0].status, checks::Status::Skipped);

    let go = tempfile::tempdir().unwrap();
    std::fs::write(go.path().join("go.mod"), "module x").unwrap();
    let verdict = checks::verify(go.path()).await;
    // Whether Go is installed here or not, the harness never calls an absent toolchain a failure.
    assert!(
        verdict
            .checks
            .iter()
            .all(|c| c.status != checks::Status::Failed || which_go()),
        "{verdict:?}"
    );
}
fn which_go() -> bool {
    std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("go").is_file()))
}

#[tokio::test]
async fn verification_can_be_turned_off() {
    let dir = project(r#"{"test":"exit 1"}"#);
    let (mut lead, _) = fake(|_, _| "hecho".into());
    let out = run(
        SCOPED,
        &options(dir.path(), Mode::Auto, false, false),
        &mut lead,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!(
        (out.status, out.response.as_str()),
        (Status::Completed, "hecho")
    );
}

#[tokio::test]
async fn a_feature_converges_through_the_quality_gate_with_repair_cycles_and_a_final_run() {
    let dir = project(r#"{"test":"echo ok"}"#);
    let (mut lead, prompts) = fake(|prompt, n| match n {
        0 => "tareas hechas\nVERDICT: FAIL (falta validar)".into(),
        1 => {
            assert!(prompt.contains("Ciclo de reparación 1/2") && prompt.contains("falta validar"));
            "reparado\nVERDICT: PASS".into()
        }
        _ => "resumen final".into(),
    });
    let mut asked = vec![];
    let out = run(
        FEATURE,
        &options(dir.path(), Mode::Approval, true, true),
        &mut lead,
        &mut |gate, text| {
            asked.push((gate.to_owned(), text.to_owned()));
            true
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (out.route, out.status, out.repair_cycles),
        (Tier::Feature, Status::Completed, 1)
    );
    assert_eq!(
        prompts.lock().unwrap().len(),
        3,
        "attempt, repair, convergence"
    );
    assert!(out.response.contains("resumen final") && out.response.contains("todo en verde"));
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].0, "convergence");
    assert!(prompts.lock().unwrap()[0].contains("task_delegate_group"));
}

#[tokio::test]
async fn a_declined_convergence_waits_for_the_person_and_auto_mode_never_asks() {
    let dir = project("{}");
    let (mut lead, _) = fake(|_, n| {
        if n == 0 {
            "VERDICT: PASS".into()
        } else {
            "resumen".into()
        }
    });
    let out = run(
        FEATURE,
        &options(dir.path(), Mode::Approval, true, false),
        &mut lead,
        &mut |_, _| false,
    )
    .await
    .unwrap();
    assert_eq!(out.status, Status::WaitingUser);
    let (mut lead, _) = fake(|_, n| {
        if n == 0 {
            "VERDICT: PASS".into()
        } else {
            "resumen".into()
        }
    });
    let out = run(
        FEATURE,
        &options(dir.path(), Mode::Auto, true, false),
        &mut lead,
        &mut |_, _| panic!("auto never asks"),
    )
    .await
    .unwrap();
    assert_eq!(out.status, Status::Completed);
}

#[tokio::test]
async fn a_gate_that_never_passes_fails_after_two_repair_cycles() {
    let dir = project("{}");
    let (mut lead, prompts) = fake(|_, _| "VERDICT: FAIL".into());
    let out = run(
        FEATURE,
        &options(dir.path(), Mode::Auto, true, false),
        &mut lead,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!((out.status, out.repair_cycles), (Status::Failed, 2));
    assert_eq!(prompts.lock().unwrap().len(), 3);
    assert!(out.response.contains("no convergió"));
}

#[tokio::test]
async fn without_workers_a_feature_is_run_like_a_scoped_change() {
    let dir = project(r#"{"test":"echo ok"}"#);
    let (mut lead, prompts) = fake(|_, _| "hecho".into());
    let out = run(
        FEATURE,
        &options(dir.path(), Mode::Auto, false, true),
        &mut lead,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!(
        out.route,
        Tier::Feature,
        "the route is still reported as it was decided"
    );
    assert!(prompts.lock().unwrap()[0].starts_with("Cambio pequeño"));
}

#[test]
fn verdicts_need_an_explicit_pass_and_no_fail() {
    assert!(passed("todo bien\nVERDICT: PASS"));
    assert!(passed("veredicto: aprobado"));
    assert!(!passed("VERDICT: PASS pero luego\nVERDICT: FAIL"));
    assert!(!passed("parece que funciona"));
}

#[tokio::test]
async fn a_type_checker_that_did_not_run_is_the_environment_not_a_type_error() {
    // package.json + tsconfig + a "compiler" that is only a marker: `tsc` itself is not on this PATH.
    let dir = tempfile::tempdir().unwrap();
    for (path, content) in [
        ("package.json", "{}"),
        ("tsconfig.json", "{}"),
        ("node_modules/typescript/package.json", "{}"),
        ("package-lock.json", "{}"),
    ] {
        let full = dir.path().join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, content).unwrap();
    }
    let planned = checks::planned(dir.path()).await;
    if !planned
        .iter()
        .any(|c| c.label.as_str() == "tipos" && c.skip.is_none())
    {
        return; // npm is not installed here: nothing to run, and nothing to assert.
    }
    let verdict = checks::verify(dir.path()).await;
    let types = verdict.checks.iter().find(|c| c.name == "tipos").unwrap();
    // Either the machine really has a working tsc for this fake package (impossible) or it is skipped.
    assert_ne!(types.status, checks::Status::Failed, "{verdict:?}");
}
