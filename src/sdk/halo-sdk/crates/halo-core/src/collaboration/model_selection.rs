use crate::error::{Error, Result};
use serde_json::{json, Value};
use std::collections::HashSet;

fn invalid(message: &str) -> Error {
    Error::new("MODEL_SELECTION", message)
}

fn object(value: &Value, fields: &[&str]) -> Result<()> {
    let map = value
        .as_object()
        .ok_or_else(|| invalid("Expected a model selection object."))?;
    if map.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err(invalid("Unexpected model selection field."));
    }
    Ok(())
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| invalid("A required model selection string is missing."))
}

fn optional_text(value: &Value, key: &str) -> Result<()> {
    if value.get(key).is_some() {
        text(value, key)?;
    }
    Ok(())
}

pub fn limits() -> Value {
    serde_json::from_str(include_str!(
        "../../../../bindings/node/collaboration/model-selection-limits.json"
    ))
    .expect("model selection limits")
}

pub fn validate_effective_reasoning(value: &Value) -> Result<Value> {
    if value["version"] != 1 {
        return Err(invalid("Unsupported reasoning version."));
    }
    match value["mode"].as_str() {
        Some("provider-default" | "off") => object(value, &["version", "mode"])?,
        Some("effort") => {
            object(value, &["version", "mode", "effort"])?;
            text(value, "effort")?;
        }
        Some("budget") => {
            object(value, &["version", "mode", "budgetTokens", "effort"])?;
            if !value["budgetTokens"]
                .as_u64()
                .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
            {
                return Err(invalid("Reasoning budget must be a positive safe integer."));
            }
            optional_text(value, "effort")?;
        }
        Some("adaptive") => {
            object(value, &["version", "mode", "effort"])?;
            optional_text(value, "effort")?;
        }
        _ => return Err(invalid("Unknown reasoning mode.")),
    }
    Ok(value.clone())
}

fn parent(value: &Value) -> Result<()> {
    object(value, &["bindingId", "restoreRef", "model", "reasoning"])?;
    for key in ["bindingId", "restoreRef", "model"] {
        text(value, key)?;
    }
    validate_effective_reasoning(&value["reasoning"])?;
    Ok(())
}

fn selection_ref(profile: &Value) -> String {
    format!(
        "profile:{}",
        serde_json::to_string(&json!([profile["profileId"], profile["profileRevision"]])).unwrap()
    )
}

fn validate_supported(value: &Value) -> Result<()> {
    let supported = value
        .as_array()
        .ok_or_else(|| invalid("Supported reasoning efforts must be an array."))?;
    let mut seen = HashSet::new();
    for effort in supported {
        let effort = effort
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| invalid("Invalid supported reasoning effort."))?;
        if !seen.insert(effort) {
            return Err(invalid("Duplicate supported reasoning effort."));
        }
    }
    Ok(())
}

fn bounded_text(value: &Value, key: &str, max: usize, empty: bool) -> Result<()> {
    let s = value[key]
        .as_str()
        .ok_or_else(|| invalid("Invalid model profile text."))?;
    if (!empty && s.trim().is_empty()) || s.chars().count() > max {
        return Err(invalid("Model profile text exceeds its allowed bounds."));
    }
    Ok(())
}

pub fn validate_catalog(catalog: &Value) -> Result<()> {
    object(catalog, &["revision", "policy", "policyRevision", "profiles"])?;
    text(catalog, "revision")?;
    text(catalog, "policyRevision")?;
    if !matches!(catalog["policy"].as_str(), Some("inherit" | "task")) {
        return Err(invalid("Unknown model selection policy."));
    }
    let bounds = limits();
    if serde_json::to_vec(catalog)
        .map_err(|_| invalid("Invalid catalog."))?
        .len()
        > bounds["catalogBytes"].as_u64().unwrap() as usize
    {
        return Err(invalid("Model profile catalog exceeds its byte limit."));
    }
    let profiles = catalog["profiles"]
        .as_array()
        .ok_or_else(|| invalid("Model profile catalog requires profiles."))?;
    let mut ids = HashSet::new();
    for profile in profiles {
        object(
            profile,
            &[
                "profileId", "profileRevision", "name", "description", "target",
                "reasoning", "available", "unavailableReason",
            ],
        )?;
        let id = text(profile, "profileId")?;
        text(profile, "profileRevision")?;
        if !ids.insert(id) {
            return Err(invalid("Duplicate model profile identity."));
        }
        bounded_text(
            profile, "name", bounds["nameCodePoints"].as_u64().unwrap() as usize, false,
        )?;
        bounded_text(
            profile, "description", bounds["descriptionCodePoints"].as_u64().unwrap() as usize, true,
        )?;
        object(&profile["target"], &["kind", "label", "models", "accountLabel"])?;
        if !matches!(profile["target"]["kind"].as_str(), Some("single" | "pool")) {
            return Err(invalid("Unknown model profile target kind."));
        }
        text(&profile["target"], "label")?;
        optional_text(&profile["target"], "accountLabel")?;
        let models = profile["target"]["models"]
            .as_array()
            .ok_or_else(|| invalid("Profile target requires models."))?;
        if (models.is_empty()
            && !(profile["target"]["kind"] == "pool" && profile["available"] == false))
            || models.iter().any(|m| !m.as_str().is_some_and(|s| !s.trim().is_empty()))
            || (profile["target"]["kind"] == "single" && models.len() != 1)
        {
            return Err(invalid("Invalid profile target models."));
        }
        object(&profile["reasoning"], &["supported", "profileDefault", "modelDefault"])?;
        if let Some(supported) = profile["reasoning"].get("supported") {
            validate_supported(supported)?;
        }
        optional_text(&profile["reasoning"], "profileDefault")?;
        optional_text(&profile["reasoning"], "modelDefault")?;
        if !profile["available"].is_boolean() {
            return Err(invalid("Model profile availability must be a boolean."));
        }
        optional_text(profile, "unavailableReason")?;
        for key in ["profileDefault", "modelDefault"] {
            optional_text(&profile["reasoning"], key)?;
        }
        if let Some(values) = profile["reasoning"].get("supported") {
            if !values.as_array().is_some_and(|a| {
                a.iter().all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
            }) {
                return Err(invalid("Invalid supported reasoning efforts."));
            }
        }
        if !profile["available"].is_boolean() {
            return Err(invalid("Profile availability must be explicit."));
        }
        optional_text(profile, "unavailableReason")?;
        if profile["available"] == false && profile.get("unavailableReason").is_none() {
            return Err(invalid("Unavailable profile requires a reason."));
        }
        let mut descriptor = profile.clone();
        descriptor.as_object_mut().unwrap().remove("profileId");
        descriptor.as_object_mut().unwrap().remove("profileRevision");
        descriptor["selectionRef"] = selection_ref(profile).into();
        if serde_json::to_vec(&descriptor).unwrap().len() + 2048
            > bounds["resultBytes"].as_u64().unwrap() as usize
        {
            return Err(invalid("A complete model profile cannot fit in a directory response."));
        }
    }
    Ok(())
}

pub fn plan_model_selection(args: &Value) -> Result<Value> {
    validate_catalog(&args["catalog"])?;
    plan_with_catalog(args, &args["catalog"], None)
}

fn plan_with_catalog(
    args: &Value,
    catalog: &Value,
    profile_index: Option<&std::collections::HashMap<String, usize>>,
) -> Result<Value> {
    object(args, &["input", "parent", "catalog", "policyRevision"])?;
    object(&args["input"], &["model_profile", "reasoning_effort"])?;
    optional_text(&args["input"], "model_profile")?;
    optional_text(&args["input"], "reasoning_effort")?;
    parent(&args["parent"])?;
    text(args, "policyRevision")?;
    let input = &args["input"];
    let inherit = input.get("model_profile").is_none() || input["model_profile"] == "inherit";
    if (!inherit || input.get("reasoning_effort").is_some())
        && args["policyRevision"] != catalog["policyRevision"]
    {
        return Err(invalid("Model selection settings changed. Use the refreshed session before overriding the model or reasoning."));
    }
    let mut plan = json!({
        "selection":{"kind":"inherit"},
        "parent":args["parent"],
        "policyRevision":args["policyRevision"]
    });
    if let Some(effort) = input.get("reasoning_effort") {
        plan["requestedEffort"] = effort.clone();
    }
    if !inherit {
        let reference = input["model_profile"].as_str().unwrap();
        let profiles = catalog["profiles"].as_array().unwrap();
        let profile = match profile_index {
            Some(index) => index.get(reference).and_then(|position| profiles.get(*position)),
            None => profiles.iter().find(|profile| selection_ref(profile) == reference),
        }
        .ok_or_else(|| invalid("Model profile is missing or changed. Query the model profile directory again."))?;
        if profile["available"] != true {
            return Err(invalid("The selected model profile is unavailable. Query the model profile directory again."));
        }
        plan["selection"] = json!({
            "kind":"profile",
            "profileId":profile["profileId"],
            "profileRevision":profile["profileRevision"],
            "selectionRef":selection_ref(profile)
        });
        plan["target"] = json!({
            "kind":profile["target"]["kind"],
            "models":profile["target"]["models"]
        });
        if let Some(effort) = profile["reasoning"].get("profileDefault") {
            plan["profileDefaultEffort"] = effort.clone();
        }
    }
    Ok(plan)
}

fn validate_plan(plan: &Value) -> Result<()> {
    object(
        plan,
        &["selection", "parent", "policyRevision", "requestedEffort", "profileDefaultEffort", "target"],
    )?;
    parent(&plan["parent"])?;
    text(plan, "policyRevision")?;
    optional_text(plan, "requestedEffort")?;
    optional_text(plan, "profileDefaultEffort")?;
    match plan["selection"]["kind"].as_str() {
        Some("inherit") => {
            object(&plan["selection"], &["kind"])?;
            if plan.get("profileDefaultEffort").is_some() {
                return Err(invalid("Inherited plans cannot contain profile defaults."));
            }
        }
        Some("profile") => {
            object(&plan["selection"], &["kind", "profileId", "profileRevision", "selectionRef"])?;
            for key in ["profileId", "profileRevision", "selectionRef"] {
                text(&plan["selection"], key)?;
            }
            if selection_ref(&plan["selection"])
                != plan["selection"]["selectionRef"].as_str().unwrap()
            {
                return Err(invalid("Invalid profile selection identity."));
            }
        }
        _ => return Err(invalid("Unknown model choice plan selection.")),
    }
    if plan["selection"]["kind"] == "profile" {
        object(&plan["target"], &["kind", "models"])?;
        let models = plan["target"]["models"]
            .as_array()
            .ok_or_else(|| invalid("Profile plan requires target models."))?;
        if !matches!(plan["target"]["kind"].as_str(), Some("single" | "pool"))
            || models.is_empty()
            || models.iter().any(|v| !v.as_str().is_some_and(|s| !s.trim().is_empty()))
            || (plan["target"]["kind"] == "single" && models.len() != 1)
        {
            return Err(invalid("Invalid profile plan target."));
        }
    } else if plan.get("target").is_some() {
        return Err(invalid("Inherited plans cannot contain a profile target."));
    }
    Ok(())
}

fn supports(reasoning: &Value, capability: &Value) -> Result<()> {
    validate_effective_reasoning(reasoning)?;
    if let Some(effort) = reasoning.get("effort") {
        if !capability["supported"].as_array().is_some_and(|a| a.contains(effort))
            && !capability["effortMapping"].as_object().is_some_and(|m| m.values().any(|v| v == reasoning))
            && capability["default"] != *reasoning
        {
            return Err(invalid("The target cannot validate the requested reasoning effort."));
        }
    }
    if reasoning["mode"] == "budget" || reasoning["mode"] == "adaptive" || reasoning["mode"] == "off" {
        if capability["default"] != *reasoning
            && !capability["effortMapping"].as_object().is_some_and(|m| m.values().any(|v| v == reasoning))
            && !capability["modes"].as_array().is_some_and(|modes| modes.contains(&reasoning["mode"]))
        {
            return Err(invalid("The target cannot validate the requested reasoning mode."));
        }
    }
    if reasoning["mode"] == "budget"
        && capability["maxBudgetTokens"].as_u64().is_some_and(|maximum| {
            reasoning["budgetTokens"].as_u64().unwrap() > maximum
        })
    {
        return Err(invalid("Reasoning budget exceeds the target reasoning capability."));
    }
    Ok(())
}

pub fn finalize_model_selection(args: &Value) -> Result<Value> {
    object(args, &["plan", "binding"])?;
    let plan = &args["plan"];
    validate_plan(plan)?;
    let binding = &args["binding"];
    object(
        binding,
        &["bindingId", "restoreRef", "model", "targetKind", "contextWindow", "maxOutputTokens", "modalities", "reasoning"],
    )?;
    for key in ["bindingId", "restoreRef", "model"] {
        text(binding, key)?;
    }
    if !matches!(binding["targetKind"].as_str(), Some("single" | "pool")) {
        return Err(invalid("Invalid prepared target kind."));
    }
    for key in ["contextWindow", "maxOutputTokens"] {
        if !binding[key].as_u64().is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991) {
            return Err(invalid("Target capacity must be a positive safe integer."));
        }
    }
    if binding["maxOutputTokens"].as_u64() > binding["contextWindow"].as_u64() {
        return Err(invalid("Target output limit exceeds its context window."));
    }
    if !binding["modalities"].as_array().is_some_and(|a| {
        !a.is_empty() && a.iter().all(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    }) {
        return Err(invalid("Target modalities are required."));
    }
    let capability = &binding["reasoning"];
    object(capability, &["supported", "default", "effortMapping", "modes", "maxBudgetTokens"])?;
    if let Some(maximum) = capability.get("maxBudgetTokens") {
        if !maximum.as_u64().is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991) {
            return Err(invalid("Maximum reasoning budget must be a positive safe integer."));
        }
    }
    if let Some(modes) = capability.get("modes") {
        let modes = modes.as_array().ok_or_else(|| invalid("Reasoning modes must be an array."))?;
        let mut seen = HashSet::new();
        for mode in modes {
            let mode = mode
                .as_str()
                .filter(|mode| matches!(*mode, "provider-default" | "off" | "effort" | "budget" | "adaptive"))
                .ok_or_else(|| invalid("Unknown supported reasoning mode."))?;
            if !seen.insert(mode) {
                return Err(invalid("Duplicate supported reasoning mode."));
            }
        }
    }
    validate_effective_reasoning(&capability["default"])?;
    if let Some(mapping) = capability.get("effortMapping") {
        for (key, value) in mapping
            .as_object()
            .ok_or_else(|| invalid("Invalid reasoning effort mapping."))?
        {
            if key.trim().is_empty() {
                return Err(invalid("Invalid reasoning effort mapping."));
            }
            validate_effective_reasoning(value)?;
        }
    }
    if let Some(supported) = capability.get("supported") {
        validate_supported(supported)?;
    }
    let inherited = plan["selection"]["kind"] == "inherit";
    if !inherited
        && (binding["targetKind"] != plan["target"]["kind"]
            || (binding["targetKind"] == "single" && binding["model"] != plan["target"]["models"][0]))
    {
        return Err(invalid("Prepared target differs from the selected model profile."));
    }
    if inherited
        && ["bindingId", "restoreRef", "model"].iter().any(|key| binding[key] != plan["parent"][key])
    {
        return Err(invalid("Prepared inherited binding differs from its direct parent."));
    }
    let effort = plan.get("requestedEffort").or_else(|| plan.get("profileDefaultEffort"));
    let reasoning = if let Some(effort) = effort {
        if let Some(mapped) = capability["effortMapping"].get(effort.as_str().unwrap()) {
            mapped.clone()
        } else if capability["supported"].as_array().is_some_and(|a| a.contains(effort)) {
            json!({"version":1,"mode":"effort","effort":effort})
        } else {
            return Err(invalid("The target does not support the requested reasoning effort."));
        }
    } else if inherited {
        plan["parent"]["reasoning"].clone()
    } else {
        capability["default"].clone()
    };
    supports(&reasoning, capability)?;
    if reasoning["mode"] == "budget"
        && reasoning["budgetTokens"].as_u64().unwrap() >= binding["maxOutputTokens"].as_u64().unwrap()
    {
        return Err(invalid("Reasoning budget must be smaller than the target output limit."));
    }
    Ok(json!({
        "version":1,
        "selection":plan["selection"],
        "bindingId":binding["bindingId"],
        "restoreRef":binding["restoreRef"],
        "model":binding["model"],
        "targetKind":binding["targetKind"],
        "reasoning":reasoning
    }))
}

pub fn query_model_profiles(args: &Value) -> Result<Value> {
    validate_catalog(&args["catalog"])?;
    query_with_catalog(args, &args["catalog"], None)
}

fn query_with_catalog(args: &Value, catalog: &Value, cached_stamp: Option<&str>) -> Result<Value> {
    object(args, &["catalog", "parent", "policyRevision", "input"])?;
    parent(&args["parent"])?;
    text(args, "policyRevision")?;
    if args["policyRevision"] != catalog["policyRevision"] {
        return Err(invalid("Model selection settings changed. Query again after the session refreshes."));
    }
    let input = &args["input"];
    object(input, &["query", "cursor", "limit"])?;
    let bounds = limits();
    let query = match input.get("query") {
        Some(v) => v.as_str().ok_or_else(|| invalid("Directory query must be text."))?,
        None => "",
    };
    if query.chars().count() > bounds["queryCodePoints"].as_u64().unwrap() as usize {
        return Err(invalid("Model directory query is too long."));
    }
    let limit = match input.get("limit") {
        Some(v) => v
            .as_u64()
            .filter(|n| *n > 0 && *n <= bounds["pageMaximum"].as_u64().unwrap())
            .ok_or_else(|| invalid("Invalid directory page limit."))?,
        None => bounds["pageDefault"].as_u64().unwrap(),
    } as usize;
    let normalized = query.trim().to_lowercase();
    let stamp = cached_stamp.map(str::to_owned).unwrap_or_else(|| catalog_stamp(catalog));
    let offset = if let Some(cursor) = input.get("cursor") {
        let cursor: Value = serde_json::from_str(
            cursor.as_str().ok_or_else(|| invalid("Invalid directory cursor."))?,
        )
        .map_err(|_| invalid("Invalid directory cursor."))?;
        object(&cursor, &["version", "revision", "policyRevision", "query", "stamp", "offset"])?;
        if cursor["version"] != 1
            || cursor["revision"] != catalog["revision"]
            || cursor["policyRevision"] != args["policyRevision"]
            || cursor["query"] != normalized
            || cursor["stamp"] != stamp
        {
            return Err(invalid("Model directory cursor expired. Start a new query."));
        }
        cursor["offset"].as_u64().ok_or_else(|| invalid("Invalid directory cursor offset."))? as usize
    } else {
        0
    };
    let matches: Vec<&Value> = catalog["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|profile| {
            if normalized.is_empty() {
                return profile["available"] == true;
            }
            let matches = ["name", "description"].iter().any(|key| {
                profile[key].as_str().unwrap().to_lowercase().contains(&normalized)
            }) || profile["target"]["models"].as_array().unwrap().iter().any(|v| {
                v.as_str().unwrap().to_lowercase().contains(&normalized)
            });
            matches
                && (profile["available"] == true
                    || profile["name"].as_str().unwrap().to_lowercase() == normalized
                    || profile["target"]["models"].as_array().unwrap().iter().any(|v| {
                        v.as_str().unwrap().to_lowercase() == normalized
                    }))
        })
        .collect();
    if offset > matches.len() {
        return Err(invalid("Invalid directory cursor offset."));
    }
    let mut result = json!({
        "revision":catalog["revision"],
        "policy":catalog["policy"],
        "policyRevision":catalog["policyRevision"],
        "parent":{"model":args["parent"]["model"],"reasoning":args["parent"]["reasoning"]},
        "profiles":[],
        "hasMore":false
    });
    let mut end = offset;
    while end < matches.len() && end - offset < limit {
        let profile = matches[end];
        let mut descriptor = profile.clone();
        descriptor.as_object_mut().unwrap().remove("profileId");
        descriptor.as_object_mut().unwrap().remove("profileRevision");
        descriptor["selectionRef"] = selection_ref(profile).into();
        result["profiles"].as_array_mut().unwrap().push(descriptor);
        end += 1;
        set_cursor(&mut result, catalog, &args["policyRevision"], &normalized, &stamp, end, matches.len());
        if serde_json::to_vec(&result).unwrap().len() > bounds["resultBytes"].as_u64().unwrap() as usize {
            result["profiles"].as_array_mut().unwrap().pop();
            end -= 1;
            break;
        }
    }
    set_cursor(&mut result, catalog, &args["policyRevision"], &normalized, &stamp, end, matches.len());
    if end == offset && end < matches.len()
        || serde_json::to_vec(&result).unwrap().len() > bounds["resultBytes"].as_u64().unwrap() as usize
    {
        return Err(invalid("A complete directory entry cannot fit in its response."));
    }
    Ok(result)
}

pub fn validate_model_selection_snapshot(snapshot: &Value) -> Result<Value> {
    object(
        snapshot,
        &["version", "selection", "bindingId", "restoreRef", "model", "targetKind", "reasoning"],
    )?;
    if snapshot["version"] != 1 {
        return Err(invalid("Unsupported model selection snapshot version."));
    }
    for key in ["bindingId", "restoreRef", "model"] {
        text(snapshot, key)?;
    }
    if !matches!(snapshot["targetKind"].as_str(), Some("single" | "pool")) {
        return Err(invalid("Invalid saved target kind."));
    }
    validate_effective_reasoning(&snapshot["reasoning"])?;
    let mut plan = json!({
        "selection":snapshot["selection"],
        "parent":{
            "bindingId":snapshot["bindingId"],
            "restoreRef":snapshot["restoreRef"],
            "model":snapshot["model"],
            "reasoning":snapshot["reasoning"]
        },
        "policyRevision":"snapshot"
    });
    if plan["selection"]["kind"] == "profile" {
        plan["target"] = json!({"kind":snapshot["targetKind"],"models":[snapshot["model"]]});
    }
    validate_plan(&plan)?;
    Ok(snapshot.clone())
}

pub fn validate_model_selection_restore(args: &Value) -> Result<Value> {
    object(args, &["snapshot", "binding"])?;
    let snapshot = &args["snapshot"];
    validate_model_selection_snapshot(snapshot)?;
    for key in ["bindingId", "restoreRef", "model", "targetKind"] {
        if snapshot[key] != args["binding"][key] {
            return Err(invalid("Restored model binding differs from the saved target."));
        }
    }
    let plan = json!({
        "selection":{"kind":"inherit"},
        "parent":{
            "bindingId":snapshot["bindingId"],
            "restoreRef":snapshot["restoreRef"],
            "model":snapshot["model"],
            "reasoning":snapshot["reasoning"]
        },
        "policyRevision":"restore"
    });
    finalize_model_selection(&json!({"plan":plan,"binding":args["binding"]}))?;
    Ok(snapshot.clone())
}

fn catalog_stamp(catalog: &Value) -> String {
    let mut hash = 14695981039346656037u64;
    for byte in serde_json::to_string(catalog).unwrap().bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("{hash:016x}")
}

pub struct ValidatedModelCatalog {
    catalog: Value,
    stamp: String,
    profile_index: std::collections::HashMap<String, usize>,
}

impl ValidatedModelCatalog {
    pub fn new(catalog: Value) -> Result<Self> {
        validate_catalog(&catalog)?;
        let profile_index = catalog["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(position, profile)| (selection_ref(profile), position))
            .collect();
        let stamp = catalog_stamp(&catalog);
        Ok(Self { catalog, stamp, profile_index })
    }

    pub fn revision(&self) -> &str {
        self.catalog["revision"].as_str().unwrap()
    }

    pub fn policy_revision(&self) -> &str {
        self.catalog["policyRevision"].as_str().unwrap()
    }

    pub fn policy(&self) -> &str {
        self.catalog["policy"].as_str().unwrap()
    }

    pub fn plan(&self, input: &Value) -> Result<Value> {
        plan_with_catalog(input, &self.catalog, Some(&self.profile_index))
    }

    pub fn query(&self, input: &Value) -> Result<Value> {
        query_with_catalog(input, &self.catalog, Some(&self.stamp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent_binding() -> Value {
        json!({
            "bindingId":"parent",
            "restoreRef":"parent-v1",
            "model":"model-a",
            "reasoning":{"version":1,"mode":"budget","budgetTokens":4096,"effort":"high"}
        })
    }

    fn catalog(count: usize) -> Value {
        json!({
            "revision":"catalog-1",
            "policy":"inherit",
            "policyRevision":"policy-1",
            "profiles":(0..count).map(|n| json!({
                "profileId":format!("id-{n}"),
                "profileRevision":"1",
                "name":format!("Profile {n}"),
                "description":"Extraction and review",
                "target":{"kind":"single","label":"Model B","models":["model-b"]},
                "reasoning":{"supported":["low","high"],"profileDefault":"low"},
                "available":true
            })).collect::<Vec<_>>()
        })
    }

    fn metadata() -> Value {
        json!({
            "bindingId":"target-b",
            "restoreRef":"target-b-v1",
            "model":"model-b",
            "targetKind":"single",
            "contextWindow":32768,
            "maxOutputTokens":8192,
            "modalities":["text"],
            "reasoning":{
                "supported":["low","high"],
                "default":{"version":1,"mode":"provider-default"},
                "effortMapping":{"high":{"version":1,"mode":"budget","budgetTokens":4096,"effort":"high"}}
            }
        })
    }

    #[test]
    fn strict_reasoning_rejects_mixed_modes_and_invalid_budgets() {
        for value in [
            json!({"version":1,"mode":"off","budgetTokens":10}),
            json!({"version":1,"mode":"effort"}),
            json!({"version":1,"mode":"budget","budgetTokens":0}),
            json!({"version":2,"mode":"provider-default"}),
        ] {
            assert!(validate_effective_reasoning(&value).is_err());
        }
        assert!(validate_effective_reasoning(&parent_binding()["reasoning"]).is_ok());
    }

    #[test]
    fn profile_priority_and_exact_target_are_validated() {
        let catalog = catalog(1);
        let reference = selection_ref(&catalog["profiles"][0]);
        let mut plan = plan_model_selection(&json!({
            "input":{"model_profile":reference},
            "parent":parent_binding(),
            "catalog":catalog,
            "policyRevision":"policy-1"
        })).unwrap();
        let result = finalize_model_selection(&json!({"plan":plan,"binding":metadata()})).unwrap();
        assert_eq!(result["reasoning"], json!({"version":1,"mode":"effort","effort":"low"}));
        plan["requestedEffort"] = "high".into();
        let result = finalize_model_selection(&json!({"plan":plan,"binding":metadata()})).unwrap();
        assert_eq!(result["reasoning"], parent_binding()["reasoning"]);
        let mut wrong = metadata();
        wrong["model"] = "model-c".into();
        assert!(finalize_model_selection(&json!({"plan":plan,"binding":wrong})).is_err());
        plan["requestedEffort"] = "xhigh".into();
        assert!(finalize_model_selection(&json!({"plan":plan,"binding":metadata()})).is_err());
    }

    #[test]
    fn policy_invalidation_blocks_overrides_but_allows_plain_inheritance() {
        let catalog = catalog(1);
        for input in [
            json!({"model_profile":selection_ref(&catalog["profiles"][0])}),
            json!({"reasoning_effort":"high"}),
        ] {
            assert!(plan_model_selection(&json!({
                "input":input,"parent":parent_binding(),"catalog":catalog,"policyRevision":"stale"
            })).is_err());
        }
        assert!(plan_model_selection(&json!({
            "input":{},"parent":parent_binding(),"catalog":catalog,"policyRevision":"stale"
        })).is_ok());
        assert!(query_model_profiles(&json!({
            "input":{},"parent":parent_binding(),"catalog":catalog,"policyRevision":"stale"
        })).is_err());
    }

    #[test]
    fn declared_modes_validate_arbitrary_inherited_budgets_with_current_bounds() {
        let catalog = catalog(1);
        let plan = plan_model_selection(&json!({
            "catalog":catalog,"parent":parent_binding(),"input":{},"policyRevision":"policy-1"
        })).unwrap();
        let mut binding = metadata();
        binding["bindingId"] = "parent".into();
        binding["restoreRef"] = "parent-v1".into();
        binding["model"] = "model-a".into();
        binding["reasoning"] = json!({
            "default":{"version":1,"mode":"provider-default"},
            "supported":["high"],
            "modes":["budget","off","adaptive"],
            "maxBudgetTokens":6000
        });
        assert_eq!(
            finalize_model_selection(&json!({"plan":plan,"binding":binding})).unwrap()["reasoning"],
            parent_binding()["reasoning"]
        );
        binding["reasoning"]["maxBudgetlicenses"] = 5000.into();
        assert!(finalize_model_selection(&json!({"plan":plan,"binding":binding})).is_err());
        binding["reasoning"].as_object_mut().unwrap().remove("maxBudgetlicenses");
        binding["reasoning"]["maxBudgetTokens"] = 4000.into();
        assert!(finalize_model_selection(&json!({"plan":plan,"binding":binding})).is_err());
        binding["reasoning"]["modes"] = json!(["unknown"]);
        assert!(finalize_model_selection(&json!({"plan":plan,"binding":binding})).is_err());
    }

    #[test]
    fn budget_above_or_equal_to_output_limit_is_rejected_on_creation_and_restore() {
        let catalog = catalog(1);
        let mut plan = plan_model_selection(&json!({
            "input":{"model_profile":selection_ref(&catalog["profiles"][0]),"reasoning_effort":"high"},
            "parent":parent_binding(),"catalog":catalog,"policyRevision":"policy-1"
        })).unwrap();
        let snapshot = finalize_model_selection(&json!({"plan":plan,"binding":metadata()})).unwrap();
        for output in [1024, 4096] {
            let mut binding = metadata();
            binding["maxOutputTokens"] = output.into();
            assert!(finalize_model_selection(&json!({"plan":plan,"binding":binding})).is_err());
            assert!(validate_model_selection_restore(&json!({"snapshot":snapshot,"binding":binding})).is_err());
        }
        plan["requestedEffort"] = "low".into();
        assert!(finalize_model_selection(&json!({"plan":plan,"binding":metadata()})).is_ok());
    }

    #[test]
    fn snapshot_validation_rejects_secrets_and_incomplete_identity() {
        let plan = json!({"selection":{"kind":"inherit"},"parent":parent_binding(),"policyRevision":"policy-1"});
        let mut binding = metadata();
        for key in ["bindingId", "restoreRef", "model"] {
            binding[key] = parent_binding()[key].clone();
        }
        let snapshot = finalize_model_selection(&json!({"plan":plan,"binding":binding})).unwrap();
        assert!(validate_model_selection_snapshot(&snapshot).is_ok());
        let mut secret = snapshot.clone();
        secret["apiKey"] = "canary".into();
        assert!(validate_model_selection_snapshot(&secret).is_err());
        let mut missing = snapshot.clone();
        missing.as_object_mut().unwrap().remove("bindingId");
        assert!(validate_model_selection_snapshot(&missing).is_err());
        let mut mixed = snapshot;
        mixed["reasoning"]["mode"] = "off".into();
        assert!(validate_model_selection_snapshot(&mixed).is_err());
    }

    #[test]
    fn unavailable_empty_pool_is_queryable_but_not_executable() {
        let mut catalog = catalog(1);
        catalog["profiles"][0]["target"]["kind"] = "pool".into();
        catalog["profiles"][0]["target"]["models"] = json!([]);
        catalog["profiles"][0]["available"] = false.into();
        catalog["profiles"][0]["unavailableReason"] = "The configured pool is empty.".into();
        let page = query_model_profiles(&json!({
            "catalog":catalog,"parent":parent_binding(),"policyRevision":"policy-1","input":{"query":"Profile 0"}
        })).unwrap();
        assert_eq!(page["profiles"][0]["target"]["models"], json!([]));
        assert!(page["parent"].get("bindingId").is_none());
        assert!(page["parent"].get("restoreRef").is_none());
        assert!(plan_model_selection(&json!({
            "catalog":catalog,"parent":parent_binding(),"policyRevision":"policy-1",
            "input":{"model_profile":page["profiles"][0]["selectionRef"]}
        })).is_err());
        catalog["profiles"][0]["available"] = true.into();
        assert!(validate_catalog(&catalog).is_err());
    }

    #[test]
    fn pages_are_complete_reachable_and_bound_to_snapshot() {
        let mut catalog = catalog(101);
        let mut input = json!({});
        let mut seen = Vec::new();
        loop {
            let page = query_model_profiles(&json!({
                "input":input,"parent":parent_binding(),"catalog":catalog,"policyRevision":"policy-1"
            })).unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() <= 16384);
            for profile in page["profiles"].as_array().unwrap() {
                seen.push(profile["selectionRef"].clone());
            }
            if page["hasMore"] != true {
                break;
            }
            input = json!({"cursor":page["nextCursor"]});
        }
        assert_eq!(seen.len(), 101);
        let first = query_model_profiles(&json!({
            "input":{},"parent":parent_binding(),"catalog":catalog,"policyRevision":"policy-1"
        })).unwrap();
        catalog["profiles"][0]["profileRevision"] = "2".into();
        assert!(query_model_profiles(&json!({
            "input":{"cursor":first["nextCursor"]},"parent":parent_binding(),"catalog":catalog,"policyRevision":"policy-1"
        })).is_err());
        assert!(plan_model_selection(&json!({
            "input":{"model_profile":seen[0]},"parent":parent_binding(),"catalog":catalog,"policyRevision":"policy-1"
        })).is_err());
    }

    #[test]
    fn cached_catalog_matches_function_and_restores_exact_binding() {
        let catalog = catalog(1);
        let view = ValidatedModelCatalog::new(catalog.clone()).unwrap();
        let input = json!({"input":{},"parent":parent_binding(),"policyRevision":"policy-1"});
        let mut full = input.clone();
        full["catalog"] = catalog;
        assert_eq!(view.query(&input).unwrap(), query_model_profiles(&full).unwrap());
        assert_eq!(view.plan(&input).unwrap(), plan_model_selection(&full).unwrap());
        let plan = plan_model_selection(&json!({
            "input":{"model_profile":selection_ref(&full["catalog"]["profiles"][0])},
            "parent":parent_binding(),"catalog":full["catalog"],"policyRevision":"policy-1"
        })).unwrap();
        let snapshot = finalize_model_selection(&json!({"plan":plan,"binding":metadata()})).unwrap();
        assert_eq!(
            validate_model_selection_restore(&json!({"snapshot":snapshot,"binding":metadata()})).unwrap(),
            snapshot
        );
    }
}

fn set_cursor(
    result: &mut Value,
    catalog: &Value,
    policy: &Value,
    query: &str,
    stamp: &str,
    end: usize,
    total: usize,
) {
    result["hasMore"] = (end < total).into();
    if end < total {
        result["nextCursor"] = serde_json::to_string(&json!({
            "version":1,"revision":catalog["revision"],"policyRevision":policy,
            "query":query,"stamp":stamp,"offset":end
        })).unwrap().into();
    } else {
        result.as_object_mut().unwrap().remove("nextCursor");
    }
}
