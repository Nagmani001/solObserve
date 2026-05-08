//! Worked example: a `liquidate` instruction that emits an event when the
//! `collateral_amount` field of the position account changes (the proc-macro
//! `#[track_account(field = "collateral_amount")]` is the sugar — this raw
//! version makes the wire effect explicit).

use borsh::BorshSerialize;
use solobserve_sdk::{event, metric, span_end, span_start, SpanStatus};

#[derive(BorshSerialize)]
struct CollateralChanged {
    position: String,
    before: u64,
    after: u64,
}

fn liquidate(position: &str, collateral_before: u64, collateral_after: u64) {
    let span = span_start!("liquidate");
    metric!("liquidations_total", 1);
    if collateral_before != collateral_after {
        event!(
            "account.field_changed",
            &CollateralChanged {
                position: position.into(),
                before: collateral_before,
                after: collateral_after,
            },
            [("field", "collateral_amount")]
        );
    }
    span_end!(span, SpanStatus::Ok);
}

fn main() {
    liquidate("Pos11111", 1_000_000, 250_000);
}
