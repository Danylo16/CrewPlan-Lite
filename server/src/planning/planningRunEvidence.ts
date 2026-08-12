import type { buildPortfolioPlanPreview } from "./portfolioPlan.js";

export const PLANNING_EVIDENCE_VERSION = "planning-run-evidence-v1";

type PortfolioPreview = Awaited<ReturnType<typeof buildPortfolioPlanPreview>>;

type JsonRecord = Record<string, unknown>;

interface PlanningRunRecord {
  id: string;
  previewId: string;
  inputVersion: string;
  horizonStart: Date;
  horizonEndExclusive: Date;
  replaceMode: string;
  status: string;
  configuration: unknown;
  metrics: unknown;
  evidence: unknown;
  appliedAt: Date;
  supersededAt: Date | null;
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function buildPlanningRunEvidence(
  preview: PortfolioPreview,
  reportedComparisonId?: string,
) {
  const diagnostics = preview.optimizerDiagnostics;
  return {
    evidenceVersion: PLANNING_EVIDENCE_VERSION,
    selection: {
      context: reportedComparisonId === undefined
        ? "DIRECT_PREVIEW"
        : "SCENARIO_COMPARISON_REPORTED",
      reportedComparisonId: reportedComparisonId ?? null,
    },
    optimizer: {
      planningProfile: preview.planningProfile,
      algorithmVersion: diagnostics.algorithmVersion,
      strategy: diagnostics.strategy,
      runtimeMs: diagnostics.runtimeMs,
      limits: {
        beamWidth: diagnostics.beamWidth,
        packageVariantWidth: diagnostics.packageVariantWidth,
        branchWidth: diagnostics.branchWidth,
        placementStateLimit: diagnostics.placementStateLimit,
      },
      search: {
        orderExploredStates: diagnostics.orderExploredStates,
        placementExploredStates: diagnostics.placementExploredStates,
        orderPrunedStates: diagnostics.orderPrunedStates,
        placementPrunedStates: diagnostics.placementPrunedStates,
        dominancePrunedStates: diagnostics.dominancePrunedStates,
        evaluatedPlans: diagnostics.evaluatedPlans,
        searchLimitReached: diagnostics.searchLimitReached,
      },
      objectiveVector: diagnostics.objectiveVector,
      baselines: {
        greedy: diagnostics.greedyBaseline,
        previousBeam: diagnostics.v1Baseline,
        optimized: diagnostics.optimized,
        improvementVsGreedy: diagnostics.improvement,
        improvementVsPreviousBeam: diagnostics.improvementVsV1,
      },
    },
    plan: {
      workPackageAssignments: preview.assignments.length,
      fixedCoverageAssignments: preview.fixedCoverageAssignments.length,
      unplannedWorkPackages: preview.unplannedWorkPackages.length,
      warningCount: preview.warnings.length,
      allocations: [
        ...preview.assignments.map((assignment) => ({
          kind: "WORK_PACKAGE",
          employeeId: assignment.employeeId,
          projectId: assignment.projectId,
          workPackageId: assignment.workPackageId,
          projectRequirementId: null,
          startAt: assignment.startAt,
          endAt: assignment.endAt,
          plannedCostCents: assignment.plannedCostCents,
        })),
        ...preview.fixedCoverageAssignments.map((assignment) => ({
          kind: "FIXED_COVERAGE",
          employeeId: assignment.employeeId,
          projectId: assignment.projectId,
          workPackageId: null,
          projectRequirementId: assignment.projectRequirementId,
          startAt: assignment.startAt,
          endAt: assignment.endAt,
          plannedCostCents: assignment.plannedCostCents,
        })),
      ],
    },
    warnings: preview.warnings,
  };
}

export function planningRunSummary(run: PlanningRunRecord) {
  const configuration = record(run.configuration);
  const evidence = record(run.evidence);
  const optimizer = record(evidence.optimizer);
  return {
    id: run.id,
    previewId: run.previewId,
    inputVersion: run.inputVersion,
    horizonStart: dateOnly(run.horizonStart),
    horizonEndExclusive: dateOnly(run.horizonEndExclusive),
    replaceMode: run.replaceMode,
    status: run.status,
    planningProfile:
      stringValue(optimizer.planningProfile)
      ?? stringValue(configuration.planningProfile),
    algorithmVersion: stringValue(optimizer.algorithmVersion),
    strategy: stringValue(optimizer.strategy),
    evidenceVersion: stringValue(evidence.evidenceVersion),
    hasEvidence: Object.keys(evidence).length > 0,
    metrics: record(run.metrics),
    objectiveVector: Object.keys(record(optimizer.objectiveVector)).length > 0
      ? record(optimizer.objectiveVector)
      : null,
    searchDiagnostics: Object.keys(record(optimizer.search)).length > 0
      ? record(optimizer.search)
      : null,
    appliedAt: run.appliedAt.toISOString(),
    supersededAt: run.supersededAt?.toISOString() ?? null,
  };
}

export function planningRunDetail<T extends PlanningRunRecord & { shifts: unknown[] }>(
  run: T,
) {
  const evidence = record(run.evidence);
  const plan = record(evidence.plan);
  return {
    ...planningRunSummary(run),
    configuration: record(run.configuration),
    evidence,
    allocationSnapshot: Array.isArray(plan.allocations) ? plan.allocations : [],
    currentAllocations: run.shifts,
  };
}
