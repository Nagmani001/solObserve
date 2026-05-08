//! Worked example: an escrow lifecycle (create → release → dispute) with
//! per-stage spans and events.

use borsh::BorshSerialize;
use solobserve_sdk::{event, metric, span_end, span_start, SpanStatus};

#[derive(BorshSerialize)]
struct EscrowAction {
    id: u64,
    actor: String,
}

fn create(id: u64, actor: &str) {
    let s = span_start!("escrow_create");
    metric!("escrows_total", 1);
    event!(
        "EscrowCreated",
        &EscrowAction {
            id,
            actor: actor.into(),
        }
    );
    span_end!(s, SpanStatus::Ok);
}

fn release(id: u64, actor: &str) {
    let s = span_start!("escrow_release");
    event!(
        "EscrowReleased",
        &EscrowAction {
            id,
            actor: actor.into(),
        }
    );
    span_end!(s, SpanStatus::Ok);
}

fn main() {
    create(1, "Alice");
    release(1, "Alice");
}
