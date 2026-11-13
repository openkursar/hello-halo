use halo_core::tools::ProcessRetirement;
use napi::{Env, Result};
use std::sync::Arc;

pub(crate) fn retain(mut env: Env, retirement: Arc<ProcessRetirement>) -> Result<()> {
    if retirement.is_settled() { return Ok(()); }
    crate::environment::track(&mut env, &retirement, ProcessRetirement::abort_now, "retiring processes")?;
    crate::promises::spawn(env, async move {
        if let Err(error) = retirement.wait_closed().await {
            eprintln!("[SDK:Native] Process retirement failed: code={}", error.code);
            retirement.abort_now();
        }
        Ok(())
    }, |_env, value| Ok(value))?;
    Ok(())
}
