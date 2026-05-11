use anyhow::{anyhow, Result};
use pest::{iterators::Pair, Parser};
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

#[derive(Debug, Clone)]
enum Expr {
    Number(f64),
    Vector(VectorExpr),
    Func {
        name: String,
        args: Vec<Expr>,
    },
    Aggregation {
        op: AggOp,
        grouping: Option<Grouping>,
        expr: Box<Expr>,
    },
    Binary {
        left: Box<Expr>,
        op: BinaryOp,
        right: Box<Expr>,
    },
}

#[derive(Debug, Clone)]
struct VectorExpr {
    name: String,
    labels: Vec<LabelMatch>,
    range_s: Option<i64>,
}

#[derive(Debug, Clone)]
struct LabelMatch {
    key: String,
    op: LabelOp,
    value: String,
}

#[derive(Debug, Clone, Copy)]
enum LabelOp {
    Eq,
    Ne,
    RegexEq,
    RegexNe,
}

#[derive(Debug, Clone)]
struct Grouping {
    by: bool,
    labels: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
enum AggOp {
    Sum,
    Avg,
    Min,
    Max,
    Count,
}

#[derive(Debug, Clone, Copy)]
enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MetricKind {
    Counter,
    #[allow(dead_code)]
    Gauge,
    TDigest,
}

#[derive(Debug, Clone, Copy)]
struct MetricDef {
    table: &'static str,
    time_col: &'static str,
    value_sql: &'static str,
    kind: MetricKind,
    tdigest_col: Option<&'static str>,
    labels: &'static [(&'static str, &'static str)],
}

#[derive(Debug, Clone)]
struct SqlNode {
    sql: String,
    labels: Vec<String>,
}

pub fn parse(input: &str) -> Result<Value> {
    let root = parse_query_pair(input)?;
    Ok(pair_to_json(&root))
}

fn pair_to_json(pair: &Pair<'_, Rule>) -> Value {
    json!({
        "rule": format!("{:?}", pair.as_rule()),
        "text": pair.as_str(),
        "children": pair.clone().into_inner().map(|p| pair_to_json(&p)).collect::<Vec<_>>(),
    })
}

pub fn compile(input: &str, ctx: &CompileCtx) -> Result<CompiledQuery> {
    let expr = parse_to_expr(input)?;
    let mut params = base_params(ctx);
    let compiled = compile_expr(&expr, ctx, &mut params, 0)?;
    Ok(CompiledQuery {
        sql: compiled.sql,
        params,
        plan: ResultShape {
            labels: compiled.labels,
            value_column: "v".to_string(),
            time_column: "t".to_string(),
        },
    })
}

fn base_params(ctx: &CompileCtx) -> BTreeMap<String, Value> {
    let mut m = BTreeMap::new();
    m.insert("program_id".to_string(), json!(ctx.program_id));
    m.insert("cluster".to_string(), json!(ctx.cluster));
    m.insert("from_s".to_string(), json!(ctx.from_ms / 1000));
    m.insert("to_s".to_string(), json!(ctx.to_ms / 1000));
    m.insert("step_ms".to_string(), json!(ctx.step_ms));
    m.insert("step_s".to_string(), json!((ctx.step_ms as f64) / 1000.0));
    m
}

fn parse_query_pair(input: &str) -> Result<Pair<'_, Rule>> {
    let mut parsed = DslParser::parse(Rule::query, input).map_err(|e| anyhow!(e.to_string()))?;
    parsed.next().ok_or_else(|| anyhow!("empty parse"))
}

fn parse_to_expr(input: &str) -> Result<Expr> {
    let root = parse_query_pair(input)?;
    let expr_pair = root
        .into_inner()
        .find(|p| p.as_rule() == Rule::expr)
        .ok_or_else(|| anyhow!("missing expr"))?;
    parse_expr(expr_pair)
}

fn parse_expr(pair: Pair<'_, Rule>) -> Result<Expr> {
    match pair.as_rule() {
        Rule::expr => {
            let inner = pair
                .into_inner()
                .next()
                .ok_or_else(|| anyhow!("empty expr"))?;
            parse_expr(inner)
        }
        Rule::binary => {
            let mut inner = pair.into_inner();
            let left = parse_expr(inner.next().ok_or_else(|| anyhow!("missing lhs"))?)?;
            let op = match inner
                .next()
                .ok_or_else(|| anyhow!("missing binary op"))?
                .as_str()
            {
                "+" => BinaryOp::Add,
                "-" => BinaryOp::Sub,
                "*" => BinaryOp::Mul,
                "/" => BinaryOp::Div,
                x => return Err(anyhow!("unsupported binary op: {x}")),
            };
            let right = parse_expr(inner.next().ok_or_else(|| anyhow!("missing rhs"))?)?;
            Ok(Expr::Binary {
                left: Box::new(left),
                op,
                right: Box::new(right),
            })
        }
        Rule::atom => parse_expr(
            pair.into_inner()
                .next()
                .ok_or_else(|| anyhow!("empty atom"))?,
        ),
        Rule::number => Ok(Expr::Number(pair.as_str().parse::<f64>()?)),
        Rule::vector => {
            let mut name = String::new();
            let mut labels = Vec::new();
            let mut range_s = None;
            for p in pair.into_inner() {
                match p.as_rule() {
                    Rule::ident if name.is_empty() => name = p.as_str().to_string(),
                    Rule::selector => labels = parse_selector(p)?,
                    Rule::range => range_s = Some(parse_duration_s(p.as_str())?),
                    _ => {}
                }
            }
            if name.is_empty() {
                return Err(anyhow!("vector metric name missing"));
            }
            if labels.is_empty() && range_s.is_none() {
                if let Ok(n) = name.parse::<f64>() {
                    return Ok(Expr::Number(n));
                }
            }
            Ok(Expr::Vector(VectorExpr {
                name,
                labels,
                range_s,
            }))
        }
        Rule::func => {
            let mut name = String::new();
            let mut args = Vec::new();
            for p in pair.into_inner() {
                match p.as_rule() {
                    Rule::ident if name.is_empty() => name = p.as_str().to_string(),
                    Rule::args => {
                        for a in p.into_inner() {
                            if a.as_rule() == Rule::expr {
                                args.push(parse_expr(a)?);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Expr::Func { name, args })
        }
        Rule::aggregation => {
            let text = pair.as_str().trim();
            let op = if text.starts_with("sum") {
                AggOp::Sum
            } else if text.starts_with("avg") {
                AggOp::Avg
            } else if text.starts_with("min") {
                AggOp::Min
            } else if text.starts_with("max") {
                AggOp::Max
            } else {
                AggOp::Count
            };
            let mut grouping = None;
            let mut inner_expr = None;
            for p in pair.into_inner() {
                match p.as_rule() {
                    Rule::grouping => grouping = Some(parse_grouping(p)?),
                    Rule::expr => inner_expr = Some(parse_expr(p)?),
                    _ => {}
                }
            }
            Ok(Expr::Aggregation {
                op,
                grouping,
                expr: Box::new(inner_expr.ok_or_else(|| anyhow!("missing aggregation expr"))?),
            })
        }
        Rule::query => unreachable!(),
        _ => Err(anyhow!("unsupported parse node: {:?}", pair.as_rule())),
    }
}

fn parse_selector(pair: Pair<'_, Rule>) -> Result<Vec<LabelMatch>> {
    let mut out = Vec::new();
    for lm in pair.into_inner() {
        if lm.as_rule() != Rule::label_match {
            continue;
        }
        let mut it = lm.into_inner();
        let key = it
            .next()
            .ok_or_else(|| anyhow!("missing label key"))?
            .as_str()
            .to_string();
        let op = match it
            .next()
            .ok_or_else(|| anyhow!("missing label op"))?
            .as_str()
        {
            "=" => LabelOp::Eq,
            "!=" => LabelOp::Ne,
            "=~" => LabelOp::RegexEq,
            "!~" => LabelOp::RegexNe,
            x => return Err(anyhow!("unsupported label op: {x}")),
        };
        let raw = it
            .next()
            .ok_or_else(|| anyhow!("missing label value"))?
            .as_str()
            .to_string();
        out.push(LabelMatch {
            key,
            op,
            value: unquote(&raw),
        });
    }
    Ok(out)
}

fn parse_grouping(pair: Pair<'_, Rule>) -> Result<Grouping> {
    let text = pair.as_str();
    let by = text.trim_start().starts_with("by");
    let open = text.find('(').ok_or_else(|| anyhow!("invalid grouping"))?;
    let close = text.rfind(')').ok_or_else(|| anyhow!("invalid grouping"))?;
    let labels = text[open + 1..close]
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    Ok(Grouping { by, labels })
}

fn parse_duration_s(text: &str) -> Result<i64> {
    let raw = text.trim().trim_start_matches('[').trim_end_matches(']');
    if raw.len() < 2 {
        return Err(anyhow!("invalid duration: {text}"));
    }
    let (num, unit) = raw.split_at(raw.len() - 1);
    let n: i64 = num.parse()?;
    let mul = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86400,
        _ => return Err(anyhow!("invalid duration unit: {unit}")),
    };
    Ok(n * mul)
}

fn unquote(s: &str) -> String {
    s.trim_matches('"').replace("\\\"", "\"")
}

fn compile_expr(
    expr: &Expr,
    ctx: &CompileCtx,
    params: &mut BTreeMap<String, Value>,
    depth: usize,
) -> Result<SqlNode> {
    match expr {
        Expr::Vector(v) => compile_vector(v, params),
        Expr::Func { name, args } => match name.as_str() {
            "rate" | "irate" | "increase" => compile_rate_like(name, args, ctx, params, depth),
            "histogram_quantile" => compile_histogram_quantile(args, ctx, params),
            "topk" => compile_k_fn(args, ctx, params, depth, true),
            "bottomk" => compile_k_fn(args, ctx, params, depth, false),
            _ => Err(anyhow!("unsupported function: {name}")),
        },
        Expr::Aggregation { op, grouping, expr } => {
            let inner = compile_expr(expr, ctx, params, depth + 1)?;
            compile_aggregation(*op, grouping.as_ref(), inner)
        }
        Expr::Binary { left, op, right } => {
            let l = compile_expr(left, ctx, params, depth + 1)?;
            let r = compile_expr(right, ctx, params, depth + 1)?;
            let sym = match op {
                BinaryOp::Add => "+",
                BinaryOp::Sub => "-",
                BinaryOp::Mul => "*",
                BinaryOp::Div => "/",
            };
            Ok(SqlNode {
                sql: format!(
                    "SELECT l.t AS t, (l.v {sym} r.v) AS v
                     FROM ({}) l
                     INNER JOIN ({}) r ON l.t = r.t
                     ORDER BY t",
                    l.sql, r.sql
                ),
                labels: vec![],
            })
        }
        Expr::Number(v) => Ok(SqlNode {
            sql: format!("SELECT toDateTime({{to_s:Int64}}) AS t, {} AS v", *v),
            labels: vec![],
        }),
    }
}

fn metric_registry(name: &str) -> Option<MetricDef> {
    match name {
        "latency_processed_to_confirmed_ms" => Some(MetricDef {
            table: "(SELECT cp.program_id, cp.cluster, cp.signature, toDateTime(cp.observed_at_ms / 1000) AS observed_at, greatest(cp.observed_at_ms - toUnixTimestamp64Milli(t.block_time), 0) AS latency_ms, any(i.instruction_name) AS instruction_name FROM commitment_promotions cp LEFT JOIN transactions t ON t.signature = cp.signature AND t.program_id = cp.program_id LEFT JOIN instructions i ON i.signature = cp.signature AND i.program_id = cp.program_id WHERE cp.commitment = 'confirmed' GROUP BY cp.program_id, cp.cluster, cp.signature, observed_at, latency_ms)",
            time_col: "observed_at",
            value_sql: "avg(latency_ms)",
            kind: MetricKind::Gauge,
            tdigest_col: None,
            labels: &[("instruction", "instruction_name")],
        }),
        "latency_confirmed_to_finalized_ms" => Some(MetricDef {
            table: "(SELECT c.program_id, c.cluster, c.signature, toDateTime(f.observed_at_ms / 1000) AS observed_at, greatest(f.observed_at_ms - c.observed_at_ms, 0) AS latency_ms, any(i.instruction_name) AS instruction_name FROM commitment_promotions c INNER JOIN commitment_promotions f ON f.signature = c.signature AND f.program_id = c.program_id AND f.commitment = 'finalized' LEFT JOIN instructions i ON i.signature = c.signature AND i.program_id = c.program_id WHERE c.commitment = 'confirmed' GROUP BY c.program_id, c.cluster, c.signature, observed_at, latency_ms)",
            time_col: "observed_at",
            value_sql: "avg(latency_ms)",
            kind: MetricKind::Gauge,
            tdigest_col: None,
            labels: &[("instruction", "instruction_name")],
        }),
        "latency_wallclock_perceived_ms" => Some(MetricDef {
            table: "(SELECT cp.program_id, cp.cluster, cp.signature, toDateTime(cp.observed_at_ms / 1000) AS observed_at, greatest(cp.observed_at_ms - toUnixTimestamp64Milli(t.block_time), 0) AS latency_ms, any(i.instruction_name) AS instruction_name FROM commitment_promotions cp LEFT JOIN transactions t ON t.signature = cp.signature AND t.program_id = cp.program_id LEFT JOIN instructions i ON i.signature = cp.signature AND i.program_id = cp.program_id WHERE cp.commitment IN ('confirmed', 'finalized') GROUP BY cp.program_id, cp.cluster, cp.signature, observed_at, latency_ms)",
            time_col: "observed_at",
            value_sql: "avg(latency_ms)",
            kind: MetricKind::Gauge,
            tdigest_col: None,
            labels: &[("instruction", "instruction_name")],
        }),
        "instruction_calls_total" => Some(MetricDef {
            table: "metrics_instruction_calls_minute",
            time_col: "minute",
            value_sql: "countMerge(calls_state)",
            kind: MetricKind::Counter,
            tdigest_col: None,
            labels: &[("instruction", "instruction_name"), ("status", "status")],
        }),
        "instruction_cu_consumed" => Some(MetricDef {
            table: "metrics_instruction_calls_minute",
            time_col: "minute",
            value_sql: "sumMerge(sum_cu_state)",
            kind: MetricKind::TDigest,
            tdigest_col: Some("cu_tdigest_state"),
            labels: &[("instruction", "instruction_name"), ("status", "status")],
        }),
        "errors_total" => Some(MetricDef {
            table: "metrics_errors_minute",
            time_col: "minute",
            value_sql: "countMerge(errors_state)",
            kind: MetricKind::Counter,
            tdigest_col: None,
            labels: &[
                ("instruction", "instruction_name"),
                ("error_name", "error_name"),
            ],
        }),
        "cpi_calls_total" => Some(MetricDef {
            table: "metrics_cpi_minute",
            time_col: "minute",
            value_sql: "countMerge(calls_state)",
            kind: MetricKind::Counter,
            tdigest_col: None,
            labels: &[("callee_program", "callee_program")],
        }),
        "signer_fees_lamports_total" => Some(MetricDef {
            table: "transactions",
            time_col: "block_time",
            value_sql: "sum(fee_lamports)",
            kind: MetricKind::Counter,
            tdigest_col: None,
            labels: &[("signer", "signer"), ("status", "status")],
        }),
        _ => None,
    }
}

fn compile_vector(v: &VectorExpr, params: &mut BTreeMap<String, Value>) -> Result<SqlNode> {
    if v.name == "event" {
        return compile_event_vector(v, params);
    }
    let def = metric_registry(&v.name).ok_or_else(|| anyhow!("unknown metric: {}", v.name))?;
    let mut where_parts = vec![
        "program_id = {program_id:String}".to_string(),
        "cluster = {cluster:String}".to_string(),
        format!(
            "{} >= toDateTime({{from_s:Int64}}) AND {} <= toDateTime({{to_s:Int64}})",
            def.time_col, def.time_col
        ),
    ];
    if let Some(range_s) = v.range_s {
        where_parts.push(format!(
            "{} >= toDateTime(greatest({{from_s:Int64}}, {{to_s:Int64}} - {{range_s:Int64}}))",
            def.time_col
        ));
        params.insert("range_s".to_string(), json!(range_s));
    }
    let label_projection: Vec<String> = def
        .labels
        .iter()
        .map(|(label, col)| format!("{col} AS {label}"))
        .collect();
    for (i, lm) in v.labels.iter().enumerate() {
        let (_, col) = def
            .labels
            .iter()
            .find(|(label, _)| *label == lm.key)
            .copied()
            .ok_or_else(|| anyhow!("unknown label '{}' for metric '{}'", lm.key, v.name))?;
        let p = format!("label_{i}");
        params.insert(p.clone(), json!(lm.value.clone()));
        let clause = match lm.op {
            LabelOp::Eq => format!("{col} = {{{p}:String}}"),
            LabelOp::Ne => format!("{col} != {{{p}:String}}"),
            LabelOp::RegexEq => format!("match({col}, {{{p}:String}})"),
            LabelOp::RegexNe => format!("NOT match({col}, {{{p}:String}})"),
        };
        where_parts.push(clause);
    }
    let label_cols = def
        .labels
        .iter()
        .map(|(label, _)| label.to_string())
        .collect::<Vec<_>>();
    let mut select_cols = vec![format!("toStartOfMinute({}) AS t", def.time_col)];
    select_cols.extend(label_projection);
    select_cols.push(format!("{} AS v", def.value_sql));
    let mut group_cols = vec!["t".to_string()];
    group_cols.extend(label_cols.clone());
    Ok(SqlNode {
        sql: format!(
            "SELECT {}
             FROM {}
             WHERE {}
             GROUP BY {}
             ORDER BY t",
            select_cols.join(", "),
            def.table,
            where_parts.join(" AND "),
            group_cols.join(", ")
        ),
        labels: label_cols,
    })
}

fn compile_event_vector(v: &VectorExpr, params: &mut BTreeMap<String, Value>) -> Result<SqlNode> {
    let mut event_type = None;
    let mut where_parts = vec![
        "program_id = {program_id:String}".to_string(),
        "cluster = {cluster:String}".to_string(),
        "block_time >= toDateTime({from_s:Int64})".to_string(),
        "block_time <= toDateTime({to_s:Int64})".to_string(),
    ];
    for (i, lm) in v.labels.iter().enumerate() {
        if lm.key == "type" {
            if !matches!(lm.op, LabelOp::Eq) {
                return Err(anyhow!("event type only supports '='"));
            }
            event_type = Some(lm.value.clone());
            params.insert("event_type".to_string(), json!(lm.value.clone()));
            where_parts.push("event_name = {event_type:String}".to_string());
        } else {
            let p = format!("event_label_{i}");
            params.insert(p.clone(), json!(lm.value.clone()));
            let expr = format!("JSONExtractString(payload_json, '{}')", lm.key);
            let clause = match lm.op {
                LabelOp::Eq => format!("{expr} = {{{p}:String}}"),
                LabelOp::Ne => format!("{expr} != {{{p}:String}}"),
                LabelOp::RegexEq => format!("match({expr}, {{{p}:String}})"),
                LabelOp::RegexNe => format!("NOT match({expr}, {{{p}:String}})"),
            };
            where_parts.push(clause);
        }
    }
    if event_type.is_none() {
        return Err(anyhow!("event{{type=\"...\"}} is required"));
    }
    Ok(SqlNode {
        sql: format!(
            "SELECT toStartOfMinute(block_time) AS t, event_name, count() AS v
             FROM events
             WHERE {}
             GROUP BY t, event_name
             ORDER BY t",
            where_parts.join(" AND ")
        ),
        labels: vec!["event_name".to_string()],
    })
}

fn compile_rate_like(
    name: &str,
    args: &[Expr],
    _ctx: &CompileCtx,
    params: &mut BTreeMap<String, Value>,
    depth: usize,
) -> Result<SqlNode> {
    if args.len() != 1 {
        return Err(anyhow!("{name} expects one argument"));
    }
    let vec = match &args[0] {
        Expr::Vector(v) => v,
        _ => return Err(anyhow!("{name} expects a vector argument")),
    };
    let def = metric_registry(&vec.name).ok_or_else(|| anyhow!("unknown metric '{}'", vec.name))?;
    if def.kind != MetricKind::Counter {
        return Err(anyhow!("{name} requires a counter metric"));
    }
    let inner = compile_expr(&args[0], _ctx, params, depth + 1)?;
    let denom = if name == "increase" {
        "1.0"
    } else {
        "greatest({step_s:Float64}, 1.0)"
    };
    Ok(SqlNode {
        sql: format!(
            "SELECT t, {} / {denom} AS v{}
             FROM ({}) q
             ORDER BY t",
            if name == "increase" { "v" } else { "v" },
            if inner.labels.is_empty() {
                "".to_string()
            } else {
                format!(", {}", inner.labels.join(", "))
            },
            inner.sql
        ),
        labels: inner.labels,
    })
}

fn compile_histogram_quantile(
    args: &[Expr],
    _ctx: &CompileCtx,
    params: &mut BTreeMap<String, Value>,
) -> Result<SqlNode> {
    if args.len() != 2 {
        return Err(anyhow!("histogram_quantile expects two arguments"));
    }
    let q = match &args[0] {
        Expr::Number(v) => *v,
        _ => {
            return Err(anyhow!(
                "histogram_quantile quantile argument must be numeric"
            ))
        }
    };
    let vec = match &args[1] {
        Expr::Vector(v) => v,
        _ => {
            return Err(anyhow!(
                "histogram_quantile metric argument must be a vector"
            ))
        }
    };
    let def = metric_registry(&vec.name).ok_or_else(|| anyhow!("unknown metric '{}'", vec.name))?;
    if def.kind != MetricKind::TDigest {
        return Err(anyhow!(
            "histogram_quantile only supports t-digest metrics, got '{}'",
            vec.name
        ));
    }
    params.insert("q".to_string(), json!(q));
    let td_col = def
        .tdigest_col
        .ok_or_else(|| anyhow!("tdigest column missing for '{}'", vec.name))?;
    let base = compile_vector(vec, params)?;
    Ok(SqlNode {
        sql: format!(
            "SELECT t, quantileTDigestMerge({{q:Float64}})({td_col}) AS v{}
             FROM ({}) b
             GROUP BY t{}
             ORDER BY t",
            if base.labels.is_empty() {
                "".to_string()
            } else {
                format!(", {}", base.labels.join(", "))
            },
            // Need vector query with original source table for tdigest column.
            compile_tdigest_base(vec, params)?,
            if base.labels.is_empty() {
                "".to_string()
            } else {
                format!(", {}", base.labels.join(", "))
            }
        ),
        labels: base.labels,
    })
}

fn compile_tdigest_base(v: &VectorExpr, params: &mut BTreeMap<String, Value>) -> Result<String> {
    let def = metric_registry(&v.name).ok_or_else(|| anyhow!("unknown metric '{}'", v.name))?;
    let td_col = def
        .tdigest_col
        .ok_or_else(|| anyhow!("metric '{}' is not tdigest-backed", v.name))?;
    let mut where_parts = vec![
        "program_id = {program_id:String}".to_string(),
        "cluster = {cluster:String}".to_string(),
        format!(
            "{} >= toDateTime({{from_s:Int64}}) AND {} <= toDateTime({{to_s:Int64}})",
            def.time_col, def.time_col
        ),
    ];
    for (i, lm) in v.labels.iter().enumerate() {
        let (_, col) = def
            .labels
            .iter()
            .find(|(label, _)| *label == lm.key)
            .copied()
            .ok_or_else(|| anyhow!("unknown label '{}' for metric '{}'", lm.key, v.name))?;
        let p = format!("td_label_{i}");
        params.insert(p.clone(), json!(lm.value.clone()));
        where_parts.push(match lm.op {
            LabelOp::Eq => format!("{col} = {{{p}:String}}"),
            LabelOp::Ne => format!("{col} != {{{p}:String}}"),
            LabelOp::RegexEq => format!("match({col}, {{{p}:String}})"),
            LabelOp::RegexNe => format!("NOT match({col}, {{{p}:String}})"),
        });
    }
    let labels = def
        .labels
        .iter()
        .map(|(label, col)| format!("{col} AS {label}"))
        .collect::<Vec<_>>();
    let mut select = vec![format!("toStartOfMinute({}) AS t", def.time_col)];
    select.extend(labels);
    select.push(format!("{td_col}"));
    Ok(format!(
        "SELECT {} FROM {} WHERE {}",
        select.join(", "),
        def.table,
        where_parts.join(" AND ")
    ))
}

fn compile_aggregation(op: AggOp, grouping: Option<&Grouping>, inner: SqlNode) -> Result<SqlNode> {
    let labels = match grouping {
        Some(g) if g.by => g.labels.clone(),
        Some(g) => inner
            .labels
            .iter()
            .filter(|l| !g.labels.iter().any(|x| x == *l))
            .cloned()
            .collect::<Vec<_>>(),
        None => vec![],
    };
    for l in &labels {
        if !inner.labels.iter().any(|x| x == l) {
            return Err(anyhow!("unknown grouping label '{l}'"));
        }
    }
    let agg = match op {
        AggOp::Sum => "sum(v)",
        AggOp::Avg => "avg(v)",
        AggOp::Min => "min(v)",
        AggOp::Max => "max(v)",
        AggOp::Count => "count(v)",
    };
    let mut select_cols = vec!["t".to_string(), format!("{agg} AS v")];
    select_cols.extend(labels.clone());
    let mut groups = vec!["t".to_string()];
    groups.extend(labels.clone());
    Ok(SqlNode {
        sql: format!(
            "SELECT {} FROM ({}) q GROUP BY {} ORDER BY t",
            select_cols.join(", "),
            inner.sql,
            groups.join(", ")
        ),
        labels,
    })
}

fn compile_k_fn(
    args: &[Expr],
    ctx: &CompileCtx,
    params: &mut BTreeMap<String, Value>,
    depth: usize,
    top: bool,
) -> Result<SqlNode> {
    if args.len() != 2 {
        return Err(anyhow!(
            "{} expects two args",
            if top { "topk" } else { "bottomk" }
        ));
    }
    let k = match &args[0] {
        Expr::Number(v) if *v >= 1.0 => *v as u32,
        _ => return Err(anyhow!("k must be a positive integer literal")),
    };
    params.insert("k".to_string(), json!(k));
    let inner = compile_expr(&args[1], ctx, params, depth + 1)?;
    let order = if top { "DESC" } else { "ASC" };
    let label_cols = if inner.labels.is_empty() {
        "".to_string()
    } else {
        format!(", {}", inner.labels.join(", "))
    };
    let label_group = if inner.labels.is_empty() {
        "".to_string()
    } else {
        format!(" GROUP BY {}", inner.labels.join(", "))
    };
    Ok(SqlNode {
        sql: format!(
            "SELECT toDateTime({{to_s:Int64}}) AS t, ranked.v{label_cols}
             FROM (
                 SELECT sum(v) AS v{label_cols}
                 FROM ({}) base
                 {label_group}
                 ORDER BY v {order}
                 LIMIT {{k:UInt32}}
             ) ranked",
            inner.sql
        ),
        labels: inner.labels,
    })
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

    #[test]
    fn injects_label_filters_into_sql() {
        let q = compile(
            r#"instruction_calls_total{instruction="swap",status="success"}[5m]"#,
            &ctx(),
        )
        .expect("compile");
        assert!(q.sql.contains("instruction_name = {label_0:String}"));
        assert!(q.sql.contains("status = {label_1:String}"));
        assert_eq!(q.params.get("label_0"), Some(&json!("swap")));
    }

    #[test]
    fn rate_divides_by_step_seconds() {
        let q = compile(
            r#"rate(instruction_calls_total{instruction="swap"}[5m])"#,
            &ctx(),
        )
        .expect("compile");
        assert!(q.sql.contains("/ greatest({step_s:Float64}, 1.0)"));
    }

    #[test]
    fn honors_sum_by_grouping() {
        let q = compile(
            r#"sum by (instruction) (instruction_calls_total{status="success"})"#,
            &ctx(),
        )
        .expect("compile");
        assert!(q.sql.contains("GROUP BY t, instruction"));
    }

    #[test]
    fn topk_uses_literal_k() {
        let q = compile(
            r#"topk(3, sum by (signer) (signer_fees_lamports_total))"#,
            &ctx(),
        )
        .expect("compile");
        assert!(q.sql.contains("LIMIT {k:UInt32}"));
        assert_eq!(q.params.get("k"), Some(&json!(3)));
    }

    #[test]
    fn bottomk_orders_ascending() {
        let q = compile(
            r#"bottomk(2, sum by (signer) (signer_fees_lamports_total))"#,
            &ctx(),
        )
        .expect("compile");
        assert!(q.sql.contains("ORDER BY v ASC"));
    }

    #[test]
    fn range_clause_participates_in_sql() {
        let q = compile(r#"instruction_calls_total[1h]"#, &ctx()).expect("compile");
        assert!(q.sql.contains("range_s:Int64"));
        assert_eq!(q.params.get("range_s"), Some(&json!(3600)));
    }

    #[test]
    fn histogram_quantile_rejects_non_tdigest_metric() {
        let err = compile(
            "histogram_quantile(0.99, instruction_calls_total{instruction=\"swap\"})",
            &ctx(),
        )
        .expect_err("must fail");
        assert!(err.to_string().contains("t-digest"));
    }
}
