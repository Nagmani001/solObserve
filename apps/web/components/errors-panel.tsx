"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addErrorComment,
  getErrorIssueDetail,
  getErrorIssues,
  updateErrorIssue,
} from "@/actions/control-plane";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";

type Issue = {
  id: string;
  instructionName?: string | null;
  errorName?: string | null;
  totalCount: number;
  lastSeenAt: string;
  status: string;
};

export function ErrorsPanel({ programId }: { programId: string }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState<string>("all");
  const [selectedIssueId, setSelectedIssueId] = useState<string>("");
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [comment, setComment] = useState("");

  useEffect(() => {
    getErrorIssues(programId, status === "all" ? undefined : status).then(
      (r) => {
        setIssues((r.issues as Issue[]) ?? []);
      },
    );
  }, [programId, status]);

  useEffect(() => {
    if (!selectedIssueId) return;
    getErrorIssueDetail(programId, selectedIssueId).then(setDetail);
  }, [programId, selectedIssueId]);

  const selected = useMemo(
    () => issues.find((i) => i.id === selectedIssueId),
    [issues, selectedIssueId],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Issues</h3>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-40 rounded-md border bg-background px-2 py-1 text-sm"
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="muted">Muted</option>
          </select>
        </div>
        <div className="space-y-2">
          {issues.map((issue) => (
            <button
              key={issue.id}
              className="w-full rounded border p-2 text-left hover:bg-muted"
              onClick={() => setSelectedIssueId(issue.id)}
            >
              <div className="text-sm font-medium">
                {issue.instructionName ?? "Unknown"} :{" "}
                {issue.errorName ?? "UnknownError"}
              </div>
              <div className="text-xs text-muted-foreground">
                Count {issue.totalCount} · Last seen{" "}
                {new Date(issue.lastSeenAt).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-3 rounded-md border p-4">
        <h3 className="text-sm font-semibold">Issue Detail</h3>
        {!selectedIssueId && (
          <p className="text-sm text-muted-foreground">
            Select an issue to inspect samples and workflow actions.
          </p>
        )}
        {selectedIssueId && selected && (
          <>
            <div className="text-sm">
              <p className="font-medium">
                {selected.instructionName ?? "Unknown"} :{" "}
                {selected.errorName ?? "UnknownError"}
              </p>
              <p className="text-muted-foreground">Status: {selected.status}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  updateErrorIssue(programId, selectedIssueId, {
                    status: "acknowledged",
                  })
                }
              >
                Acknowledge
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  updateErrorIssue(programId, selectedIssueId, {
                    status: "resolved",
                  })
                }
              >
                Resolve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  updateErrorIssue(programId, selectedIssueId, {
                    status: "muted",
                    mute_hours: 24,
                  })
                }
              >
                Mute 24h
              </Button>
            </div>
            <div className="space-y-2 text-xs">
              <p className="font-medium">Why did this fail?</p>
              <pre className="max-h-52 overflow-auto rounded bg-muted p-2">
                {JSON.stringify(detail, null, 2)}
              </pre>
            </div>
            <div className="space-y-2">
              <Input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add comment"
              />
              <Button
                size="sm"
                onClick={async () => {
                  if (!comment.trim()) return;
                  await addErrorComment(
                    programId,
                    selectedIssueId,
                    comment.trim(),
                  );
                  setComment("");
                  setDetail(
                    await getErrorIssueDetail(programId, selectedIssueId),
                  );
                }}
              >
                Comment
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
