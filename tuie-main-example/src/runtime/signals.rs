//! Process signal handling for the runtime.

#[cfg(unix)]
use std::os::unix::io::{AsRawFd, RawFd};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::sync::atomic::Ordering;

#[cfg(unix)]
pub(super) fn install(wake: Option<&UnixStream>) -> std::io::Result<()> {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGTSTP};

    let Some(wake) = wake else {
        return Ok(());
    };
    let fd: RawFd = wake.as_raw_fd();

    for signo in [SIGINT, SIGTERM, SIGHUP, SIGQUIT] {
        // SAFETY: the handler only stores to an atomic and writes one byte to a
        // pipe, both async-signal-safe.
        unsafe {
            signal_hook::low_level::register(signo, move || {
                super::CONTROL
                    .quit_signal
                    .store(128u8.wrapping_add(signo as u8), Ordering::Release);
                poke(fd);
            })?;
        }
    }
    // SAFETY: the handler only stores to an atomic and writes one byte to a
    // pipe, both async-signal-safe.
    unsafe {
        signal_hook::low_level::register(SIGTSTP, move || {
            super::CONTROL.suspend_pending.store(true, Ordering::Release);
            poke(fd);
        })?;
    }
    Ok(())
}

#[cfg(unix)]
fn poke(fd: RawFd) {
    let byte = [0u8];
    // SAFETY: writing one byte from a valid stack buffer to the wake pipe fd.
    unsafe {
        libc::write(fd, byte.as_ptr() as *const libc::c_void, 1);
    }
}

#[cfg(windows)]
pub(super) fn install(_wake: Option<&std::os::windows::io::OwnedHandle>) -> std::io::Result<()> {
    Ok(())
}
