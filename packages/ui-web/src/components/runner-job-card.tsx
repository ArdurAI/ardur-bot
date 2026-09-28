import React from "react";

export function RunnerJobCard({ job }: { job: any }) {
  return (
    <div className="rounded border bg-card p-4">
      <h3 className="font-semibold">Runner Job: {job.providerRef}</h3>
      <p>Status: {job.state}</p>
      {job.exitCode !== null && <p>Exit Code: {job.exitCode}</p>}
    </div>
  );
}
