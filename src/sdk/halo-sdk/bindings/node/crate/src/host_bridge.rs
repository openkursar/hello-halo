use crate::host_callbacks::{bind_resource_activity, Callbacks};
use halo_core::{bridge::{HostBridge, HostServices}, error::{Error, Result}, resource_activity::{ResourceActivity,ResourceSubscription}, search::CodeSearchPool};
use async_trait::async_trait;
use napi::{Env,JsFunction};
use serde_json::{json,Value};
use std::sync::{Arc,atomic::{AtomicU64,Ordering}};
use tokio_util::sync::CancellationToken;

pub(crate) struct CallbackBridge {
    pub callbacks:Arc<Callbacks>,
    resources:Arc<ResourceActivity>,
    services:HostServices,
    _subscription:ResourceSubscription,
    next:AtomicU64,
}
impl CallbackBridge {
    pub fn new(mut env:Env,callback:&JsFunction)->napi::Result<Arc<Self>>{
        let callbacks=Callbacks::new_named(env,callback,"Halo MCP callbacks")?;
        let resources=Arc::new(ResourceActivity::new());
        let subscription=bind_resource_activity(&resources,&callbacks);
        let services=crate::environment::host_services(env)?;
        let result=Arc::new(Self{callbacks,resources,services,_subscription:subscription,next:AtomicU64::new(1)});
        crate::environment::track(&mut env,&result,Self::abort,"MCP callback bridge")?;
        Ok(result)
    }
    pub fn abort(&self){self.resources.close();self.callbacks.shutdown();}
    pub fn resources(&self)->Arc<ResourceActivity>{self.resources.clone()}
}
struct Pending<'a>{callbacks:&'a Callbacks,id:String,complete:bool}
impl Drop for Pending<'_>{fn drop(&mut self){if !self.complete{self.callbacks.notify("cancel",json!({"id":self.id}));}}}
#[async_trait]
impl HostBridge for CallbackBridge {
    async fn call_data(&self,method:&str,params:halo_core::js::value::JsValue,cancellation:&CancellationToken)->Result<halo_core::js::value::JsValue>{
        if cancellation.is_cancelled(){return Err(Error::cancelled());}
        let id=self.next.fetch_add(1,Ordering::Relaxed).to_string();
        let mut pending=Pending{callbacks:&self.callbacks,id:id.clone(),complete:false};
        let document=halo_core::js::wire::WireDocument::encode(&params).to_json();
        let result=tokio::select!{biased;
            _=cancellation.cancelled()=>return Err(Error::cancelled()),
            result=self.callbacks.asynchronous("callData",json!({"id":id,"method":method,"params":document}))=>result,
        };
        pending.complete=true;
        halo_core::js::wire::WireDocument::from_json(result?).and_then(|document|document.decode())
            .map_err(|error|Error::new("HOST_DATA_INVALID",error.to_string()))
    }
    async fn call(&self,method:&str,params:Value,cancellation:&CancellationToken)->Result<Value>{
        if cancellation.is_cancelled(){return Err(Error::cancelled());}
        let id=self.next.fetch_add(1,Ordering::Relaxed).to_string();
        let mut pending=Pending{callbacks:&self.callbacks,id:id.clone(),complete:false};
        let result=tokio::select!{biased;
            _=cancellation.cancelled()=>return Err(Error::cancelled()),
            result=self.callbacks.asynchronous("call",json!({"id":id,"method":method,"params":params}))=>result,
        };
        pending.complete=true;result
    }
    fn resource_activity(&self)->Option<Arc<ResourceActivity>>{Some(self.resources.clone())}
    fn code_search_pool(&self)->Option<Arc<CodeSearchPool>>{self.services.code_search_pool.clone()}
    fn http_trust(&self)->Option<Arc<halo_core::http::HostTrust>>{self.services.http_trust.clone()}
}
impl Drop for CallbackBridge{fn drop(&mut self){self.abort();}}
