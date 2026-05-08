//! Attribute macros for instrumenting Anchor programs.
//!
//! - `#[observed]` on an instruction handler: wraps the body in
//!   `span_start!` / `span_end!` calls.
//! - `#[track_account(field = "...")]` on an account struct field: emits an
//!   `event!` when the named field changes between entry and exit.
//!
//! The macros expand to plain Rust that calls into `solobserve-sdk`. The
//! consuming crate must depend on `solobserve-sdk` and re-export it as
//! `::solobserve_sdk` (default crate name).

use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, ItemFn, LitStr};

/// `#[observed]` — wrap an `fn` body with a SolObserve span.
///
/// ```ignore
/// #[observed]
/// pub fn swap(ctx: Context<Swap>, amount: u64) -> Result<()> { ... }
/// ```
#[proc_macro_attribute]
pub fn observed(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as ItemFn);
    let ItemFn {
        attrs,
        vis,
        sig,
        block,
    } = input;
    let name = sig.ident.to_string();
    let name_lit = LitStr::new(&name, proc_macro2::Span::call_site());
    let stmts = &block.stmts;

    let expanded = quote! {
        #(#attrs)*
        #vis #sig {
            let __sobs_span_id = ::solobserve_sdk::span_start!(#name_lit);
            // Drop-guard so panics still close the span as Panic.
            struct __SobsSpanGuard(u64, bool);
            impl Drop for __SobsSpanGuard {
                fn drop(&mut self) {
                    if !self.1 {
                        ::solobserve_sdk::span_end!(
                            self.0,
                            ::solobserve_sdk::SpanStatus::Panic
                        );
                    }
                }
            }
            let mut __sobs_guard = __SobsSpanGuard(__sobs_span_id, false);
            let __sobs_result = (|| { #(#stmts)* })();
            __sobs_guard.1 = true;
            let __sobs_status = if __sobs_is_err(&__sobs_result) {
                ::solobserve_sdk::SpanStatus::Err
            } else {
                ::solobserve_sdk::SpanStatus::Ok
            };
            ::solobserve_sdk::span_end!(__sobs_span_id, __sobs_status);
            __sobs_result
        }
    };

    // Inject a tiny helper that decides whether the return value is an Err.
    // We do this via a free fn defined at the call site so it is generic over
    // `Result<T,E>` without leaking trait bounds into the macro.
    let helper = quote! {
        fn __sobs_is_err<T, E>(r: &core::result::Result<T, E>) -> bool {
            r.is_err()
        }
    };

    TokenStream::from(quote! {
        #helper
        #expanded
    })
}

/// `#[track_account(field = "...")]` — placeholder attribute.
///
/// In v1 this is recognized by the proc-macro layer but emits nothing on its
/// own; the developer is expected to call [`solobserve_sdk::event!`] in their
/// Anchor `exit` hook (see crate docs for the worked example). A future
/// version will fully wire this via Anchor's `Accounts` derive.
#[proc_macro_attribute]
pub fn track_account(_attr: TokenStream, item: TokenStream) -> TokenStream {
    item
}
