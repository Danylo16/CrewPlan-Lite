import { useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import type { AppliedPortfolioPlan, PortfolioPlanPreview } from "../types";

function nextMonday() {
  const date = new Date();
  const days = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function hours(minutes: number) {
  return `${Math.round(minutes / 6) / 10}h`;
}

function money(cents: number) {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(cents / 100);
}

function weekOf(value: string) {
  const date = new Date(value);
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = local.getDay() || 7;
  local.setDate(local.getDate() - day + 1);
  return local.toISOString().slice(0, 10);
}

export function PlannerPage() {
  const [horizonStart, setHorizonStart] = useState(nextMonday);
  const [horizonWeeks, setHorizonWeeks] = useState(6);
  const [replaceGenerated, setReplaceGenerated] = useState(true);
  const [preview, setPreview] = useState<PortfolioPlanPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [applied, setApplied] = useState<AppliedPortfolioPlan | null>(null);

  const assignmentsByWeek = useMemo(() => {
    const grouped = new Map<string, PortfolioPlanPreview["assignments"]>();
    for (const assignment of preview?.assignments ?? []) {
      const key = weekOf(assignment.startAt);
      grouped.set(key, [...(grouped.get(key) ?? []), assignment]);
    }
    return grouped;
  }, [preview]);

  async function generate() {
    setIsGenerating(true);
    setError(null);
    setApplied(null);
    try {
      setPreview(await apiRequest<PortfolioPlanPreview>("/portfolio-plan/preview", {
        method: "POST",
        body: JSON.stringify({ horizonStart, horizonWeeks, replaceGenerated }),
      }));
    } catch (generationError) {
      setPreview(null);
      setError(generationError instanceof Error ? generationError.message : "Planning failed");
    } finally {
      setIsGenerating(false);
    }
  }

  async function apply() {
    if (!preview || !window.confirm(`Apply this ${preview.horizonWeeks}-week plan?`)) return;
    setIsApplying(true);
    setError(null);
    try {
      const result = await apiRequest<AppliedPortfolioPlan>("/portfolio-plan/apply", {
        method: "POST",
        body: JSON.stringify({ horizonStart: preview.horizonStart, horizonWeeks: preview.horizonWeeks, replaceGenerated: preview.replaceGenerated, previewId: preview.previewId, inputVersion: preview.inputVersion }),
      });
      setApplied(result);
      setPreview(null);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Could not apply plan");
    } finally {
      setIsApplying(false);
    }
  }

  return <section className="planner-page">
    <div className="page-header planner-header">
      <div><span className="planner-eyebrow">Rolling horizon</span><h2>Portfolio capacity plan</h2><p>Turn project scope into a feasible multi-week allocation plan.</p></div>
      <div className="planner-health"><span>Timezone</span><strong>Europe/Vienna</strong></div>
    </div>

    <div className="panel planner-controls">
      <label>First week<input type="date" value={horizonStart} onChange={(event) => { setHorizonStart(event.target.value); setPreview(null); }} /></label>
      <label>Horizon<select value={horizonWeeks} onChange={(event) => { setHorizonWeeks(Number(event.target.value)); setPreview(null); }}>{[2,4,6,8,12].map((weeks) => <option value={weeks} key={weeks}>{weeks} weeks</option>)}</select></label>
      <label className="planner-replace"><input type="checkbox" checked={replaceGenerated} onChange={(event) => { setReplaceGenerated(event.target.checked); setPreview(null); }} /><span><strong>Replace generated plan</strong><small>Manual and legacy shifts stay untouched.</small></span></label>
      <button className="primary-button" disabled={isGenerating} type="button" onClick={() => void generate()}>{isGenerating ? "Planning…" : "Generate preview"}</button>
    </div>
    {error && <div className="error-message portfolio-error">{error}</div>}
    {applied && <div className="planner-success"><strong>Plan applied.</strong><span>{applied.createdShifts} allocations created, {applied.deletedShifts} generated allocations replaced.</span></div>}

    {!preview && !applied && <div className="planner-empty"><div className="planner-empty-icon">↗</div><h3>Build a defensible delivery plan</h3><p>The planner reserves fixed coverage first, then schedules work packages around skills, dependencies, availability and weekly limits.</p></div>}

    {preview && <>
      <div className="planner-summary">
        <div><span>Planned work</span><strong>{hours(preview.metrics.proposedWorkMinutes)}</strong><small>{preview.metrics.assignedWorkPackages} work packages</small></div>
        <div><span>Fixed coverage</span><strong>{hours(preview.metrics.proposedFixedCoverageMinutes)}</strong><small>reserved before project work</small></div>
        <div><span>Planned cost</span><strong>{money(preview.metrics.plannedCostCents)}</strong><small>based on employee rates</small></div>
        <div className={preview.metrics.unplannedWorkPackages > 0 ? "metric-alert" : ""}><span>Unplanned</span><strong>{preview.metrics.unplannedWorkPackages}</strong><small>work packages need attention</small></div>
      </div>

      {preview.warnings.length > 0 && <div className="planner-warnings"><strong>Plan diagnostics</strong>{preview.warnings.map((warning, index) => <div key={`${warning.code}-${index}`}><span>{warning.code.replaceAll("_", " ")}</span><p>{warning.message}</p></div>)}</div>}

      <div className="planner-timeline">
        {preview.weekSummaries.map((week) => {
          const weekAssignments = assignmentsByWeek.get(week.weekStart) ?? [];
          return <article className="panel planner-week" key={week.weekStart}>
            <div className="planner-week-heading"><div><span>Week of</span><h3>{new Date(`${week.weekStart}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</h3></div><strong className={week.utilizationPercent > 90 ? "utilization-hot" : ""}>{week.utilizationPercent}%</strong></div>
            <div className="utilization-track"><span style={{ width: `${Math.min(100, week.utilizationPercent)}%` }} /></div>
            <div className="week-capacity"><span>{hours(week.committedMinutes)} committed</span><span>{hours(week.proposedMinutes)} proposed</span><span>{money(week.plannedCostCents)}</span></div>
            <div className="week-assignments">{weekAssignments.length === 0 ? <p>No project work proposed.</p> : weekAssignments.map((assignment, index) => <div key={`${assignment.workPackageId}-${assignment.employeeId}-${assignment.startAt}-${index}`}><span className="assignment-color" /><div><strong>{assignment.workPackageName}</strong><small>{assignment.projectName} · {assignment.employeeName}</small></div><time>{new Date(assignment.startAt).toLocaleDateString(undefined, { weekday: "short" })} {new Date(assignment.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–{new Date(assignment.endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>)}</div>
          </article>;
        })}
      </div>

      {preview.unplannedWorkPackages.length > 0 && <div className="panel unplanned-panel"><h3>Unplanned scope</h3>{preview.unplannedWorkPackages.map((item) => <div key={item.workPackageId}><div><strong>{item.name}</strong><span>{item.reason}</span></div><b>{hours(item.unplannedMinutes)}</b></div>)}</div>}
      <div className="planner-actions"><div><strong>Preview only</strong><span>No shifts or progress have changed yet.</span></div><button className="primary-button" disabled={isApplying} type="button" onClick={() => void apply()}>{isApplying ? "Applying…" : "Apply rolling plan"}</button></div>
    </>}
  </section>;
}
