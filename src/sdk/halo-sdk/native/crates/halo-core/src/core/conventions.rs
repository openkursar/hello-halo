use serde_json::Value;
use std::path::Path;

pub fn process_environment(options: &Value) -> Value {
    options
        .get("nativeProcessEnv")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| {
            serde_json::json!(std::env::vars().collect::<std::collections::HashMap<_, _>>())
        })
}
pub fn process_value(options: &Value, name: &str) -> Option<String> {
    if let Some(environment) = options
        .get("nativeProcessEnv")
        .filter(|value| value.is_object())
    {
        environment[name].as_str().map(str::to_owned)
    } else {
        std::env::var(name).ok()
    }
}
pub fn merged_environment(
    base: &Value,
    overrides: &[&Value],
    fold_case: bool,
) -> std::collections::HashMap<String, String> {
    let mut environment = std::collections::HashMap::new();
    for values in std::iter::once(base).chain(overrides.iter().copied()) {
        if let Some(values) = values.as_object() {
            for (name, value) in values {
                let name = if fold_case {
                    name.to_uppercase()
                } else {
                    name.clone()
                };
                if crate::js::is_undefined(value) {
                    environment.remove(&name);
                } else {
                    environment.insert(name, crate::js::to_string(value));
                }
            }
        }
    }
    environment
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn subprocess_environment_matches_node_value_coercion_and_undefined_removal() {
        let base = json!({"UNDEFINED":"old", "KEPT":"base"});
        let mut overrides = json!({"NUMBER":1,"BOOLEAN":false,"NULL":null,"ARRAY":[1,2],"OBJECT":{"x":1}});
        overrides["UNDEFINED"] = crate::js::undefined();
        let actual = merged_environment(&base, &[&overrides], false);
        assert_eq!(actual.get("NUMBER").map(String::as_str), Some("1"));
        assert_eq!(actual.get("BOOLEAN").map(String::as_str), Some("false"));
        assert_eq!(actual.get("NULL").map(String::as_str), Some("null"));
        assert_eq!(actual.get("ARRAY").map(String::as_str), Some("1,2"));
        assert_eq!(actual.get("OBJECT").map(String::as_str), Some("[object Object]"));
        assert!(!actual.contains_key("UNDEFINED"));
        assert_eq!(actual.get("KEPT").map(String::as_str), Some("base"));
    }
}

pub fn home(options: &Value) -> String {
    options["env"]["HOME"]
        .as_str()
        .or_else(|| options["env"]["USERPROFILE"].as_str())
        .map(str::to_owned)
        .or_else(|| process_value(options, "HOME"))
        .or_else(|| process_value(options, "USERPROFILE"))
        .or_else(|| options["nativeHomeDirectory"].as_str().map(str::to_owned))
        .unwrap_or_default()
}
pub fn temp_dir(options: &Value) -> std::path::PathBuf {
    if let Some(directory) = options["nativeTempDirectory"].as_str() { return directory.into(); }
    if options["nativeProcessEnv"].is_object() {
        let names: &[&str] = if cfg!(windows) { &["TEMP", "TMP"] } else { &["TMPDIR", "TMP", "TEMP"] };
        if let Some(directory) = names.iter().find_map(|name| process_value(options, name).filter(|value| !value.is_empty())) { return directory.into(); }
        return if cfg!(windows) { process_value(options, "SystemRoot").or_else(|| process_value(options, "windir")).map(|root| Path::new(&root).join("temp")).unwrap_or_else(|| Path::new("C:\\Windows\\temp").to_owned()) } else { "/tmp".into() };
    }
    std::env::temp_dir()
}
pub fn config_dir(options: &Value) -> String {
    let key = options["conventions"]["configDirEnv"]
        .as_str()
        .unwrap_or("CLAUDE_CONFIG_DIR");
    options["env"]
        .get(key)
        .map(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| process_value(options, key))
        .unwrap_or_else(|| {
            Path::new(&home(options))
                .join(
                    options["conventions"]["userConfigDirName"]
                        .as_str()
                        .unwrap_or(".claude"),
                )
                .to_string_lossy()
                .into_owned()
        })
}
