import { DateTime } from "luxon";
import { allocationCostBreakdown } from "../scheduling/scoring.js";
import { SCHEDULE_TIME_ZONE } from "../scheduling/timeAdapter.js";
import {
  allocatePortfolioWorkV1,
  compareVectors,
  freeSegments,
  localDateAtMinute,
  objectiveVector,
  objectiveComponents,
  overlaps,
  resultMetrics,
  searchPackageOrders,
  weekKey,
  type Interval,
  type OptimizerProject,
  type OptimizerWorkPackage,
  type PackageEntry,
  type PlanAssignment,
  type PortfolioOptimizerInput,
  type UnplannedWorkPackage,
} from "./portfolioOptimizer.js";

const MAX_ASSIGNMENTS = 4_000;
const MAX_BLOCK_MINUTES = 480;

// Keep enough alternatives to recover from greedy placement decisions without
// letting a realistic portfolio multiply into thousands of near-equivalent
// states. The benchmark scenarios cover scarce skills, dependencies, cost,
// overtime and mixed-portfolio scale for these bounds.
const PLACEMENT_BEAM_WIDTH = 6;
const PACKAGE_VARIANT_WIDTH = 3;
const PLACEMENT_BRANCH_WIDTH = 3;
const PLACEMENT_ORDER_LIMIT = 2;
const MAX_PLACEMENT_STATES = 50_000;
const PLACEMENT_LOOKAHEAD_DAYS = 3;

function placementLimits(input: PortfolioOptimizerInput) {
  return input.searchMode === "COMPARISON"
    ? {
      beamWidth: 3,
      packageVariantWidth: 2,
      branchWidth: 2,
      orderLimit: 1,
      maxStates: 2_000,
    }
    : {
      beamWidth: PLACEMENT_BEAM_WIDTH,
      packageVariantWidth: PACKAGE_VARIANT_WIDTH,
      branchWidth: PLACEMENT_BRANCH_WIDTH,
      orderLimit: PLACEMENT_ORDER_LIMIT,
      maxStates: MAX_PLACEMENT_STATES,
    };
}

interface PlacementState {
  assignments: PlanAssignment[];
  unplannedWorkPackages: UnplannedWorkPackage[];
  employeeOccupied: Map<number, Interval[]>;
  weeklyMinutes: Map<string, number>;
  packageFinish: Map<number, Date>;
}

interface PackageVariant {
  state: PlacementState;
  remaining: number;
  packageIntervals: Interval[];
}

interface PlacementSearchStats {
  exploredStates: number;
  prunedStates: number;
  dominancePrunedStates: number;
  searchLimitReached: boolean;
}

function clonePlacementState(state: PlacementState): PlacementState {
  return {
    assignments: [...state.assignments],
    unplannedWorkPackages: [...state.unplannedWorkPackages],
    employeeOccupied: new Map(
      [...state.employeeOccupied].map(([employeeId, intervals]) => [
        employeeId,
        [...intervals],
      ]),
    ),
    weeklyMinutes: new Map(state.weeklyMinutes),
    packageFinish: new Map(state.packageFinish),
  };
}

function reservePlacement(
  state: PlacementState,
  employeeId: number,
  interval: Interval,
) {
  state.employeeOccupied.set(employeeId, [
    ...(state.employeeOccupied.get(employeeId) ?? []),
    interval,
  ]);
  const key = `${employeeId}:${weekKey(interval.startAt)}`;
  state.weeklyMinutes.set(
    key,
    (state.weeklyMinutes.get(key) ?? 0)
      + Math.round((interval.endAt.getTime() - interval.startAt.getTime()) / 60_000),
  );
}

function initialPlacementState(input: PortfolioOptimizerInput): PlacementState {
  const state: PlacementState = {
    assignments: [],
    unplannedWorkPackages: [],
    employeeOccupied: new Map(input.employees.map((employee) => [employee.id, []])),
    weeklyMinutes: new Map(),
    packageFinish: new Map(),
  };
  for (const interval of input.occupiedIntervals) {
    reservePlacement(state, interval.employeeId, interval);
  }
  return state;
}

function packageEarliest(
  state: PlacementState,
  project: OptimizerProject,
  workPackage: OptimizerWorkPackage,
  start: DateTime,
) {
  let earliest = start;
  if (project.startDate) {
    earliest = DateTime.max(
      earliest,
      DateTime.fromJSDate(project.startDate, { zone: "utc" }).setZone(SCHEDULE_TIME_ZONE),
    );
  }
  if (workPackage.earliestStartDate) {
    earliest = DateTime.max(
      earliest,
      DateTime.fromJSDate(workPackage.earliestStartDate, { zone: "utc" })
        .setZone(SCHEDULE_TIME_ZONE),
    );
  }
  for (const dependency of workPackage.incomingDependencies) {
    const finish = state.packageFinish.get(dependency.predecessorId);
    if (finish) {
      earliest = DateTime.max(
        earliest,
        DateTime.fromJSDate(finish).setZone(SCHEDULE_TIME_ZONE)
          .plus({ minutes: dependency.lagMinutes }),
      );
    }
  }
  return earliest;
}

function placementCandidates(
  input: PortfolioOptimizerInput,
  state: PlacementState,
  project: OptimizerProject,
  workPackage: OptimizerWorkPackage,
  earliest: DateTime,
  remaining: number,
  packageIntervals: Interval[],
) {
  const portfolioScale = input.employees.length * input.projects.reduce(
    (total, candidateProject) => total + candidateProject.workPackages.length,
    0,
  );
  const lookaheadDays = (input.planningProfile ?? "BALANCED") === "COST_FIRST"
    && portfolioScale <= 40
    ? PLACEMENT_LOOKAHEAD_DAYS
    : 1;
  const collected = [] as Array<{
    employee: PortfolioOptimizerInput["employees"][number];
    interval: Interval;
    minutes: number;
    cost: ReturnType<typeof allocationCostBreakdown>;
    employeeScarcity: number;
    usedMinutes: number;
  }>;
  let firstCandidateDay: DateTime | null = null;
  for (
    let day = earliest.startOf("day");
    day < input.end;
    day = day.plus({ days: 1 })
  ) {
    if (
      project.deadlineType === "HARD"
      && project.targetEndDate
      && day.startOf("day") > DateTime.fromJSDate(project.targetEndDate, { zone: "utc" })
        .setZone(SCHEDULE_TIME_ZONE).startOf("day")
    ) return [];
    const dayName = day.toFormat("cccc").toUpperCase();
    const earliestDate = earliest.toUTC().toJSDate();
    const candidates = input.employees.flatMap((employee) => {
      const qualified = employee.skills.some(
        (skill) => skill.skillId === workPackage.requiredSkillId
          && skill.level >= workPackage.minimumSkillLevel,
      );
      if (!qualified) return [];
      return employee.availability
        .filter((availability) => availability.dayOfWeek === dayName)
        .flatMap((availability) => {
          const window = {
            startAt: localDateAtMinute(day, availability.startMinute),
            endAt: localDateAtMinute(day, availability.endMinute),
          };
          return freeSegments(window, state.employeeOccupied.get(employee.id) ?? [])
            .map((segment) => ({ employee, segment }));
        });
    }).filter(({ segment }) => segment.endAt > earliestDate)
      .map(({ employee, segment }) => ({
        employee,
        segment: {
          ...segment,
          startAt: segment.startAt < earliestDate ? earliestDate : segment.startAt,
        },
      }))
      .flatMap(({ employee, segment }) => {
        const key = `${employee.id}:${weekKey(segment.startAt)}`;
        const used = state.weeklyMinutes.get(key) ?? 0;
        const availableWeekly = employee.maxWeeklyMinutes - used;
        const segmentMinutes = Math.round(
          (segment.endAt.getTime() - segment.startAt.getTime()) / 60_000,
        );
        const minutes = Math.min(
          remaining,
          availableWeekly,
          segmentMinutes,
          MAX_BLOCK_MINUTES,
        );
        if (minutes <= 0) return [];
        const interval = {
          startAt: segment.startAt,
          endAt: new Date(segment.startAt.getTime() + minutes * 60_000),
        };
        if (
          packageIntervals.filter((item) => overlaps(item, interval)).length
            >= workPackage.maxParallelEmployees
        ) return [];
        const cost = allocationCostBreakdown(employee, used, minutes);
        const employeeScarcity = employee.skills.length;
        return [{ employee, interval, minutes, cost, employeeScarcity, usedMinutes: used }];
      })
      .sort((first, second) => first.employee.id - second.employee.id);
    if (candidates.length > 0) {
      firstCandidateDay ??= day;
      collected.push(...candidates);
    }
    if (
      firstCandidateDay !== null
      && day.diff(firstCandidateDay, "days").days >= lookaheadDays - 1
    ) break;
  }
  return collected.sort((first, second) => {
    const profile = input.planningProfile ?? "BALANCED";
    if (profile === "COST_FIRST") {
      return first.cost.overtimeMinutes - second.cost.overtimeMinutes
        || first.cost.totalCostCents - second.cost.totalCostCents
        || first.interval.startAt.getTime() - second.interval.startAt.getTime()
        || first.employee.id - second.employee.id;
    }
    if (profile === "RESILIENCE_FIRST") {
      return first.usedMinutes / Math.max(1, first.employee.maxWeeklyMinutes)
        - second.usedMinutes / Math.max(1, second.employee.maxWeeklyMinutes)
        || first.employeeScarcity - second.employeeScarcity
        || first.interval.startAt.getTime() - second.interval.startAt.getTime()
        || first.cost.totalCostCents - second.cost.totalCostCents
        || first.employee.id - second.employee.id;
    }
    return first.interval.startAt.getTime() - second.interval.startAt.getTime()
      || first.cost.overtimeMinutes - second.cost.overtimeMinutes
      || first.employeeScarcity - second.employeeScarcity
      || first.cost.totalCostCents - second.cost.totalCostCents
      || first.employee.id - second.employee.id;
  });
}

function variantVector(variant: PackageVariant, input: PortfolioOptimizerInput) {
  return [
    variant.remaining,
    ...objectiveVector({
      assignments: variant.state.assignments,
      unplannedWorkPackages: variant.state.unplannedWorkPackages,
    }, input),
  ];
}

function placementSignature(state: PlacementState) {
  return state.assignments.map((assignment) => [
    assignment.workPackageId,
    assignment.employeeId,
    assignment.startAt.toISOString(),
    assignment.endAt.toISOString(),
  ].join(":"))
    .sort()
    .join("|");
}

function compareSignatures(first: string, second: string) {
  return first < second ? -1 : first > second ? 1 : 0;
}

function prunePlacementStates(
  states: PlacementState[],
  input: PortfolioOptimizerInput,
  width: number,
  stats: PlacementSearchStats,
) {
  const dominantBySignature = new Map<string, PlacementState>();
  for (const state of states) {
    const signature = placementSignature(state);
    const existing = dominantBySignature.get(signature);
    if (!existing) {
      dominantBySignature.set(signature, state);
      continue;
    }
    stats.dominancePrunedStates += 1;
    if (
      compareVectors(
        objectiveVector({
          assignments: state.assignments,
          unplannedWorkPackages: state.unplannedWorkPackages,
        }, input),
        objectiveVector({
          assignments: existing.assignments,
          unplannedWorkPackages: existing.unplannedWorkPackages,
        }, input),
      ) < 0
    ) dominantBySignature.set(signature, state);
  }
  const scored = [...dominantBySignature.values()].map((state) => ({
    state,
    signature: placementSignature(state),
    vector: objectiveVector({
      assignments: state.assignments,
      unplannedWorkPackages: state.unplannedWorkPackages,
    }, input),
  })).sort((first, second) =>
    compareVectors(first.vector, second.vector)
      || compareSignatures(first.signature, second.signature),
  );
  stats.prunedStates += Math.max(0, scored.length - width);
  return scored.slice(0, width).map((item) => item.state);
}

function schedulePackageVariants(
  input: PortfolioOptimizerInput,
  baseState: PlacementState,
  entry: PackageEntry,
  stats: PlacementSearchStats,
) {
  const limits = placementLimits(input);
  const { project, workPackage } = entry;
  const remaining = Math.max(
    0,
    workPackage.remainingMinutes
      - (input.futurePlannedByPackage.get(workPackage.id) ?? 0),
  );
  const existingPackageIntervals = input.futurePlannedIntervalsByPackage.get(workPackage.id) ?? [];
  const incompleteDependency = workPackage.incomingDependencies.find(
    (dependency) => dependency.predecessor.status !== "COMPLETED"
      && !baseState.packageFinish.has(dependency.predecessorId),
  );
  if (incompleteDependency) {
    const blocked = clonePlacementState(baseState);
    blocked.unplannedWorkPackages.push({
      workPackageId: workPackage.id,
      projectId: project.id,
      name: workPackage.name,
      unplannedMinutes: remaining,
      reason: `Blocked by ${incompleteDependency.predecessor.name}`,
    });
    return [blocked];
  }
  if (remaining === 0) {
    const completed = clonePlacementState(baseState);
    const latest = [...existingPackageIntervals]
      .sort((first, second) => second.endAt.getTime() - first.endAt.getTime())[0];
    if (latest) completed.packageFinish.set(workPackage.id, latest.endAt);
    return [completed];
  }

  const earliest = packageEarliest(baseState, project, workPackage, input.start);
  let variants: PackageVariant[] = [{
    state: clonePlacementState(baseState),
    remaining,
    packageIntervals: [...existingPackageIntervals],
  }];
  const completed: PlacementState[] = [];

  while (variants.length > 0) {
    const expanded: PackageVariant[] = [];
    for (const variant of variants) {
      if (variant.remaining === 0) {
        const latest = [...variant.packageIntervals]
          .sort((first, second) => second.endAt.getTime() - first.endAt.getTime())[0];
        if (latest) variant.state.packageFinish.set(workPackage.id, latest.endAt);
        completed.push(variant.state);
        continue;
      }
      const candidates = placementCandidates(
        input,
        variant.state,
        project,
        workPackage,
        earliest,
        variant.remaining,
        variant.packageIntervals,
      );
      if (candidates.length === 0 || variant.state.assignments.length >= MAX_ASSIGNMENTS) {
        variant.state.unplannedWorkPackages.push({
          workPackageId: workPackage.id,
          projectId: project.id,
          name: workPackage.name,
          unplannedMinutes: variant.remaining,
          reason: variant.state.assignments.length >= MAX_ASSIGNMENTS
            ? "Planner assignment limit reached"
            : "Insufficient qualified capacity in horizon",
        });
        completed.push(variant.state);
        continue;
      }
      for (const candidate of candidates.slice(0, limits.branchWidth)) {
        if (stats.exploredStates >= limits.maxStates) {
          stats.searchLimitReached = true;
          break;
        }
        stats.exploredStates += 1;
        const nextState = clonePlacementState(variant.state);
        const assignment: PlanAssignment = {
          ...candidate.interval,
          employeeId: candidate.employee.id,
          employeeName: candidate.employee.name,
          projectId: project.id,
          projectName: project.name,
          workPackageId: workPackage.id,
          workPackageName: workPackage.name,
          regularMinutes: candidate.cost.regularMinutes,
          overtimeMinutes: candidate.cost.overtimeMinutes,
          regularCostCents: candidate.cost.regularCostCents,
          overtimeCostCents: candidate.cost.overtimeCostCents,
          plannedCostCents: candidate.cost.totalCostCents,
        };
        nextState.assignments.push(assignment);
        reservePlacement(nextState, candidate.employee.id, candidate.interval);
        expanded.push({
          state: nextState,
          remaining: variant.remaining - candidate.minutes,
          packageIntervals: [...variant.packageIntervals, candidate.interval],
        });
      }
      if (stats.searchLimitReached) break;
    }
    if (stats.searchLimitReached) break;
    expanded.sort((first, second) =>
      compareVectors(variantVector(first, input), variantVector(second, input))
      || compareSignatures(
        placementSignature(first.state),
        placementSignature(second.state),
      ),
    );
    stats.prunedStates += Math.max(0, expanded.length - limits.packageVariantWidth);
    variants = expanded.slice(0, limits.packageVariantWidth);
  }
  if (completed.length > 0) return completed;
  const fallback = clonePlacementState(baseState);
  fallback.unplannedWorkPackages.push({
    workPackageId: workPackage.id,
    projectId: project.id,
    name: workPackage.name,
    unplannedMinutes: remaining,
    reason: stats.searchLimitReached
      ? "Placement search limit reached"
      : "Insufficient qualified capacity in horizon",
  });
  return [fallback];
}

function placementSearchForOrder(
  input: PortfolioOptimizerInput,
  order: PackageEntry[],
  stats: PlacementSearchStats,
) {
  const limits = placementLimits(input);
  let beam = [initialPlacementState(input)];
  for (const entry of order) {
    const expanded = beam.flatMap((state) =>
      schedulePackageVariants(input, state, entry, stats),
    );
    if (stats.searchLimitReached) return [];
    beam = prunePlacementStates(expanded, input, limits.beamWidth, stats);
  }
  return beam.map((state) => ({
    assignments: state.assignments,
    unplannedWorkPackages: state.unplannedWorkPackages,
  }));
}

export function allocatePortfolioWork(input: PortfolioOptimizerInput) {
  const startedAt = Date.now();
  const orderSearch = searchPackageOrders(input);
  const v1 = allocatePortfolioWorkV1(input, orderSearch);
  const stats: PlacementSearchStats = {
    exploredStates: 0,
    prunedStates: 0,
    dominancePrunedStates: 0,
    searchLimitReached: false,
  };
  let best = {
    assignments: v1.assignments,
    unplannedWorkPackages: v1.unplannedWorkPackages,
  };
  let bestVector = objectiveVector(best, input);
  let evaluatedPlans = 1;
  const limits = placementLimits(input);
  const orders = [...orderSearch.uniqueOrders.values()].slice(0, limits.orderLimit);
  for (const order of orders) {
    for (const candidate of placementSearchForOrder(input, order, stats)) {
      evaluatedPlans += 1;
      const vector = objectiveVector(candidate, input);
      if (compareVectors(vector, bestVector) < 0) {
        best = candidate;
        bestVector = vector;
      }
    }
    if (stats.searchLimitReached) break;
  }

  const greedyMetrics = v1.optimizerDiagnostics.greedyBaseline;
  const v1Metrics = resultMetrics(v1);
  const optimizedMetrics = resultMetrics(best);
  const components = objectiveComponents(best, input);
  return {
    ...best,
    optimizerDiagnostics: {
      algorithmVersion: "portfolio-beam-v2",
      strategy: "PLACEMENT_AWARE_BOUNDED_BEAM_SEARCH",
      planningProfile: input.planningProfile ?? "BALANCED",
      searchMode: input.searchMode ?? "FULL",
      beamWidth: limits.beamWidth,
      packageVariantWidth: limits.packageVariantWidth,
      branchWidth: limits.branchWidth,
      exploredStates: orderSearch.exploredStates + stats.exploredStates,
      prunedStates: orderSearch.prunedStates + stats.prunedStates,
      dominancePrunedStates: stats.dominancePrunedStates,
      evaluatedPlans,
      searchLimitReached: orderSearch.searchLimitReached || stats.searchLimitReached,
      runtimeMs: Date.now() - startedAt,
      objectiveVector: components,
      greedyBaseline: greedyMetrics,
      v1Baseline: v1Metrics,
      optimized: optimizedMetrics,
      improvement: {
        plannedMinutes: optimizedMetrics.plannedMinutes - greedyMetrics.plannedMinutes,
        unplannedMinutes: greedyMetrics.unplannedMinutes - optimizedMetrics.unplannedMinutes,
        overtimeMinutes: greedyMetrics.overtimeMinutes - optimizedMetrics.overtimeMinutes,
        laborCostCents: greedyMetrics.laborCostCents - optimizedMetrics.laborCostCents,
      },
      improvementVsV1: {
        plannedMinutes: optimizedMetrics.plannedMinutes - v1Metrics.plannedMinutes,
        unplannedMinutes: v1Metrics.unplannedMinutes - optimizedMetrics.unplannedMinutes,
        overtimeMinutes: v1Metrics.overtimeMinutes - optimizedMetrics.overtimeMinutes,
        laborCostCents: v1Metrics.laborCostCents - optimizedMetrics.laborCostCents,
      },
    },
  };
}
