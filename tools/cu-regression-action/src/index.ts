import * as core from "@actions/core";
import * as github from "@actions/github";
import { exec, getExecOutput } from "@actions/exec";

interface CuPerIx {
  name: string;
  cu_samples: number[];
}

interface DeltaRow {
  name: string;
  before: number | null;
  after: number;
  delta: number | null;
  pct: number | null;
  threshold: number;
  regressed: boolean;
}

interface CuRunResponse {
  run_id: string;
  deltas: DeltaRow[];
  regressed: boolean;
  is_default_branch: boolean;
  markdown: string;
}

const CU_LINE_RE = /^Program (\w+) consumed (\d+) of \d+ compute units/;
const TEST_NAME_RE = /^(?:ok |running |test )(?<name>[^\s]+)/i;

function parseCuFromLogs(output: string): CuPerIx[] {
  const byName: Map<string, number[]> = new Map();
  let currentIx: string | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const m = TEST_NAME_RE.exec(line);
    if (m?.groups?.name) {
      currentIx = m.groups.name;
      continue;
    }
    const cm = CU_LINE_RE.exec(line);
    if (cm && currentIx) {
      const cu = Number(cm[2]);
      if (Number.isFinite(cu)) {
        const arr = byName.get(currentIx) ?? [];
        arr.push(cu);
        byName.set(currentIx, arr);
      }
    }
  }
  return Array.from(byName.entries()).map(([name, cu_samples]) => ({
    name,
    cu_samples,
  }));
}

async function main() {
  try {
    const programId = core.getInput("program-id", { required: true });
    const token = core.getInput("solobserve-token", { required: true });
    const url = core.getInput("solobserve-url") || "https://api.solobserve.dev";
    const threshold = Number(core.getInput("threshold-percent") || "5");
    const bypassLabel = core.getInput("bypass-label") || "cu-regression-ok";
    const testCmd =
      core.getInput("test-command") || "anchor test --skip-deploy";

    const { sha, ref } = github.context;
    const branch = ref.replace(/^refs\/heads\//, "");
    const prNumber = github.context.payload.pull_request?.number ?? null;

    core.info(`Running test command: ${testCmd}`);
    const out = await getExecOutput("bash", ["-c", testCmd], {
      ignoreReturnCode: true,
    });
    const cuRows = parseCuFromLogs(out.stdout + "\n" + out.stderr);
    if (cuRows.length === 0) {
      core.warning(
        "No CU lines parsed from test output. Ensure tests print `Program <id> consumed N CU` lines.",
      );
    }

    const body = {
      program_id: programId,
      commit_sha: sha,
      branch,
      pr_number: prNumber,
      threshold_percent: threshold,
      instructions: cuRows,
    };

    const res = await fetch(
      `${url.replace(/\/$/, "")}/v1/integrations/github/cu-runs`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      core.setFailed(`SolObserve returned ${res.status}: ${text}`);
      return;
    }
    const json = (await res.json()) as CuRunResponse;

    const labels = (github.context.payload.pull_request?.labels ??
      []) as Array<{
      name?: string;
    }>;
    const bypass = labels.some((l) => l.name === bypassLabel);

    // PR comment via the Octokit client if we have a GITHUB_TOKEN.
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken && prNumber) {
      const oct = github.getOctokit(ghToken);
      const { owner, repo } = github.context.repo;
      const banner = json.regressed
        ? bypass
          ? "**SolObserve CU check: regression bypassed via label**"
          : "**SolObserve CU check: REGRESSION**"
        : "**SolObserve CU check: OK**";
      const body = `${banner}\n\n${json.markdown}\n\nRun id: \`${json.run_id}\``;
      await oct.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
    }

    if (json.regressed && !bypass) {
      core.setFailed("CU regression detected — see PR comment for details.");
      return;
    }
    if (json.regressed && bypass) {
      core.warning("CU regression bypassed via label.");
    }
    core.setOutput("run_id", json.run_id);
  } catch (err) {
    core.setFailed(`Action failed: ${(err as Error).message}`);
  }
}

main();
