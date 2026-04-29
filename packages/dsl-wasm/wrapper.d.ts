export type CompileCtx = {
  program_id: string;
  cluster: string;
  from_ms: number;
  to_ms: number;
  step_ms: number;
};

export type CompiledQuery = {
  sql: string;
  params: Record<string, unknown>;
  plan: {
    labels: string[];
    value_column: string;
    time_column: string;
  };
};

export function compile(dsl: string, ctx: CompileCtx): CompiledQuery;
export function parse(dsl: string): unknown;
