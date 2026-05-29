//! POSIX shared-memory image transmission.

use std::ffi::CString;
use std::ptr;

fn image_name(id: u32) -> String {
    format!("/tty-graphics-protocol-{id}")
}

fn probe_name() -> String {
    format!("/tty-graphics-protocol-probe-{}", std::process::id())
}

pub(crate) fn write_image(id: u32, bytes: &[u8]) -> Option<String> {
    let name = image_name(id);
    let cname = CString::new(name.as_str()).ok()?;
    write_shm(&cname, bytes)?;
    Some(name)
}

pub(crate) fn write_probe() -> Option<String> {
    let name = probe_name();
    let cname = CString::new(name.as_str()).ok()?;
    write_shm(&cname, &[0, 0, 0])?;
    Some(name)
}

pub(crate) fn unlink_probe() {
    if let Ok(cname) = CString::new(probe_name()) {
        unsafe {
            libc::shm_unlink(cname.as_ptr());
        }
    }
}

fn write_shm(name: &std::ffi::CStr, bytes: &[u8]) -> Option<()> {
    let len = bytes.len();
    unsafe {
        libc::shm_unlink(name.as_ptr());
        let fd = libc::shm_open(
            name.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_RDWR,
            0o600,
        );
        if fd < 0 {
            return None;
        }
        if libc::ftruncate(fd, len as libc::off_t) < 0 {
            libc::close(fd);
            libc::shm_unlink(name.as_ptr());
            return None;
        }
        let p = libc::mmap(
            ptr::null_mut(),
            len,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED,
            fd,
            0,
        );
        if p == libc::MAP_FAILED {
            libc::close(fd);
            libc::shm_unlink(name.as_ptr());
            return None;
        }
        ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, len);
        libc::munmap(p, len);
        libc::close(fd);
    }
    Some(())
}
