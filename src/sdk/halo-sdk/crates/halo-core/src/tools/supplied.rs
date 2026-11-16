use crate::{
    error::{Error, Result},
    harness::{ResolvedHarness, ResourceId, TextId},
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

pub(super) struct SuppliedTool {
    pub name: String,
    pub implementation: Option<String>,
    pub descriptor: Value,
    description_default: bool,
    schema_default: bool,
}
pub(super) struct SuppliedTools {
    ordered: Vec<Arc<SuppliedTool>>,
    names: HashMap<String, Arc<SuppliedTool>>,
}
impl SuppliedTools {
    pub fn new(descriptors: Vec<Value>) -> Result<Self> {
        let mut ordered = Vec::with_capacity(descriptors.len());
        let mut names = HashMap::new();
        let defaults = crate::harness::baseline().resource(ResourceId::ToolDefinitions);
        for descriptor in descriptors {
            let name = descriptor["name"]
                .as_str()
                .ok_or_else(|| {
                    Error::template(
                        "INVALID_SUPPLIED_TOOL",
                        TextId::ToolsSuppliedNameRequired,
                        &[],
                    )
                })?
                .to_owned();
            let implementation = descriptor["__haloSdkNativeTool"]["name"]
                .as_str()
                .map(str::to_owned);
            if let Some(implementation) = &implementation {
                if implementation != "CodeSearch"
                    && !defaults
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|tool| tool["name"] == *implementation)
                {
                    return Err(Error::template(
                        "INVALID_SUPPLIED_TOOL",
                        TextId::ToolsSuppliedUnknownImplementation,
                        &[("name", implementation.clone().into())],
                    ));
                }
            }
            let search = (implementation.as_deref() == Some("CodeSearch")
                || descriptor["__haloSdkNativeToolDefinition"] == "CodeSearchDefinition")
                .then(|| crate::harness::baseline().resource(ResourceId::CodeSearchDefinition));
            let baseline = search.as_ref().or_else(|| {
                implementation.as_ref().and_then(|name| {
                    defaults
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|value| value["name"] == *name)
                })
            });
            let description_default =
                baseline.is_some_and(|value| descriptor["description"] == value["description"]);
            let schema_default = baseline.is_some_and(|value| {
                crate::js::data::stringify(
                    descriptor
                        .get("inputSchema")
                        .unwrap_or(&descriptor["input_schema"]),
                ) == crate::js::data::stringify(&value["input_schema"])
            });
            let tool = Arc::new(SuppliedTool {
                name: name.clone(),
                implementation,
                descriptor,
                description_default,
                schema_default,
            });
            names.entry(name).or_insert_with(|| tool.clone());
            ordered.push(tool);
        }
        Ok(Self { ordered, names })
    }
    pub fn get(&self, name: &str) -> Option<Arc<SuppliedTool>> {
        self.names.get(name).cloned()
    }
    pub fn contains(&self, name: &str) -> bool {
        self.names.contains_key(name)
    }
    pub fn definitions(&self, harness: &ResolvedHarness) -> Vec<Value> {
        let has_native = self
            .ordered
            .iter()
            .any(|tool| tool.description_default || tool.schema_default);
        let selected = has_native.then(|| harness.resource(ResourceId::ToolDefinitions));
        let search = self
            .ordered
            .iter()
            .any(|tool| {
                (tool.implementation.as_deref() == Some("CodeSearch")
                    || tool.descriptor["__haloSdkNativeToolDefinition"] == "CodeSearchDefinition")
                    && (tool.description_default || tool.schema_default)
            })
            .then(|| harness.resource(ResourceId::CodeSearchDefinition));
        self.ordered
            .iter()
            .map(|tool| {
                let source = &tool.descriptor;
                let current = if tool.implementation.as_deref() == Some("CodeSearch")
                    || source["__haloSdkNativeToolDefinition"] == "CodeSearchDefinition"
                {
                    search.as_ref()
                } else {
                    selected.as_ref().and_then(|selected| {
                        selected.as_array().unwrap().iter().find(|value| {
                            Some(value["name"].as_str().unwrap_or(""))
                                == tool.implementation.as_deref()
                        })
                    })
                };
                let description = current
                    .filter(|_| tool.description_default)
                    .map(|value| &value["description"])
                    .unwrap_or(&source["description"]);
                let schema = current
                    .filter(|_| tool.schema_default)
                    .map(|value| &value["input_schema"])
                    .unwrap_or_else(|| {
                        source.get("inputSchema").unwrap_or(&source["input_schema"])
                    });
                let mut definition =
                    json!({"name":tool.name,"description":description,"input_schema":schema});
                if let Some(metadata) = source.get("mcpSource") {
                    definition["mcpSource"] = metadata.clone();
                }
                definition
            })
            .collect()
    }
}
