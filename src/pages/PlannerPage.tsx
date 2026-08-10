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

function moneyRate(cents: number) {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

function varianceLabel(cents: number | null) {
  if (cents === null) return "Budget not set";
  if (cents === 0) return "On budget";
  return `${money(Math.abs(cents))} ${cents > 0 ? "over" : "under"}`;
}

function strategyLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function weekOf(value: string) {
  const date = new Date(value);
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = local.getDay() || 7;
  local.setDate(local.getDate() - day + 1);
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const dateOfMonth = String(local.getDate()).padStart(2, "0");
  return `${year}-${month}-${dateOfMonth}`;
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

  const budgetPortfolio = useMemo(() => {
    const projects = preview?.projectCostSummaries.filter((project) => project.totalBudgetCents !== null) ?? [];
    const budgetCents = projects.reduce((sum, project) => sum + (project.totalBudgetCents ?? 0), 0);
    const knownCostCents = projects.reduce((sum, project) => sum + project.knownCostCents, 0);
    return { projects: projects.length, budgetCents, knownCostCents, varianceCents: knownCostCents - budgetCents };
  }, [preview]);

  const warningGroups = useMemo(() => {
    const groups = new Map<string, { id: string; code: string; message: string; occurrences: number; weeks: Set<string> }>();
    for (const warning of preview?.warnings ?? []) {
      const key = `${warning.code}:${warning.message}:${warning.projectId ?? "portfolio"}`;
      const group = groups.get(key) ?? { id: key, code: warning.code, message: warning.message, occurrences: 0, weeks: new Set<string>() };
      group.occurrences += 1;
      if (warning.weekStart) group.weeks.add(warning.weekStart);
      groups.set(key, group);
    }
    return [...groups.values()];
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

      {warningGroups.length > 0 && <div className="planner-warnings"><strong>Plan diagnostics</strong>{warningGroups.map((warning) => <div key={warning.id}><span>{warning.code.replaceAll("_", " ")}</span><p>{warning.message}{warning.occurrences > 1 ? ` · ${warning.occurrences} occurrences` : ""}{warning.weeks.size > 0 ? ` across ${warning.weeks.size} week${warning.weeks.size === 1 ? "" : "s"}` : ""}</p></div>)}</div>}

      <section className="planner-dashboard-section">
        <div className="planner-section-heading">
          <div><span>Cost control</span><h3>Labor cost and budget variance</h3><p>Committed and proposed labor are kept separate from actual work already logged.</p></div>
          <div className={`budget-verdict ${budgetPortfolio.projects > 0 && budgetPortfolio.varianceCents > 0 ? "budget-over" : "budget-under"}`}><span>Budgeted projects</span><strong>{budgetPortfolio.projects === 0 ? "No total budgets" : varianceLabel(budgetPortfolio.varianceCents)}</strong><small>{budgetPortfolio.projects} with total budgets</small></div>
        </div>

        <div className="cost-breakdown-grid">
          <div><span>Regular labor</span><strong>{money(preview.metrics.regularCostCents)}</strong><small>{hours(preview.metrics.regularMinutes)}</small></div>
          <div className={preview.metrics.overtimeCostCents > 0 ? "cost-alert" : ""}><span>Overtime</span><strong>{money(preview.metrics.overtimeCostCents)}</strong><small>{hours(preview.metrics.overtimeMinutes)}</small></div>
          <div><span>Fixed coverage</span><strong>{money(preview.metrics.fixedCoverageCostCents)}</strong><small>operational commitments</small></div>
          <div><span>Work packages</span><strong>{money(preview.metrics.workPackageCostCents)}</strong><small>optimized project scope</small></div>
          <div><span>Average planned rate</span><strong>{moneyRate(preview.metrics.averagePlannedHourlyCostCents)}</strong><small>per allocated hour</small></div>
        </div>

        <div className="project-budget-list">
          <div className="project-budget-header"><span>Project</span><span>Actual</span><span>Planned</span><span>Known cost</span><span>Total budget</span><span>Variance</span></div>
          {preview.projectCostSummaries.map((project) => {
            const usage = project.totalBudgetCents && project.totalBudgetCents > 0 ? Math.min(100, project.knownCostCents / project.totalBudgetCents * 100) : 0;
            return <article className="project-budget-row" key={project.projectId}>
              <div className="project-budget-main">
                <div><strong>{project.projectName}</strong><small>{project.knownCostCents === 0 ? "No forecasted labor" : project.forecastComplete ? "Forecast complete" : "Partial forecast"}</small></div>
                <span>{money(project.actualCostCents)}</span>
                <span>{money(project.plannedCostCents)}<small>{money(project.workPackageCostCents)} scope</small></span>
                <span>{money(project.knownCostCents)}</span>
                <span>{project.totalBudgetCents === null ? "Not set" : money(project.totalBudgetCents)}</span>
                <span className={project.totalBudgetVarianceCents === null ? "variance-neutral" : project.totalBudgetVarianceCents > 0 ? "variance-over" : "variance-under"}>{varianceLabel(project.totalBudgetVarianceCents)}</span>
              </div>
              {project.totalBudgetCents !== null && <div className={`budget-progress ${project.totalBudgetVarianceCents !== null && project.totalBudgetVarianceCents > 0 ? "budget-progress-over" : ""}`}><span style={{ width: `${usage}%` }} /></div>}
              <div className="week-budget-strip">
                {project.weeks.map((week) => {
                  const weeklyUsage = week.weeklyBudgetCents && week.weeklyBudgetCents > 0 ? Math.min(100, week.plannedCostCents / week.weeklyBudgetCents * 100) : 0;
                  return <div key={week.weekStart} title={`${week.weekStart}: ${varianceLabel(week.weeklyBudgetVarianceCents)}`}><span>{new Date(`${week.weekStart}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span><i><b className={week.weeklyBudgetVarianceCents !== null && week.weeklyBudgetVarianceCents > 0 ? "week-over" : ""} style={{ width: `${weeklyUsage}%` }} /></i><small>{money(week.plannedCostCents)}</small></div>;
                })}
              </div>
            </article>;
          })}
        </div>
      </section>

      <section className="planner-dashboard-section optimizer-dashboard">
        <div className="planner-section-heading">
          <div><span>Optimization evidence</span><h3>Greedy baseline vs optimized plan</h3><p>This comparison covers Work Package placement only; Fixed Coverage cost is excluded from both sides.</p></div>
          <div className="optimizer-version"><strong>{preview.optimizerDiagnostics.algorithmVersion}</strong><span>{strategyLabel(preview.optimizerDiagnostics.strategy)}</span></div>
        </div>

        <div className="optimizer-comparison">
          <div className="optimizer-comparison-header"><span>Objective</span><span>Greedy</span><span>Optimized</span><span>Gain</span></div>
          <div><strong>Planned work</strong><span>{hours(preview.optimizerDiagnostics.greedyBaseline.plannedMinutes)}</span><span>{hours(preview.optimizerDiagnostics.optimized.plannedMinutes)}</span><b>{hours(preview.optimizerDiagnostics.optimized.plannedMinutes - preview.optimizerDiagnostics.greedyBaseline.plannedMinutes)}</b></div>
          <div><strong>Unplanned work</strong><span>{hours(preview.optimizerDiagnostics.greedyBaseline.unplannedMinutes)}</span><span>{hours(preview.optimizerDiagnostics.optimized.unplannedMinutes)}</span><b>{hours(preview.optimizerDiagnostics.greedyBaseline.unplannedMinutes - preview.optimizerDiagnostics.optimized.unplannedMinutes)} reduced</b></div>
          <div><strong>Overtime</strong><span>{hours(preview.optimizerDiagnostics.greedyBaseline.overtimeMinutes)}</span><span>{hours(preview.optimizerDiagnostics.optimized.overtimeMinutes)}</span><b>{hours(preview.optimizerDiagnostics.greedyBaseline.overtimeMinutes - preview.optimizerDiagnostics.optimized.overtimeMinutes)} reduced</b></div>
          <div><strong>Labor cost</strong><span>{money(preview.optimizerDiagnostics.greedyBaseline.laborCostCents)}</span><span>{money(preview.optimizerDiagnostics.optimized.laborCostCents)}</span><b>{money(preview.optimizerDiagnostics.greedyBaseline.laborCostCents - preview.optimizerDiagnostics.optimized.laborCostCents)} saved</b></div>
        </div>

        <div className="optimizer-facts">
          <div><span>Runtime</span><strong>{preview.optimizerDiagnostics.runtimeMs} ms</strong></div>
          <div><span>States explored</span><strong>{preview.optimizerDiagnostics.exploredStates}</strong></div>
          <div><span>States pruned</span><strong>{preview.optimizerDiagnostics.prunedStates + preview.optimizerDiagnostics.dominancePrunedStates}</strong></div>
          <div><span>Plans evaluated</span><strong>{preview.optimizerDiagnostics.evaluatedPlans}</strong></div>
          <div className={preview.optimizerDiagnostics.searchLimitReached ? "search-limit" : ""}><span>Search limit</span><strong>{preview.optimizerDiagnostics.searchLimitReached ? "Reached" : "Not reached"}</strong></div>
        </div>
      </section>

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
