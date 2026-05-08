//! `solobserve-local` — one-command local dev mode for the full stack.
//!
//! Usage:
//! ```text
//! solobserve-local --program ./path/to/Anchor.toml
//! solobserve-local --skip-validator
//! ```
//!
//! Responsibilities:
//! 1. Bring up the data plane (`docker compose -f infra/local-compose.yml up -d`).
//! 2. Spawn `solana-test-validator` (unless `--skip-validator`).
//! 3. Spawn the Rust services (ingestor, decoder, alerter, replay,
//!    metrics-scraper, error-grouper).
//! 4. Spawn the Express backend + Next.js web app via `pnpm`.
//! 5. Open the browser at `http://localhost:7777`.

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::{Child, Command};
use tokio::signal;

#[derive(Parser, Debug)]
#[command(version, about = "SolObserve local dev mode", long_about = None)]
struct Args {
    /// Path to the Anchor.toml of the program to register on boot.
    #[arg(long)]
    program: Option<PathBuf>,
    /// Skip starting `solana-test-validator` (use an external one).
    #[arg(long, default_value_t = false)]
    skip_validator: bool,
    /// Skip docker compose (assume infra is already running).
    #[arg(long, default_value_t = false)]
    skip_infra: bool,
    /// Port to serve the web UI on.
    #[arg(long, default_value_t = 7777)]
    port: u16,
    /// Open the browser when the stack is up.
    #[arg(long, default_value_t = true)]
    open_browser: bool,
    /// Project root (defaults to current dir).
    #[arg(long)]
    root: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let args = Args::parse();

    let root = match &args.root {
        Some(p) => p.clone(),
        None => std::env::current_dir().context("cwd")?,
    };
    tracing::info!(root = %root.display(), "starting solobserve-local");

    let mut children: Vec<Child> = Vec::new();

    if !args.skip_infra {
        let compose = root.join("infra/local-compose.yml");
        if compose.exists() {
            tracing::info!("starting infra via docker compose");
            let status = Command::new("docker")
                .args([
                    "compose",
                    "-f",
                    compose.to_str().unwrap(),
                    "up",
                    "-d",
                ])
                .current_dir(&root)
                .status()
                .await
                .context("docker compose")?;
            if !status.success() {
                anyhow::bail!("docker compose failed");
            }
        } else {
            tracing::warn!(path = %compose.display(), "local-compose.yml not found — skipping infra");
        }
    }

    if !args.skip_validator {
        match Command::new("solana-test-validator")
            .args(["--quiet", "--reset"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => children.push(c),
            Err(e) => tracing::warn!(error = ?e, "solana-test-validator not available — continuing"),
        }
    }

    // Rust services
    for svc in [
        "ingestor",
        "decoder",
        "alerter",
        "metrics-scraper",
        "error-grouper",
        "replay",
    ] {
        match Command::new("cargo")
            .args(["run", "--release", "-p", svc])
            .current_dir(&root)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
        {
            Ok(c) => children.push(c),
            Err(e) => tracing::warn!(svc, error = ?e, "failed to spawn service"),
        }
    }

    // Express + Next.js via pnpm dev
    let pnpm = Command::new("pnpm")
        .args(["dev"])
        .current_dir(&root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .env("PORT", args.port.to_string())
        .spawn();
    match pnpm {
        Ok(c) => children.push(c),
        Err(e) => tracing::warn!(error = ?e, "failed to spawn pnpm dev"),
    }

    if args.open_browser {
        let url = format!("http://localhost:{}", args.port);
        let _ = Command::new("xdg-open").arg(&url).spawn();
    }

    tracing::info!(port = args.port, "stack up. ctrl-c to stop.");
    signal::ctrl_c().await.context("ctrl_c")?;
    tracing::info!("shutting down");
    for mut c in children {
        let _ = c.start_kill();
    }
    Ok(())
}
