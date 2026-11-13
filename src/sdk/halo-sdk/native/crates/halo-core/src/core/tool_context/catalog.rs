use crate::{
    error::{Error, Result},
    harness::{ResolvedHarness,TextId},
    js::{compare_text, is_whitespace, stringify, trim_js, truthy, utf16_len},
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

pub const SEARCH_BYTES: usize = 32 * 1024;
pub const QUERY_CHARACTERS: usize = 4096;
pub const STATE_BYTES: usize = 4 * 1024 * 1024;
pub const CATALOG_BYTES: usize = 16 * 1024 * 1024;

pub fn stable_json(value: &Value) -> String {
    fn sort(value: &Value) -> Value {
        match value {
            Value::Array(array) => Value::Array(array.iter().map(sort).collect()),
            Value::Object(object) => {
                let mut pairs: Vec<_> = object.iter().collect();
                pairs.sort_by(|(a, _), (b, _)| compare_text(a, b));
                Value::Object(
                    pairs
                        .into_iter()
                        .map(|(key, value)| (key.clone(), sort(value)))
                        .collect(),
                )
            }
            _ => value.clone(),
        }
    }
    stringify(&sort(value))
}
pub fn fingerprint(value: &Value) -> String {
    hex::encode(Sha256::digest(stable_json(value)))
}
pub fn definition(tool: &Value) -> Value {
    json!({"name":tool["name"],"description":tool["description"],"input_schema":tool["input_schema"]})
}
fn bounded_summary(text: &str) -> String {
    trim_js(
        &text
            .split(is_whitespace)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
    )
    .chars()
    .take(512)
    .collect()
}
fn normalize(text: &str) -> String {
    text.nfkc().collect::<String>().to_lowercase()
}
fn keywords(text: &str) -> Vec<String> {
    let normalized = text.nfkc().collect::<String>();
    static PATTERNS: std::sync::OnceLock<[regex::Regex; 5]> = std::sync::OnceLock::new();
    let [words, split1, split2, split_words, asian] = PATTERNS.get_or_init(|| {
        [
            r"[\p{L}\p{N}_]+",
            r"([a-z0-9])([A-Z])",
            r"([A-Z])([A-Z][a-z])",
            r"[\p{L}\p{N}]+",
            r"\p{Han}|\p{Hiragana}|\p{Katakana}|\p{Hangul}",
        ]
        .map(|pattern| regex::Regex::new(pattern).unwrap())
    });
    let lower = normalized.to_lowercase();
    let mut parts: Vec<String> = words.find_iter(&lower).map(|m| m.as_str().into()).collect();
    let camel = split2
        .replace_all(&split1.replace_all(&normalized, "${1} ${2}"), "${1} ${2}")
        .to_lowercase();
    parts.extend(split_words.find_iter(&camel).map(|m| m.as_str().to_owned()));
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for part in &parts {
        if seen.insert(part.clone()) {
            terms.push(part.clone());
        }
    }
    for part in parts {
        if asian.is_match(&part) {
            let chars: Vec<_> = part.chars().collect();
            for pair in chars.windows(2) {
                let pair = pair.iter().collect::<String>();
                if seen.insert(pair.clone()) {
                    terms.push(pair);
                }
            }
        }
    }
    terms
}

pub fn validate_options(options: &Value) -> Result<()> {
    if options
        .as_object()
        .is_none_or(|o| o.keys().any(|k| k != "services"))
        || !options["services"].is_object()
    {
        return Err(Error::template("INVALID_ARGUMENT", TextId::ContextDiscoveryRequiresServices, &[]));
    }
    for policy in options["services"].as_object().unwrap().values() {
        if policy.as_object().is_none_or(|o| {
            o.keys().any(|k| {
                ![
                    "identity",
                    "loading",
                    "summary",
                    "usageGuide",
                    "toolOverrides",
                ]
                .contains(&k.as_str())
            })
        }) || policy["identity"]
            .as_str()
            .is_none_or(|s| trim_js(s).is_empty())
            || !["eager", "deferred"].contains(&policy["loading"].as_str().unwrap_or(""))
            || ["summary", "usageGuide"]
                .iter()
                .any(|k| policy.get(*k).is_some_and(|v| !v.is_string()&&!crate::js::is_undefined(v)))
            || policy.get("toolOverrides").filter(|value|!crate::js::is_undefined(value)).is_some_and(|v| {
                v.as_object()
                    .is_none_or(|o| o.values().any(|v| v != "eager" && v != "deferred"))
            })
        {
            return Err(Error::template("INVALID_ARGUMENT", TextId::ContextDiscoveryInvalidPolicy, &[]));
        }
    }
    Ok(())
}
struct Indexed {
    entry: Value,
    name: String,
    original_name: String,
    terms: HashSet<String>,
}
pub struct Catalog {
    pub eager: Vec<Value>,
    pub deferred: Map<String, Value>,
    pub directory: String,
    pub generation: String,
    index: Vec<Indexed>,
}
impl Catalog {
    pub fn new(tools: &[Value], options: &Value) -> Result<Self> {Self::new_with_harness(tools,options,&crate::harness::baseline())}
    pub fn new_with_harness(tools:&[Value],options:&Value,harness:&ResolvedHarness)->Result<Self>{
        validate_options(options)?;
        let mut names = HashSet::new();
        let mut eager = Vec::new();
        let mut deferred = Map::new();
        let mut services = Map::new();
        let mut sources = HashMap::<String, HashSet<String>>::new();
        let mut catalog_bytes = 0usize;
        for tool in tools {
            let name = tool["name"].as_str().unwrap_or("");
            if !names.insert(name.to_owned()) {
                return Err(Error::template("TOOL_IDENTITY", TextId::ContextDiscoveryDuplicateIdentity, &[("name", name.into())]));
            }
            let source = &tool["mcpSource"];
            let server = source["server"].as_str().unwrap_or("");
            let original = source["name"].as_str().unwrap_or("");
            if source.is_object() {
                sources
                    .entry(server.into())
                    .or_default()
                    .insert(original.into());
            }
            let policy = options["services"].get(server).unwrap_or(&Value::Null);
            let loading = policy["toolOverrides"]
                .get(original)
                .unwrap_or(&policy["loading"]);
            if !source.is_object() || !policy.is_object() || loading != "deferred" {
                eager.push(tool.clone());
                continue;
            }
            if policy["identity"]
                .as_str()
                .is_none_or(|s| trim_js(s).is_empty())
            {
                return Err(Error::template("TOOL_IDENTITY", TextId::ContextDiscoveryServiceIdentityRequired, &[("server", server.into())]));
            }
            let mut declared = definition(tool);
            declared["description"] = source
                .get("toolDescription")
                .cloned()
                .unwrap_or(tool["description"].clone());
            let mut content = json!({"server":server,"identity":policy["identity"],"originalName":original,"definition":declared});
            let guide = policy.get("usageGuide").unwrap_or(&source["instructions"]);
            if truthy(guide) {
                content["usageGuide"] = guide.clone();
            }
            let serialized = stable_json(&content);
            catalog_bytes += serialized.len();
            if catalog_bytes > CATALOG_BYTES {
                tracing::warn!(
                    bytes = catalog_bytes,
                    limit = CATALOG_BYTES,
                    "Tool discovery catalog exceeds its memory bound"
                );
                return Err(Error::template("CATALOG_SIZE", TextId::ContextDiscoveryCatalogLimit, &[]));
            }
            content["version"] = json!(hex::encode(Sha256::digest(serialized)));
            deferred.insert(name.into(), content);
            if !services.contains_key(server) {
                let summary = [
                    &policy["summary"],
                    &source["description"],
                    &source["instructions"],
                ]
                .into_iter()
                .find(|v| truthy(v))
                .and_then(Value::as_str)
                .unwrap_or("");
                services.insert(
                    server.into(),
                    json!({"identity":policy["identity"],"summary":bounded_summary(summary)}),
                );
            }
        }
        let unknown: usize = options["services"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(server, policy)| {
                policy["toolOverrides"]
                    .as_object()
                    .map(|overrides| {
                        overrides
                            .keys()
                            .filter(|name| {
                                sources
                                    .get(server)
                                    .is_none_or(|known| !known.contains(*name))
                            })
                            .count()
                    })
                    .unwrap_or(0)
            })
            .sum();
        if unknown > 0 {
            tracing::warn!(
                count = unknown,
                "Tool loading overrides did not match the permitted tool pool"
            );
        }
        let mut entries: Vec<_> = deferred.values().cloned().collect();
        entries.sort_by(|a, b| {
            compare_text(
                a["definition"]["name"].as_str().unwrap(),
                b["definition"]["name"].as_str().unwrap(),
            )
        });
        for (server, service) in &mut services {
            if service["summary"] == "" {
                let combined = entries
                    .iter()
                    .filter(|e| e["server"] == server.as_str())
                    .map(|e| {
                        if truthy(&e["definition"]["description"]) {
                            e["definition"]["description"].as_str().unwrap_or("")
                        } else {
                            e["originalName"].as_str().unwrap_or("")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                let summary = bounded_summary(&combined);
                service["summary"] = json!(if summary.is_empty() {
                    server.clone()
                } else {
                    summary
                });
            }
        }
        let mut service_keys: Vec<_> = services.keys().cloned().collect();
        service_keys.sort_by(|a, b| compare_text(a, b));
        let directory = if services.is_empty() {
            String::new()
        } else {
            harness.render(TextId::ContextDiscoveryDirectory,&[("services",&stringify(&json!(service_keys.iter().map(|server|json!({"server":server,"summary":services[server]["summary"]})).collect::<Vec<_>>())))])
        };
        let generation = fingerprint(
            &json!({"directory":directory,"definitions":entries.iter().map(|e|e["version"].clone()).collect::<Vec<_>>(),"eager":eager.iter().map(|tool|{
            let mut item=json!({"definition":definition(tool)}); for key in ["server","instructions"] { if let Some(value)=tool["mcpSource"].get(key){item[key]=value.clone();} } item
        }).collect::<Vec<_>>()}),
        );
        let index = entries
            .into_iter()
            .map(|entry| {
                let text = format!(
                    "{} {} {} {} {} {}",
                    entry["server"].as_str().unwrap(),
                    services[entry["server"].as_str().unwrap()]["summary"]
                        .as_str()
                        .unwrap_or(""),
                    entry["originalName"].as_str().unwrap(),
                    entry["definition"]["name"].as_str().unwrap(),
                    entry["definition"]["description"].as_str().unwrap_or(""),
                    stringify(&entry["definition"]["input_schema"])
                );
                Indexed {
                    name: normalize(entry["definition"]["name"].as_str().unwrap()),
                    original_name: normalize(entry["originalName"].as_str().unwrap()),
                    terms: keywords(&text).into_iter().collect(),
                    entry,
                }
            })
            .collect();
        Ok(Self {
            eager,
            deferred,
            directory,
            generation,
            index,
        })
    }
    pub fn search(&self, query: &str, server: Option<&str>) -> Vec<Value> {
        let selected = query.strip_prefix("select:").map(|rest| {
            rest.split(|c| is_whitespace(c) || c == ',')
                .filter(|s| !s.is_empty())
                .collect::<HashSet<_>>()
        });
        let normalized = normalize(query);
        let normalized = trim_js(&normalized);
        let terms = keywords(query);
        let mut matches: Vec<_> = self
            .index
            .iter()
            .filter(|item| {
                server.is_none_or(|server| server.is_empty() || item.entry["server"] == server)
            })
            .map(|item| {
                let score = if let Some(selected) = &selected {
                    if selected.contains(item.entry["definition"]["name"].as_str().unwrap()) {
                        1000
                    } else {
                        0
                    }
                } else if item.name == normalized || item.original_name == normalized {
                    1000
                } else {
                    terms
                        .iter()
                        .map(|term| {
                            if item.terms.contains(term) {
                                4
                            } else if utf16_len(term) >= 3 && item.original_name.contains(term) {
                                1
                            } else {
                                0
                            }
                        })
                        .sum()
                };
                (item, score)
            })
            .filter(|(_, score)| *score > 0)
            .collect();
        matches.sort_by(|(a, sa), (b, sb)| {
            sb.cmp(sa).then_with(|| {
                compare_text(
                    a.entry["definition"]["name"].as_str().unwrap(),
                    b.entry["definition"]["name"].as_str().unwrap(),
                )
            })
        });
        matches
            .into_iter()
            .map(|(item, _)| item.entry.clone())
            .collect()
    }
}
