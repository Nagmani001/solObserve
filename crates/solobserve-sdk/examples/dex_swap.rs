//! Worked example: a tiny DEX `swap` instruction instrumented with
//! `#[observed]` and a custom `TradeExecuted` event.
//!
//! Run with `cargo run --example dex_swap -p solobserve-sdk`. Output lines
//! starting with `Program log: __SOBS__:` are what the on-chain `msg!()` would
//! produce; the decoder service parses them into typed rows.

use borsh::BorshSerialize;
use solobserve_sdk::{event, metric, span_end, span_start, SpanStatus};

#[derive(BorshSerialize)]
struct TradeExecuted {
    pair: String,
    side: u8, // 0 = buy, 1 = sell
    size: u64,
    price: u64,
}

fn swap(amount: u64, side: u8) -> Result<(), &'static str> {
    let span = span_start!("swap");
    metric!("swap_count", 1, [("side", if side == 0 { "buy" } else { "sell" })]);
    event!(
        "TradeExecuted",
        &TradeExecuted {
            pair: "SOL-USDC".into(),
            side,
            size: amount,
            price: 14237,
        },
        [("source", "user")]
    );
    let status = if amount == 0 {
        SpanStatus::Err
    } else {
        SpanStatus::Ok
    };
    span_end!(span, status);
    if amount == 0 {
        Err("zero amount")
    } else {
        Ok(())
    }
}

fn main() {
    let _ = swap(1_000_000, 0);
    let _ = swap(0, 1);
}
