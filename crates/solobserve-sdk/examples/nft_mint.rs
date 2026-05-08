//! Worked example: NFT mint with a span + counter + per-mint event.

use borsh::BorshSerialize;
use solobserve_sdk::{event, metric, span_end, span_start, SpanStatus};

#[derive(BorshSerialize)]
struct MintEvent {
    mint: String,
    edition: u64,
}

fn mint(edition: u64) {
    let span = span_start!("mint_nft");
    metric!("nft_mints_total", 1);
    event!(
        "MintExecuted",
        &MintEvent {
            mint: format!("Mint{:08}", edition),
            edition,
        }
    );
    span_end!(span, SpanStatus::Ok);
}

fn main() {
    for i in 0..3 {
        mint(i);
    }
}
