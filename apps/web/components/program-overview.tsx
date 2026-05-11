import Link from "next/link";
import { prisma } from "@repo/database/client";
import { formatDistanceToNow } from "@/lib/format";

interface Props {
  orgId: string;
  projectId: string;
  programId: string;
  programAddress: string;
  cluster: string;
}

export async function ProgramOverview({
  orgId,
  projectId,
  programId,
  programAddress,
  cluster,
}: Props) {
  const state = await prisma.ingestionState
    .findUnique({
      where: {
        programIdFk_cluster: {
          programIdFk: programId,
          cluster: cluster as "mainnet" | "devnet",
        },
      },
    })
    .catch(() => null);

  const base = `/org/${orgId}/project/${projectId}/program/${programId}`;
  const live =
    state && Date.now() - new Date(state.lastSeenAt).getTime() < 5 * 60 * 1000;

  return (
    <div className="space-y-8">
      <Section
        eyebrow="Ingestion"
        title={live ? "Live" : state ? "Idle" : "Not started"}
        statusColor={
          live ? "var(--ok)" : state ? "oklch(70% 0.13 75)" : "var(--ink-faint)"
        }
      >
        <Stats
          items={[
            {
              label: "Last processed slot",
              value: state
                ? Number(state.lastProcessedSlot).toLocaleString()
                : "—",
              mono: true,
            },
            {
              label: "Lag",
              value: state ? `${state.lagSlots} slots` : "—",
            },
            {
              label: "Last activity",
              value: state ? formatDistanceToNow(state.lastSeenAt) : "—",
            },
            {
              label: "Cluster",
              value: cluster,
              uppercase: true,
            },
          ]}
        />
        {state?.lastProcessedSignature ? (
          <div className="mt-4 text-[12px]">
            <span style={{ color: "var(--ink-faint)" }}>Last signature </span>
            <Link
              href={`${base}?tab=raw`}
              className="font-mono hover:underline"
              style={{ color: "var(--ink-mid)" }}
            >
              {state.lastProcessedSignature.slice(0, 12)}…
              {state.lastProcessedSignature.slice(-8)}
            </Link>
          </div>
        ) : null}
      </Section>

      <Section eyebrow="Next" title="What to do here">
        <div className="grid gap-3 sm:grid-cols-2">
          <Action
            href={`${base}?tab=dashboards`}
            title="Open dashboards"
            body="Calls per minute, CU profile, errors over time, top instructions."
          />
          <Action
            href={`${base}?tab=logs`}
            title="Inspect recent ix"
            body="Decoded instruction stream with args and call status."
          />
          <Action
            href={`${base}?tab=errors`}
            title="Triage errors"
            body="Grouped failures with sample signatures and constraint causes."
          />
          <Action
            href={`${base}?tab=alerts`}
            title="Wire up alerts"
            body="Rule-based notifications on rates, latencies, or failures."
          />
        </div>
      </Section>

      {!state ? (
        <div
          className="rounded p-4 text-[13px]"
          style={{
            background: "var(--accent-soft)",
            border: "1px solid var(--line)",
            color: "var(--ink)",
          }}
        >
          <strong className="font-medium">No traffic yet.</strong> Send a tx to{" "}
          <span className="font-mono text-[12px]">{programAddress}</span> on{" "}
          {cluster}. The ingestor should pick it up within ~5 seconds and this
          page will fill in.
        </div>
      ) : null}
    </div>
  );
}

function Section({
  eyebrow,
  title,
  statusColor,
  children,
}: {
  eyebrow: string;
  title: string;
  statusColor?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div
        className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em]"
        style={{ color: "var(--ink-faint)" }}
      >
        {eyebrow}
      </div>
      <h2
        className="mb-4 inline-flex items-center gap-2 text-[18px] font-semibold tracking-tight"
        style={{ color: "var(--ink)" }}
      >
        {statusColor ? (
          <span
            className="inline-block size-2 rounded-full"
            style={{ background: statusColor }}
          />
        ) : null}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Stats({
  items,
}: {
  items: Array<{
    label: string;
    value: string;
    mono?: boolean;
    uppercase?: boolean;
  }>;
}) {
  return (
    <dl
      className="grid gap-px overflow-hidden rounded"
      style={{
        background: "var(--line)",
        border: "1px solid var(--line)",
        gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
      }}
    >
      {items.map((it) => (
        <div
          key={it.label}
          className="px-4 py-3"
          style={{ background: "var(--bg-elevated)" }}
        >
          <dt
            className="text-[10px] font-medium uppercase tracking-[0.08em]"
            style={{ color: "var(--ink-faint)" }}
          >
            {it.label}
          </dt>
          <dd
            className={
              "mt-1 text-[18px] tabular-nums " +
              (it.mono ? "font-mono " : "") +
              (it.uppercase ? "uppercase tracking-wide " : "")
            }
            style={{ color: "var(--ink)" }}
          >
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Action({
  href,
  title,
  body,
}: {
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group block rounded p-4 transition-colors"
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--line)",
      }}
    >
      <div
        className="flex items-center justify-between text-[14px] font-medium"
        style={{ color: "var(--ink)" }}
      >
        {title}
        <span
          className="text-[12px] opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--accent)" }}
        >
          →
        </span>
      </div>
      <p
        className="mt-1 text-[12px] leading-relaxed"
        style={{ color: "var(--ink-mid)" }}
      >
        {body}
      </p>
    </Link>
  );
}
