import { useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import type {
  AppliedPortfolioPlan,
  PlanningProfile,
  PortfolioPlanPreview,
  PortfolioResilienceReport,
  PortfolioScenarioComparison,
} from "../types";

const PROFILE_CONTENT: Record<PlanningProfile, { label: string; description: string }> = {
  BALANCED: {
    label: "Balanced",
    description: "Coverage and deadlines first, then cost and workload balance.",
  },
  COST_FIRST: {
    label: "Cost first",
    description: "Accepts more schedule exposure when that materially lowers labor cost.",
  },
  DEADLINE_FIRST: {
    label: "Deadline first",
    description: "Minimizes hard and soft deadline exposure before cost.",
  },
  RESILIENCE_FIRST: {
    label: "Resilience first",
    description: "Spreads scarce-skill work to reduce single-person concentration.",
  },
};

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

function gainHours(minutes: number, suffix = "") {
  return minutes === 0 ? "—" : `${hours(minutes)}${suffix ? ` ${suffix}` : ""}`;
}

function costOutcome(greedyCents: number, optimizedCents: number) {
  const difference = optimizedCents - greedyCents;
  if (difference === 0) return "—";
  return difference < 0
    ? `${money(Math.abs(difference))} lower`
    : `${money(difference)} additional`;
}

function signedCostDelta(cents: number) {
  if (cents === 0) return "same cost";
  return cents < 0 ? `${money(Math.abs(cents))} less` : `${money(cents)} more`;
}

function signedPercentDelta(basisPoints: number) {
  if (basisPoints === 0) return "same concentration";
  const points = Math.abs(basisPoints) / 100;
  return basisPoints < 0
    ? `${points.toFixed(0)}pp less concentrated`
    : `${points.toFixed(0)}pp more concentrated`;
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
  const [planningProfile, setPlanningProfile] = useState<PlanningProfile>("BALANCED");
  const [preview, setPreview] = useState<PortfolioPlanPreview | null>(null);
  const [comparison, setComparison] = useState<PortfolioScenarioComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isComparing, setIsComparing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [applied, setApplied] = useState<AppliedPortfolioPlan | null>(null);
  const [resilience, setResilience] = useState<PortfolioResilienceReport | null>(null);
  const [isTestingResilience, setIsTestingResilience] = useState(false);

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

  const optimizerGain = useMemo(() => {
    if (!preview) return false;
    const { greedyBaseline, optimized } = preview.optimizerDiagnostics;
    return optimized.plannedMinutes > greedyBaseline.plannedMinutes
      || optimized.unplannedMinutes < greedyBaseline.unplannedMinutes
      || optimized.overtimeMinutes < greedyBaseline.overtimeMinutes
      || optimized.laborCostCents < greedyBaseline.laborCostCents;
  }, [preview]);
  const balancedScenario = comparison?.scenarios.find(
    (scenario) => scenario.planningProfile === "BALANCED",
  );

  async function generate(profile = planningProfile) {
    setIsGenerating(true);
    setError(null);
    setApplied(null);
    setResilience(null);
    try {
      setPreview(await apiRequest<PortfolioPlanPreview>("/portfolio-plan/preview", {
        method: "POST",
        body: JSON.stringify({
          horizonStart,
          horizonWeeks,
          replaceGenerated,
          planningProfile: profile,
        }),
      }));
    } catch (generationError) {
      setPreview(null);
      setError(generationError instanceof Error ? generationError.message : "Planning failed");
    } finally {
      setIsGenerating(false);
    }
  }

  async function compareScenarios() {
    setIsComparing(true);
    setError(null);
    setApplied(null);
    setResilience(null);
    setPreview(null);
    try {
      setComparison(await apiRequest<PortfolioScenarioComparison>("/portfolio-plan/scenarios", {
        method: "POST",
        body: JSON.stringify({ horizonStart, horizonWeeks, replaceGenerated }),
      }));
    } catch (comparisonError) {
      setComparison(null);
      setError(comparisonError instanceof Error
        ? comparisonError.message
        : "Scenario comparison failed");
    } finally {
      setIsComparing(false);
    }
  }

  async function reviewScenario(profile: PlanningProfile) {
    setPlanningProfile(profile);
    await generate(profile);
  }

  async function testResilience() {
    if (!preview) return;
    setIsTestingResilience(true);
    setError(null);
    try {
      setResilience(await apiRequest<PortfolioResilienceReport>("/portfolio-plan/resilience", {
        method: "POST",
        body: JSON.stringify({
          horizonStart: preview.horizonStart,
          horizonWeeks: preview.horizonWeeks,
          replaceGenerated: preview.replaceGenerated,
          previewId: preview.previewId,
          inputVersion: preview.inputVersion,
          planningProfile: preview.planningProfile,
        }),
      }));
    } catch (resilienceError) {
      setResilience(null);
      setError(resilienceError instanceof Error
        ? resilienceError.message
        : "Resilience testing failed");
    } finally {
      setIsTestingResilience(false);
    }
  }

  async function apply() {
    if (!preview || !window.confirm(`Apply this ${preview.horizonWeeks}-week plan?`)) return;
    setIsApplying(true);
    setError(null);
    try {
      const result = await apiRequest<AppliedPortfolioPlan>("/portfolio-plan/apply", {
        method: "POST",
        body: JSON.stringify({ horizonStart: preview.horizonStart, horizonWeeks: preview.horizonWeeks, replaceGenerated: preview.replaceGenerated, planningProfile: preview.planningProfile, previewId: preview.previewId, inputVersion: preview.inputVersion }),
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
      <label>First week<input type="date" value={horizonStart} onChange={(event) => { setHorizonStart(event.target.value); setPreview(null); setComparison(null); }} /></label>
      <label>Horizon<select value={horizonWeeks} onChange={(event) => { setHorizonWeeks(Number(event.target.value)); setPreview(null); setComparison(null); }}>{[2,4,6,8,12].map((weeks) => <option value={weeks} key={weeks}>{weeks} weeks</option>)}</select></label>
      <label>Planning objective<select value={planningProfile} onChange={(event) => { setPlanningProfile(event.target.value as PlanningProfile); setPreview(null); setResilience(null); }}>{Object.entries(PROFILE_CONTENT).map(([profile, content]) => <option value={profile} key={profile}>{content.label}</option>)}</select></label>
      <label className="planner-replace"><input type="checkbox" checked={replaceGenerated} onChange={(event) => { setReplaceGenerated(event.target.checked); setPreview(null); setComparison(null); }} /><span><strong>Replace generated plan</strong><small>Manual and legacy shifts stay untouched.</small></span></label>
      <div className="planner-control-actions"><button className="secondary-button" disabled={isComparing || isGenerating} type="button" onClick={() => void compareScenarios()}>{isComparing ? "Comparing four plans…" : "Compare strategies"}</button><button className="primary-button" disabled={isGenerating || isComparing} type="button" onClick={() => void generate()}>{isGenerating ? "Planning…" : `Preview ${PROFILE_CONTENT[planningProfile].label}`}</button></div>
    </div>
    {error && <div className="error-message portfolio-error">{error}</div>}
    {applied && <div className="planner-success"><strong>Plan applied.</strong><span>{applied.createdShifts} allocations created, {applied.deletedShifts} generated allocations replaced.</span></div>}

    {comparison && <section className="planner-dashboard-section scenario-comparison">
      <div className="planner-section-heading"><div><span>Decision support</span><h3>Same portfolio, four planning objectives</h3><p>This is a fast bounded shortlist built from one portfolio snapshot. Review recomputes the selected objective with the full optimizer before Apply or N−1 validation.</p></div><div className="scenario-runtime"><span>Shortlist runtime</span><strong>{(comparison.runtimeMs / 1000).toFixed(1)}s</strong></div></div>
      <div className="scenario-grid">{comparison.scenarios.map((scenario) => {
        const content = PROFILE_CONTENT[scenario.planningProfile];
        const deadlineExposure = scenario.hardDeadlineExposureMinutes + scenario.softDeadlineExposureMinutes;
        const balancedDeadlineExposure = balancedScenario
          ? balancedScenario.hardDeadlineExposureMinutes
            + balancedScenario.softDeadlineExposureMinutes
          : 0;
        const costDelta = balancedScenario
          ? scenario.workPackageCostCents - balancedScenario.workPackageCostCents
          : 0;
        const deadlineDelta = deadlineExposure - balancedDeadlineExposure;
        const concentrationDelta = balancedScenario
          ? scenario.skillConcentrationBasisPoints
            - balancedScenario.skillConcentrationBasisPoints
          : 0;
        return <article className={`scenario-card ${planningProfile === scenario.planningProfile ? "scenario-selected" : ""}`} key={scenario.planningProfile}>
          <div><span>{scenario.planningProfile.replaceAll("_", " ")}</span><h4>{content.label}</h4><p>{content.description}</p></div>
          <dl><div><dt>Planned / unplanned</dt><dd>{hours(scenario.proposedWorkMinutes)} / {hours(scenario.unplannedMinutes)}</dd></div><div><dt>Work Package cost</dt><dd>{money(scenario.workPackageCostCents)}</dd></div><div><dt>Deadline exposure</dt><dd>{hours(deadlineExposure)}</dd></div><div><dt>Single-point exposure</dt><dd>{hours(scenario.singlePointExposureMinutes)}</dd></div><div><dt>Skill concentration</dt><dd>{(scenario.skillConcentrationBasisPoints / 100).toFixed(0)}%</dd></div></dl>
          <div className="scenario-deltas"><strong>{scenario.planningProfile === "BALANCED" ? "Comparison baseline" : "Difference from Balanced"}</strong>{scenario.planningProfile !== "BALANCED" && <><span>{signedCostDelta(costDelta)}</span><span>{deadlineDelta === 0 ? "same deadline exposure" : `${hours(Math.abs(deadlineDelta))} ${deadlineDelta < 0 ? "less" : "more"} deadline exposure`}</span><span>{signedPercentDelta(concentrationDelta)}</span></>}</div>
          <button className={planningProfile === scenario.planningProfile ? "primary-button" : "secondary-button"} disabled={isGenerating} type="button" onClick={() => void reviewScenario(scenario.planningProfile)}>{isGenerating && planningProfile === scenario.planningProfile ? "Building preview…" : "Review this plan"}</button>
        </article>;
      })}</div>
      <div className="scenario-note"><strong>Resilience here is a search proxy, not the N−1 result.</strong><span>After selecting a scenario, run the full deterministic employee-removal stress test on its preview.</span></div>
    </section>}

    {!preview && !applied && !comparison && <div className="planner-empty"><div className="planner-empty-icon">↗</div><h3>Build a defensible delivery plan</h3><p>Generate one objective directly, or compare all four strategies against the same portfolio snapshot.</p></div>}

    {preview && <>
      <div className="selected-profile"><div><span>Selected objective</span><strong>{PROFILE_CONTENT[preview.planningProfile].label}</strong><small>{PROFILE_CONTENT[preview.planningProfile].description}</small></div>{comparison && <button className="secondary-button" type="button" onClick={() => { setPreview(null); setResilience(null); }}>Back to comparison</button>}</div>
      <div className="planner-summary">
        <div><span>Planned work</span><strong>{hours(preview.metrics.proposedWorkMinutes)}</strong><small>{preview.metrics.assignedWorkPackages} work packages</small></div>
        <div><span>Fixed coverage</span><strong>{hours(preview.metrics.proposedFixedCoverageMinutes)}</strong><small>reserved before project work</small></div>
        <div><span>Planned cost</span><strong>{money(preview.metrics.plannedCostCents)}</strong><small>based on employee rates</small></div>
        <div className={preview.metrics.unplannedWorkPackages > 0 ? "metric-alert" : ""}><span>Unplanned</span><strong>{preview.metrics.unplannedWorkPackages}</strong><small>work packages need attention</small></div>
      </div>

      {warningGroups.length > 0 && <div className="planner-warnings"><strong>Plan diagnostics</strong>{warningGroups.map((warning) => <div key={warning.id}><span>{warning.code.replaceAll("_", " ")}</span><p>{warning.message}{warning.occurrences > 1 ? ` · ${warning.occurrences} occurrences` : ""}{warning.weeks.size > 0 ? ` across ${warning.weeks.size} week${warning.weeks.size === 1 ? "" : "s"}` : ""}</p></div>)}</div>}

      <section className="planner-dashboard-section">
        <div className="planner-section-heading">
          <div><span>Cost forecast</span><h3>What has been spent and what this plan would cost</h3><p>Confirmed work cost + scheduled horizon cost = known project cost. A preview never counts as completed work.</p></div>
          <div className={`budget-verdict ${budgetPortfolio.projects > 0 && budgetPortfolio.varianceCents > 0 ? "budget-over" : "budget-under"}`}><span>Portfolio budget remaining</span><strong>{budgetPortfolio.projects === 0 ? "No total budgets" : varianceLabel(budgetPortfolio.varianceCents)}</strong><small>Net across {budgetPortfolio.projects} projects · weekly caps checked separately</small></div>
        </div>

        <div className="cost-breakdown-grid">
          <div><span>Regular-hours cost</span><strong>{money(preview.metrics.regularCostCents)}</strong><small>{hours(preview.metrics.regularMinutes)} scheduled</small></div>
          <div className={preview.metrics.overtimeCostCents > 0 ? "cost-alert" : ""}><span>Overtime</span><strong>{money(preview.metrics.overtimeCostCents)}</strong><small>{hours(preview.metrics.overtimeMinutes)}</small></div>
          <div><span>Fixed coverage cost</span><strong>{money(preview.metrics.fixedCoverageCostCents)}</strong><small>recurring operational commitments</small></div>
          <div><span>Work Package cost</span><strong>{money(preview.metrics.workPackageCostCents)}</strong><small>project scope proposed by optimizer</small></div>
          <div><span>Average planned rate</span><strong>{moneyRate(preview.metrics.averagePlannedHourlyCostCents)}</strong><small>per allocated hour</small></div>
        </div>

        <div className="project-budget-list">
          <div className="project-budget-header"><span>Project</span><span>Completed work cost</span><span>Next {preview.horizonWeeks} weeks</span><span>Actual + plan</span><span>Approved budget</span><span>Budget remaining</span></div>
          {preview.projectCostSummaries.map((project) => {
            const usage = project.totalBudgetCents && project.totalBudgetCents > 0 ? Math.min(100, project.knownCostCents / project.totalBudgetCents * 100) : 0;
            return <article className="project-budget-row" key={project.projectId}>
              <div className="project-budget-main">
                <div><strong>{project.projectName}</strong><small>{project.knownCostCents === 0 ? "No scheduled labor" : project.forecastComplete ? "All current scope scheduled" : "Partial scope forecast"}</small></div>
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
                  return <div key={week.weekStart} title={`${week.weekStart}: ${varianceLabel(week.weeklyBudgetVarianceCents)}`}><span>{new Date(`${week.weekStart}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span><i><b className={week.weeklyBudgetVarianceCents !== null && week.weeklyBudgetVarianceCents > 0 ? "week-over" : ""} style={{ width: `${weeklyUsage}%` }} /></i><small>{money(week.plannedCostCents)}{week.weeklyBudgetCents === null ? " · no cap" : ` / ${money(week.weeklyBudgetCents)} cap`}</small></div>;
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
          <div className="optimizer-comparison-header"><span>Objective</span><span>Greedy</span><span>Optimized</span><span>Outcome</span></div>
          <div><strong>Planned work</strong><span>{hours(preview.optimizerDiagnostics.greedyBaseline.plannedMinutes)}</span><span>{hours(preview.optimizerDiagnostics.optimized.plannedMinutes)}</span><b>{gainHours(preview.optimizerDiagnostics.optimized.plannedMinutes - preview.optimizerDiagnostics.greedyBaseline.plannedMinutes)}</b></div>
          <div><strong>Unplanned work</strong><span>{hours(preview.optimizerDiagnostics.greedyBaseline.unplannedMinutes)}</span><span>{hours(preview.optimizerDiagnostics.optimized.unplannedMinutes)}</span><b>{gainHours(preview.optimizerDiagnostics.greedyBaseline.unplannedMinutes - preview.optimizerDiagnostics.optimized.unplannedMinutes, "reduced")}</b></div>
          <div><strong>Overtime</strong><span>{hours(preview.optimizerDiagnostics.greedyBaseline.overtimeMinutes)}</span><span>{hours(preview.optimizerDiagnostics.optimized.overtimeMinutes)}</span><b>{gainHours(preview.optimizerDiagnostics.greedyBaseline.overtimeMinutes - preview.optimizerDiagnostics.optimized.overtimeMinutes, "reduced")}</b></div>
          <div><strong>Labor cost</strong><span>{money(preview.optimizerDiagnostics.greedyBaseline.laborCostCents)}</span><span>{money(preview.optimizerDiagnostics.optimized.laborCostCents)}</span><b>{costOutcome(preview.optimizerDiagnostics.greedyBaseline.laborCostCents, preview.optimizerDiagnostics.optimized.laborCostCents)}</b></div>
        </div>

        <div className={`optimizer-verdict ${optimizerGain ? "optimizer-verdict-gain" : "optimizer-verdict-neutral"}`}><strong>{optimizerGain ? "The optimizer improved this portfolio input." : "Greedy already found an optimal plan for this input."}</strong><span>{optimizerGain ? "The gains above are measured against the same Work Package scope and constraints." : "No additional coverage, overtime reduction or cost saving was available in this scenario."}</span></div>

        <div className="optimizer-facts">
          <div><span>Runtime</span><strong>{preview.optimizerDiagnostics.runtimeMs} ms</strong></div>
          <div><span>States explored</span><strong>{preview.optimizerDiagnostics.exploredStates}</strong></div>
          <div><span>States pruned</span><strong>{preview.optimizerDiagnostics.prunedStates + preview.optimizerDiagnostics.dominancePrunedStates}</strong></div>
          <div><span>Plans evaluated</span><strong>{preview.optimizerDiagnostics.evaluatedPlans}</strong></div>
          <div className={preview.optimizerDiagnostics.searchLimitReached ? "search-limit" : ""}><span>Search limit</span><strong>{preview.optimizerDiagnostics.searchLimitReached ? "Reached" : "Not reached"}</strong></div>
        </div>
      </section>

      <section className="planner-dashboard-section resilience-dashboard">
        <div className="planner-section-heading">
          <div><span>Operational risk</span><h3>N−1 schedule resilience</h3><p>Each scenario removes one scheduled employee and rebuilds the same horizon under the same skills, availability, capacity, dependency and deadline constraints.</p></div>
          <button className="secondary-button" disabled={isTestingResilience || preview.resilienceCandidates.length === 0} type="button" onClick={() => void testResilience()}>{isTestingResilience ? `Testing ${preview.resilienceCandidates.length} absences…` : resilience ? "Run stress test again" : "Run N−1 stress test"}</button>
        </div>

        {!resilience && <div className="resilience-intro"><strong>This analysis is intentionally separate from planning.</strong><span>It runs {preview.resilienceCandidates.length} additional deterministic plans and does not modify shifts or progress.</span></div>}

        {resilience && <>
          <div className="resilience-summary">
            <div className={resilience.recoverableAbsences < resilience.testedAbsences ? "resilience-risk" : ""}><span>Full recovery rate</span><strong>{resilience.recoverableAbsences}/{resilience.testedAbsences}</strong><small>absences recovered without new gaps</small></div>
            <div><span>Average coverage retained</span><strong>{resilience.scorePercent}%</strong><small>scheduled minutes, not probability</small></div>
            <div className={resilience.worstCaseCoveragePercent < 100 ? "resilience-risk" : ""}><span>Worst case</span><strong>{resilience.worstCaseCoveragePercent}%</strong><small>{resilience.worstCaseEmployee ?? "No scheduled employees"}</small></div>
            <div className={resilience.criticalGapsAtRisk > 0 ? "resilience-risk" : ""}><span>Critical coverage gaps</span><strong>{resilience.criticalGapsAtRisk}</strong><small>occurrences in worst scenario</small></div>
            <div><span>Required reassignments</span><strong>{resilience.maxRequiredReassignments}</strong><small>worst single absence</small></div>
          </div>

          <div className={`resilience-verdict ${resilience.employeesWithNoFullReplacement.length > 0 ? "resilience-verdict-risk" : "resilience-verdict-safe"}`}><div><strong>{resilience.employeesWithNoFullReplacement.length === 0 ? "Every tested absence is fully recoverable." : `Portfolio is fragile: only ${resilience.recoverableAbsences}/${resilience.testedAbsences} absences fully recover.`}</strong>{resilience.employeesWithNoFullReplacement.length > 0 && <small>No full replacement: {resilience.employeesWithNoFullReplacement.join(", ")}</small>}</div><span>{resilience.algorithmVersion} · {resilience.testedAbsences} replans · {(resilience.runtimeMs / 1000).toFixed(1)}s</span></div>

          <div className="resilience-scenarios">
            <div className="resilience-scenario-header"><span>Removed employee</span><span>Affected plan</span><span>Coverage retained</span><span>Unrecovered</span><span>Cost change</span><span>Result</span></div>
            {resilience.scenarios.map((scenario) => <div key={scenario.employeeId}>
              <strong>{scenario.employeeName}</strong>
              <span>{scenario.affectedAllocations} allocations · {hours(scenario.affectedMinutes)}</span>
              <span>{scenario.coveragePercent}%</span>
              <span>{hours(scenario.lostMinutes)}{scenario.criticalGapsAtRisk > 0 ? ` · ${scenario.criticalGapsAtRisk} critical gaps` : ""}</span>
              <span>{scenario.additionalCostCents === null ? "Not comparable" : scenario.additionalCostCents === 0 ? "—" : `${scenario.additionalCostCents > 0 ? "+" : "−"}${money(Math.abs(scenario.additionalCostCents))}`}</span>
              <b className={scenario.recoverable ? "scenario-recovered" : "scenario-at-risk"}>{scenario.recoverable ? "Recovered" : "At risk"}</b>
            </div>)}
          </div>
        </>}
      </section>

      <div className="planner-timeline">
        {preview.weekSummaries.map((week) => {
          const weekAssignments = assignmentsByWeek.get(week.weekStart) ?? [];
          return <article className="panel planner-week" key={week.weekStart}>
            <div className="planner-week-heading"><div><span>Week of</span><h3>{new Date(`${week.weekStart}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</h3></div><div className="week-utilization"><span>Capacity utilization</span><strong className={week.utilizationPercent > 90 ? "utilization-hot" : ""}>{week.utilizationPercent}%</strong></div></div>
            <div className="utilization-track"><span style={{ width: `${Math.min(100, week.utilizationPercent)}%` }} /></div>
            <div className="week-capacity"><span><strong>{hours(week.committedMinutes + week.proposedMinutes)}</strong> of {hours(week.capacityMinutes)} allocated</span><span><strong>{hours(Math.max(0, week.capacityMinutes - week.committedMinutes - week.proposedMinutes))}</strong> available</span><span>{hours(week.committedMinutes)} commitments + {hours(week.proposedMinutes)} portfolio work</span><span>{money(week.plannedCostCents)}</span></div>
            <div className="week-assignments">{weekAssignments.length === 0 ? <p>No project work proposed.</p> : weekAssignments.map((assignment, index) => <div key={`${assignment.workPackageId}-${assignment.employeeId}-${assignment.startAt}-${index}`}><span className="assignment-color" /><div><strong>{assignment.workPackageName}</strong><small>{assignment.projectName} · {assignment.employeeName}</small></div><time>{new Date(assignment.startAt).toLocaleDateString(undefined, { weekday: "short" })} {new Date(assignment.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–{new Date(assignment.endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>)}</div>
          </article>;
        })}
      </div>

      {preview.unplannedWorkPackages.length > 0 && <div className="panel unplanned-panel"><h3>Unplanned scope</h3>{preview.unplannedWorkPackages.map((item) => <div key={item.workPackageId}><div><strong>{item.name}</strong><span>{item.reason}</span></div><b>{hours(item.unplannedMinutes)}</b></div>)}</div>}
      <div className="planner-actions"><div><strong>Preview only</strong><span>No shifts or progress have changed yet.</span></div><button className="primary-button" disabled={isApplying} type="button" onClick={() => void apply()}>{isApplying ? "Applying…" : "Apply rolling plan"}</button></div>
    </>}
  </section>;
}
