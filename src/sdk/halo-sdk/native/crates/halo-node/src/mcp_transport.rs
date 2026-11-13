use crate::{decode,failure,host_bridge::CallbackBridge,host_callbacks};
use halo_core::{error::{Error,Result as CoreResult},tools::mcp::public_transport::PublicTransport};
use napi::{Env,JsFunction,JsObject,Result};
use napi_derive::napi;
use serde_json::Value;
use std::{collections::HashMap,future::Future,pin::Pin,sync::{Arc,Mutex}};
use tokio_util::sync::CancellationToken;

#[napi]
pub struct NativeMcpTransport{inner:Arc<PublicTransport>,bridge:Arc<CallbackBridge>,operations:Arc<Mutex<HashMap<String,CancellationToken>>>}
#[napi]
impl NativeMcpTransport{
    #[napi(constructor)]
    pub fn new(mut env:Env,config:String,options:String,callback:JsFunction)->Result<Self>{
        let config=decode(&config)?;let options=decode(&options)?;
        crate::with_runtime(||{let bridge=CallbackBridge::new(env,&callback)?;let inner=Arc::new(PublicTransport::new(config,options,bridge.clone()));
            crate::environment::track(&mut env,&inner,PublicTransport::abort_now,"public MCP transport")?;
            Ok(Self{inner,bridge,operations:Arc::new(Mutex::new(HashMap::new()))})})
    }
    #[napi]
    pub fn connected(&self)->bool{self.inner.connected()}
    #[napi]
    pub fn set_request_handler(&self,method:String,callback:String){self.inner.set_request_handler(method,callback);}
    #[napi]
    pub fn cancel(&self,id:String){if let Some(cancel)=self.operations.lock().unwrap().get(&id){cancel.cancel();}}
    #[napi]
    pub fn start(&self,env:Env,method:String,payload:String,id:String,aborted:bool,callback:JsFunction)->Result<JsObject>{
        let payload=decode(&payload)?;let inner=self.inner.clone();let cancel=CancellationToken::new();if aborted{cancel.cancel();}
        let token=cancel.clone();
        let prepared:Pin<Box<dyn Future<Output=CoreResult<Value>>+Send>>=match method.as_str(){
            "connect"=>{let ready=inner.prepare_connect();Box::pin(async move{ready.await?;Ok(halo_core::js::undefined())})},
            "send"=>Box::pin(async move{inner.send(payload,&token).await}),
            "notify"=>Box::pin(async move{inner.notify(payload).await?;Ok(halo_core::js::undefined())}),
            _=>return Err(failure(Error::new("UNKNOWN_MCP_OPERATION",format!("Unknown MCP transport operation: {method}")))),
        };
        self.operations.lock().unwrap().insert(id.clone(),cancel);let operations=self.operations.clone();
        host_callbacks::start(env,self.bridge.callbacks.clone(),callback,async move{let _operation=Operation{operations,id};prepared.await})
    }
    #[napi]
    pub fn close(&self,env:Env)->Result<JsObject>{self.inner.close().map_err(failure)?;let inner=self.inner.clone();crate::promises::spawn(env,async move{inner.when_closed().await;Ok(())},|_env,value|Ok(value))}
}
struct Operation{operations:Arc<Mutex<HashMap<String,CancellationToken>>>,id:String}
impl Drop for Operation{fn drop(&mut self){self.operations.lock().unwrap().remove(&self.id);}}
impl Drop for NativeMcpTransport{fn drop(&mut self){self.inner.abort_now();self.bridge.abort();}}
