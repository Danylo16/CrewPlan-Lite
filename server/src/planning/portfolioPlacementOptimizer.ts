import { DateTime } from "luxon";
import { allocationCostBreakdown } from "../scheduling/scoring.js";
import { SCHEDULE_TIME_ZONE } from "../scheduling/timeAdapter.js";
import {
  allocatePortfolioWorkV1,
  compareVectors,
  freeSegments,
  localDateAtMinute,
  objectiveVector,
  objectiveVectorFromComponents,
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
  type PlanningProfile,
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
// The shared search keeps alternatives for every objective by round-robin rank,
// so it does not need the Cartesian budget of four independent searches. Four
// placement branches guarantee one leading candidate per planning profile;
// the wider state beam retains a second Pareto alternative where it matters.
const PARETO_BEAM_WIDTH = 8;
const PARETO_PACKAGE_VARIANT_WIDTH = 4;
const PARETO_BRANCH_WIDTH = 4;
const PARETO_ORDER_LIMIT = 1;
const PARETO_MAX_PLACEMENT_STATES = 2_500;

function placementLimits(input: PortfolioOptimizerInput) {
  if ((input.comparisonProfiles?.length ?? 0) > 1) {
    return {
      beamWidth: PARETO_BEAM_WIDTH,
      packageVariantWidth: PARETO_PACKAGE_VARIANT_WIDTH,
      branchWidth: PARETO_BRANCH_WIDTH,
      orderLimit: PARETO_ORDER_LIMIT,
      maxStates: PARETO_MAX_PLACEMENT_STATES,
    };
  }
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

function searchProfiles(input: PortfolioOptimizerInput) {
  return input.comparisonProfiles?.length
    ? input.comparisonProfiles
    : [input.planningProfile ?? "BALANCED"];
}

function withProfile(input: PortfolioOptimizerInput, planningProfile: PlanningProfile) {
  const singleProfileInput = { ...input };
  delete singleProfileInput.comparisonProfiles;
  return { ...singleProfileInput, planningProfile };
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
  const profiles = searchProfiles(input);
  const lookaheadDays = input.comparisonProfiles?.length
    ? PLACEMENT_LOOKAHEAD_DAYS
    : (input.planningProfile ?? "BALANCED") === "COST_FIRST"
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
  const compareForProfile = (
    first: typeof collected[number],
    second: typeof collected[number],
    profile: PlanningProfile,
  ) => {
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
  };
  if (profiles.length === 1) {
    return collected.sort((first, second) =>
      compareForProfile(first, second, profiles[0]!),
    );
  }

  const ranked = profiles.map((profile) =>
    [...collected].sort((first, second) => compareForProfile(first, second, profile)),
  );
  const union: typeof collected = [];
  const seen = new Set<string>();
  for (let rank = 0; rank < collected.length; rank += 1) {
    for (const candidates of ranked) {
      const candidate = candidates[rank];
      if (!candidate) continue;
      const key = `${candidate.employee.id}:${candidate.interval.startAt.toISOString()}:${candidate.interval.endAt.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(candidate);
    }
  }
  return union;
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

function placementSignature(state: Pick<PlacementState, "assignments">) {
  return state.assignments.map((assignment) => [
    assignment.workPackageId,
    assignment.employeeId,
    assignment.startAt.toISOString(),
    assignment.endAt.toISOString(),
  ].join(":"))
    .sort()
    .join("|");
}

function planSignature(
  result: Pick<PlacementState, "assignments" | "unplannedWorkPackages">,
) {
  const unplanned = result.unplannedWorkPackages.map((item) => [
    item.projectId,
    item.workPackageId,
    item.unplannedMinutes,
    item.reason,
  ].join(":"))
    .sort()
    .join("|");
  return `${placementSignature(result)}#${unplanned}`;
}

function compareSignatures(first: string, second: string) {
  return first < second ? -1 : first > second ? 1 : 0;
}

type ComparablePlan = {
  assignments: PlanAssignment[];
  unplannedWorkPackages: UnplannedWorkPackage[];
};

interface ComparisonScore {
  signature: string;
  components: ReturnType<typeof objectiveComponents>;
  vectors: Map<PlanningProfile, number[]>;
}

interface ComparisonScoreCache {
  score(result: ComparablePlan): ComparisonScore;
}

function comparisonScoreCache(input: PortfolioOptimizerInput): ComparisonScoreCache {
  const scores = new Map<string, ComparisonScore>();
  return {
    score(result) {
      const signature = planSignature(result);
      const cached = scores.get(signature);
      if (cached) return cached;
      const components = objectiveComponents(result, input);
      const score = {
        signature,
        components,
        vectors: new Map<PlanningProfile, number[]>(),
      };
      scores.set(signature, score);
      return score;
    },
  };
}

function profileVector(score: ComparisonScore, profile: PlanningProfile) {
  const cached = score.vectors.get(profile);
  if (cached) return cached;
  const vector = objectiveVectorFromComponents(score.components, profile);
  score.vectors.set(profile, vector);
  return vector;
}

function commonParetoVector(components: ReturnType<typeof objectiveComponents>) {
  return [
    components.criticalUnplannedMinutes,
    components.highUnplannedMinutes,
    components.normalUnplannedMinutes,
    components.lowUnplannedMinutes,
    components.hardDeadlineExposureMinutes,
    components.softDeadlineExposureMinutes,
    components.overtimeMinutes,
    components.laborCostCents,
    components.singlePointExposureMinutes,
    components.maxRecoveryShortfallMinutes,
    components.skillConcentrationBasisPoints,
    components.imbalanceBasisPoints,
  ];
}

function dominates(first: number[], second: number[]) {
  let strictlyBetter = false;
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference > 0) return false;
    if (difference < 0) strictlyBetter = true;
  }
  return strictlyBetter;
}

function roundRobinByProfile<T>(
  items: T[],
  width: number,
  profiles: PlanningProfile[],
  vector: (item: T, profile: PlanningProfile) => number[],
  signature: (item: T) => string,
) {
  if (items.length <= width) return items;
  const scored = items.map((item) => ({
    item,
    signature: signature(item),
    vectors: new Map(profiles.map((profile) => [profile, vector(item, profile)])),
  }));
  const rankings = profiles.map((profile) => [...scored].sort((first, second) =>
    compareVectors(first.vectors.get(profile)!, second.vectors.get(profile)!)
      || compareSignatures(first.signature, second.signature),
  ));
  const selected: T[] = [];
  const seen = new Set<string>();
  for (let rank = 0; selected.length < width && rank < scored.length; rank += 1) {
    for (const ranking of rankings) {
      const scoredItem = ranking[rank];
      if (!scoredItem || seen.has(scoredItem.signature)) continue;
      seen.add(scoredItem.signature);
      selected.push(scoredItem.item);
      if (selected.length === width) break;
    }
  }
  return selected;
}

function prunePlacementStates(
  states: PlacementState[],
  input: PortfolioOptimizerInput,
  width: number,
  stats: PlacementSearchStats,
  scoreCache?: ComparisonScoreCache,
) {
  const dominantBySignature = new Map<string, PlacementState>();
  for (const state of states) {
    const signature = planSignature(state);
    if (dominantBySignature.has(signature)) {
      stats.dominancePrunedStates += 1;
    } else {
      dominantBySignature.set(signature, state);
    }
  }
  const unique = [...dominantBySignature.values()];
  const profiles = searchProfiles(input);
  if (profiles.length > 1) {
    const activeScoreCache = scoreCache ?? comparisonScoreCache(input);
    const scores = new Map(unique.map((state) => {
      const result = {
        assignments: state.assignments,
        unplannedWorkPackages: state.unplannedWorkPackages,
      };
      return [state, activeScoreCache.score(result)] as const;
    }));
    const paretoVectors = new Map(unique.map((state) => [
      state,
      commonParetoVector(scores.get(state)!.components),
    ]));
    const frontier = unique.filter((candidate) => !unique.some((other) =>
      other !== candidate && dominates(
        paretoVectors.get(other)!,
        paretoVectors.get(candidate)!,
      ),
    ));
    stats.dominancePrunedStates += unique.length - frontier.length;
    const selected = roundRobinByProfile(
      frontier,
      width,
      profiles,
      (state, profile) => profileVector(scores.get(state)!, profile),
      (state) => scores.get(state)!.signature,
    );
    stats.prunedStates += Math.max(0, frontier.length - selected.length);
    return selected;
  }
  const scored = unique.map((state) => ({
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

function prunePackageVariants(
  variants: PackageVariant[],
  input: PortfolioOptimizerInput,
  width: number,
  stats: PlacementSearchStats,
  scoreCache?: ComparisonScoreCache,
) {
  const profiles = searchProfiles(input);
  if (profiles.length === 1) {
    variants.sort((first, second) =>
      compareVectors(variantVector(first, input), variantVector(second, input))
      || compareSignatures(
        placementSignature(first.state),
        placementSignature(second.state),
      ),
    );
    stats.prunedStates += Math.max(0, variants.length - width);
    return variants.slice(0, width);
  }
  const activeScoreCache = scoreCache ?? comparisonScoreCache(input);
  const scores = new Map(variants.map((variant) => {
    const result = {
      assignments: variant.state.assignments,
      unplannedWorkPackages: variant.state.unplannedWorkPackages,
    };
    return [variant, activeScoreCache.score(result)] as const;
  }));
  const paretoVectors = new Map(variants.map((variant) => [
    variant,
    [variant.remaining, ...commonParetoVector(scores.get(variant)!.components)],
  ]));
  const frontier = variants.filter((candidate) => !variants.some((other) =>
    other !== candidate && dominates(
      paretoVectors.get(other)!,
      paretoVectors.get(candidate)!,
    ),
  ));
  stats.dominancePrunedStates += variants.length - frontier.length;
  const selected = roundRobinByProfile(
    frontier,
    width,
    profiles,
    (variant, profile) => [
      variant.remaining,
      ...profileVector(scores.get(variant)!, profile),
    ],
    (variant) => `${variant.remaining}:${scores.get(variant)!.signature}`,
  );
  stats.prunedStates += Math.max(0, frontier.length - selected.length);
  return selected;
}

function schedulePackageVariants(
  input: PortfolioOptimizerInput,
  baseState: PlacementState,
  entry: PackageEntry,
  stats: PlacementSearchStats,
  scoreCache?: ComparisonScoreCache,
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
    variants = prunePackageVariants(
      expanded,
      input,
      limits.packageVariantWidth,
      stats,
      scoreCache,
    );
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
  scoreCache?: ComparisonScoreCache,
) {
  const limits = placementLimits(input);
  let beam = [initialPlacementState(input)];
  for (const entry of order) {
    const expanded = beam.flatMap((state) =>
      schedulePackageVariants(input, state, entry, stats, scoreCache),
    );
    if (stats.searchLimitReached) return [];
    beam = prunePlacementStates(expanded, input, limits.beamWidth, stats, scoreCache);
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

export function allocatePortfolioScenarioPlans(
  input: PortfolioOptimizerInput,
  profiles: PlanningProfile[],
) {
  const startedAt = Date.now();
  const sharedInput: PortfolioOptimizerInput = {
    ...input,
    planningProfile: "BALANCED",
    searchMode: "COMPARISON",
    comparisonProfiles: profiles,
  };
  const orderSearch = searchPackageOrders(sharedInput);
  const baselines = new Map(profiles.map((profile) => {
    const profileInput = withProfile(sharedInput, profile);
    return [profile, allocatePortfolioWorkV1(profileInput, orderSearch)] as const;
  }));
  const stats: PlacementSearchStats = {
    exploredStates: 0,
    prunedStates: 0,
    dominancePrunedStates: 0,
    searchLimitReached: false,
  };
  const limits = placementLimits(sharedInput);
  const scoreCache = comparisonScoreCache(sharedInput);
  const candidateBySignature = new Map<string, {
    assignments: PlanAssignment[];
    unplannedWorkPackages: UnplannedWorkPackage[];
  }>();
  for (const baseline of baselines.values()) {
    const candidate = {
      assignments: baseline.assignments,
      unplannedWorkPackages: baseline.unplannedWorkPackages,
    };
    candidateBySignature.set(planSignature(candidate), candidate);
  }
  const orders = [...orderSearch.uniqueOrders.values()].slice(0, limits.orderLimit);
  for (const order of orders) {
    for (const candidate of placementSearchForOrder(sharedInput, order, stats, scoreCache)) {
      candidateBySignature.set(planSignature(candidate), candidate);
    }
    if (stats.searchLimitReached) break;
  }
  const candidates = [...candidateBySignature.values()];
  const sharedRuntimeMs = Date.now() - startedAt;
  const results = new Map<PlanningProfile, ReturnType<typeof allocatePortfolioWork>>();

  for (const profile of profiles) {
    const v1 = baselines.get(profile)!;
    let best = candidates[0] ?? {
      assignments: v1.assignments,
      unplannedWorkPackages: v1.unplannedWorkPackages,
    };
    let bestScore = scoreCache.score(best);
    let bestVector = profileVector(bestScore, profile);
    let bestSignature = bestScore.signature;
    for (const candidate of candidates.slice(1)) {
      const score = scoreCache.score(candidate);
      const vector = profileVector(score, profile);
      const signature = score.signature;
      if (
        compareVectors(vector, bestVector) < 0
        || (compareVectors(vector, bestVector) === 0 && signature < bestSignature)
      ) {
        best = candidate;
        bestScore = score;
        bestVector = vector;
        bestSignature = signature;
      }
    }
    const greedyMetrics = v1.optimizerDiagnostics.greedyBaseline;
    const v1Metrics = resultMetrics(v1);
    const optimizedMetrics = resultMetrics(best);
    results.set(profile, {
      ...best,
      optimizerDiagnostics: {
        algorithmVersion: "portfolio-pareto-beam-v1",
        strategy: "SHARED_MULTI_OBJECTIVE_PARETO_BEAM_SEARCH",
        planningProfile: profile,
        searchMode: "COMPARISON",
        beamWidth: limits.beamWidth,
        packageVariantWidth: limits.packageVariantWidth,
        branchWidth: limits.branchWidth,
        exploredStates: orderSearch.exploredStates + stats.exploredStates,
        prunedStates: orderSearch.prunedStates + stats.prunedStates,
        dominancePrunedStates: stats.dominancePrunedStates,
        evaluatedPlans: candidates.length,
        searchLimitReached: orderSearch.searchLimitReached || stats.searchLimitReached,
        runtimeMs: sharedRuntimeMs,
        objectiveVector: bestScore.components,
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
    });
  }
  return results;
}
