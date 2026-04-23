use sha2::{Digest, Sha256};

/// Anchor discriminators: `sha256("{prefix}:{name}")[..8]`
pub fn anchor_discriminator(prefix: &str, name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(prefix.as_bytes());
    hasher.update(b":");
    hasher.update(name.as_bytes());
    let out = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&out[..8]);
    disc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_initialize_stable() {
        let d = anchor_discriminator("global", "initialize");
        assert_eq!(hex::encode(d), "afaf6d1f0d989bed");
    }
}
