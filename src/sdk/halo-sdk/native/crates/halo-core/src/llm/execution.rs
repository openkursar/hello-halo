use super::provider::Provider;
use crate::{bridge::HostServices,callback_channel::CallbackChannel,error::{Error,Result}};
use serde_json::{json,Value};
use std::sync::Arc;
pub use super::transport::ProviderTransport;

pub type ProviderExecution = CallbackChannel;

pub fn start_provider(options:Value,request:Value,mode:String,transport:Arc<ProviderTransport>)->Result<Arc<ProviderExecution>>{
    CallbackChannel::spawn(move|channel|async move{
        transport.ensure_open()?;
        channel.set_host_services(HostServices { code_search_pool: None, http_trust: transport.trust() });
        let provider=Provider::with_transport(&options,channel.clone(),transport)?;
        let cancellation=channel.cancellation();
        if mode=="stream"{
            let mut stream=provider.stream(request,cancellation).await?;
            let result:Result<()>=async {while let Some(event)=stream.next().await?{channel.envelope(json!({"kind":"event","event":event})).await?;}Ok(())}.await;
            let cleanup=stream.close().await;result.and(cleanup).map(|_|None)
        }else{
            let result=match mode.as_str(){
                "completeStream"=>{
                    let model=super::anthropic_stream::resolve_model(&request,&json!({"defaultModel":options["nativeCollectorDefaultModel"]}))?;
                    let mut request=request;request["stream"]=json!(true);
                    let mut stream=provider.stream(request,cancellation).await?;let mut collector=super::anthropic_response::ResponseCollector::new(model);
                    let outcome:Result<Value>=async{while let Some(event)=stream.next().await?{collector.event(&event)?;}Ok(collector.finish())}.await;
                    let cleanup=stream.close().await;cleanup?;outcome?
                }
                "complete"=>provider.complete(request,cancellation).await?,
                "models"=>provider.list_models(&cancellation).await?,
                "health"=>provider.health_check(&cancellation).await?,
                _=>return Err(Error::new("INVALID_OPERATION",format!("Unknown provider operation: {mode}"))),
            };Ok(Some(result))
        }
    })
}
