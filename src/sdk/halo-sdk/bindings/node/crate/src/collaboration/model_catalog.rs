use super::super::{decode, encode, failure};
use halo_core::collaboration::model_selection::ValidatedModelCatalog;
use napi::{Error, Result, Status};
use napi_derive::napi;

#[napi]
pub struct NativeModelProfileCatalog {
    catalog: Option<ValidatedModelCatalog>,
}

#[napi]
impl NativeModelProfileCatalog {
    #[napi(constructor)]
    pub fn new(options: String) -> Result<Self> {
        let catalog = ValidatedModelCatalog::new(decode(&options)?).map_err(failure)?;
        Ok(Self { catalog: Some(catalog) })
    }
    #[napi]
    pub fn call(&self, name: String, payload: String) -> Result<String> {
        let catalog = self.catalog.as_ref().ok_or_else(|| Error::new(Status::InvalidArg, "Model profile catalog is closed."))?;
        let input = decode(&payload)?;
        let result = match name.as_str() {
            "plan" => catalog.plan(&input),
            "query" => catalog.query(&input),
            _ => return Err(Error::new(Status::InvalidArg, "Unknown model profile catalog operation.")),
        }.map_err(failure)?;
        encode(&result)
    }
    #[napi]
    pub fn close(&mut self) { self.catalog = None; }
}
