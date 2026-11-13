use crate::{error::Result, processes::OwnedProcesses};
use futures::future::{BoxFuture, Shared};
use std::sync::Arc;

#[derive(Clone)]
pub struct ProcessRetirement {
    owners: Vec<Arc<OwnedProcesses>>,
    closing: Vec<Shared<BoxFuture<'static, ()>>>,
}
impl ProcessRetirement {
    pub(crate) fn new(
        owners: Vec<Arc<OwnedProcesses>>,
        closing: Vec<Shared<BoxFuture<'static, ()>>>,
    ) -> Self {
        Self { owners, closing }
    }
    pub(crate) fn append(&mut self, other: Self) {
        for owner in other.owners {
            if !self
                .owners
                .iter()
                .any(|current| Arc::ptr_eq(current, &owner))
            {
                self.owners.push(owner);
            }
        }
        self.closing.extend(other.closing);
    }
    pub fn count(&self) -> usize {
        self.owners.iter().map(|owner| owner.count()).sum()
    }
    pub fn is_settled(&self) -> bool {
        self.count() == 0 && self.closing.iter().all(|future| future.peek().is_some())
    }
    pub fn abort_now(&self) {
        for owner in &self.owners {
            owner.abort_now();
        }
    }
    pub async fn wait_closed(&self)->Result<()> {
        futures::future::join_all(self.closing.iter().cloned()).await;
        for owner in &self.owners {
            if let Err(error) = owner.wait_all().await {
                tracing::warn!(error=%error,"Owned process retirement could not be confirmed");
                return Err(error.into());
            }
        }
        Ok(())
    }
    pub async fn force_reap(&self) -> Result<()> {self.abort_now();self.wait_closed().await}
}
