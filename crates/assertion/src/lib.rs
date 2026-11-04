//! Verifies the gateway's signed assertion. It says who the caller is, never what they may do.
//! Only EdDSA over Ed25519 is accepted, and keys are selected by `kid` so the gateway can rotate them.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use std::collections::HashMap;

pub const AUDIENCE: &str = "podster-api";
pub const MAX_LIFETIME_SECS: i64 = 60;
pub const CLOCK_SKEW_SECS: i64 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Agent,
    Person,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Identity {
    pub sub: String,
    pub kind: Kind,
    pub org: String,
    pub gen: Option<u64>,
    pub jti: String,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AssertionError {
    Malformed,
    UnsupportedAlgorithm,
    UnknownKey,
    BadSignature,
    WrongAudience,
    Expired,
    NotYetValid,
    LifetimeTooLong,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: Option<String>,
}

#[derive(Deserialize)]
struct Audience {
    aud: String,
}

#[derive(Default)]
pub struct KeySet(HashMap<String, VerifyingKey>);

impl KeySet {
    /// Parses a JSON object of `kid` to base64url public key.
    pub fn from_json(json: &str) -> Result<KeySet, AssertionError> {
        let raw: HashMap<String, String> =
            serde_json::from_str(json).map_err(|_| AssertionError::Malformed)?;
        let mut keys = HashMap::new();
        for (kid, encoded) in raw {
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| AssertionError::Malformed)?;
            let bytes: [u8; 32] = bytes.try_into().map_err(|_| AssertionError::Malformed)?;
            keys.insert(
                kid,
                VerifyingKey::from_bytes(&bytes).map_err(|_| AssertionError::Malformed)?,
            );
        }
        Ok(KeySet(keys))
    }
}

/// Verifies a compact JWS and its claims. `now` is seconds since the epoch.
pub fn verify(token: &str, keys: &KeySet, now: i64) -> Result<Identity, AssertionError> {
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(AssertionError::Malformed);
    };
    let decode = |part: &str| {
        URL_SAFE_NO_PAD
            .decode(part)
            .map_err(|_| AssertionError::Malformed)
    };

    let parsed: Header =
        serde_json::from_slice(&decode(header)?).map_err(|_| AssertionError::Malformed)?;
    if parsed.alg != "EdDSA" {
        return Err(AssertionError::UnsupportedAlgorithm);
    }
    let key = parsed
        .kid
        .and_then(|kid| keys.0.get(&kid).copied())
        .ok_or(AssertionError::UnknownKey)?;

    let signature: [u8; 64] = decode(signature)?
        .try_into()
        .map_err(|_| AssertionError::Malformed)?;
    let message = format!("{header}.{payload}");
    key.verify_strict(message.as_bytes(), &Signature::from_bytes(&signature))
        .map_err(|_| AssertionError::BadSignature)?;

    // Claims are only read after the signature checks out.
    let claims = decode(payload)?;
    let audience: Audience =
        serde_json::from_slice(&claims).map_err(|_| AssertionError::Malformed)?;
    if audience.aud != AUDIENCE {
        return Err(AssertionError::WrongAudience);
    }
    let identity: Identity =
        serde_json::from_slice(&claims).map_err(|_| AssertionError::Malformed)?;
    if identity.sub.is_empty() || identity.org.is_empty() || identity.jti.is_empty() {
        return Err(AssertionError::Malformed);
    }
    if identity.exp.saturating_sub(identity.iat) > MAX_LIFETIME_SECS {
        return Err(AssertionError::LifetimeTooLong);
    }
    if now >= identity.exp.saturating_add(CLOCK_SKEW_SECS) {
        return Err(AssertionError::Expired);
    }
    if identity.iat > now.saturating_add(CLOCK_SKEW_SECS) {
        return Err(AssertionError::NotYetValid);
    }
    Ok(identity)
}
