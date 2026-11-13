use crate::error::{Error, Result};
use rustls::{pki_types::{pem::PemObject, CertificateDer}, RootCertStore};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct TrustSnapshot {
    pub generation: u64,
    pub roots: Arc<RootCertStore>,
}

pub(crate) fn with_trust(
    builder: reqwest::ClientBuilder,
    snapshot: Option<&TrustSnapshot>,
) -> Result<reqwest::ClientBuilder> {
    let Some(snapshot) = snapshot else { return Ok(builder); };
    let provider = rustls::crypto::CryptoProvider::get_default().cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let mut tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(rustls::ALL_VERSIONS)
        .map_err(|error| Error::new("TLS_CONFIGURATION", error.to_string()))?
        .with_root_certificates(snapshot.roots.clone())
        .with_no_client_auth();
    // The SDK enables reqwest HTTP/1.1 without its optional HTTP/2 feature.
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(builder.use_preconfigured_tls(tls))
}

#[derive(Default)]
pub struct HostTrust {
    current: Mutex<Option<TrustSnapshot>>,
}

impl HostTrust {
    pub fn new() -> Self { Self::default() }

    pub fn update_certificates(&self, certificates: Vec<String>) -> Result<u64> {
        let mut roots = RootCertStore::empty();
        for (index, pem) in certificates.iter().enumerate() {
            let mut count = 0;
            for certificate in CertificateDer::pem_slice_iter(pem.as_bytes()) {
                let certificate = certificate.map_err(|_| Error::new("TLS_TRUST_INVALID", format!("Host trust certificate {index} is not valid PEM")))?;
                roots.add(certificate).map_err(|_| Error::new("TLS_TRUST_INVALID", format!("Host trust certificate {index} is not a supported certificate")))?;
                count += 1;
            }
            if count == 0 { return Err(Error::new("TLS_TRUST_INVALID", format!("Host trust certificate {index} contains no certificate"))); }
        }
        let mut current = self.current.lock().unwrap();
        let generation = current.as_ref().map_or(Some(1), |snapshot| snapshot.generation.checked_add(1))
            .ok_or_else(|| Error::new("TLS_TRUST_GENERATION", "Host trust generation is exhausted"))?;
        *current = Some(TrustSnapshot { generation, roots: Arc::new(roots) });
        Ok(generation)
    }

    pub fn snapshot(&self) -> Option<TrustSnapshot> { self.current.lock().unwrap().clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_trust_distinguishes_native_source_and_explicit_empty_and_preserves_failed_updates() {
        let trust = HostTrust::new();
        assert!(trust.snapshot().is_none());
        assert_eq!(trust.update_certificates(Vec::new()).unwrap(), 1);
        let first = trust.snapshot().unwrap();
        assert!(first.roots.is_empty());
        assert!(trust.update_certificates(vec!["invalid certificate".into()]).is_err());
        assert_eq!(trust.snapshot().unwrap().generation, 1);
        assert_eq!(trust.update_certificates(Vec::new()).unwrap(), 2);
        assert_eq!(first.generation, 1);
    }

}
