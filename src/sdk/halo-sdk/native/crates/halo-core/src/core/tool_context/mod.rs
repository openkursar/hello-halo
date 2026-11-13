pub mod catalog;
pub mod checkpoint;
pub mod history;
mod presentation;
pub mod invocation;
pub mod feedback;
pub mod state;

use crate::error::Result;
use serde_json::{json,Value};
pub use state::State;

pub fn prepare(options:&Value,tools:&[Value],history:&[Value],legacy:bool)->Result<Option<State>>{prepare_with_harness(options,tools,history,legacy,crate::harness::baseline())}
pub fn prepare_with_harness(options:&Value,tools:&[Value],history:&[Value],legacy:bool,harness:std::sync::Arc<crate::harness::ResolvedHarness>)->Result<Option<State>>{
    let previous=self::history::read_snapshot(history)?;
    let native=options["toolCallingMode"].as_str().unwrap_or("native")=="native";
    if (!native&&previous.is_none())||(options.get("toolDiscovery").is_none()&&previous.is_none())||(legacy&&previous.is_none()){return Ok(None);}
    let empty=json!({"services":{}});let policy=if native{options.get("toolDiscovery").unwrap_or(&empty)}else{&empty};
    let disallowed=options["disallowedTools"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut state=State::new_with_harness(tools,policy,options["toolResultBudget"].as_u64().unwrap_or(50_000)as usize,(options["contextWindow"].as_f64().unwrap_or(200_000.0)-options["maxOutputTokens"].as_f64().unwrap_or(16_384.0)).max(0.0),disallowed,native&&previous.as_ref().is_some_and(|previous|previous["discoveryEntries"]==true),harness)?;
    if let Some(previous)=previous{state.restore(&previous);}Ok(Some(state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::stringify;
    #[test]
    fn discovery_errors_keep_owned_text_and_opaque_slots_until_model_selection() {
        let name = "mcp__records__{server}";
        let tool = json!({"name":name,"description":"Fixture","inputSchema":{"type":"object"}});
        let duplicate = catalog::Catalog::new(&[tool.clone(), tool], &json!({"services":{}}))
            .err().unwrap();
        let metadata = history::read_snapshot(&[json!({"role":"user","content":[],"toolContext":{}})])
            .unwrap_err();
        let mut state = State::new(&[], &json!({"services":{}}), 32768, 50000.0, &[], false).unwrap();
        let commit = state.commit(&Value::Null).unwrap_err();
        assert_eq!(duplicate.message, format!("Duplicate tool identity: {name}"));
        assert_eq!(metadata.message, "Invalid tool context journal metadata");
        assert_eq!(commit.message, "Cannot commit invalid tool discovery metadata");
        let harness = crate::harness::Harness::from_config(&json!({"models":{
            "first":{
                "context.discovery.duplicate_identity":"First: {name}",
                "context.discovery.history.invalid_metadata":"First metadata",
                "context.discovery.invalid_commit":"First commit"
            },
            "second":{
                "context.discovery.duplicate_identity":"Second: {name}",
                "context.discovery.history.invalid_metadata":"Second metadata",
                "context.discovery.invalid_commit":"Second commit"
            }
        }})).unwrap();
        for (model, label) in [("first", "First"), ("second", "Second")] {
            let selected = harness.for_model(model);
            assert_eq!(duplicate.render_for(&selected), format!("{label}: {name}"));
            assert_eq!(metadata.render_for(&selected), format!("{label} metadata"));
            assert_eq!(commit.render_for(&selected), format!("{label} commit"));
            let external = crate::error::Error::new("TOOL_IDENTITY", duplicate.message.clone());
            assert_eq!(external.render_for(&selected), duplicate.message);
        }
    }
    fn normalized(state:&State,call:&Value)->Value{
        let(call,origin,error)=state.normalize(call);let mut value=json!({"call":call});if let Some(origin)=origin{value["origin"]=origin;}if let Some(error)=error{value["error"]=json!(error);}value
    }
    fn snapshot_contract(value: &Value) -> Value {
        let mut value = value.clone();
        if let Some(object) = value.as_object_mut() { object.remove("directory"); object.remove("generation"); }
        value
    }
    fn record_contract(value: &Value) -> Value {
        let mut value = value.clone();
        if let Some(object) = value.as_object_mut() { object.remove("version"); }
        if value.get("baseline").is_some() { value["baseline"] = snapshot_contract(&value["baseline"]); }
        for origin in value.get_mut("calls").and_then(Value::as_array_mut).into_iter().flatten() {
            origin.as_object_mut().unwrap().remove("normalization");
            origin.as_object_mut().unwrap().remove("rawInput");
        }
        for presentation in value.get_mut("presentations").and_then(Value::as_array_mut).into_iter().flatten() {
            presentation.as_object_mut().unwrap().remove("payloadLength");
        }
        value
    }
    fn history_contract(messages: &Value) -> Value {
        json!(messages.as_array().unwrap().iter().map(|message| {
            let calls: Vec<_> = message["content"].as_array().into_iter().flatten()
                .filter(|block| block["type"] == "tool_use").cloned().collect();
            let results: Vec<_> = message["content"].as_array().into_iter().flatten()
                .filter(|block| block["type"] == "tool_result").map(|block| block["tool_use_id"].clone()).collect();
            json!({"role":message["role"],"calls":calls,"results":results,"record":record_contract(&message["toolContext"])})
        }).collect::<Vec<_>>())
    }
    #[test]
    fn matches_catalog_search_history_and_checkpoint_fixtures(){
        let fixture:Value=serde_json::from_str(include_str!("fixtures/golden.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap(){
            let scenario=&case["scenario"];
            let mut state=State::new(case["tools"].as_array().unwrap(),&case["policy"],scenario["resultCharacters"].as_u64().unwrap_or(32768)as usize,scenario["recoveryTokens"].as_f64().unwrap_or(50000.0),&[],false).unwrap();
            let initial=state.recovery_message();let raw=state.search(&case["input"],"search");
            let prefix=scenario["prefix"].as_str().unwrap_or("");let suffix=scenario["suffix"].as_str().unwrap_or("");let mut result=raw;result["content"]=json!(format!("{prefix}{}{suffix}",result["content"].as_str().unwrap()));
            let(result,record)=state.settle("search",result,prefix,suffix);let mut found=json!({"result":result});if let Some(record)=&record{found["record"]=record.clone();}
            let before=normalized(&state,&case["wrapper"]);if let Some(record)=&record{state.commit(record).unwrap();}let after=normalized(&state,&case["wrapper"]);
            let mut block=json!({"type":"tool_result","tool_use_id":"search","content":result["content"]});if result["isError"]==true{block["is_error"]=json!(true);}let mut result_message=json!({"role":"user","content":[block]});if let Some(record)=record{result_message["toolContext"]=record;}
            let mut history=vec![initial.clone(),result_message];if after.get("origin").is_some(){history.push(json!({"role":"assistant","content":[after["call"]],"toolContext":{"version":2,"calls":[after["origin"]]}}));}
            for message in &history { if let Some(record) = message.get("toolContext") { assert!(history::valid_record(record),"invalid {} {}",scenario["name"],stringify(record)); } }
            let checkpoint=checkpoint::prepare(&history,&history,Some(&state.snapshot())).unwrap();
            let actual=json!({"modelDefinitions":state.model_definitions,"generation":state.catalog.generation,"directory":state.catalog.directory,"initial":initial,"before":before,"found":found,"after":after,"snapshot":state.snapshot(),"recovery":state.recovery_message(),"historySnapshot":history::read_snapshot(&history).unwrap(),"projection":history::project(&history),"checkpoint":checkpoint});
            let expected = &case["expected"];
            let current = catalog::Catalog::new(case["tools"].as_array().unwrap(), &case["policy"]).unwrap();
            assert_eq!(actual["generation"], current.generation, "{} catalog generation", scenario["name"]);
            for key in ["snapshot", "historySnapshot"] {
                assert_eq!(actual[key]["generation"], actual["generation"]);
                assert_eq!(snapshot_contract(&actual[key]), snapshot_contract(&expected[key]), "{}: {key}", scenario["name"]);
            }
            assert_eq!(record_contract(&actual["found"]["record"]), record_contract(&expected["found"]["record"]));
            for key in ["before", "after"] {
                assert_eq!(actual[key]["call"], expected[key]["call"]);
                assert_eq!(actual[key].get("error").is_some(), expected[key].get("error").is_some());
                for field in ["id", "definitionVersion", "input"] { assert_eq!(actual[key]["origin"][field], expected[key]["origin"][field]); }
            }
            for key in ["projection", "checkpoint"] { assert_eq!(history_contract(&actual[key]), history_contract(&expected[key]), "{}: {key}", scenario["name"]); }
        }
    }
    #[test]
    fn changed_search_payload_and_forged_snapshot_never_grant_execution(){
        let fixture:Value=serde_json::from_str(include_str!("fixtures/golden.json")).unwrap();let case=&fixture["cases"][0];
        let mut state=State::new(case["tools"].as_array().unwrap(),&case["policy"],32768,50000.0,&[],false).unwrap();
        state.search(&case["input"],"search");let(result,record)=state.settle("search",json!({"content":"replaced","isError":false}),"","");assert_eq!(result["isError"],true);assert!(record.is_none());assert!(state.normalize(&case["wrapper"]).2.is_some());
        let mut record=case["expected"]["found"]["record"].clone();record["discoveries"][0]["definitions"][0]["definition"]["description"]=json!("tampered");assert!(!history::valid_record(&record));assert!(state.commit(&record).is_err());
        assert!(history::read_snapshot(&[json!({"role":"user","content":[],"toolContext":case["expected"]["found"]["record"]})]).is_err());
    }

    #[test]
    fn search_targets_preserve_schemas_guides_and_discovery_receipts() {
        let fixture: Value = serde_json::from_str(include_str!("fixtures/golden.json")).unwrap();
        let case = &fixture["cases"][2];
        let mut state = State::new(case["tools"].as_array().unwrap(), &case["policy"], 32768, 50000.0, &[], false).unwrap();
        let initial = state.recovery_message();
        let first = state.search(&case["input"], "one");
        let second = state.search(&case["input"], "two");
        let first = state.settle("one", first, "", "").0;
        let second = state.settle("two", second, "", "").0;
        let mut message = json!({"role":"user","content":[
            {"type":"tool_result","tool_use_id":"one","content":first["content"]},
            {"type":"tool_result","tool_use_id":"two","content":second["content"]}
        ]});
        state.finalize_results(&mut message).unwrap();
        let payloads: Vec<Value> = message["content"].as_array().unwrap().iter().map(|block| serde_json::from_str(block["content"].as_str().unwrap()).unwrap()).collect();
        let expected = &case["expected"]["snapshot"]["definitions"][0];
        for payload in &payloads {
            assert_eq!(payload["invoke_via"], "CallTool");
            assert!(payload.get("tools").is_none());
            assert!(payload["instructions"].is_string());
            assert_eq!(presentation::definition(&payload["targets"][0], true), expected["definition"]);
        }
        assert_eq!(payloads.iter().filter(|payload| payload["targets"][0].get("usage_guide").is_some()).count(), 1);
        assert_eq!(message["toolContext"]["version"], 2);
        assert_eq!(message["toolContext"]["discoveries"].as_array().unwrap().len(), 1);
        state.commit(&message["toolContext"]).unwrap();
        let ordinary = state.search(&json!({"query":"orders"}), "later");
        let ordinary: Value = serde_json::from_str(ordinary["content"].as_str().unwrap()).unwrap();
        assert_eq!(ordinary["targets"][0]["already_loaded"], true);
        assert!(ordinary["targets"][0].get("arguments_schema").is_none());
        let history = vec![initial, message];
        let checkpoint = checkpoint::prepare(&history, &history, Some(&state.snapshot())).unwrap();
        assert!(!checkpoint[0]["content"].as_str().unwrap().contains("arguments_schema"));
        assert_eq!(history::read_snapshot(&checkpoint).unwrap().unwrap()["definitions"], state.snapshot()["definitions"]);
        let legacy = case["expected"]["checkpoint"].as_array().unwrap();
        let restored = checkpoint::prepare(legacy, legacy, Some(&case["expected"]["snapshot"])).unwrap();
        assert!(!restored[0]["content"].as_str().unwrap().contains("arguments_schema"));
        assert_eq!(history::read_snapshot(&restored).unwrap().unwrap()["definitions"], state.snapshot()["definitions"]);
    }

    #[test]
    fn versioned_origins_restore_objects_and_verify_raw_normalization() {
        let fixture: Value = serde_json::from_str(include_str!("fixtures/golden.json")).unwrap();
        let case = &fixture["cases"][2];
        let snapshot = &case["expected"]["snapshot"];
        let call = &case["expected"]["after"]["call"];
        let legacy = &case["expected"]["after"]["origin"];
        let baseline = json!({"role":"user","content":"fixture","isMeta":true,"toolContext":{"version":1,"baseline":snapshot}});
        let check = |origin: Value, version: u64| history::read_snapshot(&[
            baseline.clone(), json!({"role":"assistant","content":[call],"toolContext":{"version":version,"calls":[origin]}})
        ]);
        assert!(check(legacy.clone(), 1).is_ok());
        let mut object = legacy.clone();
        object["input"]["arguments"] = call["input"].clone();
        assert!(check(object.clone(), 2).is_ok());
        assert!(check(object.clone(), 1).is_err());
        let raw = format!("{{\"tool\":{},\"arguments\":{{\"customer\":\"42\",}},}}", stringify(&call["name"]));
        let decoded = invocation::decode(&object["input"], Some(&raw)).unwrap();
        object["input"] = decoded.original;
        object["rawInput"] = json!(decoded.raw_input.unwrap());
        object["normalization"] = json!(decoded.normalization);
        assert!(check(object.clone(), 2).is_ok());
        let mut corrupted = object.clone();
        corrupted["normalization"] = json!([]);
        assert!(check(corrupted, 2).is_err());
        object["rawInput"] = json!(raw.replace("42", "changed"));
        assert!(check(object, 2).is_err());
        let mut invalid_legacy = legacy.clone();
        invalid_legacy["input"]["arguments"] = json!("{\"customer\":\"42\",}");
        assert!(check(invalid_legacy, 1).is_err());
        assert_eq!(history::merge(Some(&json!({"version":1,"calls":[legacy]})), Some(&json!({"version":2,"rejectedCalls":[{"id":"other","name":"CallTool"}]}))).unwrap().unwrap()["version"], 2);
    }
}
