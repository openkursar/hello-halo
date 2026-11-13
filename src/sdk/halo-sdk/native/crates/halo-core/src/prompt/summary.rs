use crate::harness::{ResolvedHarness, TextId};
use serde_json::Value;

pub fn system_prompt(harness: &ResolvedHarness) -> &str {
    harness.text(TextId::ContextSummarySystem)
}

pub fn build(options: &Value) -> String {
    build_with_harness(options, &crate::harness::baseline())
}
pub fn build_with_harness(options: &Value, harness: &ResolvedHarness) -> String {
    let placement = match options["scope"].as_str() {
        Some("suffix") => TextId::ContextSummaryPlacementSuffix,
        Some("prefix") => TextId::ContextSummaryPlacementPrefix,
        _ => TextId::ContextSummaryPlacementConversation,
    };
    let mut sections: Vec<String> = [
        TextId::ContextSummaryPrepare,
        placement,
        TextId::ContextSummaryEvidence,
        TextId::ContextSummarySections,
        TextId::ContextSummaryRequest,
        TextId::ContextSummaryRemainingWork,
        TextId::ContextSummaryVerifiedState,
        TextId::ContextSummaryWorkingDetails,
        TextId::ContextSummaryRecovery,
        TextId::ContextSummaryCombine,
        TextId::ContextSummaryOutput,
    ]
    .into_iter()
    .map(|id| harness.text(id).to_owned())
    .collect();
    if let Some(tokens) = options
        .get("maxTokens")
        .filter(|value| !crate::js::is_undefined(value))
    {
        sections.push(harness.render(
            TextId::ContextSummaryBudget,
            &[("max_tokens", &crate::js::to_string(tokens))],
        ));
    }
    if let Some(guidance) = options["modelGuidance"]
        .as_str()
        .filter(|text| !text.is_empty())
    {
        sections.push(guidance.into());
    }
    if let Some(instructions) = options["instructions"]
        .as_str()
        .map(crate::js::trim_js)
        .filter(|text| !text.is_empty())
    {
        sections.push(harness.render(
            TextId::ContextSummaryAdditional,
            &[("instructions", instructions)],
        ));
    }
    sections.join("\n\n")
}

pub fn for_model(options: &Value, model: &str, selection: &Value) -> crate::error::Result<String> {
    for_model_with_harness(options, model, selection, &crate::harness::baseline())
}
pub fn for_model_with_harness(
    options: &Value,
    model: &str,
    selection: &Value,
    harness: &ResolvedHarness,
) -> crate::error::Result<String> {
    let profile = super::profile_with_harness(model, selection, harness)?;
    let mut options = options.clone();
    options["modelGuidance"] = profile["summaryGuidance"].clone();
    Ok(build_with_harness(&options, harness))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_match_fixture_bytes() {
        let fixture: Value = serde_json::from_str(include_str!("fixtures/summary.json")).unwrap();
        assert_eq!(
            system_prompt(&crate::harness::baseline()),
            fixture["systemPrompt"]
        );
        for case in fixture["cases"].as_array().unwrap() {
            assert_eq!(
                build(&case["options"]),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
        for case in fixture["profiles"].as_array().unwrap() {
            assert_eq!(
                for_model(
                    &case["options"],
                    case["model"].as_str().unwrap(),
                    &case["selection"]
                )
                .unwrap(),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
