//! Shared worker thread pool for image decoding.

use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, available_parallelism};

type Job = Box<dyn FnOnce() + Send + 'static>;

struct Pool {
    tx: mpsc::Sender<Job>,
}

impl Pool {
    const FALLBACK_WORKERS: usize = 4;

    fn new(worker_count: usize) -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        for _ in 0..worker_count {
            let rx = Arc::clone(&rx);
            thread::spawn(move || loop {
                let guard = rx.lock().unwrap();
                let Ok(job) = guard.recv() else {
                    return;
                };
                drop(guard);
                job();
            });
        }
        Self { tx }
    }
}

static POOL: OnceLock<Pool> = OnceLock::new();

pub(super) fn spawn(f: impl FnOnce() + Send + 'static) {
    let pool = POOL.get_or_init(|| {
        let worker_count = available_parallelism()
            .map(|n| n.get())
            .unwrap_or(Pool::FALLBACK_WORKERS);
        Pool::new(worker_count)
    });
    let _ = pool.tx.send(Box::new(f));
}
