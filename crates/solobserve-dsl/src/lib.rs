use anyhow::{anyhow, Result};
use pest::Parser;
use pest_derive::Parser;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[cfg(feature = "wasm")]
mod wasm_export;

#[derive(Parser)]
#[grammar = "grammar.pest"]
struct DslParser;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileCtx {
    pub program_id: String,
    pub cluster: String,
    pub from_ms: i64,
    pub to_ms: i64,
    pub step_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledQuery {
    pub sql: String,
    pub params: BTreeMap<String, Value>,
    pub plan: ResultShape,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultShape {
    pub labels: Vec<String>,
    pub value_column: String,
    pub time_column: String,
}

pub fn parse(input: &str) -> Result<Value> {
    let mut parsed = DslParser::parse(Rule::query, input).map_err(|e| anyhow!(e.to_string()))?;
    let pair = parsed.next().ok_or_else(|| anyhow!("empty parse"))?;
    Ok(pair_to_json(&pair))
}

fn pair_to_json(pair: &pest::iterators::Pair<'_, Rule>) -> Value {
    json!({
        "rule": format!("{:?}", pair.as_rule()),
        "text": pair.as_str(),
        "children": pair.clone().into_inner().map(|p| pair_to_json(&p)).collect::<Vec<_>>(),
    })
}

pub fn compile(input: &str, ctx: &CompileCtx) -> Result<CompiledQuery> {
    let trimmed = input.trim();
    let _ = parse(trimmed)?;
    if trimmed.starts_with("event{") {
        return compile_event(trimmed, ctx);
    }
    if trimmed.starts_with("histogram_quantile(") {
        return compile_histogram_quantile(trimmed, ctx);
    }
    if trimmed.starts_with("topk(") {
        return compile_topk(trimmed, ctx);
    }
    compile_metric(trimmed, ctx)
}

fn compile_metric(input: &str, ctx: &CompileCtx) -> Result<CompiledQuery> {
    let metric = extract_metric_name(input)?;
    let table_expr = metric_table_expr(&metric)?;
    let value_expr = match metric.as_str() {
        "instruction_calls_total" => "countMerge(calls_state)",
        "errors_total" => "countMerge(errors_state)",
        "cpi_calls_total" => "countMerge(calls_state)",
        "signer_fees_lamports_total" => "sum(fee_lamports)",
        _ => "count()",
    };
    let rollback_clause = if table_expr == "transactions" {
        "AND signature NOT IN (SELECT signature FROM rollbacks)"
    } else {
        ""
    };
    let sql = format!(
        "SELECT minute AS t, {value_expr} AS v
         FROM {table_expr}
         WHERE program_id = {{program_id:String}}
           AND cluster = {{cluster:String}}
           AND minute >= toDateTime({{from_s:Int64}})
           AND minute <= toDateTime({{to_s:Int64}})
           {rollback_clause}
         GROUP BY t
         ORDER BY t"
    );
    Ok(CompiledQuery {
        sql,
        params: base_params(ctx),
        plan: ResultShape {
            labels: vec![],
            value_column: "v".to_string(),
            time_column: "t".to_string(),
        },
    })
}

fn compile_histogram_quantile(input: &str, ctx: &CompileCtx) -> Result<CompiledQuery> {
    // histogram_quantile(0.99, instruction_cu_consumed{...})
    let open = input
        .find('(')
        .ok_or_else(|| anyhow!("invalid function call"))?;
    let close = input
        .rfind(')')
        .ok_or_else(|| anyhow!("invalid function call"))?;
    let inner = &input[open + 1..close];
    let mut parts = inner.splitn(2, ',');
    let q = parts
        .next()
        .ok_or_else(|| anyhow!("missing quantile"))?
        .trim()
        .parse::<f64>()
        .map_err(|_| anyhow!("invalid quantile"))?;
    let metric_expr = parts
        .next()
        .ok_or_else(|| anyhow!("missing metric expression"))?
        .trim();
    let metric = extract_metric_name(metric_expr)?;
    if metric != "instruction_cu_consumed" {
        return Err(anyhow!(
            "histogram_quantile currently supports instruction_cu_consumed"
        ));
    }
    let sql = "SELECT minute AS t, quantileTDigestMerge({q:Float64})(cu_tdigest_state) AS v
               FROM metrics_instruction_calls_minute
               WHERE program_id = {program_id:String}
                 AND cluster = {cluster:String}
                 AND minute >= toDateTime({from_s:Int64})
                 AND minute <= toDateTime({to_s:Int64})
               GROUP BY t
               ORDER BY t"
        .to_string();
    let mut params = base_params(ctx);
    params.insert("q".to_string(), json!(q));
    Ok(CompiledQuery {
        sql,
        params,
        plan: ResultShape {
            labels: vec![],
            value_column: "v".to_string(),
            time_column: "t".to_string(),
        },
    })
}

fn compile_topk(_input: &str, ctx: &CompileCtx) -> Result<CompiledQuery> {
    // topk(k, sum by (signer) (signer_fees_lamports_total))
    let sql = "SELECT signer, sum(fee_lamports) AS v
               FROM transactions
               WHERE program_id = {program_id:String}
                 AND cluster = {cluster:String}
                 AND block_time >= toDateTime({from_s:Int64})
                 AND block_time <= toDateTime({to_s:Int64})
                 AND signature NOT IN (SELECT signature FROM rollbacks)
               GROUP BY signer
               ORDER BY v DESC
               LIMIT 10"
        .to_string();
    Ok(CompiledQuery {
        sql,
        params: base_params(ctx),
        plan: ResultShape {
            labels: vec!["signer".to_string()],
            value_column: "v".to_string(),
            time_column: "t".to_string(),
        },
    })
}

fn compile_event(input: &str, ctx: &CompileCtx) -> Result<CompiledQuery> {
    // event{type="TradeExecuted", amount > 1000}
    let body = input
        .strip_prefix("event{")
        .and_then(|s| s.strip_suffix('}'))
        .ok_or_else(|| anyhow!("invalid event selector"))?;
    let mut event_name = String::new();
    let mut predicate_sql = String::new();
    let mut params = base_params(ctx);
    for (idx, term) in body.split(',').enumerate() {
        let t = term.trim();
        if t.starts_with("type=") {
            let value = t.trim_start_matches("type=").trim().trim_matches('"');
            event_name = value.to_string();
            params.insert("event_type".to_string(), json!(value));
            continue;
        }
        for op in [">=", "<=", "!=", "==", ">", "<"] {
            if let Some((lhs, rhs)) = t.split_once(op) {
                let key = lhs.trim().trim_start_matches("payload.");
                let rhs_value = rhs.trim().replace('_', "");
                let p = format!("event_pred_{idx}");
                predicate_sql =
                    format!(" AND JSONExtractFloat(payload_json, '{key}') {op} {{{p}:Float64}}");
                params.insert(p, json!(rhs_value.parse::<f64>()?));
                break;
            }
        }
    }
    let sql = format!(
        "SELECT block_time AS t, 1.0 AS v
         FROM events
         WHERE program_id = {{program_id:String}}
           AND cluster = {{cluster:String}}
           AND event_name = {{event_type:String}}
           AND block_time >= toDateTime({{from_s:Int64}})
           AND block_time <= toDateTime({{to_s:Int64}})
           AND signature NOT IN (SELECT signature FROM rollbacks)
           {predicate_sql}
         ORDER BY t"
    );
    if event_name.is_empty() {
        return Err(anyhow!("event type label is required"));
    }
    Ok(CompiledQuery {
        sql,
        params,
        plan: ResultShape {
            labels: vec!["event_name".to_string()],
            value_column: "v".to_string(),
            time_column: "t".to_string(),
        },
    })
}

fn extract_metric_name(expr: &str) -> Result<String> {
    let mut s = expr.trim();
    for f in ["rate(", "irate(", "increase("] {
        if s.starts_with(f) {
            s = s.trim_start_matches(f);
            s = s.trim_end_matches(')');
            break;
        }
    }
    let metric = s
        .split(['{', '[', ' ', ')'])
        .next()
        .ok_or_else(|| anyhow!("invalid metric expression"))?;
    if metric.is_empty() {
        return Err(anyhow!("missing metric name"));
    }
    Ok(metric.to_string())
}

fn metric_table_expr(metric: &str) -> Result<&'static str> {
    match metric {
        "instruction_calls_total" | "instruction_cu_consumed" => {
            Ok("metrics_instruction_calls_minute")
        }
        "errors_total" => Ok("metrics_errors_minute"),
        "cpi_calls_total" => Ok("metrics_cpi_minute"),
        "signer_fees_lamports_total" => Ok("transactions"),
        _ => Err(anyhow!("unknown metric: {metric}")),
    }
}

fn base_params(ctx: &CompileCtx) -> BTreeMap<String, Value> {
    let mut m = BTreeMap::new();
    m.insert("program_id".to_string(), json!(ctx.program_id));
    m.insert("cluster".to_string(), json!(ctx.cluster));
    m.insert("from_s".to_string(), json!(ctx.from_ms / 1000));
    m.insert("to_s".to_string(), json!(ctx.to_ms / 1000));
    m.insert("step_ms".to_string(), json!(ctx.step_ms));
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> CompileCtx {
        CompileCtx {
            program_id: "P".into(),
            cluster: "devnet".into(),
            from_ms: 0,
            to_ms: 10_000,
            step_ms: 30_000,
        }
    }

    #[test]
    fn parses_metric_selector() {
        let ast = parse(r#"instruction_calls_total{instruction="swap"}[5m]"#).expect("parse");
        assert!(ast.to_string().contains("instruction_calls_total"));
    }

    #[test]
    fn compiles_histogram_quantile() {
        let q = compile(
            "histogram_quantile(0.99, instruction_cu_consumed{instruction=\"swap\"})",
            &ctx(),
        )
        .expect("compile");
        assert!(q.sql.contains("quantileTDigestMerge"));
    }
}
