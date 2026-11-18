use super::{catalog, checkpoint, history, State};
use serde_json::{json, Value};

fn tool(name: &str, description: &str) -> Value {
    json!({"name":format!("mcp__crm__{name}"),"description":description,"mcpSource":{"server":"crm","name":name},"input_schema":{"type":"object","properties":{"customerId":{"type":"string"}}}})
}
fn definition(name: &str) -> Value {
    let mut item = json!({"server":"crm","identity":"installed-crm","originalName":name,"usageGuide":"Use account references.","definition":{"name":format!("mcp__crm__{name}"),"description":format!("{name} complete definition."),"input_schema":{"type":"object","properties":{"account":{"type":"string"}},"required":["account"],"additionalProperties":false}}});
    item["version"] = json!(catalog::fingerprint(&item)); item
}
fn snapshot(items: Vec<Value>) -> Value { json!({"version":1,"generation":"current","discoveryEntries":true,"directory":"Available services: customer records.","definitions":items}) }
fn baseline(snapshot: &Value) -> Value { json!({"role":"user","isMeta":true,"content":"Available services: customer records.","toolContext":{"version":1,"baselineAttachment":true,"baseline":snapshot}}) }
fn discovery(item: &Value, guide: bool) -> Vec<Value> {
    let id = format!("search-{}",item["originalName"].as_str().unwrap());
    let mut shown = item["definition"].clone(); shown["version"] = item["version"].clone(); if guide { shown["usage_guide"] = item["usageGuide"].clone(); }
    vec![json!({"role":"assistant","content":[{"type":"tool_use","name":"ToolSearch","id":id,"input":{"query":format!("select:{}",item["definition"]["name"].as_str().unwrap())}}]}), json!({"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":json!({"tools":[shown]}).to_string()}],"toolContext":{"version":1,"discoveries":[{"callId":id,"definitions":[item]}],"presentations":[{"callId":id,"definitions":[item["version"]],"guides":if guide {vec![item["version"].clone()]} else {vec![]}}]}})]
}
fn policy() -> Value { json!({"services":{"crm":{"identity":"fixture","loading":"deferred","summary":"Customer records","usageGuide":"Use account references."}}}) }
fn owner() -> State { State::new(&[tool("lookup","Look up customer records.")], &policy(), 32768, 10000.0, &[], false).unwrap() }
fn search(state: &mut State, id: &str, explicit: bool, rejected: bool) -> Value {
    let result = state.search(&json!({"query":if explicit {"select:mcp__crm__lookup"} else {"lookup"}}), id);
    let result = if rejected {json!({"content":"Replaced by the output hook.","isError":false})} else {result};
    let (result, _) = state.settle(id, result, "", "");
    let mut block = json!({"type":"tool_result","tool_use_id":id,"content":result["content"]});
    if result["isError"] == true { block["is_error"] = json!(true); }
    block
}
#[test]
fn checkpoint_retains_one_baseline_and_deduplicates_verified_presentations() {
    let alpha = definition("alpha"); let beta = definition("beta");
    let current = snapshot(vec![alpha.clone(),beta.clone()]);
    let old = baseline(&snapshot(vec![alpha.clone()])); let found = discovery(&beta,true);
    let source = [vec![old],found.clone()].concat(); let candidate = [vec![baseline(&current)],source.clone()].concat(); let original = candidate.clone();
    let prepared = checkpoint::prepare(&candidate,&source,Some(&current)).unwrap();
    assert_eq!(prepared.iter().filter(|item|item["toolContext"].get("baseline").is_some()).count(),1);
    assert_eq!(&prepared[1..],found.as_slice()); assert_eq!(history::read_snapshot(&prepared).unwrap().unwrap()["definitions"],current["definitions"]);
    let visible = prepared.iter().map(|item|item["content"].to_string()).collect::<Vec<_>>().join("\n");
    assert_eq!(visible.matches("alpha complete definition.").count(),1); assert_eq!(visible.matches("beta complete definition.").count(),1); assert_eq!(visible.matches("Use account references.").count(),1);
    assert_eq!(candidate,original); assert_eq!(checkpoint::prepare(&prepared,&prepared,Some(&current)).unwrap(),prepared);
    let retained = [discovery(&alpha,false),discovery(&beta,false)].concat(); let candidate = [vec![baseline(&current)],retained.clone()].concat();
    let prepared = checkpoint::prepare(&candidate,&retained,Some(&current)).unwrap();
    let recovery = prepared[0]["content"].as_str().unwrap(); assert!(recovery.contains("Service usage guides:")); assert!(!recovery.contains("alpha complete definition.")); assert!(!recovery.contains("beta complete definition."));
    assert_eq!(prepared.iter().map(|item|item["content"].to_string().matches("Use account references.").count()).sum::<usize>(),1);
    assert_eq!(history::read_snapshot(&prepared).unwrap().unwrap()["definitions"],current["definitions"]); assert_eq!(checkpoint::prepare(&prepared,&prepared,Some(&current)).unwrap(),prepared);
    let current = snapshot(vec![alpha.clone()]); let mut retained = discovery(&alpha,true); retained[1]["toolContext"].as_object_mut().unwrap().remove("discoveries");
    let candidate = [vec![baseline(&current)],retained.clone()].concat(); let prepared = checkpoint::prepare(&candidate,&retained,Some(&current)).unwrap();
    assert_eq!(prepared[0]["content"],current["directory"]); assert!(!prepared.iter().any(|item|item["toolContext"].get("discoveries").is_some())); assert_eq!(history::read_snapshot(&prepared).unwrap().unwrap()["definitions"],current["definitions"]);
    assert_eq!(checkpoint::prepare(&prepared,&prepared,Some(&current)).unwrap(),prepared);
}
#[test]
fn checkpoint_verifies_utf16_spans_and_restores_untrusted_or_incomplete_payloads() {
    let alpha = definition("alpha"); let beta = definition("beta"); let current = snapshot(vec![alpha.clone()]);
    for kind in ["span","empty-span","untrusted","truncated","wrong-schema","error"] {
        let mut retained = discovery(&alpha,true);
        if kind == "span" {
            let prefix = format!("Host note 中文 🧩: {}\n\n",json!({"tools":[beta["definition"]]}));
            let payload = retained[1]["content"][0]["content"].as_str().unwrap().to_owned();
            retained[1]["content"][0]["content"] = json!(format!("{prefix}{payload}\n\nHost suffix."));
            retained[1]["toolContext"]["presentations"][0]["payloadOffset"] = json!(prefix.encode_utf16().count()); retained[1]["toolContext"]["presentations"][0]["payloadLength"] = json!(payload.encode_utf16().count());
        } else if kind == "empty-span" {
            let payload = retained[1]["content"][0]["content"].as_str().unwrap().to_owned(); let context = "{\"tools\":[]}";
            retained[1]["content"][0]["content"] = json!(format!("{context}\n\n{payload}")); retained[1]["toolContext"]["presentations"][0]["payloadOffset"] = json!(0); retained[1]["toolContext"]["presentations"][0]["payloadLength"] = json!(context.len());
        } else if kind == "untrusted" || kind == "error" {
            retained[1].as_object_mut().unwrap().remove("toolContext"); if kind == "error" {retained[1]["content"][0]["is_error"] = json!(true);}
        } else if kind == "truncated" {
            let payload = retained[1]["content"][0]["content"].as_str().unwrap(); retained[1]["content"][0]["content"] = json!(&payload[..payload.len()-12]);
        } else {
            let mut payload: Value = serde_json::from_str(retained[1]["content"][0]["content"].as_str().unwrap()).unwrap(); payload["tools"][0]["input_schema"] = json!({"type":"object"}); retained[1]["content"][0]["content"] = json!(payload.to_string());
        }
        let candidate = [vec![baseline(&current)],retained.clone()].concat(); let prepared = checkpoint::prepare(&candidate,&retained,Some(&current)).unwrap();
        if kind=="span" {assert_eq!(prepared[0]["content"],current["directory"]);} else {assert!(prepared[0]["content"].as_str().unwrap().contains("alpha complete definition."),"{kind}");}
        assert_eq!(&prepared[1..],retained.as_slice()); assert_eq!(history::read_snapshot(&prepared).unwrap().unwrap()["definitions"],current["definitions"]); assert_eq!(checkpoint::prepare(&prepared,&prepared,Some(&current)).unwrap(),prepared);
    }
}
#[test]
fn state_admission_commit_restore_and_fixed_declarations_preserve_ownership() {
    let mut state = owner(); let declarations = state.model_definitions.clone();
    assert_eq!(declarations.iter().map(|item|item["name"].as_str().unwrap()).collect::<Vec<_>>(),["ToolSearch","CallTool"]); assert!(!json!(declarations).to_string().contains("mcp__crm__lookup"));
    let wrapper = json!({"type":"tool_use","id":"execute","name":"CallTool","input":{"tool":"mcp__crm__lookup","arguments":"{ \"customer\" : \"42\" }"}});
    let baseline = state.recovery_message(); let found = state.search(&json!({"query":"lookup"}),"search"); let (result,record) = state.settle("search",found,"",""); let record = record.unwrap();
    assert!(result["content"].as_str().unwrap().contains("arguments_schema")); assert!(!record["discoveries"][0]["definitions"].as_array().unwrap().is_empty()); assert!(state.normalize(&wrapper).2.is_some());
    state.commit(&record).unwrap(); let (call,origin,error) = state.normalize(&wrapper); assert!(error.is_none()); assert_eq!(call["name"],"mcp__crm__lookup"); assert_eq!(call["input"],json!({"customer":"42"})); assert_eq!(state.model_definitions,declarations);
    let message = json!({"role":"assistant","content":[call],"toolContext":{"version":2,"calls":[origin.unwrap()]}}); let original = message.clone(); let projected = history::project(&[message.clone()]); assert!(projected[0].get("toolContext").is_none()); assert_eq!(projected[0]["content"],json!([wrapper])); assert_eq!(message,original);
    for arguments in ["null","[]","1","\"text\"","{"] {
        let mut invalid = wrapper.clone(); invalid["input"]["arguments"] = json!(arguments); assert!(state.normalize(&invalid).2.is_some(),"{arguments}");
    }
    let mut extra = wrapper.clone(); extra["input"]["extra"] = json!(true); assert!(state.normalize(&extra).2.is_some());
    let mut eager = wrapper.clone(); eager["input"]["tool"] = json!("Read"); assert!(state.normalize(&eager).2.is_some());
    assert!(state.normalize(&json!({"type":"tool_use","id":"direct","name":"mcp__crm__lookup","input":{}})).2.is_some());
    let repeated = state.search(&json!({"query":"lookup"}),"repeat"); let (repeated,record) = state.settle("repeat",repeated,"",""); assert!(repeated["content"].as_str().unwrap().contains("already_loaded")); assert!(record.is_none());
    let explicit = state.search(&json!({"query":"select:mcp__crm__lookup"}),"explicit"); let (explicit,record) = state.settle("explicit",explicit,"",""); assert!(explicit["content"].as_str().unwrap().contains("arguments_schema")); let record = record.unwrap(); assert!(record.get("discoveries").is_none()); assert_eq!(record["presentations"][0]["guides"],json!([]));
    let snapshot = state.snapshot(); let mut child = owner(); assert_eq!(child.snapshot()["definitions"],json!([])); child.restore(&snapshot); child.clear(); assert_eq!(state.snapshot()["definitions"].as_array().unwrap().len(),1);
    let mut changed = State::new(&[tool("lookup","Changed")],&policy(),32768,10000.0,&[],false).unwrap(); changed.restore(&snapshot); assert_eq!(changed.snapshot()["definitions"],json!([]));
    let mut removed = State::new(&[],&policy(),32768,10000.0,&[],false).unwrap(); removed.restore(&snapshot); assert_eq!(removed.snapshot()["definitions"],json!([])); assert!(!removed.enabled()); assert!(removed.model_definitions.is_empty()); assert!(removed.catalog.directory.is_empty());
    assert_eq!(history::read_snapshot(&[baseline]).unwrap().unwrap()["definitions"],json!([]));
}
#[test]
fn eager_overrides_reserved_names_and_absent_search_receipts_are_not_reinterpreted() {
    let mut ordinary = tool("lookup",""); ordinary.as_object_mut().unwrap().remove("mcpSource");
    let state = State::new(&[ordinary.clone()],&policy(),32768,10000.0,&[],false).unwrap(); assert!(!state.enabled()); assert_eq!(state.model_definitions[0]["name"],ordinary["name"]);
    ordinary["name"] = json!("CallTool"); let state = State::new(&[ordinary.clone()],&policy(),32768,10000.0,&[],false).unwrap(); let direct = json!({"type":"tool_use","id":"execute","name":"CallTool","input":{"customer":"42"}}); let (call,origin,error) = state.normalize(&direct); assert_eq!(call,direct); assert!(origin.is_none()); assert!(error.is_none()); assert_eq!(state.snapshot()["discoveryEntries"],false); assert_eq!(state.recovery_message()["content"],"");
    assert!(State::new(&[tool("lookup",""),tool("lookup","")],&policy(),32768,10000.0,&[],false).is_err()); assert!(State::new(&[tool("lookup",""),ordinary],&policy(),32768,10000.0,&[],false).is_err()); assert!(State::new(&[tool("lookup","")],&policy(),32768,10000.0,&[json!("ToolSearch")],false).is_err()); assert!(State::new(&[],&policy(),32768,10000.0,&[json!("ToolSearch")],false).is_ok());
    let state = State::new(&[tool("lookup",""),tool("notes","")],&json!({"services":{"crm":{"identity":"fixture","loading":"eager","toolOverrides":{"lookup":"deferred"}}}}),32768,10000.0,&[],false).unwrap(); assert_eq!(state.model_definitions.iter().map(|item|item["name"].as_str().unwrap()).collect::<Vec<_>>(),["mcp__crm__notes","ToolSearch","CallTool"]);
    let mut state = owner(); let (result,record) = state.settle("fake",json!({"content":"ok","isError":false,"metadata":{"discoveries":[tool("lookup","")]}}),"",""); assert_eq!(result["content"],"ok"); assert!(record.is_none());
}
#[test]
fn presentation_and_direct_call_damage_never_grant_discovery() {
    let item = definition("lookup"); let current = snapshot(vec![item.clone()]); let mut inert = snapshot(vec![]); inert["historicalDefinitions"] = json!([item.clone()]);
    let mut shown = discovery(&item,true).remove(1); shown["toolContext"].as_object_mut().unwrap().remove("discoveries");
    assert_eq!(history::read_snapshot(&[baseline(&inert),shown.clone()]).unwrap().unwrap()["definitions"],json!([])); assert!(history::project(&[baseline(&inert),shown.clone()]).iter().all(|item|item.get("toolContext").is_none()));
    for damage in ["unknown-version","missing-result","error-result","assistant-result","unlisted-guide"] {
        let mut message = shown.clone(); match damage {
            "unknown-version" => {message["toolContext"]["presentations"][0]["definitions"] = json!(["unknown"]); message["toolContext"]["presentations"][0]["guides"] = json!([]);},
            "missing-result" => message["content"] = json!([]), "error-result" => message["content"][0]["is_error"] = json!(true), "assistant-result" => message["role"] = json!("assistant"), _ => message["toolContext"]["presentations"][0]["guides"] = json!(["unlisted"])
        }
        assert!(history::read_snapshot(&[baseline(&current),message]).is_err(),"{damage}");
    }
    for span in [json!({"payloadOffset":0}),json!({"payloadLength":10}),json!({"payloadOffset":-1,"payloadLength":10}),json!({"payloadOffset":0.5,"payloadLength":10}),json!({"payloadOffset":0,"payloadLength":0}),json!({"payloadOffset":0,"payloadLength":100000})] {
        let mut message = shown.clone(); message["toolContext"]["presentations"][0].as_object_mut().unwrap().extend(span.as_object().unwrap().clone()); assert!(history::read_snapshot(&[baseline(&current),message]).is_err(),"{span}");
    }
    let direct = json!({"role":"assistant","content":[{"type":"tool_use","id":"direct","name":item["definition"]["name"],"input":{}}],"toolContext":{"version":1,"directCalls":[{"id":"direct","name":item["definition"]["name"]}]}});
    assert_eq!(history::read_snapshot(&[baseline(&current),direct.clone()]).unwrap().unwrap()["definitions"],current["definitions"]); assert_eq!(history::project(&[direct.clone()])[0]["content"],direct["content"]);
    let merged = history::merge(direct.get("toolContext"),shown.get("toolContext")).unwrap().unwrap(); assert_eq!(merged["directCalls"],direct["toolContext"]["directCalls"]); assert_eq!(merged["presentations"],shown["toolContext"]["presentations"]);
    for damage in ["wrong-name","missing-block","user-role","missing-marker","duplicate-marker"] {
        let mut message = direct.clone(); match damage { "wrong-name"=>message["toolContext"]["directCalls"][0]["name"] = json!("other"),"missing-block"=>message["content"] = json!([]),"user-role"=>message["role"] = json!("user"),"missing-marker"=>{message.as_object_mut().unwrap().remove("toolContext");},_=>message["toolContext"]["rejectedCalls"] = message["toolContext"]["directCalls"].clone() }
        assert!(history::read_snapshot(&[baseline(&current),message]).is_err(),"{damage}");
    }
}
#[test]
fn checkpoint_empty_baselines_preserve_real_user_and_summary_bodies() {
    let item = definition("alpha"); let empty = snapshot(vec![]); let current = snapshot(vec![item.clone()]);
    let eager = json!({"role":"assistant","content":[{"type":"tool_use","id":"eager-call","name":item["definition"]["name"],"input":{"account":"before-discovery"}}],"toolContext":{"version":1,"directCalls":[{"id":"eager-call","name":item["definition"]["name"]}]}});
    let result = json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"eager-call","content":"Earlier direct result."}]}); let source = [vec![baseline(&empty),eager.clone(),result.clone()],discovery(&item,true)].concat(); let candidate = [vec![baseline(&current)],source.clone()].concat();
    let prepared = checkpoint::prepare(&candidate,&source,Some(&current)).unwrap(); assert!(prepared.contains(&eager)); assert!(prepared.contains(&result)); assert_eq!(history::read_snapshot(&prepared).unwrap().unwrap()["definitions"],current["definitions"]); assert_eq!(checkpoint::prepare(&prepared,&prepared,Some(&current)).unwrap(),prepared);
    for entries in [false,true] {
        let empty = json!({"version":1,"generation":"empty","discoveryEntries":entries,"directory":"","definitions":[]});
        let user = json!({"role":"user","content":"Do not delete files. Report the results.","toolContext":{"version":1,"baseline":empty}});
        let prepared = checkpoint::prepare(&[baseline(&empty),user.clone()],&[user.clone()],Some(&empty)).unwrap(); assert!(prepared.contains(&json!({"role":"user","content":user["content"]}))); assert_eq!(prepared.iter().filter(|item|item["toolContext"].get("baseline").is_some()).count(),1); assert_eq!(user["toolContext"]["baseline"],empty);
        let summary = json!({"role":"user","content":"Keep the verified work constraints."}); let source = vec![baseline(&empty),json!({"role":"user","content":"Continue the task."})]; let candidate = [vec![summary.clone(),baseline(&empty)],source.clone()].concat();
        let prepared = checkpoint::prepare(&candidate,&source,Some(&empty)).unwrap(); assert_eq!(prepared[0]["content"],summary["content"]); assert_eq!(prepared[0]["toolContext"]["baseline"],empty); assert_eq!(prepared[0]["toolContext"]["baselineAttachment"],false); assert!(prepared.iter().all(|item|item["content"]!="")); assert_eq!(history::read_snapshot(&prepared).unwrap().unwrap()["definitions"],json!([]));
        let candidate = [vec![json!({"role":"user","content":"Another summary."}),baseline(&empty)],prepared.clone()].concat(); let again = checkpoint::prepare(&candidate,&prepared,Some(&empty)).unwrap(); assert!(again.iter().any(|item|item["content"]==summary["content"])); assert_eq!(again[0]["content"],"Another summary."); assert_eq!(again.iter().filter(|item|item["toolContext"].get("baseline").is_some()).count(),1); assert!(again.iter().all(|item|item["content"]!=""));
    }
}
#[test]
fn historical_call_definitions_are_private_revoked_and_collectable() {
    let item = definition("lookup"); let full = snapshot(vec![item.clone()]); let empty = snapshot(vec![]);
    let call = json!({"role":"assistant","content":[{"type":"tool_use","id":"old-call","name":item["definition"]["name"],"input":{"account":"42"}}],"toolContext":{"version":1,"calls":[{"id":"old-call","definitionVersion":item["version"],"input":{"tool":item["definition"]["name"],"arguments":"{ \"account\": \"42\" }"}}]}});
    let result = json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"old-call","content":"Receipt 42."}]}); let source = [vec![baseline(&full)],discovery(&item,true),vec![call.clone(),result.clone()]].concat(); let candidate = [vec![baseline(&empty)],source.clone()].concat();
    let prepared = checkpoint::prepare(&candidate,&source,Some(&empty)).unwrap(); assert_eq!(history::read_snapshot(&prepared).unwrap().unwrap()["definitions"],json!([])); assert_eq!(prepared[0]["toolContext"]["baseline"]["historicalDefinitions"],json!([item.clone()])); assert!(!prepared.iter().any(|item|item["toolContext"]["discoveries"].as_array().is_some_and(|values|!values.is_empty()))); assert!(prepared.contains(&call)); assert!(prepared.contains(&result)); assert!(history::project(&prepared).iter().all(|item|item.get("toolContext").is_none())); assert_eq!(checkpoint::prepare(&prepared,&prepared,Some(&empty)).unwrap(),prepared);
    let without = checkpoint::prepare(&[baseline(&empty)],&prepared,Some(&empty)).unwrap(); assert!(without[0]["toolContext"]["baseline"].get("historicalDefinitions").is_none());
    assert!(checkpoint::prepare(&[baseline(&empty),call.clone()],&[baseline(&empty)],None).is_err());
    for damage in ["missing-origin","wrong-name","wrong-version","missing-block","duplicate-id","invalid-arguments","changed-arguments"] {
        let mut message = call.clone(); match damage {"missing-origin"=>{message.as_object_mut().unwrap().remove("toolContext");},"wrong-name"=>message["toolContext"]["calls"][0]["input"]["tool"] = json!("mcp__other__lookup"),"wrong-version"=>message["toolContext"]["calls"][0]["definitionVersion"] = json!("unknown"),"missing-block"=>message["content"] = json!([]),"duplicate-id"=>{let block = message["content"][0].clone();message["content"].as_array_mut().unwrap().push(block);},"invalid-arguments"=>message["toolContext"]["calls"][0]["input"]["arguments"] = json!("[]"),_=>message["toolContext"]["calls"][0]["input"]["arguments"] = json!("{\"account\":\"different\"}")}
        assert!(history::read_snapshot(&[baseline(&full),message]).is_err(),"{damage}");
    }
    let mut rejected = call.clone(); rejected["toolContext"] = json!({"version":1,"rejectedCalls":[{"id":"old-call","name":item["definition"]["name"]}]}); let mut error = result.clone(); error["content"][0]["is_error"] = json!(true); assert_eq!(history::read_snapshot(&[baseline(&full),rejected.clone(),error.clone()]).unwrap().unwrap()["definitions"],full["definitions"]); assert_eq!(history::project(&[rejected.clone()])[0]["content"],rejected["content"]); error["content"][0]["is_error"] = json!(false); assert!(history::read_snapshot(&[baseline(&full),rejected,error]).is_err());
    let mut eager = call; eager.as_object_mut().unwrap().remove("toolContext"); assert_eq!(history::read_snapshot(&[baseline(&full),baseline(&empty),eager]).unwrap().unwrap()["definitions"],json!([]));
}
#[tokio::test]
async fn journal_hides_attachments_preserves_block_anchors_and_self_contained_checkpoints() {
    let root = std::env::temp_dir().join(format!("halo-tool-context-{}",uuid::Uuid::new_v4())); std::fs::create_dir_all(&root).unwrap();
    let options = json!({"cwd":"/fixture/project","env":{"FIXTURE_STORE":root},"conventions":{"configDirEnv":"FIXTURE_STORE"}}); let journal = crate::history::Journal::new("session",&options).await.unwrap(); let path = crate::history::transcript_path("session",&options);
    let item = definition("lookup"); let empty = snapshot(vec![]); let full = snapshot(vec![item.clone()]);
    journal.append("user",baseline(&empty),"baseline",None,true).await.unwrap();
    let mut summary = baseline(&empty); summary["content"] = json!("Keep the verified constraints and continue the task."); summary["toolContext"]["baselineAttachment"] = json!(false); journal.append("user",summary.clone(),"summary",None,true).await.unwrap();
    let page = crate::history::page::read(&path,"session",&json!({}),&tokio_util::sync::CancellationToken::new()).await.unwrap(); assert_eq!(page.len(),1); assert_eq!(page[0]["message"]["content"],summary["content"]); assert!(page[0]["message"].get("toolContext").is_none());
    let found = discovery(&item,true); journal.append("assistant",found[0].clone(),"search-block",None,true).await.unwrap(); journal.append("user",found[1].clone(),"search-result",None,true).await.unwrap();
    for (id,arguments) in [("call-one","{ \"account\": \"42\" }"),("call-two","{\n\"account\":\"42\"\n}")] {
        let message = json!({"role":"assistant","content":[{"type":"tool_use","id":id,"name":item["definition"]["name"],"input":{"account":"42"}}],"toolContext":{"version":1,"calls":[{"id":id,"definitionVersion":item["version"],"input":{"tool":item["definition"]["name"],"arguments":arguments}}]}});
        journal.append("assistant",message,id,Some("calls"),true).await.unwrap();
    }
    let report = crate::history::read_report(&path,None).await.unwrap(); assert!(!report.tool_context_damaged); assert_eq!(history::read_snapshot(&report.messages).unwrap().unwrap()["definitions"],full["definitions"]); assert_eq!(report.messages.last().unwrap()["toolContext"]["calls"].as_array().unwrap().len(),2);
    let projected = history::project(&[report.messages.last().unwrap().clone()]); assert_eq!(projected[0]["content"][0]["input"]["arguments"],"{ \"account\": \"42\" }"); assert_eq!(projected[0]["content"][1]["input"]["arguments"],"{\n\"account\":\"42\"\n}");
    let page = crate::history::page::read(&path,"session",&json!({}),&tokio_util::sync::CancellationToken::new()).await.unwrap(); assert_eq!(page.len(),5); assert!(page.iter().all(|entry|entry["message"].get("toolContext").is_none())); assert_eq!(crate::history::page::read(&path,"session",&json!({"limit":1}),&tokio_util::sync::CancellationToken::new()).await.unwrap(),vec![page[0].clone()]);
    let before = crate::history::read_report(&path,Some("search-block")).await.unwrap(); assert_eq!(history::read_snapshot(&before.messages).unwrap().unwrap()["definitions"],json!([])); let midway = crate::history::read_report(&path,Some("call-one")).await.unwrap(); assert_eq!(midway.messages.last().unwrap()["toolContext"]["calls"].as_array().unwrap().len(),1);
    let checkpoint = vec![baseline(&full),json!({"role":"user","content":"Summary without tool names."})]; journal.checkpoint(&checkpoint,"Summary without tool names.").await.unwrap(); assert_eq!(crate::history::read_report(&path,None).await.unwrap().messages,checkpoint);
    let raw = std::fs::read_to_string(&path).unwrap(); let entry: Value = serde_json::from_str(raw.lines().last().unwrap()).unwrap(); assert_eq!(entry["checkpointVersion"],2);
    let child = crate::history::Journal::new("child",&options).await.unwrap(); child.checkpoint(&checkpoint,"Child summary").await.unwrap(); let child_path = crate::history::transcript_path("child",&options); assert_eq!(history::read_snapshot(&crate::history::read_report(&child_path,None).await.unwrap().messages).unwrap().unwrap()["definitions"],full["definitions"]);
    assert!(journal.checkpoint(&[found[1].clone()],"Missing baseline").await.is_err());
    journal.flush().await.unwrap(); child.flush().await.unwrap(); drop(journal); drop(child); std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn damaged_new_journals_cannot_downgrade_to_legacy() {
    for damage in ["unknown-version","missing-baseline","missing-field","invalid-definition","truncated","retained-bound","resumed-tail","v2-without-baseline","v1-with-context"] {
        let root = std::env::temp_dir().join(format!("halo-tool-context-{}",uuid::Uuid::new_v4())); std::fs::create_dir_all(&root).unwrap(); let options = json!({"cwd":"/fixture/project","env":{"FIXTURE_STORE":root},"conventions":{"configDirEnv":"FIXTURE_STORE"}}); let journal = crate::history::Journal::new("session",&options).await.unwrap(); let path = crate::history::transcript_path("session",&options);
        let item = definition("lookup"); let empty = snapshot(vec![]); journal.append("user",baseline(&empty),"baseline",None,true).await.unwrap();
        let mut raw = std::fs::read_to_string(&path).unwrap();
        match damage {
            "unknown-version" => raw.push_str(&format!("{}\n",json!({"type":"user","uuid":"broken","message":{"role":"user","content":"broken","toolContext":{"version":99}}}))),
            "missing-baseline" => raw = format!("{}\n",json!({"type":"user","message":discovery(&item,true)[1]})),
            "missing-field" => raw = format!("{}\n",json!({"toolContextVersion":1,"type":"user","message":{"role":"user","content":"Definition removed."}})),
            "invalid-definition" => {let mut found = discovery(&item,true).remove(1); found["toolContext"]["discoveries"][0]["definitions"][0]["version"] = json!("wrong"); raw.push_str(&format!("{}\n",json!({"type":"user","message":found})));},
            "truncated" => raw.truncate(raw.len()-8),
            "retained-bound" => {for index in 0..4096 {raw.push_str(&format!("{}\n",json!({"type":"user","message":{"role":"user","content":format!("message-{index}")}})));}},
            "resumed-tail" => {journal.set_tool_context_mode().await; journal.append("user",json!({"role":"user","content":"A later plain turn."}),"plain",None,true).await.unwrap(); let full = std::fs::read_to_string(&path).unwrap(); let lines = full.lines().collect::<Vec<_>>(); let first: Value = serde_json::from_str(lines[0]).unwrap(); let second: Value = serde_json::from_str(lines[1]).unwrap(); assert_eq!(first["toolContextRecord"],true); assert_eq!(second["toolContextRecord"],false); assert_eq!(second["toolContextVersion"],2); assert!(!crate::history::read_report(&path,None).await.unwrap().tool_context_damaged); raw = format!("{}\n",lines[1]);},
            "v2-without-baseline" => raw.push_str(&format!("{}\n",json!({"type":"compact_checkpoint","checkpointVersion":2,"uuid":"bad","summary":"Summary","messages":[{"role":"user","content":"State missing."}]}))),
            _ => raw.push_str(&format!("{}\n",json!({"type":"compact_checkpoint","checkpointVersion":1,"uuid":"bad","summary":"Summary","messages":[baseline(&empty)]})))
        }
        std::fs::write(&path,raw).unwrap(); let report = crate::history::read_report(&path,None).await.unwrap(); assert!(report.tool_context_damaged,"{damage}"); if damage=="retained-bound" {assert!(report.omitted>0);}
        drop(journal); std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn discovery_guides_budgets_settlement_and_corrupt_deltas_preserve_safety() {
    let mut state = State::new(&[tool("lookup","Look up records"),tool("notes","Record notes")],&policy(),32768,10000.0,&[],false).unwrap();
    let baseline = state.recovery_message(); let found = state.search(&json!({"query":"select:mcp__crm__lookup"}),"one"); let (found,record) = state.settle("one",found,"",""); let record = record.unwrap(); state.commit(&record).unwrap();
    let next = state.search(&json!({"query":"select:mcp__crm__notes"}),"two"); let (next,next_record) = state.settle("two",next,"",""); assert!(!next["content"].as_str().unwrap().contains("usage_guide")); state.commit(&next_record.unwrap()).unwrap(); assert_eq!(state.recovery_message()["content"].as_str().unwrap().matches("Use account references.").count(),1);
    let message = json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"one","content":found["content"]}],"toolContext":record}); assert_eq!(history::read_snapshot(&[baseline.clone(),message.clone()]).unwrap().unwrap()["definitions"].as_array().unwrap().len(),1); assert!(history::read_snapshot(&[message.clone()]).is_err());
    let mut broken = message["toolContext"].clone(); broken["discoveries"][0]["definitions"][0]["definition"]["description"] = json!("tampered"); assert!(!history::valid_record(&broken)); assert!(history::read_snapshot(&[json!({"role":"user","content":message["toolContext"].to_string()})]).unwrap().is_none());
    for (description,recovery) in [(format!("lookup {}","x".repeat(40000)),50000.0),("lookup".to_owned(),5.0)] {
        let mut state = State::new(&[tool("lookup",&description)],&policy(),32768,recovery,&[],false).unwrap(); let found = state.search(&json!({"query":"lookup"}),"budget"); let (found,record) = state.settle("budget",found,"",""); assert!(record.is_none()); assert_eq!(state.snapshot()["definitions"],json!([])); if recovery>5.0 {assert!(found["content"].as_str().unwrap().contains("did not fit"));}
    }
    let mut state = owner(); state.search(&json!({"query":"lookup"}),"changed"); let (result,record) = state.settle("changed",json!({"content":"replacement","isError":false}),"",""); assert_eq!(result["isError"],true); assert!(record.is_none()); assert_eq!(state.snapshot()["definitions"],json!([]));
    let mut state = State::new(&[tool("lookup","lookup"),tool("notes","notes")],&policy(),32768,10000.0,&[],false).unwrap(); let baseline = state.recovery_message(); let mut blocks = Vec::new();
    for name in ["lookup","notes"] {let found = state.search(&json!({"query":format!("select:mcp__crm__{name}")}),name);let (result,record) = state.settle(name,found,"",""); assert_eq!(record.unwrap()["presentations"][0]["guides"].as_array().unwrap().len(),1); blocks.push(json!({"type":"tool_result","tool_use_id":name,"content":result["content"]}));}
    let mut message = json!({"role":"user","content":blocks}); state.finalize_results(&mut message).unwrap(); assert_eq!(message["toolContext"]["presentations"].as_array().unwrap().iter().map(|item|item["guides"].as_array().unwrap().len()).collect::<Vec<_>>(),[1,0]); assert!(message["content"][0]["content"].as_str().unwrap().contains("usage_guide")); assert!(!message["content"][1]["content"].as_str().unwrap().contains("usage_guide")); assert!(history::valid_record(&message["toolContext"])); assert_eq!(history::read_snapshot(&[baseline,message]).unwrap().unwrap()["definitions"].as_array().unwrap().len(),2);
}
struct Summary;
#[async_trait::async_trait]
impl crate::core::compact::SummaryProvider for Summary {
    async fn complete(&self, _request: &mut Value, _cancel: &tokio_util::sync::CancellationToken) -> crate::error::Result<Value> {
        Ok(json!({"id":"summary","model":"fixture","content":[{"type":"text","text":"Continue the requested work with the verified constraints."}],"stopReason":"end_turn","usage":{"input_tokens":100,"output_tokens":12}}))
    }
}
struct Reconcile { source: Vec<Value>, snapshot: Value }
#[async_trait::async_trait]
impl crate::core::compact::CompactCallbacks for Reconcile {
    async fn prepare_candidate(&self, candidate: crate::core::compact::CompactCandidate) -> crate::error::Result<crate::core::compact::CompactCandidate> {
        Ok(crate::core::compact::CompactCandidate::created(checkpoint::prepare(&candidate.messages,&self.source,Some(&self.snapshot))?))
    }
}
#[tokio::test]
async fn two_real_compactions_preserve_discovery_without_tool_names_in_summaries() {
    let alpha = definition("alpha"); let beta = definition("beta"); let current = snapshot(vec![alpha.clone(),beta.clone()]);
    let work = || (0..14).map(|index|json!({"role":if index%2==0 {"user"} else {"assistant"},"content":format!("Earlier work {index}: {}","evidence ".repeat(700))})).collect::<Vec<_>>();
    let mut source = work(); source.push(baseline(&snapshot(vec![alpha.clone()]))); source.extend(discovery(&beta,true));
    source.push(json!({"role":"assistant","content":[{"type":"tool_use","id":"call","name":alpha["definition"]["name"],"input":{"account":"42"}}],"toolContext":{"version":1,"calls":[{"id":"call","definitionVersion":alpha["version"],"input":{"tool":alpha["definition"]["name"],"arguments":"{ \"account\": \"42\" }"}}]}})); source.push(json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"call","content":"Receipt 42."}]}));
    let original = source.clone(); let cancel = tokio_util::sync::CancellationToken::new();
    for round in 0..2 {
        let callbacks = Reconcile {source:source.clone(),snapshot:current.clone()};
        let result = crate::core::compact::full_compact(&source,&Summary,"fixture",&[baseline(&current)],None,None,&json!({}),&callbacks,&cancel).await.unwrap();
        assert!(!result.summary.contains("mcp__")); assert_eq!(result.messages.iter().filter(|message|message["toolContext"].get("baseline").is_some()).count(),1); assert_eq!(history::read_snapshot(&result.messages).unwrap().unwrap()["definitions"],current["definitions"]);
        let visible = result.messages.iter().map(|message|message["content"].to_string()).collect::<Vec<_>>().join("\n"); assert_eq!(visible.matches("beta complete definition.").count(),1); if round==1 {assert_eq!(visible.matches("alpha complete definition.").count(),1);assert_eq!(visible.matches("Use account references.").count(),1);}
        assert_eq!(result.tokens_freed,crate::core::tokens::estimate_message_tokens(&source)-crate::core::tokens::estimate_message_tokens(&result.messages)); if round==0 {assert_eq!(source,original);}
        source = result.messages; source.extend(work());
    }
}
#[test]
fn parallel_search_commits_once_preserves_redisplays_and_is_idempotent() {
    for explicit in [false, true] { for rejected in [false, true] {
        let mut state = owner();
        let baseline = state.recovery_message();
        let first = search(&mut state,"first",explicit,rejected);
        let second = search(&mut state,"second",explicit,false);
        let sizes: Vec<_> = [&first,&second].iter().map(|block| block["content"].as_str().unwrap().to_owned()).collect();
        let mut message = json!({"role":"user","content":[first,second]});
        state.finalize_results(&mut message).unwrap();
        assert_eq!(state.snapshot()["definitions"], json!([]));
        let record = &message["toolContext"];
        assert_eq!(record["discoveries"].as_array().unwrap().len(),1);
        assert_eq!(record["discoveries"][0]["callId"],if rejected {"second"} else {"first"});
        assert_eq!(record["discoveries"][0]["definitions"].as_array().unwrap().len(),1);
        let shown: Value = serde_json::from_str(message["content"][1]["content"].as_str().unwrap()).unwrap();
        if explicit || rejected { assert_eq!(shown["targets"][0]["arguments_schema"],tool("lookup","")["input_schema"]); }
        else { assert_eq!(shown["targets"][0]["already_loaded"],true); assert!(shown["targets"][0].get("arguments_schema").is_none()); }
        assert_eq!(record["presentations"].as_array().unwrap().len(),if !rejected && explicit {2} else {1});
        assert_eq!(record["presentations"].as_array().unwrap().iter().map(|item| item["guides"].as_array().unwrap().len()).sum::<usize>(),1);
        assert_eq!(message["content"].to_string().matches("Use account references.").count(),1);
        for (index, original) in sizes.iter().enumerate() {
            let current = message["content"][index]["content"].as_str().unwrap();
            assert!(current.len() <= original.len()); assert!(current.encode_utf16().count() <= original.encode_utf16().count());
        }
        assert_eq!(history::read_snapshot(&[baseline,message.clone()]).unwrap().unwrap()["definitions"].as_array().unwrap().len(),1);
        let prepared = message.clone(); state.finalize_results(&mut message).unwrap(); assert_eq!(message,prepared);
        state.commit(&message["toolContext"]).unwrap(); assert_eq!(state.snapshot()["definitions"].as_array().unwrap().len(),1);
        let later = search(&mut state,"later",false,false); assert!(later["content"].as_str().unwrap().contains("already_loaded"));
    }}
}
#[test]
fn search_delivery_order_not_completion_order_owns_discovery() {
    let mut state = owner();
    let first = search(&mut state,"completed-first",false,false);
    let second = search(&mut state,"completed-second",false,false);
    let mut message = json!({"role":"user","content":[second,first]});
    state.finalize_results(&mut message).unwrap();
    assert_eq!(message["toolContext"]["discoveries"][0]["callId"],"completed-second");
    assert_eq!(message["toolContext"]["presentations"][0]["callId"],"completed-second");
    let payload: Value = serde_json::from_str(message["content"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(payload["targets"][0]["already_loaded"],true);
}
#[test]
fn interrupted_search_never_grants_and_respects_result_budget() {
    let mut small = State::new(&[tool("lookup","Look up customer records.")],&policy(),100,10000.0,&[],false).unwrap();
    let rejected = small.search(&json!({"query":"unknown-capability"}),"small");
    assert_eq!(rejected["isError"],true); assert!(rejected["content"].as_str().unwrap().encode_utf16().count()<=100); assert_eq!(small.snapshot()["definitions"],json!([])); assert!(!small.has_search_result("small"));
    for budget in [256,32768] {
        let mut state = State::new(&[tool("lookup","Look up customer records.")],&policy(),budget,10000.0,&[],false).unwrap();
        let found = state.search(&json!({"query":if budget==256 {"unknown-capability"} else {"lookup"}}),"unsettled");
        assert!(state.has_search_result("unsettled"));
        let mut message = json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"unsettled","content":found["content"]}]});
        state.finalize_results(&mut message).unwrap();
        assert!(message.get("toolContext").is_none()); assert_eq!(state.snapshot()["definitions"],json!([]));
        let block = &message["content"][0]; assert_eq!(block["is_error"],true);
        let text = block["content"].as_str().unwrap(); assert!(text.encode_utf16().count()<=budget); assert!(text.len()<=found["content"].as_str().unwrap().len());
        assert!(!text.contains("arguments_schema"));
    }
}
#[test]
fn invalid_policies_large_catalog_and_unicode_queries_are_bounded() {
    for invalid in [Value::Null,json!([]),json!({}),json!({"services":[]}),json!({"services":{"crm":{}}}),json!({"services":{"crm":{"identity":"crm","loading":"automatic"}}}),json!({"services":{"crm":{"identity":"","loading":"deferred"}}}),json!({"services":{"crm":{"identity":"crm","loading":"deferred","toolOverrides":{"lookup":"automatic"}}}}),json!({"services":{"crm":{"identity":"crm","loading":"deferred","summary":false}}})] {
        assert!(catalog::validate_options(&invalid).is_err(),"accepted {invalid}");
    }
    let large = tool("large",&"x".repeat(catalog::CATALOG_BYTES));
    assert!(State::new(&[large],&policy(),32768,100000.0,&[],false).is_err());
    let mut state = owner();
    assert_ne!(state.search(&json!({"query":"🧩".repeat(catalog::QUERY_CHARACTERS)}),"limit")["isError"],true);
    let rejected = state.search(&json!({"query":"🧩".repeat(catalog::QUERY_CHARACTERS+1)}),"too-long");
    assert_eq!(rejected["isError"],true); assert!(rejected["content"].as_str().unwrap().contains("Use a shorter purpose")); assert_eq!(state.snapshot()["definitions"],json!([]));
}
#[test]
fn catalog_search_indexes_identifiers_ranks_exact_names_and_filters_services() {
    let catalog = catalog::Catalog::new(&[tool("get_orders",""),tool("getHTTPStatus","")],&policy()).unwrap();
    let names = |query: &str| catalog.search(query,None).iter().map(|item|item["originalName"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(names("order"),["get_orders"]); assert_eq!(names("HTTP status"),["getHTTPStatus"]); assert_eq!(names("customer id").len(),2);
    let catalog = catalog::Catalog::new(&[tool("z","查客户订单"),tool("a","查客户订单"),tool("lookup","查客户订单")],&policy()).unwrap();
    let names = |query: &str| catalog.search(query,None).iter().map(|item|item["originalName"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(names("客户订单"),["a","lookup","z"]); assert_eq!(names("lookup")[0],"lookup"); assert_eq!(names("select:mcp__crm__z,mcp__crm__a"),["a","z"]); assert!(catalog.search("客户订单",Some("disabled-service")).is_empty());
    let mut original = tool("lookup",""); original["mcpSource"]["instructions"] = json!("Original service guide.");
    let mut updated = original.clone(); updated["mcpSource"]["instructions"] = json!("Updated service guide.");
    assert_ne!(catalog::Catalog::new(&[original],&json!({"services":{}})).unwrap().generation,catalog::Catalog::new(&[updated],&json!({"services":{}})).unwrap().generation);
}
