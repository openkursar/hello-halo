use serde_json::Value;
use std::{collections::{BTreeMap,BTreeSet},env,fs,path::{Path,PathBuf}};
fn files(directory:&Path)->Vec<PathBuf>{let mut paths=Vec::new();for entry in fs::read_dir(directory).unwrap(){let path=entry.unwrap().path();if path.is_dir(){paths.extend(files(&path));}else if path.extension().is_some_and(|extension|extension=="json"){paths.push(path);}}paths.sort();paths}
fn variant(key:&str)->String{key.split(|character:char|!character.is_ascii_alphanumeric()).filter(|part|!part.is_empty()).map(|part|{let mut chars=part.chars();format!("{}{}",chars.next().unwrap().to_ascii_uppercase(),chars.as_str())}).collect()}
fn identifier(key:&str)->bool{key.split('.').all(|part|part.chars().next().is_some_and(|character|character.is_ascii_lowercase())&&part.chars().all(|character|character.is_ascii_lowercase()||character.is_ascii_digit()||character=='_'))}
fn references(value:&Value,templates:&BTreeMap<String,(String,Vec<String>)>){
    match value{
        Value::Array(items)=>for item in items{references(item,templates);},
        Value::Object(object)=>{
            if object.len()==1&&object.contains_key("$harness"){
                let key=object["$harness"].as_str().expect("Harness reference must be a string");let template=templates.get(key).unwrap_or_else(||panic!("Unknown Harness resource reference: {key}"));assert!(template.1.is_empty(),"Resource reference requires a static template: {key}");
            }else{for value in object.values(){references(value,templates);}}
        }
        _=>{}
    }
}
fn enumeration(name:&str,keys:&[String])->String{
    let mut variants=BTreeSet::new();let mut output=format!("#[derive(Clone,Copy,Debug,Eq,PartialEq,Hash)]\npub enum {name} {{\n");
    for key in keys{let variant=variant(key);assert!(variants.insert(variant.clone()),"Ambiguous Harness variant: {variant}");output.push_str(&format!("{variant},\n"));}output.push_str("}\n");
    output.push_str(&format!("impl {name} {{ pub const fn index(self)->usize {{match self{{"));for(index,key)in keys.iter().enumerate(){output.push_str(&format!("Self::{}=>{index},",variant(key)));}output.push_str("}}\npub const fn as_str(self)->&'static str{match self{");for key in keys{output.push_str(&format!("Self::{}=>{:?},",variant(key),key));}output.push_str("}}\npub fn from_key(key:&str)->Option<Self>{match key{");for key in keys{output.push_str(&format!("{:?}=>Some(Self::{}),",key,variant(key)));}output.push_str("_=>None}}}\n");output
}
fn main(){
    let root=PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("src/harness");println!("cargo:rerun-if-changed={}",root.display());
    let mut templates=BTreeMap::new();for path in files(&root.join("catalogs")){
        let value:Value=serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap_or_else(|error|panic!("{}: {error}",path.display()));
        for(key,entry)in value.as_object().expect("Harness catalog must be an object"){
            assert!(identifier(key),"Invalid Harness template identifier: {key}");assert!(entry.as_object().is_some_and(|object|object.keys().all(|key|["text","slots"].contains(&key.as_str()))),"Invalid Harness entry: {key}");
            let text=entry["text"].as_str().expect("Harness text must be a string").to_owned();let slots:Vec<String>=entry["slots"].as_array().expect("Harness slots must be an array").iter().map(|slot|slot.as_str().expect("Harness slot must be a string").to_owned()).collect();
            let mut unique=BTreeSet::new();for slot in &slots{assert!(identifier(slot)&&!slot.contains('.'),"Invalid Harness slot: {key}.{slot}");assert!(unique.insert(slot),"Duplicate Harness slot: {key}.{slot}");assert!(text.contains(&format!("{{{slot}}}")),"Missing Harness slot: {key}.{slot}");}
            assert!(templates.insert(key.clone(),(text,slots)).is_none(),"Duplicate Harness template: {key}");
        }
    }
    let mut resources=BTreeMap::new();for path in files(&root.join("resources")){let source=fs::read_to_string(&path).unwrap();let value:Value=serde_json::from_str(&source).unwrap();references(&value,&templates);let key=path.file_stem().unwrap().to_str().unwrap().to_owned();assert!(resources.insert(key,source).is_none(),"Duplicate Harness resource");}
    let mut output=enumeration("TextId",&templates.keys().cloned().collect::<Vec<_>>());
    output.push_str("impl TextId { pub const fn default_text(self)->&'static str {match self{");for(key,(text,_))in &templates{output.push_str(&format!("Self::{}=>{:?},",variant(key),text));}output.push_str("}}}\n");
    output.push_str(&enumeration("ResourceId",&resources.keys().cloned().collect::<Vec<_>>()));
    output.push_str("static TEMPLATE_SPECS:&[TemplateSpec]=&[\n");for(key,(text,slots))in &templates{output.push_str(&format!("TemplateSpec{{id:TextId::{},text:{:?},slots:&{:?}}},\n",variant(key),text,slots));}output.push_str("];\nstatic RESOURCE_SPECS:&[ResourceSpec]=&[\n");for(key,source)in &resources{output.push_str(&format!("ResourceSpec{{id:ResourceId::{},source:{:?}}},\n",variant(key),source));}output.push_str("];\n");
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("harness_catalog.rs"),output).unwrap();
}
