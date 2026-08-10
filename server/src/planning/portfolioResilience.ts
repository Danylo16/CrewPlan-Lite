import { buildPortfolioPlanPreview } from "./portfolioPlan.js";
import type { PlanningDatabase, PortfolioPlanOptions } from "./portfolioPlan.js";

const MAX_RESILIENCE_SCENARIOS = 12;

export interface PortfolioResilienceOptions extends Omit<PortfolioPlanOptions, "excludedEmployeeIds"> {
  previewId: string;
  inputVersion: string;
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}

export async function buildPortfolioResilienceReport(
  database: PlanningDatabase,
  options: PortfolioResilienceOptions,
) {
  const startedAt = Date.now();
  const planOptions: PortfolioPlanOptions = {
    horizonStart: options.horizonStart,
    horizonWeeks: options.horizonWeeks,
    replaceGenerated: options.replaceGenerated,
  };
  const baseline = await buildPortfolioPlanPreview(database, planOptions);
  if (baseline.previewId !== options.previewId || baseline.inputVersion !== options.inputVersion) {
    throw new Error("PORTFOLIO_PREVIEW_STALE");
  }
  if (baseline.resilienceCandidates.length > MAX_RESILIENCE_SCENARIOS) {
    throw new Error("RESILIENCE_INPUT_TOO_LARGE");
  }

  const baselineMinutes = baseline.metrics.allocatedMinutes;
  const baselineCriticalRisks = baseline.metrics.unfilledCriticalFixedCoveragePositions
    + baseline.metrics.criticalUnplannedWorkPackages;
  const scenarios = [];

  for (const candidate of baseline.resilienceCandidates) {
    const scenarioStartedAt = Date.now();
    const scenario = await buildPortfolioPlanPreview(database, {
      ...planOptions,
      excludedEmployeeIds: [candidate.employeeId],
    });
    const allocatedMinutes = Math.min(baselineMinutes, scenario.metrics.allocatedMinutes);
    const lostMinutes = Math.max(0, baselineMinutes - allocatedMinutes);
    const criticalGapsAtRisk = Math.max(
      0,
      scenario.metrics.unfilledCriticalFixedCoveragePositions
        + scenario.metrics.criticalUnplannedWorkPackages
        - baselineCriticalRisks,
    );
    const coveragePercent = baselineMinutes === 0
      ? 100
      : roundPercent((allocatedMinutes / baselineMinutes) * 100);

    scenarios.push({
      employeeId: candidate.employeeId,
      employeeName: candidate.employeeName,
      affectedAllocations: candidate.allocationCount,
      affectedMinutes: candidate.scheduledMinutes,
      recoveredMinutes: allocatedMinutes,
      lostMinutes,
      coveragePercent,
      criticalGapsAtRisk,
      additionalCostCents: lostMinutes === 0 && criticalGapsAtRisk === 0
        ? scenario.metrics.plannedCostCents - baseline.metrics.plannedCostCents
        : null,
      recoverable: lostMinutes === 0 && criticalGapsAtRisk === 0,
      runtimeMs: Date.now() - scenarioStartedAt,
    });
  }

  scenarios.sort((first, second) =>
    first.coveragePercent - second.coveragePercent
    || second.criticalGapsAtRisk - first.criticalGapsAtRisk
    || second.lostMinutes - first.lostMinutes
    || first.employeeId - second.employeeId,
  );
  const testedAbsences = scenarios.length;
  const averageCoveragePercent = testedAbsences === 0
    ? 100
    : roundPercent(
      scenarios.reduce((total, scenario) => total + scenario.coveragePercent, 0)
        / testedAbsences,
    );
  const worstCaseCoveragePercent = scenarios[0]?.coveragePercent ?? 100;
  const recoverableAbsences = scenarios.filter((scenario) => scenario.recoverable).length;
  const employeesWithNoFullReplacement = scenarios
    .filter((scenario) => !scenario.recoverable)
    .map((scenario) => scenario.employeeName);

  return {
    previewId: baseline.previewId,
    inputVersion: baseline.inputVersion,
    horizonStart: baseline.horizonStart,
    horizonEndExclusive: baseline.horizonEndExclusive,
    horizonWeeks: baseline.horizonWeeks,
    algorithmVersion: "portfolio-resilience-n-minus-one-v1",
    strategy: "DETERMINISTIC_EMPLOYEE_REMOVAL_AND_REOPTIMIZATION",
    scorePercent: averageCoveragePercent,
    averageCoveragePercent,
    worstCaseCoveragePercent,
    testedAbsences,
    recoverableAbsences,
    criticalGapsAtRisk: Math.max(
      0,
      ...scenarios.map((scenario) => scenario.criticalGapsAtRisk),
    ),
    maxRequiredReassignments: Math.max(
      0,
      ...scenarios.map((scenario) => scenario.affectedAllocations),
    ),
    employeesWithNoFullReplacement,
    worstCaseEmployee: scenarios[0]?.employeeName ?? null,
    baselineAllocatedMinutes: baselineMinutes,
    runtimeMs: Date.now() - startedAt,
    scenarios,
  };
}
