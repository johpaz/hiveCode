//! Scheduled tasks: `hivecode cron add|list|enable|disable|run`.
//!
//! Built on the SDK's durable scheduler: a schedule is stored in a queue (its own database,
//! `<home>/data/cron`, so the daemon never fights a run for the lock on the main one), published as a
//! job when it is due, and executed by a worker pool. A job is just `hivecode run` in a child
//! process, so a scheduled task is exactly a task a person could type: same provider, same worktree
//! and integration, same history. Nobody is there to approve, so `approval` mode is refused.
//!
//! The SDK's rules apply as they are: a schedule is immutable (to change one, disable it and add a
//! new one under another name), a missed occurrence is skipped (not replayed in a burst), and an
//! occurrence is not published while the previous one has not finished.
use crate::home;
use hive_agent_core::harness::{
    DurableQueue, Job, JobOutcome, QueuePolicy, ScheduleSpec, WorkerPool,
};
use hivecode_host::CancellationToken;
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio, time::Duration};

type Res = hivecode_host::Result<()>;

fn db() -> PathBuf {
    home().join("data").join("cron")
}

/// The queue the schedules live in. The store is returned too: it must outlive the queue.
fn queue() -> hivecode_host::Result<(hivecode_store::Store, DurableQueue)> {
    let store = hivecode_store::Store::open(&db())?;
    let queue = {
        let sessions = store.sessions();
        let guard = sessions.lock().map_err(|_| "store lock poisoned")?;
        guard
            .as_ref()
            .ok_or("the store is closed")?
            .queue("hivecode.cron")?
    };
    queue.open(QueuePolicy {
        max_concurrency: 2,
        lease_ms: 60_000,
        task_timeout_ms: Some(3_600_000),
        ..Default::default()
    })?;
    Ok((store, queue))
}

/// `2026-11-17 08:00:00Z` from unix milliseconds (UTC; civil-from-days, no calendar crate needed).
fn utc(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn take(args: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
    match args.iter().position(|a| a == name) {
        None => Ok(None),
        Some(i) if i + 1 < args.len() => {
            let value = args.remove(i + 1);
            args.remove(i);
            Ok(Some(value))
        }
        Some(_) => Err(format!("{name} necesita un valor")),
    }
}

pub async fn command(mut args: Vec<String>) -> Res {
    let sub = if args.is_empty() {
        "list".to_owned()
    } else {
        args.remove(0)
    };
    match sub.as_str() {
        "add" => add(args),
        "list" => list(),
        "enable" | "disable" => {
            let name = args
                .first()
                .ok_or(format!("uso: hivecode cron {sub} NOMBRE"))?;
            let (_store, queue) = queue()?;
            queue.enable_schedule(name, sub == "enable")?;
            println!(
                "Tarea `{name}`: {}.",
                if sub == "enable" {
                    "activada"
                } else {
                    "desactivada"
                }
            );
            Ok(())
        }
        "run" => run(args).await,
        other => Err(format!(
            "subcomando desconocido: cron {other} (add, list, enable, disable, run)"
        )
        .into()),
    }
}

fn add(mut args: Vec<String>) -> Res {
    let usage = "uso: hivecode cron add NOMBRE (--cron \"EXPR\" [--tz ZONA] | --every-seconds N) --task \"TEXTO\" [--root DIR] [--mode plan|auto] [--swarm]";
    let name = (!args.is_empty() && !args[0].starts_with("--"))
        .then(|| args.remove(0))
        .ok_or(usage)?;
    let swarm = args
        .iter()
        .position(|a| a == "--swarm")
        .map(|i| args.remove(i))
        .is_some();
    let (cron, tz) = (take(&mut args, "--cron")?, take(&mut args, "--tz")?);
    let every = take(&mut args, "--every-seconds")?;
    let task = take(&mut args, "--task")?
        .filter(|t| !t.trim().is_empty())
        .ok_or(usage)?;
    let root = std::fs::canonicalize(
        take(&mut args, "--root")?
            .map(PathBuf::from)
            .unwrap_or_else(|| ".".into()),
    )?;
    let mode = take(&mut args, "--mode")?.unwrap_or_else(|| "plan".into());
    if let Some(extra) = args.first() {
        return Err(format!("argumento inesperado: {extra}").into());
    }
    if !matches!(mode.as_str(), "plan" | "auto") {
        return Err("una tarea programada corre sin nadie delante: el modo es `plan` o `auto` (`approval` no tiene a quién preguntar)".into());
    }
    let schedule = match (cron, every) {
        (Some(expression), None) => {
            json!({"kind": "cron", "expression": expression, "timezone": tz.unwrap_or_else(|| "UTC".into())})
        }
        (None, Some(secs)) => {
            let secs: u64 = secs
                .parse()
                .map_err(|_| "--every-seconds: un número de segundos")?;
            json!({"kind": "interval", "every_ms": secs.checked_mul(1000).ok_or("--every-seconds es demasiado grande")?})
        }
        _ => return Err("indica --cron o --every-seconds (uno de los dos)".into()),
    };
    let spec: ScheduleSpec = serde_json::from_value(json!({
        "schedule": schedule,
        "job": {"kind": "task", "lane": name, "max_attempts": 1,
                "payload": {"task": task, "root": root, "mode": mode, "swarm": swarm}},
    }))?;
    let (_store, queue) = queue()?;
    let created = queue.create_schedule(&name, spec).map_err(|e| {
        if e.to_string().contains("SCHEDULE_IDEMPOTENCY_CONFLICT") {
            format!("ya hay una tarea `{name}` con otra definición: las programadas no se editan; desactívala y crea otra con otro nombre")
        } else {
            e.to_string()
        }
    })?;
    queue.enable_schedule(&name, true)?;
    match created["next_due"].as_u64() {
        Some(next) => println!(
            "Tarea `{name}` programada; próxima ejecución: {}.",
            utc(next)
        ),
        None => println!("Tarea `{name}` guardada, sin próxima ejecución."),
    }
    Ok(())
}

fn list() -> Res {
    let (_store, queue) = queue()?;
    let page = queue.list_schedules(200, None)?;
    let items = page["items"].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        println!(
            "Sin tareas programadas. Añade una: hivecode cron add NOMBRE --cron \"0 8 * * MON-FRI\" --task \"...\""
        );
    }
    for item in items {
        let report = queue
            .get_schedule(item["id"].as_str().unwrap_or_default())?
            .unwrap_or(item);
        let spec = &report["spec"];
        let when = match spec["schedule"]["kind"].as_str() {
            Some("cron") => format!(
                "cron {} ({})",
                spec["schedule"]["expression"].as_str().unwrap_or(""),
                spec["schedule"]["timezone"].as_str().unwrap_or("")
            ),
            Some("interval") => format!(
                "cada {} s",
                spec["schedule"]["every_ms"].as_u64().unwrap_or(0) / 1000
            ),
            _ => "una vez".to_owned(),
        };
        let next = report["next_due"].as_u64().map_or("—".to_owned(), utc);
        let last = report["active_job"]["status"].as_str().unwrap_or("—");
        println!(
            "{} {:<14} {:<9} {when}\n    próxima: {next} · publicadas: {} · último: {last}\n    {}",
            if report["enabled"] == true {
                "●"
            } else {
                "○"
            },
            report["id"].as_str().unwrap_or(""),
            report["status"].as_str().unwrap_or(""),
            report["published"],
            spec["job"]["payload"]["task"]
                .as_str()
                .unwrap_or("")
                .lines()
                .next()
                .unwrap_or("")
        );
    }
    Ok(())
}

/// One scheduled job: `hivecode run` in a child process with the job's own task, root and mode.
async fn execute(job: Job, cancel: CancellationToken) -> hive_agent_core::Result<JobOutcome> {
    let p = &job.input.payload;
    let mut command = tokio::process::Command::new(
        std::env::current_exe().map_err(|e| hive_agent_core::Error::State(e.to_string()))?,
    );
    command.args([
        "run",
        "--headless",
        // Tells the person (Telegram/webhook, if configured with `hivecode notify`) how it ended.
        "--notify",
        "--mode",
        p["mode"].as_str().unwrap_or("plan"),
        "--root",
        p["root"].as_str().unwrap_or("."),
    ]);
    if p["swarm"] == true {
        command.arg("--swarm");
    }
    command.arg(p["task"].as_str().unwrap_or_default());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|e| hive_agent_core::Error::State(format!("cannot start hivecode run: {e}")))?;
    let output = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(JobOutcome::Cancelled),
        output = child.wait_with_output() => output.map_err(|e| hive_agent_core::Error::State(e.to_string()))?,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let done: Value = stdout
        .lines()
        .rev()
        .find_map(|l| {
            serde_json::from_str(l)
                .ok()
                .filter(|v: &Value| v["type"] == "done")
        })
        .unwrap_or(Value::Null);
    Ok(if output.status.success() {
        JobOutcome::Completed {
            result: json!({"run_id": done["run_id"], "integration": done["integration"]}),
        }
    } else {
        let why = String::from_utf8_lossy(&output.stderr);
        JobOutcome::Failed {
            error: why
                .lines()
                .last()
                .unwrap_or("hivecode run failed")
                .to_owned(),
            retryable: false,
        }
    })
}

/// `hivecode cron run [--once] [--poll-ms N]`: the daemon. With `--once` it publishes what is due,
/// runs it and returns (what an external cron or a test wants).
async fn run(mut args: Vec<String>) -> Res {
    let once = args
        .iter()
        .position(|a| a == "--once")
        .map(|i| args.remove(i))
        .is_some();
    let poll: u64 = take(&mut args, "--poll-ms")?
        .map(|v| v.parse())
        .transpose()
        .map_err(|_| "--poll-ms: milisegundos")?
        .unwrap_or(1000);
    let (_store, queue) = queue()?;
    let mut pool = WorkerPool::new(queue.clone(), format!("cron-{}", std::process::id()))?;
    pool.register("task", execute)?;
    if once {
        let page = queue.list_schedules(200, None)?;
        for item in page["items"].as_array().cloned().unwrap_or_default() {
            queue.tick_schedule(item["id"].as_str().unwrap_or_default(), None)?;
        }
        let jobs = pool.run_once().await?;
        for job in &jobs {
            println!("{} · {:?}", job.input.lane, job.status);
        }
        println!("{} tarea(s) ejecutada(s).", jobs.len());
        return Ok(());
    }
    eprintln!("hivecode cron: sondeando cada {poll} ms (Ctrl+C para salir)");
    let stop = CancellationToken::new();
    let producer = tokio::spawn({
        let (queue, stop) = (queue.clone(), stop.clone());
        async move { queue.run_scheduler(poll.clamp(10, 60_000), stop).await }
    });
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            ran = pool.run_once() => {
                for job in ran? {
                    eprintln!("{} · {:?}", job.input.lane, job.status);
                }
                tokio::time::sleep(Duration::from_millis(poll)).await;
            }
        }
    }
    stop.cancel();
    pool.stop();
    let _ = producer.await;
    Ok(())
}
