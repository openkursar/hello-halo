use crate::{failure,host_bridge::CallbackBridge,host_callbacks};
use halo_core::{error::Error,js::{text::JsText,value::JsValue,wire::WireDocument},js_value,tools::mcp::public_client::PublicClient};
use napi::{Env,JsFunction,JsObject,Result};
use napi_derive::napi;
use std::{collections::HashMap,sync::{Arc,Mutex}};
use tokio_util::sync::CancellationToken;

fn decode_data(input:&str)->Result<JsValue>{
    WireDocument::from_json_str(input).and_then(|document|document.decode())
        .map_err(|error|failure(Error::new("HOST_DATA_INVALID",error.to_string())))
}

#[napi]
pub struct NativeMcpClient { inner:Arc<PublicClient>,operations:Arc<Mutex<HashMap<String,CancellationToken>>> }
#[napi]
impl NativeMcpClient{
    #[napi(constructor)]
    pub fn new(mut env:Env,name:String,elicitation:bool)->Result<Self>{
        let name=decode_data(&name)?.as_text().cloned().ok_or_else(||failure(Error::new("MCP_NAME","MCP client name must be a string")))?;
        let inner=Arc::new(PublicClient::new(name,elicitation));crate::environment::track(&mut env,&inner,PublicClient::close,"public MCP client")?;
        Ok(Self{inner,operations:Arc::new(Mutex::new(HashMap::new()))})
    }
    #[napi]
    pub fn value(&self,method:String)->Result<String>{
        let value=match method.as_str(){
            "initialized"=>js_value!(self.inner.initialized()),"serverInfo"=>self.inner.server_info(),"instructions"=>self.inner.instructions(),
            "toolsRevision"=>js_value!(self.inner.tools_revision()),"serverInfoRevision"=>js_value!(self.inner.server_info_revision()),
            _=>return Err(failure(Error::new("UNKNOWN_MCP_OPERATION",format!("Unknown MCP client operation: {method}"))))
        };
        Ok(WireDocument::encode(&value).to_json_string())
    }
    #[napi]
    pub fn close(&self){self.inner.close();}
    #[napi]
    pub fn cancel(&self,id:String){if let Some(cancel)=self.operations.lock().unwrap().get(&id){cancel.cancel();}}
    #[napi]
    pub fn start(&self,env:Env,method:String,payload:String,id:String,aborted:bool,callback:JsFunction)->Result<JsObject>{
        let payload=decode_data(&payload)?;let inner=self.inner.clone();let bridge=CallbackBridge::new(env,&callback)?;
        let cancellation=CancellationToken::new();if aborted{cancellation.cancel();}self.operations.lock().unwrap().insert(id.clone(),cancellation.clone());
        let operations=self.operations.clone();let callbacks=bridge.callbacks.clone();
        host_callbacks::start(env,callbacks,callback,async move{
            let _operation=Operation{operations,id,bridge:bridge.clone()};let harness=halo_core::harness::baseline();
            let result=match method.as_str(){
                "initialize"=>{inner.initialize(bridge,&harness).await?;JsValue::Undefined},
                "callTool"=>{
                    let name=payload.get("name").and_then(JsValue::as_text).cloned().unwrap_or_else(||JsText::from(""));
                    inner.call_tool(&name,payload.get("arguments").cloned().unwrap_or(JsValue::Undefined),bridge,&cancellation,&harness).await?.receipt()
                },
                "elicitation"=>inner.elicitation(bridge).await?,
                _=>return Err(Error::new("UNKNOWN_MCP_OPERATION",format!("Unknown MCP client operation: {method}"))),
            };
            Ok(WireDocument::encode(&result).to_json())
        })
    }
}
struct Operation{operations:Arc<Mutex<HashMap<String,CancellationToken>>>,id:String,bridge:Arc<CallbackBridge>}
impl Drop for Operation{fn drop(&mut self){self.operations.lock().unwrap().remove(&self.id);self.bridge.abort();}}
impl Drop for NativeMcpClient{fn drop(&mut self){self.inner.close();}}
