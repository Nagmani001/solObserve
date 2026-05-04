use anyhow::{anyhow, Context, Result};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use futures::{SinkExt, StreamExt};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogsNotification {
    pub signature: String,
    pub slot: u64,
    pub commitment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignatureInfo {
    pub signature: String,
    pub slot: u64,
    pub block_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignatureStatus {
    pub slot: u64,
    pub confirmation_status: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RpcEndpoint {
    pub http_url: String,
    pub rate_limit_rps: u32,
}

#[derive(Debug)]
struct EndpointHealth {
    errors: u32,
    calls: u32,
    latency_ema_ms: f64,
    last_error: Option<Instant>,
}

#[derive(Debug)]
struct RateLimiter {
    tokens: f64,
    last_refill: Instant,
    capacity: f64,
    refill_per_sec: f64,
}

impl RateLimiter {
    fn new(rps: u32) -> Self {
        let c = rps.max(1) as f64;
        Self {
            tokens: c,
            last_refill: Instant::now(),
            capacity: c,
            refill_per_sec: c,
        }
    }

    async fn acquire(&mut self) {
        loop {
            let now = Instant::now();
            let elapsed = now.duration_since(self.last_refill).as_secs_f64();
            self.last_refill = now;
            self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
            if self.tokens >= 1.0 {
                self.tokens -= 1.0;
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

#[derive(Clone)]
pub struct SolanaRpcClient {
    http: reqwest::Client,
    endpoints: Arc<Vec<RpcEndpoint>>,
    health: Arc<Mutex<HashMap<String, EndpointHealth>>>,
    limiters: Arc<Mutex<HashMap<String, RateLimiter>>>,
}

impl SolanaRpcClient {
    pub fn new(endpoints: Vec<RpcEndpoint>) -> Result<Self> {
        if endpoints.is_empty() {
            return Err(anyhow!("at least one RPC endpoint is required"));
        }
        let mut health = HashMap::new();
        let mut limiters = HashMap::new();
        for ep in &endpoints {
            health.insert(
                ep.http_url.clone(),
                EndpointHealth {
                    errors: 0,
                    calls: 0,
                    latency_ema_ms: 50.0,
                    last_error: None,
                },
            );
            limiters.insert(ep.http_url.clone(), RateLimiter::new(ep.rate_limit_rps));
        }
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .context("build reqwest client")?,
            endpoints: Arc::new(endpoints),
            health: Arc::new(Mutex::new(health)),
            limiters: Arc::new(Mutex::new(limiters)),
        })
    }

    async fn choose_endpoint(&self) -> RpcEndpoint {
        let health = self.health.lock().await;
        let mut best = self.endpoints[0].clone();
        let mut best_score = f64::MAX;
        for ep in self.endpoints.iter() {
            if let Some(h) = health.get(&ep.http_url) {
                let er = if h.calls == 0 {
                    0.0
                } else {
                    h.errors as f64 / h.calls as f64
                };
                let recent_penalty = h
                    .last_error
                    .map(|t| {
                        if t.elapsed() < Duration::from_secs(5) {
                            0.7
                        } else {
                            0.0
                        }
                    })
                    .unwrap_or(0.0);
                let score = er + (h.latency_ema_ms / 1000.0) + recent_penalty;
                if score < best_score {
                    best_score = score;
                    best = ep.clone();
                }
            }
        }
        best
    }

    async fn record_result(&self, endpoint: &str, ok: bool, latency: Duration) {
        let mut h = self.health.lock().await;
        if let Some(v) = h.get_mut(endpoint) {
            v.calls += 1;
            if !ok {
                v.errors += 1;
                v.last_error = Some(Instant::now());
            }
            let sample = latency.as_millis() as f64;
            v.latency_ema_ms = (v.latency_ema_ms * 0.8) + (sample * 0.2);
        }
    }

    /// Snapshot of per-endpoint (calls, errors) counters for metrics scraping.
    pub async fn health_snapshot(&self) -> Vec<(String, u64, u64)> {
        let h = self.health.lock().await;
        self.endpoints
            .iter()
            .map(|ep| {
                let (c, e) = h
                    .get(&ep.http_url)
                    .map(|v| (v.calls as u64, v.errors as u64))
                    .unwrap_or((0, 0));
                (ep.http_url.clone(), c, e)
            })
            .collect()
    }

    async fn rpc_call_with_source(&self, method: &str, params: Value) -> Result<(Value, String)> {
        let mut retries = 0u32;
        let mut delay = Duration::from_millis(200);
        loop {
            let ep = self.choose_endpoint().await;
            {
                let mut limiters = self.limiters.lock().await;
                if let Some(l) = limiters.get_mut(&ep.http_url) {
                    l.acquire().await;
                }
            }
            let started = Instant::now();
            let body = json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": params,
            });
            let resp = self.http.post(&ep.http_url).json(&body).send().await;
            match resp {
                Ok(r) => {
                    let status = r.status();
                    let txt = r.text().await.unwrap_or_default();
                    if status.as_u16() == 429 || status.as_u16() == 503 {
                        self.record_result(&ep.http_url, false, started.elapsed())
                            .await;
                        if retries < 5 {
                            let jitter = rand::thread_rng().gen_range(0..150);
                            tokio::time::sleep(delay + Duration::from_millis(jitter)).await;
                            delay = (delay * 2).min(Duration::from_secs(30));
                            retries += 1;
                            continue;
                        }
                        return Err(anyhow!("rpc throttled: {}", status));
                    }
                    if !status.is_success() {
                        self.record_result(&ep.http_url, false, started.elapsed())
                            .await;
                        return Err(anyhow!("rpc error {} {}", status, txt));
                    }
                    let parsed: Value = serde_json::from_str(&txt).context("decode rpc json")?;
                    if parsed.get("error").is_some() {
                        self.record_result(&ep.http_url, false, started.elapsed())
                            .await;
                        if retries < 5 {
                            let jitter = rand::thread_rng().gen_range(0..150);
                            tokio::time::sleep(delay + Duration::from_millis(jitter)).await;
                            delay = (delay * 2).min(Duration::from_secs(30));
                            retries += 1;
                            continue;
                        }
                        return Err(anyhow!("rpc response error: {}", parsed["error"]));
                    }
                    self.record_result(&ep.http_url, true, started.elapsed())
                        .await;
                    return Ok((parsed["result"].clone(), ep.http_url.clone()));
                }
                Err(e) => {
                    self.record_result(&ep.http_url, false, started.elapsed())
                        .await;
                    if retries < 5 {
                        let jitter = rand::thread_rng().gen_range(0..150);
                        tokio::time::sleep(delay + Duration::from_millis(jitter)).await;
                        delay = (delay * 2).min(Duration::from_secs(30));
                        retries += 1;
                        continue;
                    }
                    return Err(anyhow!(e)).context("rpc network error");
                }
            }
        }
    }

    async fn rpc_call(&self, method: &str, params: Value) -> Result<Value> {
        let (v, _) = self.rpc_call_with_source(method, params).await?;
        Ok(v)
    }

    pub async fn get_transaction(&self, signature: &str, commitment: &str) -> Result<Value> {
        self.rpc_call(
            "getTransaction",
            json!([
                signature,
                {
                    "encoding": "json",
                    "commitment": commitment,
                    "maxSupportedTransactionVersion": 0
                }
            ]),
        )
        .await
    }

    pub async fn get_transaction_with_source(
        &self,
        signature: &str,
        commitment: &str,
    ) -> Result<(Value, String)> {
        self.rpc_call_with_source(
            "getTransaction",
            json!([
                signature,
                {
                    "encoding": "json",
                    "commitment": commitment,
                    "maxSupportedTransactionVersion": 0
                }
            ]),
        )
        .await
    }

    pub async fn get_signatures_for_address(
        &self,
        program_id: &str,
        before: Option<&str>,
        until: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SignatureInfo>> {
        let mut cfg = json!({ "limit": limit.min(1000) });
        if let Some(v) = before {
            cfg["before"] = Value::String(v.to_string());
        }
        if let Some(v) = until {
            cfg["until"] = Value::String(v.to_string());
        }
        let v = self
            .rpc_call("getSignaturesForAddress", json!([program_id, cfg]))
            .await?;
        let mut out = Vec::new();
        for row in v.as_array().cloned().unwrap_or_default() {
            if let (Some(sig), Some(slot)) = (
                row.get("signature").and_then(|x| x.as_str()),
                row.get("slot").and_then(|x| x.as_u64()),
            ) {
                out.push(SignatureInfo {
                    signature: sig.to_string(),
                    slot,
                    block_time: row.get("blockTime").and_then(|x| x.as_i64()),
                });
            }
        }
        Ok(out)
    }

    pub async fn get_signature_statuses(
        &self,
        signatures: &[String],
    ) -> Result<Vec<Option<SignatureStatus>>> {
        let v = self
            .rpc_call(
                "getSignatureStatuses",
                json!([signatures, { "searchTransactionHistory": true }]),
            )
            .await?;
        let arr = v
            .get("value")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::with_capacity(arr.len());
        for row in arr {
            if row.is_null() {
                out.push(None);
                continue;
            }
            out.push(Some(SignatureStatus {
                slot: row.get("slot").and_then(|x| x.as_u64()).unwrap_or(0),
                confirmation_status: row
                    .get("confirmationStatus")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
            }));
        }
        Ok(out)
    }

    pub async fn get_slot(&self) -> Result<u64> {
        let v = self.rpc_call("getSlot", json!([])).await?;
        v.as_u64().ok_or_else(|| anyhow!("invalid slot response"))
    }

    pub async fn get_block_time(&self, slot: u64) -> Result<Option<i64>> {
        let v = self.rpc_call("getBlockTime", json!([slot])).await?;
        Ok(v.as_i64())
    }

    pub async fn get_account_info(&self, account: &str, commitment: &str) -> Result<Value> {
        self.rpc_call(
            "getAccountInfo",
            json!([account, { "encoding": "base64", "commitment": commitment }]),
        )
        .await
    }

    /// Free-tier friendly fallback: poll signatures and emit synthetic log notifications.
    pub async fn poll_logs_like(
        &self,
        program_id: String,
        commitment: String,
        seen: Arc<Mutex<VecDeque<String>>>,
    ) -> Result<Vec<LogsNotification>> {
        let rows = self
            .get_signatures_for_address(&program_id, None, None, 100)
            .await?;
        let mut out = Vec::new();
        let mut seen_lock = seen.lock().await;
        for row in rows {
            if seen_lock.iter().any(|s| s == &row.signature) {
                continue;
            }
            out.push(LogsNotification {
                signature: row.signature.clone(),
                slot: row.slot,
                commitment: commitment.clone(),
            });
            seen_lock.push_back(row.signature);
            if seen_lock.len() > 10_000 {
                seen_lock.pop_front();
            }
        }
        Ok(out)
    }

    pub async fn logs_subscribe(
        &self,
        program_id: String,
        commitment: String,
    ) -> Result<mpsc::Receiver<LogsNotification>> {
        let ep = self.choose_endpoint().await;
        let ws_url = if ep.http_url.starts_with("https://") {
            ep.http_url.replacen("https://", "wss://", 1)
        } else if ep.http_url.starts_with("http://") {
            ep.http_url.replacen("http://", "ws://", 1)
        } else {
            ep.http_url.clone()
        };
        let (ws, _) = tokio_tungstenite::connect_async(&ws_url).await?;
        let (mut write, mut read) = ws.split();
        let subscribe = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "logsSubscribe",
            "params": [
                { "mentions": [program_id] },
                { "commitment": commitment }
            ]
        });
        write
            .send(Message::Text(subscribe.to_string()))
            .await
            .context("logsSubscribe send")?;
        let (tx, rx) = mpsc::channel(512);
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                let Ok(msg) = msg else { break };
                let Message::Text(txt) = msg else { continue };
                let Ok(v): Result<Value, _> = serde_json::from_str(&txt) else {
                    continue;
                };
                if v.get("method").and_then(|m| m.as_str()) != Some("logsNotification") {
                    continue;
                }
                let sig = v
                    .pointer("/params/result/value/signature")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string();
                let slot = v
                    .pointer("/params/result/context/slot")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                if sig.is_empty() {
                    continue;
                }
                let _ = tx
                    .send(LogsNotification {
                        signature: sig,
                        slot,
                        commitment: "processed".to_string(),
                    })
                    .await;
            }
        });
        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rate_limiter_waits_when_empty() {
        let mut rl = RateLimiter::new(1);
        rl.acquire().await;
        let start = Instant::now();
        rl.acquire().await;
        assert!(start.elapsed() >= Duration::from_millis(800));
    }

    #[tokio::test]
    async fn endpoint_choice_prefers_lower_error_and_latency() {
        let client = SolanaRpcClient::new(vec![
            RpcEndpoint {
                http_url: "http://a".to_string(),
                rate_limit_rps: 10,
            },
            RpcEndpoint {
                http_url: "http://b".to_string(),
                rate_limit_rps: 10,
            },
        ])
        .expect("client");

        {
            let mut h = client.health.lock().await;
            if let Some(a) = h.get_mut("http://a") {
                a.calls = 10;
                a.errors = 6;
                a.latency_ema_ms = 300.0;
            }
            if let Some(b) = h.get_mut("http://b") {
                b.calls = 10;
                b.errors = 0;
                b.latency_ema_ms = 50.0;
            }
        }
        let chosen = client.choose_endpoint().await;
        assert_eq!(chosen.http_url, "http://b");
    }
}
