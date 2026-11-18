use super::*;

#[test]
fn reasoning_snapshot_preserves_effective_budget_and_off() {
    let options = json!({"model":"parent","providerConfig":{"type":"openai-compat"},"thinking":{"type":"enabled","budgetTokens":12345},"effort":"max"});
    let captured = effective_reasoning(&options);
    assert_eq!(captured,json!({"version":1,"mode":"budget","budgetTokens":12345,"effort":"high"}));
    let mut child = json!({"model":"child","adaptiveThinking":true,"maxThinkingTokens":99999,"effort":"low"});
    apply_reasoning(&mut child,&captured).unwrap();
    assert_eq!(effective_reasoning(&child),captured);
    let off = json!({"version":1,"mode":"off"});
    apply_reasoning(&mut child,&off).unwrap();
    assert_eq!(child["thinking"],json!({"type":"disabled"}));
    assert!(child.get("maxThinkingTokens").is_none());
    assert!(child.get("adaptiveThinking").is_none());
    assert_eq!(child["effort"],"");
    assert_eq!(effective_reasoning(&child),json!({"version":1,"mode":"off"}));
}

#[test]
fn legacy_reasoning_capture_records_the_sent_output_budget() {
    let options = json!({"model":"parent","apiKey":"fixture","nativeResolvedConfig":true,"thinkingExplicit":true,"thinking":{"type":"enabled","budgetTokens":20000},"maxOutputTokens":1024,"effort":"max"});
    assert_eq!(effective_reasoning(&options),json!({"version":1,"mode":"budget","budgetTokens":1023,"effort":"max"}));
}

#[test]
fn semantic_reasoning_roundtrips_without_defaulting_or_clamping() {
    for semantic in [
        json!({"version":1,"mode":"provider-default"}),
        json!({"version":1,"mode":"off"}),
        json!({"version":1,"mode":"effort","effort":"xhigh"}),
        json!({"version":1,"mode":"effort","effort":"max"}),
        json!({"version":1,"mode":"budget","budgetTokens":1024,"effort":"max"}),
        json!({"version":1,"mode":"adaptive","effort":"high"}),
    ] {
        let mut options = json!({"model":"fixture","nativeResolvedConfig":true,"effort":"high","thinking":{"type":"enabled","budgetTokens":9999}});
        apply_reasoning(&mut options,&semantic).unwrap();
        assert_eq!(effective_reasoning(&options),semantic);
        let encoded = super::super::effort::resolve(&options);
        match semantic["mode"].as_str().unwrap() {
            "provider-default" => { assert!(encoded.thinking.is_null()); assert!(encoded.reasoning.is_none()); assert_eq!(options["effort"],""); },
            "off" => { assert_eq!(encoded.thinking,json!({"type":"disabled"})); assert!(encoded.reasoning.is_none()); },
            "effort" => { assert!(encoded.thinking.is_null()); assert_eq!(encoded.reasoning.as_deref(),semantic["effort"].as_str()); },
            "budget" => { assert_eq!(encoded.thinking["budgetTokens"],1024); assert_eq!(encoded.reasoning.as_deref(),Some("max")); },
            "adaptive" => assert_eq!(encoded.thinking,json!({"type":"adaptive"})),
            _ => unreachable!(),
        }
    }
}

#[test]
fn metadata_projection_excludes_connection_and_callback_lease() {
    let binding = json!({"bindingId":"b","restoreRef":"r","model":"m","targetKind":"single","contextWindow":32000,"maxOutputTokens":1000,"modalities":["text"],"reasoning":{"default":{"version":1,"mode":"off"}},"provider":{"apiKey":"synthetic-secret"},"nativeModelBindingId":"lease"});
    let projected = model_metadata(&binding);
    assert!(projected.get("provider").is_none());
    assert!(projected.get("nativeModelBindingId").is_none());
    assert!(!projected.to_string().contains("synthetic-secret"));
    assert_eq!(projected["model"],"m");
}
