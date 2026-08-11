import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import type { Prisma } from "../generated/prisma/client.js";
import { buildSchedulePreview } from "../scheduling/schedulePreview.js";
import { allocationCostBreakdown } from "../scheduling/scoring.js";
import { SCHEDULE_TIME_ZONE } from "../scheduling/timeAdapter.js";
import {
  allocatePortfolioScenarioPlans,
  allocatePortfolioWork,
} from "./portfolioPlacementOptimizer.js";
import type {
  Interval,
  OptimizerSearchMode,
  PlanningProfile,
} from "./portfolioOptimizer.js";

const MAX_HORIZON_WEEKS = 12;
const MAX_WORK_PACKAGES = 150;

export type PlanningDatabase = Pick<
  Prisma.TransactionClient,
  "employee" | "project" | "projectRequirement" | "shift"
>;

export interface PortfolioPlanOptions {
  horizonStart: string;
  horizonWeeks: number;
  replaceGenerated: boolean;
  excludedEmployeeIds?: number[];
  planningProfile?: PlanningProfile;
  optimizerSearchMode?: OptimizerSearchMode;
  optimizerRunner?: typeof allocatePortfolioWork;
}

const PLANNING_PROFILES: PlanningProfile[] = [
  "BALANCED",
  "COST_FIRST",
  "DEADLINE_FIRST",
  "RESILIENCE_FIRST",
];

type ReadDelegate = {
  findMany(args: unknown): Promise<unknown>;
};

function memoizedDelegate(delegate: ReadDelegate) {
  const reads = new Map<string, Promise<unknown>>();
  return {
    findMany(args: unknown) {
      const key = JSON.stringify(args);
      const existing = reads.get(key);
      if (existing) return existing;
      const result = delegate.findMany(args);
      reads.set(key, result);
      return result;
    },
  };
}

function snapshotDatabase(database: PlanningDatabase): PlanningDatabase {
  return {
    employee: memoizedDelegate(database.employee as unknown as ReadDelegate),
    project: memoizedDelegate(database.project as unknown as ReadDelegate),
    projectRequirement: memoizedDelegate(
      database.projectRequirement as unknown as ReadDelegate,
    ),
    shift: memoizedDelegate(database.shift as unknown as ReadDelegate),
  } as PlanningDatabase;
}

interface CostedInterval extends Interval {
  employeeId: number;
  projectId: number;
  regularMinutes: number;
  overtimeMinutes: number;
  regularCostCents: number;
  overtimeCostCents: number;
  plannedCostCents: number;
}

function costTotals(items: CostedInterval[]) {
  return items.reduce((totals, item) => ({
    minutes: totals.minutes
      + Math.round((item.endAt.getTime() - item.startAt.getTime()) / 60_000),
    regularMinutes: totals.regularMinutes + item.regularMinutes,
    overtimeMinutes: totals.overtimeMinutes + item.overtimeMinutes,
    regularCostCents: totals.regularCostCents + item.regularCostCents,
    overtimeCostCents: totals.overtimeCostCents + item.overtimeCostCents,
    plannedCostCents: totals.plannedCostCents + item.plannedCostCents,
  }), {
    minutes: 0,
    regularMinutes: 0,
    overtimeMinutes: 0,
    regularCostCents: 0,
    overtimeCostCents: 0,
    plannedCostCents: 0,
  });
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function monday(value: string) {
  const date = DateTime.fromISO(value, { zone: SCHEDULE_TIME_ZONE });
  if (!date.isValid) throw new Error("HORIZON_START_INVALID");
  if (date.weekday !== 1) throw new Error("HORIZON_START_NOT_MONDAY");
  return date.startOf("day");
}

function weekKey(date: Date) {
  return DateTime.fromJSDate(date, { zone: SCHEDULE_TIME_ZONE })
    .startOf("week")
    .toISODate()!;
}

export async function buildPortfolioPlanPreview(
  database: PlanningDatabase,
  options: PortfolioPlanOptions,
) {
  if (!Number.isInteger(options.horizonWeeks) || options.horizonWeeks < 1 || options.horizonWeeks > MAX_HORIZON_WEEKS) {
    throw new Error("HORIZON_WEEKS_INVALID");
  }
  const start = monday(options.horizonStart);
  const end = start.plus({ weeks: options.horizonWeeks });
  const horizonStart = start.toUTC().toJSDate();
  const horizonEndExclusive = end.toUTC().toJSDate();

  const fixedPreviews = await Promise.all(
    Array.from({ length: options.horizonWeeks }, (_, index) => buildSchedulePreview(
      database,
      start.plus({ weeks: index }).toISODate()!,
      options.replaceGenerated,
      options.excludedEmployeeIds ?? [],
    )),
  );

  const [employees, projects, horizonShifts, futureWorkPackageShifts] = await Promise.all([
    database.employee.findMany({
      where: {
        archivedAt: null,
        ...(options.excludedEmployeeIds?.length
          ? { id: { notIn: options.excludedEmployeeIds } }
          : {}),
      },
      include: { skills: true, availability: true },
      orderBy: { id: "asc" },
    }),
    database.project.findMany({
      where: { status: { in: ["PLANNED", "ACTIVE"] }, archivedAt: null },
      include: {
        workLogs: { where: { status: "CONFIRMED" }, select: { actualCostCents: true } },
        workPackages: {
          where: { status: { in: ["TODO", "IN_PROGRESS"] } },
          include: { incomingDependencies: { include: { predecessor: true } } },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ priority: "desc" }, { id: "asc" }],
    }),
    database.shift.findMany({
      where: { status: "COMMITTED", startAt: { lt: horizonEndExclusive }, endAt: { gt: horizonStart } },
      orderBy: { id: "asc" },
    }),
    database.shift.findMany({
      where: { status: "COMMITTED", kind: "WORK_PACKAGE", workPackageId: { not: null }, endAt: { gt: horizonStart } },
      orderBy: { id: "asc" },
    }),
  ]);

  const workPackages = projects.flatMap((project) => project.workPackages.map((workPackage) => ({ project, workPackage })));
  if (workPackages.length > MAX_WORK_PACKAGES) throw new Error("PLANNING_INPUT_TOO_LARGE");

  const preservedHorizonShifts = options.replaceGenerated
    ? horizonShifts.filter((shift) => shift.origin !== "SOLVER")
    : horizonShifts;
  const availableEmployeeIds = new Set(employees.map((employee) => employee.id));
  const availablePreservedHorizonShifts = preservedHorizonShifts.filter(
    (shift) => availableEmployeeIds.has(shift.employeeId),
  );
  const proposedFixed = fixedPreviews.flatMap((preview) => preview.assignments.map((assignment) => ({
    employeeId: assignment.employeeId,
    projectId: assignment.projectId,
    projectRequirementId: assignment.requirementId,
    startAt: new Date(assignment.startAt),
    endAt: new Date(assignment.endAt),
    regularMinutes: 0,
    overtimeMinutes: 0,
    regularCostCents: 0,
    overtimeCostCents: 0,
    plannedCostCents: 0,
  })));

  const futurePlannedByPackage = new Map<number, number>();
  const futurePlannedIntervalsByPackage = new Map<number, Interval[]>();
  for (const shift of futureWorkPackageShifts) {
    const replaced = options.replaceGenerated
      && shift.origin === "SOLVER"
      && shift.startAt < horizonEndExclusive
      && shift.endAt > horizonStart;
    if (replaced || shift.workPackageId === null) continue;
    const minutes = Math.round((shift.endAt.getTime() - shift.startAt.getTime()) / 60_000);
    futurePlannedByPackage.set(shift.workPackageId, (futurePlannedByPackage.get(shift.workPackageId) ?? 0) + minutes);
    futurePlannedIntervalsByPackage.set(shift.workPackageId, [
      ...(futurePlannedIntervalsByPackage.get(shift.workPackageId) ?? []),
      { startAt: shift.startAt, endAt: shift.endAt },
    ]);
  }

  const optimizerInput = {
    start,
    end,
    employees,
    projects,
    occupiedIntervals: [
      ...availablePreservedHorizonShifts.map((shift) => ({
        employeeId: shift.employeeId,
        startAt: shift.startAt,
        endAt: shift.endAt,
      })),
      ...proposedFixed.map((shift) => ({
        employeeId: shift.employeeId,
        startAt: shift.startAt,
        endAt: shift.endAt,
      })),
    ],
    futurePlannedByPackage,
    futurePlannedIntervalsByPackage,
    planningProfile: options.planningProfile ?? "BALANCED",
    searchMode: options.optimizerSearchMode ?? "FULL",
  };
  const { assignments, unplannedWorkPackages, optimizerDiagnostics } = (
    options.optimizerRunner ?? allocatePortfolioWork
  )(optimizerInput);
  const retainedAllocations: CostedInterval[] = availablePreservedHorizonShifts.map((shift) => ({
    employeeId: shift.employeeId,
    projectId: shift.projectId,
    startAt: shift.startAt,
    endAt: shift.endAt,
    regularMinutes: 0,
    overtimeMinutes: 0,
    regularCostCents: 0,
    overtimeCostCents: 0,
    plannedCostCents: 0,
  }));
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const repricedWeeklyMinutes = new Map<string, number>();
  const allocationsToPrice: Array<{
    categoryOrder: number;
    allocation: CostedInterval;
  }> = [
    ...retainedAllocations.map((allocation) => ({ categoryOrder: 0, allocation })),
    ...proposedFixed.map((allocation) => ({ categoryOrder: 1, allocation })),
    ...assignments.map((allocation) => ({ categoryOrder: 2, allocation })),
  ].sort((first, second) =>
    first.allocation.startAt.getTime() - second.allocation.startAt.getTime()
    || first.allocation.endAt.getTime() - second.allocation.endAt.getTime()
    || first.categoryOrder - second.categoryOrder
    || first.allocation.employeeId - second.allocation.employeeId
    || first.allocation.projectId - second.allocation.projectId,
  );

  for (const { allocation } of allocationsToPrice) {
    const employee = employeeById.get(allocation.employeeId);
    if (!employee) continue;
    const key = `${allocation.employeeId}:${weekKey(allocation.startAt)}`;
    const previousMinutes = repricedWeeklyMinutes.get(key) ?? 0;
    const minutes = Math.round(
      (allocation.endAt.getTime() - allocation.startAt.getTime()) / 60_000,
    );
    const cost = allocationCostBreakdown(employee, previousMinutes, minutes);
    allocation.regularMinutes = cost.regularMinutes;
    allocation.overtimeMinutes = cost.overtimeMinutes;
    allocation.regularCostCents = cost.regularCostCents;
    allocation.overtimeCostCents = cost.overtimeCostCents;
    allocation.plannedCostCents = cost.totalCostCents;
    repricedWeeklyMinutes.set(key, previousMinutes + minutes);
  }

  const weekSummaries = Array.from({ length: options.horizonWeeks }, (_, index) => {
    const weekStart = start.plus({ weeks: index });
    const key = weekStart.toISODate()!;
    const proposed = assignments.filter((item) => weekKey(item.startAt) === key);
    const committedMinutes = availablePreservedHorizonShifts.filter((item) => weekKey(item.startAt) === key)
      .reduce((total, item) => total + Math.round((item.endAt.getTime() - item.startAt.getTime()) / 60_000), 0);
    const fixedMinutes = proposedFixed.filter((item) => weekKey(item.startAt) === key)
      .reduce((total, item) => total + Math.round((item.endAt.getTime() - item.startAt.getTime()) / 60_000), 0);
    const proposedMinutes = proposed.reduce((total, item) => total + Math.round((item.endAt.getTime() - item.startAt.getTime()) / 60_000), 0);
    const retained = retainedAllocations.filter((item) => weekKey(item.startAt) === key);
    const fixed = proposedFixed.filter((item) => weekKey(item.startAt) === key);
    const costs = costTotals([...retained, ...fixed, ...proposed]);
    const capacityMinutes = employees.reduce((total, employee) => {
      const availableMinutes = employee.availability.reduce(
        (sum, availability) => sum + availability.endMinute - availability.startMinute,
        0,
      );
      return total + Math.min(employee.maxWeeklyMinutes, availableMinutes);
    }, 0);
    return {
      weekStart: key,
      capacityMinutes,
      committedMinutes: committedMinutes + fixedMinutes,
      proposedMinutes,
      utilizationPercent: capacityMinutes === 0 ? 0 : Math.round(((committedMinutes + fixedMinutes + proposedMinutes) / capacityMinutes) * 10_000) / 100,
      regularMinutes: costs.regularMinutes,
      overtimeMinutes: costs.overtimeMinutes,
      regularCostCents: costs.regularCostCents,
      overtimeCostCents: costs.overtimeCostCents,
      retainedCostCents: costTotals(retained).plannedCostCents,
      fixedCoverageCostCents: costTotals(fixed).plannedCostCents,
      workPackageCostCents: costTotals(proposed).plannedCostCents,
      plannedCostCents: costs.plannedCostCents,
    };
  });
  const projectCostSummaries = projects.map((project) => {
    const retained = retainedAllocations.filter((item) => item.projectId === project.id);
    const fixed = proposedFixed.filter((item) => item.projectId === project.id);
    const work = assignments.filter((item) => item.projectId === project.id);
    const retainedCosts = costTotals(retained);
    const fixedCosts = costTotals(fixed);
    const workCosts = costTotals(work);
    const horizonCosts = costTotals([...retained, ...fixed, ...work]);
    const actualCostCents = project.workLogs.reduce(
      (total, item) => total + (item.actualCostCents ?? 0),
      0,
    );
    const knownCostCents = actualCostCents + horizonCosts.plannedCostCents;
    const forecastComplete = !unplannedWorkPackages.some(
      (item) => item.projectId === project.id && item.unplannedMinutes > 0,
    );
    const weeks = weekSummaries.map((week) => {
      const weekAllocations = [...retained, ...fixed, ...work].filter(
        (item) => weekKey(item.startAt) === week.weekStart,
      );
      const costs = costTotals(weekAllocations);
      return {
        weekStart: week.weekStart,
        plannedCostCents: costs.plannedCostCents,
        weeklyBudgetCents: project.weeklyLaborBudgetCents,
        weeklyBudgetVarianceCents: project.weeklyLaborBudgetCents === null
          ? null
          : costs.plannedCostCents - project.weeklyLaborBudgetCents,
      };
    });

    return {
      projectId: project.id,
      projectName: project.name,
      actualCostCents,
      retainedCostCents: retainedCosts.plannedCostCents,
      fixedCoverageCostCents: fixedCosts.plannedCostCents,
      workPackageCostCents: workCosts.plannedCostCents,
      regularMinutes: horizonCosts.regularMinutes,
      overtimeMinutes: horizonCosts.overtimeMinutes,
      regularCostCents: horizonCosts.regularCostCents,
      overtimeCostCents: horizonCosts.overtimeCostCents,
      plannedCostCents: horizonCosts.plannedCostCents,
      knownCostCents,
      totalBudgetCents: project.totalLaborBudgetCents,
      totalBudgetVarianceCents: project.totalLaborBudgetCents === null
        ? null
        : knownCostCents - project.totalLaborBudgetCents,
      forecastComplete,
      weeks,
    };
  });

  const warnings = [
    ...fixedPreviews.flatMap((preview) => preview.unfilledRequirements.length === 0 ? [] : [{ code: "FIXED_COVERAGE_UNFILLED", message: `${preview.unfilledRequirements.length} fixed coverage positions unfilled`, weekStart: preview.weekStart }]),
    ...unplannedWorkPackages.map((item) => ({ code: "WORK_PACKAGE_UNPLANNED", message: `${item.name}: ${item.reason}`, projectId: item.projectId })),
    ...weekSummaries.filter((week) => week.utilizationPercent > 100).map((week) => ({ code: "CAPACITY_EXCEEDED", message: `Capacity exceeds 100% in week ${week.weekStart}`, weekStart: week.weekStart })),
    ...projects.flatMap((project) => {
      const projectAssignments = assignments.filter((item) => item.projectId === project.id);
      const costs = projectCostSummaries.find((item) => item.projectId === project.id)!;
      const budgetWarnings = costs.totalBudgetVarianceCents !== null && costs.totalBudgetVarianceCents > 0
        ? [{ code: "TOTAL_BUDGET_EXCEEDED", message: `${project.name} exceeds total labor budget by €${(costs.totalBudgetVarianceCents / 100).toFixed(2)}`, projectId: project.id }]
        : [];
      const weeklyWarnings = costs.weeks.flatMap((week) =>
        week.weeklyBudgetVarianceCents !== null && week.weeklyBudgetVarianceCents > 0
          ? [{ code: "WEEKLY_BUDGET_EXCEEDED", message: `${project.name} exceeds weekly burn cap by €${(week.weeklyBudgetVarianceCents / 100).toFixed(2)} in ${week.weekStart}`, projectId: project.id, weekStart: week.weekStart }]
          : [],
      );
      const forecastWarnings = project.totalLaborBudgetCents !== null && !costs.forecastComplete
        ? [{ code: "FORECAST_INCOMPLETE", message: `${project.name} has scope outside the feasible horizon; total budget exposure is incomplete`, projectId: project.id }]
        : [];
      const deadlineWarnings = project.targetEndDate === null || project.deadlineType === "NONE" ? [] : projectAssignments.flatMap((item) =>
        item.endAt > DateTime.fromJSDate(project.targetEndDate!, { zone: "utc" }).setZone(SCHEDULE_TIME_ZONE).endOf("day").toUTC().toJSDate()
          ? [{ code: "DEADLINE_AT_RISK", message: `${project.name} has work planned after its target date`, projectId: project.id }]
          : [],
      ).slice(0, 1);
      return [...budgetWarnings, ...weeklyWarnings, ...forecastWarnings, ...deadlineWarnings];
    }),
    ...workPackages.flatMap(({ project, workPackage }) => {
      if (workPackage.targetEndDate === null) return [];
      const target = DateTime.fromJSDate(workPackage.targetEndDate, { zone: "utc" })
        .setZone(SCHEDULE_TIME_ZONE).endOf("day").toUTC().toJSDate();
      return assignments.some((item) => item.workPackageId === workPackage.id && item.endAt > target)
        ? [{ code: "WORK_PACKAGE_TARGET_AT_RISK", message: `${workPackage.name} is planned after its target date`, projectId: project.id }]
        : [];
    }),
  ];
  const inputVersion = digest({
    options,
    fixedInputVersions: fixedPreviews.map((item) => item.inputVersion),
    employees: employees.map((item) => ({ id: item.id, updatedAt: item.updatedAt, preferredWeeklyMinutes: item.preferredWeeklyMinutes, maxWeeklyMinutes: item.maxWeeklyMinutes, hourlyCostCents: item.hourlyCostCents, overtimeRateBasisPoints: item.overtimeRateBasisPoints, skills: item.skills, availability: item.availability })),
    projects: projects.map((item) => ({
      id: item.id,
      updatedAt: item.updatedAt,
      status: item.status,
      priority: item.priority,
      optimizationStrategy: item.optimizationStrategy,
      totalLaborBudgetCents: item.totalLaborBudgetCents,
      weeklyLaborBudgetCents: item.weeklyLaborBudgetCents,
      workLogs: item.workLogs,
      workPackages: item.workPackages,
    })),
    horizonShifts: horizonShifts.map((item) => ({ id: item.id, updatedAt: item.updatedAt, status: item.status, origin: item.origin })),
    futureWorkPackageShifts: futureWorkPackageShifts.map((item) => ({
      id: item.id,
      updatedAt: item.updatedAt,
      status: item.status,
      origin: item.origin,
      workPackageId: item.workPackageId,
      startAt: item.startAt,
      endAt: item.endAt,
    })),
  });
  const serializedAssignments = assignments.map((item) => ({ ...item, startAt: item.startAt.toISOString(), endAt: item.endAt.toISOString() }));
  const fixedCoverageAssignments = proposedFixed.map((item) => ({ ...item, startAt: item.startAt.toISOString(), endAt: item.endAt.toISOString() }));
  const previewId = digest({ inputVersion, assignments: serializedAssignments, fixedCoverageAssignments, unplannedWorkPackages });
  const portfolioCosts = costTotals([
    ...retainedAllocations,
    ...proposedFixed,
    ...assignments,
  ]);
  const fixedCoverageRequestedPositions = fixedPreviews.reduce(
    (total, preview) => total + preview.metrics.requestedPositions,
    0,
  );
  const fixedCoverageAssignedPositions = fixedPreviews.reduce(
    (total, preview) => total + preview.metrics.assignedPositions,
    0,
  );
  const unfilledCriticalFixedCoveragePositions = fixedPreviews.reduce(
    (total, preview) => total + preview.unfilledRequirements.filter(
      (requirement) => requirement.priority === "CRITICAL",
    ).length,
    0,
  );
  const projectPriority = new Map(projects.map((project) => [project.id, project.priority]));
  const criticalUnplannedWorkPackages = unplannedWorkPackages.filter(
    (workPackage) => projectPriority.get(workPackage.projectId) === "CRITICAL",
  ).length;
  const allocationsByEmployee = new Map<number, { minutes: number; allocations: number }>();
  for (const allocation of [...retainedAllocations, ...proposedFixed, ...assignments]) {
    const previous = allocationsByEmployee.get(allocation.employeeId) ?? {
      minutes: 0,
      allocations: 0,
    };
    previous.minutes += Math.round(
      (allocation.endAt.getTime() - allocation.startAt.getTime()) / 60_000,
    );
    previous.allocations += 1;
    allocationsByEmployee.set(allocation.employeeId, previous);
  }
  const resilienceCandidates = employees.flatMap((employee) => {
    const scheduled = allocationsByEmployee.get(employee.id);
    return scheduled ? [{
      employeeId: employee.id,
      employeeName: employee.name,
      scheduledMinutes: scheduled.minutes,
      allocationCount: scheduled.allocations,
    }] : [];
  });
  const allocatedMinutes = weekSummaries.reduce(
    (total, week) => total + week.committedMinutes + week.proposedMinutes,
    0,
  );
  return {
    previewId,
    inputVersion,
    horizonStart: options.horizonStart,
    horizonEndExclusive: end.toISODate()!,
    horizonWeeks: options.horizonWeeks,
    planningProfile: options.planningProfile ?? "BALANCED",
    timezone: SCHEDULE_TIME_ZONE,
    replaceGenerated: options.replaceGenerated,
    assignments: serializedAssignments,
    fixedCoverageAssignments,
    unplannedWorkPackages,
    weekSummaries,
    projectCostSummaries,
    resilienceCandidates,
    optimizerDiagnostics,
    warnings,
    metrics: {
      proposedWorkMinutes: assignments.reduce((total, item) => total + Math.round((item.endAt.getTime() - item.startAt.getTime()) / 60_000), 0),
      proposedFixedCoverageMinutes: fixedCoverageAssignments.reduce((total, item) => total + Math.round((new Date(item.endAt).getTime() - new Date(item.startAt).getTime()) / 60_000), 0),
      regularMinutes: portfolioCosts.regularMinutes,
      overtimeMinutes: portfolioCosts.overtimeMinutes,
      regularCostCents: portfolioCosts.regularCostCents,
      overtimeCostCents: portfolioCosts.overtimeCostCents,
      retainedCostCents: costTotals(retainedAllocations).plannedCostCents,
      fixedCoverageCostCents: costTotals(proposedFixed).plannedCostCents,
      workPackageCostCents: costTotals(assignments).plannedCostCents,
      plannedCostCents: portfolioCosts.plannedCostCents,
      averagePlannedHourlyCostCents: portfolioCosts.minutes === 0
        ? 0
        : Math.round((portfolioCosts.plannedCostCents * 60) / portfolioCosts.minutes),
      assignedWorkPackages: new Set(assignments.map((item) => item.workPackageId)).size,
      unplannedWorkPackages: unplannedWorkPackages.length,
      allocatedMinutes,
      fixedCoverageRequestedPositions,
      fixedCoverageAssignedPositions,
      unfilledFixedCoveragePositions:
        fixedCoverageRequestedPositions - fixedCoverageAssignedPositions,
      unfilledCriticalFixedCoveragePositions,
      criticalUnplannedWorkPackages,
    },
  };
}

export async function buildPortfolioScenarioComparison(
  database: PlanningDatabase,
  options: Omit<PortfolioPlanOptions, "planningProfile" | "excludedEmployeeIds">,
) {
  const startedAt = Date.now();
  const cachedDatabase = snapshotDatabase(database);
  const scenarios = [];
  let sharedPlans: ReturnType<typeof allocatePortfolioScenarioPlans> | null = null;
  const sharedRunner: typeof allocatePortfolioWork = (input) => {
    sharedPlans ??= allocatePortfolioScenarioPlans(input, PLANNING_PROFILES);
    return sharedPlans.get(input.planningProfile ?? "BALANCED")!;
  };

  for (const planningProfile of PLANNING_PROFILES) {
    const preview = await buildPortfolioPlanPreview(cachedDatabase, {
      ...options,
      planningProfile,
      optimizerSearchMode: "COMPARISON",
      optimizerRunner: sharedRunner,
    });
    const objective = preview.optimizerDiagnostics.objectiveVector;
    scenarios.push({
      planningProfile,
      previewId: preview.previewId,
      inputVersion: preview.inputVersion,
      proposedWorkMinutes: preview.metrics.proposedWorkMinutes,
      unplannedWorkPackages: preview.metrics.unplannedWorkPackages,
      unplannedMinutes: preview.optimizerDiagnostics.optimized.unplannedMinutes,
      overtimeMinutes: preview.metrics.overtimeMinutes,
      workPackageCostCents: preview.metrics.workPackageCostCents,
      plannedCostCents: preview.metrics.plannedCostCents,
      hardDeadlineExposureMinutes: objective.hardDeadlineExposureMinutes,
      softDeadlineExposureMinutes: objective.softDeadlineExposureMinutes,
      singlePointExposureMinutes: objective.singlePointExposureMinutes,
      maxRecoveryShortfallMinutes: objective.maxRecoveryShortfallMinutes,
      skillConcentrationBasisPoints: objective.skillConcentrationBasisPoints,
      optimizerRuntimeMs: preview.optimizerDiagnostics.runtimeMs,
      exploredStates: preview.optimizerDiagnostics.exploredStates,
      prunedStates: preview.optimizerDiagnostics.prunedStates,
      dominancePrunedStates: preview.optimizerDiagnostics.dominancePrunedStates,
      candidateCount: preview.optimizerDiagnostics.evaluatedPlans,
      searchLimitReached: preview.optimizerDiagnostics.searchLimitReached,
    });
  }

  return {
    comparisonId: digest({
      horizonStart: options.horizonStart,
      horizonWeeks: options.horizonWeeks,
      replaceGenerated: options.replaceGenerated,
      scenarios: scenarios.map((scenario) => ({
        planningProfile: scenario.planningProfile,
        inputVersion: scenario.inputVersion,
      })),
    }),
    horizonStart: options.horizonStart,
    horizonWeeks: options.horizonWeeks,
    replaceGenerated: options.replaceGenerated,
    comparisonMode: "SHARED_PARETO_FRONTIER" as const,
    runtimeMs: Date.now() - startedAt,
    scenarios,
  };
}
