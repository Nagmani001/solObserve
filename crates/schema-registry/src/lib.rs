use anyhow::Result;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::warn;

#[derive(Debug, Clone)]
pub struct ProgramSchemaVersion {
    pub version: i32,
    pub parsed_json: Value,
    pub created_at_unix: i64,
    pub schema_hash: String,
}

#[derive(Debug, Clone, Default)]
pub struct SchemaRegistry {
    inner: Arc<RwLock<HashMap<String, Vec<ProgramSchemaVersion>>>>,
}

impl SchemaRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn refresh_from_postgres(&self, pg: &PgPool) -> Result<()> {
        let rows = sqlx::query(
            r#"
            SELECT p.program_id, i.version, i.parsed_json, EXTRACT(EPOCH FROM i.created_at)::bigint as created_unix
            FROM idls i
            JOIN programs p ON p.id = i.program_id_fk
            ORDER BY p.program_id, i.version
            "#,
        )
        .fetch_all(pg)
        .await?;

        let mut map: HashMap<String, Vec<ProgramSchemaVersion>> = HashMap::new();
        for row in rows {
            let program_id: String = row.try_get("program_id")?;
            let version: i32 = row.try_get("version")?;
            let parsed_json: Value = row.try_get("parsed_json")?;
            let created_at_unix: i64 = row.try_get("created_unix")?;
            let schema_hash = {
                let mut h = Sha256::new();
                h.update(serde_json::to_vec(&parsed_json)?);
                format!("{:x}", h.finalize())
            };
            map.entry(program_id)
                .or_default()
                .push(ProgramSchemaVersion {
                    version,
                    parsed_json,
                    created_at_unix,
                    schema_hash,
                });
        }
        *self.inner.write().await = map;
        Ok(())
    }

    pub async fn refresh_program_from_postgres(&self, pg: &PgPool, program_id: &str) -> Result<()> {
        let rows = sqlx::query(
            r#"
            SELECT p.program_id, i.version, i.parsed_json, EXTRACT(EPOCH FROM i.created_at)::bigint as created_unix
            FROM idls i
            JOIN programs p ON p.id = i.program_id_fk
            WHERE p.program_id = $1
            ORDER BY i.version
            "#,
        )
        .bind(program_id)
        .fetch_all(pg)
        .await?;

        let mut versions = Vec::new();
        for row in rows {
            let parsed_json: Value = row.try_get("parsed_json")?;
            let schema_hash = {
                let mut h = Sha256::new();
                h.update(serde_json::to_vec(&parsed_json)?);
                format!("{:x}", h.finalize())
            };
            versions.push(ProgramSchemaVersion {
                version: row.try_get("version")?,
                parsed_json,
                created_at_unix: row.try_get("created_unix")?,
                schema_hash,
            });
        }
        self.inner
            .write()
            .await
            .insert(program_id.to_string(), versions);
        Ok(())
    }

    pub async fn resolve_for_slot(
        &self,
        program_id: &str,
        block_time_unix: Option<i64>,
    ) -> Option<ProgramSchemaVersion> {
        let lock = self.inner.read().await;
        let versions = lock.get(program_id)?;
        if versions.is_empty() {
            return None;
        }
        // v1 policy (plan 4): oldest applies before first upload timestamp, otherwise latest <= tx time.
        if let Some(bt) = block_time_unix {
            let mut chosen = versions.first().cloned();
            for v in versions {
                if v.created_at_unix <= bt {
                    chosen = Some(v.clone());
                }
            }
            return chosen;
        }
        versions.last().cloned()
    }

    pub async fn start_listener(self, pg: PgPool, pg_url: String) {
        tokio::spawn(async move {
            let mut listener = match sqlx::postgres::PgListener::connect(&pg_url).await {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = ?e, "schema registry LISTEN connect failed; fallback refresh loop");
                    loop {
                        if let Err(e) = self.refresh_from_postgres(&pg).await {
                            warn!(error = ?e, "schema registry refresh failed");
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                }
            };
            if let Err(e) = listener.listen("idl_updated").await {
                warn!(error = ?e, "schema registry LISTEN subscribe failed");
            }
            loop {
                match listener.recv().await {
                    Ok(note) => {
                        let payload = note.payload().trim().to_string();
                        if payload.is_empty() {
                            if let Err(e) = self.refresh_from_postgres(&pg).await {
                                warn!(error = ?e, "schema registry full refresh failed");
                            }
                        } else if let Err(e) =
                            self.refresh_program_from_postgres(&pg, &payload).await
                        {
                            warn!(error = ?e, program_id = %payload, "schema registry targeted refresh failed");
                        }
                    }
                    Err(e) => {
                        warn!(error = ?e, "schema registry LISTEN recv failed");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                }
            }
        });
    }
}
