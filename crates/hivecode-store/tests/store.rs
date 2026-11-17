use hivecode_store::{MAX_PATCH_BYTES, RunDoc, Store};
use hivecode_swarm::findings::Saved;

fn run(id: &str) -> RunDoc {
    RunDoc {
        id: id.into(),
        project: "/p".into(),
        objective: format!("tarea {id}"),
        status: "completed".into(),
        ..Default::default()
    }
}

#[test]
fn runs_survive_reopening_and_come_back_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = Store::open(dir.path()).unwrap();
        for id in ["run-001-a", "run-002-b", "run-003-c"] {
            store.record_run(&run(id)).unwrap();
        }
    }
    let store = Store::open(dir.path()).unwrap();
    let ids: Vec<String> = store.runs(10).unwrap().into_iter().map(|r| r.id).collect();
    assert_eq!(ids, ["run-003-c", "run-002-b", "run-001-a"]);
    assert_eq!(store.runs(2).unwrap().len(), 2);
    assert_eq!(
        store.run("run-002-b").unwrap().unwrap().objective,
        "tarea run-002-b"
    );
    assert!(store.run("nope").unwrap().is_none());
}

#[test]
fn a_patch_is_kept_for_rollback_unless_empty_or_too_big() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.record_run(&run("r1")).unwrap();
    assert!(store.save_patch("r1", "/p", "diff --git a b\n").unwrap());
    assert_eq!(store.patch("r1").unwrap().unwrap().diff, "diff --git a b\n");
    assert!(
        !store.save_patch("r2", "/p", "   \n").unwrap(),
        "nothing to undo"
    );
    assert!(
        !store
            .save_patch("r3", "/p", &"x".repeat(MAX_PATCH_BYTES + 1))
            .unwrap(),
        "too big to keep"
    );
    assert!(store.patch("r3").unwrap().is_none());
    store.mark_rolled_back("r1").unwrap();
    assert!(store.run("r1").unwrap().unwrap().rolled_back);
    assert!(store.mark_rolled_back("nope").is_err());
}

#[test]
fn scout_reports_persist_per_project_and_a_newer_one_replaces_the_older() {
    let dir = tempfile::tempdir().unwrap();
    let saved = |handoff: &str| Saved {
        worker: "scout".into(),
        key: "revisa a.txt".into(),
        files: vec![("a.txt".into(), Some(0xdead_beef_0123_4567), 42)],
        handoff: handoff.into(),
    };
    {
        let store = Store::open(dir.path()).unwrap();
        let mine = store.findings_for("/proyecto/uno");
        assert!(mine.load().is_empty());
        mine.save(&saved("primero"));
        mine.save(&saved("segundo"));
        store.findings_for("/proyecto/dos").save(&Saved {
            key: "otra".into(),
            ..saved("de otro proyecto")
        });
    }
    let store = Store::open(dir.path()).unwrap();
    let loaded = store.findings_for("/proyecto/uno").load();
    assert_eq!(
        loaded,
        vec![saved("segundo")],
        "the same question keeps only its latest report, and the content hash survives"
    );
    assert_eq!(store.findings_for("/proyecto/dos").load().len(), 1);
}

#[test]
fn the_sdk_sessions_share_the_same_database() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.record_run(&run("r")).unwrap();
    // The SDK store is usable beside hivecode's own collections.
    let sessions = store.sessions();
    let guard = sessions.lock().unwrap();
    assert!(guard.as_ref().is_some());
}

#[test]
fn delegations_come_back_per_lead_session_in_numeric_order() {
    use hivecode_swarm::records::SavedRecord;
    let dir = tempfile::tempdir().unwrap();
    let record = |id: &str, worker: &str| SavedRecord {
        id: id.into(),
        reference: format!("ref-{id}"),
        worker: worker.into(),
        session: format!("s-{id}"),
        runs: 1,
        ok: true,
        kept: None,
    };
    {
        let store = Store::open(dir.path()).unwrap();
        let mine = store.records_for("lead-1");
        for n in [1, 2, 10] {
            mine.save(&record(&format!("D{n}"), "scout"));
        }
        mine.save(&SavedRecord {
            runs: 2,
            ..record("D2", "scout")
        }); // a revision updates in place
        store.records_for("lead-2").save(&record("D1", "builder"));
    }
    let store = Store::open(dir.path()).unwrap();
    let loaded = store.records_for("lead-1").load();
    assert_eq!(
        loaded.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["D1", "D2", "D10"],
        "D10 after D2, not after D1"
    );
    assert_eq!(loaded[1].runs, 2);
    assert_eq!(store.records_for("lead-2").load().len(), 1);
}
