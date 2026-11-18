use crate::error::{Error, Result};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    OnceLock,RwLock,
};
use tokio::runtime::{Builder, Handle, Runtime};
use tracing::instrument::WithSubscriber;

static RUNTIME: OnceLock<std::result::Result<Runtime, String>> = OnceLock::new();
static HOST_RUNTIME: RwLock<Option<Handle>> = RwLock::new(None);
static SESSIONS: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn session_started() {
    SESSIONS.fetch_add(1, Ordering::Relaxed);
}
pub(crate) fn session_closed() {
    SESSIONS.fetch_sub(1, Ordering::Relaxed);
}

pub fn diagnostics() -> serde_json::Value {
    serde_json::json!({"implementation":"rust","activeSessions":SESSIONS.load(Ordering::Relaxed)})
}

pub fn shared() -> Result<Handle> {
    crate::logging::initialize();
    if let Some(handle)=HOST_RUNTIME.read().unwrap().as_ref(){return Ok(handle.clone());}
    if let Ok(handle) = Handle::try_current() {
        return Ok(handle);
    }
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .enable_all()
                .thread_name("halo-sdk")
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map(|runtime| runtime.handle().clone())
        .map_err(|message| Error::new("RUNTIME_INITIALIZATION", message))
}

pub fn register_current()->Result<()> {
    let handle=Handle::try_current().map_err(|error|Error::new("RUNTIME_INITIALIZATION",error.to_string()))?;
    *HOST_RUNTIME.write().unwrap()=Some(handle);crate::logging::initialize();Ok(())
}

pub fn spawn<F>(future:F)->tokio::task::JoinHandle<F::Output> where F:std::future::Future+Send+'static,F::Output:Send+'static {
    let handle=Handle::try_current().unwrap_or_else(|_|shared().expect("SDK runtime must be available before spawning work"));
    handle.spawn(future.with_current_subscriber())
}
