import { DateTime } from "luxon";
import { allocationCostBreakdown } from "../scheduling/scoring.js";
import {
  SCHEDULE_TIME_ZONE,
  scheduleDateStart,
} from "../scheduling/timeAdapter.js";
import {
  allocatePortfolioWorkV1,
  compareVectors,
  createObjectiveScoringContext,
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
// Memoized scoring keeps this wider budget inside the interactive target while
// allowing sparse-availability alternatives to survive until the final beam.
const PARETO_MAX_PLACEMENT_STATES = 3_000;

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
    // Interval arrays are immutable: reservePlacement replaces only the array
    // for the modified employee, so sibling beam states can safely share the
    // unchanged arrays.
    employeeOccupied: new Map(state.employeeOccupied),
    weeklyMinutes: new Map(state.weeklyMinutes),
    packageFinish: new Map(state.packageFinish),
  };
}

interface PlacementStaticIndex {
  eligibleEmployeesByPackage: Map<
    number,
    PortfolioOptimizerInput["employees"]
  >;
  days: Array<{
    localDayMillis: number;
    weekStart: string;
    windowsByEmployee: Map<number, Interval[]>;
  }>;
  portfolioScale: number;
}

function placementStaticIndex(input: PortfolioOptimizerInput): PlacementStaticIndex {
  const eligibleEmployeesByPackage = new Map<
    number,
    PortfolioOptimizerInput["employees"]
  >();
  for (const project of input.projects) {
    for (const workPackage of project.workPackages) {
      eligibleEmployeesByPackage.set(
        workPackage.id,
        input.employees.filter((employee) => employee.skills.some(
          (skill) => skill.skillId === workPackage.requiredSkillId
            && skill.level >= workPackage.minimumSkillLevel,
        )),
      );
    }
  }
  const availabilityByEmployeeDay = new Map<
    string,
    PortfolioOptimizerInput["employees"][number]["availability"]
  >();
  for (const employee of input.employees) {
    for (const availability of employee.availability) {
      const key = `${employee.id}:${availability.dayOfWeek}`;
      availabilityByEmployeeDay.set(key, [
        ...(availabilityByEmployeeDay.get(key) ?? []),
        availability,
      ]);
    }
  }
  const days: PlacementStaticIndex["days"] = [];
  // Materialize timezone-aware availability windows once per horizon. Beam
  // siblings share this immutable index instead of rebuilding Luxon dates for
  // every package/state candidate.
  for (
    let day = input.start.startOf("day");
    day < input.end;
    day = day.plus({ days: 1 })
  ) {
    const dayName = day.toFormat("cccc").toUpperCase();
    const windowsByEmployee = new Map<number, Interval[]>();
    for (const employee of input.employees) {
      const availability = availabilityByEmployeeDay.get(
        `${employee.id}:${dayName}`,
      );
      if (!availability) continue;
      windowsByEmployee.set(employee.id, availability.map((window) => ({
        startAt: localDateAtMinute(day, window.startMinute),
        endAt: localDateAtMinute(day, window.endMinute),
      })));
    }
    days.push({
      localDayMillis: day.toMillis(),
      weekStart: day.startOf("week").toISODate()!,
      windowsByEmployee,
    });
  }
  return {
    eligibleEmployeesByPackage,
    days,
    portfolioScale: input.employees.length * input.projects.reduce(
      (total, project) => total + project.workPackages.length,
      0,
    ),
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
      scheduleDateStart(project.startDate),
    );
  }
  if (workPackage.earliestStartDate) {
    earliest = DateTime.max(
      earliest,
      scheduleDateStart(workPackage.earliestStartDate),
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
  staticIndex: PlacementStaticIndex,
  state: PlacementState,
  project: OptimizerProject,
  workPackage: OptimizerWorkPackage,
  earliest: DateTime,
  remaining: number,
  packageIntervals: Interval[],
) {
  const profiles = searchProfiles(input);
  const lookaheadDays = input.comparisonProfiles?.length
    ? PLACEMENT_LOOKAHEAD_DAYS
    : (input.planningProfile ?? "BALANCED") === "COST_FIRST"
      && staticIndex.portfolioScale <= 40
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
  let candidateDayCount = 0;
  const earliestDayMillis = earliest.startOf("day").toMillis();
  const earliestDate = earliest.toUTC().toJSDate();
  const hardDeadlineDayMillis = project.deadlineType === "HARD"
    && project.targetEndDate
    ? scheduleDateStart(project.targetEndDate).toMillis()
    : null;
  for (const day of staticIndex.days) {
    if (day.localDayMillis < earliestDayMillis) continue;
    if (
      hardDeadlineDayMillis !== null
      && day.localDayMillis > hardDeadlineDayMillis
    ) return [];
    const candidates = (staticIndex.eligibleEmployeesByPackage.get(workPackage.id) ?? [])
      .flatMap((employee) => (day.windowsByEmployee.get(employee.id) ?? [])
        .flatMap((window) => freeSegments(
          window,
          state.employeeOccupied.get(employee.id) ?? [],
        ).map((segment) => ({ employee, segment }))))
      .filter(({ segment }) => segment.endAt > earliestDate)
      .map(({ employee, segment }) => ({
        employee,
        segment: {
          ...segment,
          startAt: segment.startAt < earliestDate ? earliestDate : segment.startAt,
        },
      }))
      .flatMap(({ employee, segment }) => {
        const key = `${employee.id}:${day.weekStart}`;
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
      candidateDayCount += 1;
      collected.push(...candidates);
    }
    if (candidateDayCount >= lookaheadDays) break;
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
  const scoringContext = createObjectiveScoringContext(input);
  const includeResilienceProxy = searchProfiles(input).includes("RESILIENCE_FIRST");
  return {
    score(result) {
      const signature = planSignature(result);
      const cached = scores.get(signature);
      if (cached) return cached;
      const components = objectiveComponents(
        result,
        input,
        includeResilienceProxy,
        scoringContext,
      );
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

function commonParetoVector(
  components: ReturnType<typeof objectiveComponents>,
  includeResilienceProxy: boolean,
) {
  return [
    components.criticalUnplannedMinutes,
    components.highUnplannedMinutes,
    components.normalUnplannedMinutes,
    components.lowUnplannedMinutes,
    components.hardDeadlineExposureMinutes,
    components.softDeadlineExposureMinutes,
    components.weeklyBudgetOverrunCents,
    components.totalBudgetOverrunCents,
    components.overtimeMinutes,
    components.laborCostCents,
    ...(includeResilienceProxy ? [
      components.singlePointExposureMinutes,
      components.maxRecoveryShortfallMinutes,
      components.skillConcentrationBasisPoints,
    ] : []),
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
  const includeResilienceProxy = profiles.includes("RESILIENCE_FIRST");
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
      commonParetoVector(scores.get(state)!.components, includeResilienceProxy),
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
  const activeScoreCache = scoreCache ?? comparisonScoreCache(input);
  const profile = profiles[0]!;
  const scored = unique.map((state) => ({
    state,
    score: activeScoreCache.score(state),
  })).map(({ state, score }) => ({
    state,
    signature: score.signature,
    vector: profileVector(score, profile),
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
    const activeScoreCache = scoreCache ?? comparisonScoreCache(input);
    const profile = profiles[0]!;
    const scored = variants.map((variant) => {
      const score = activeScoreCache.score(variant.state);
      return {
        variant,
        signature: `${variant.remaining}:${score.signature}`,
        vector: [variant.remaining, ...profileVector(score, profile)],
      };
    }).sort((first, second) =>
      compareVectors(first.vector, second.vector)
        || compareSignatures(first.signature, second.signature),
    );
    stats.prunedStates += Math.max(0, variants.length - width);
    return scored.slice(0, width).map((item) => item.variant);
  }
  const includeResilienceProxy = profiles.includes("RESILIENCE_FIRST");
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
    [
      variant.remaining,
      ...commonParetoVector(
        scores.get(variant)!.components,
        includeResilienceProxy,
      ),
    ],
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
  staticIndex: PlacementStaticIndex,
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
  if (stats.exploredStates >= limits.maxStates) {
    stats.searchLimitReached = true;
    const exhausted = clonePlacementState(baseState);
    exhausted.unplannedWorkPackages.push({
      workPackageId: workPackage.id,
      projectId: project.id,
      name: workPackage.name,
      unplannedMinutes: remaining,
      reason: "Placement search limit reached",
    });
    return [exhausted];
  }

  const earliest = packageEarliest(baseState, project, workPackage, input.start);
  let variants: PackageVariant[] = [{
    state: clonePlacementState(baseState),
    remaining,
    packageIntervals: [...existingPackageIntervals],
  }];
  const completed: PlacementState[] = [];
  let truncatedVariants: PackageVariant[] = [];

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
        staticIndex,
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
    if (stats.searchLimitReached) {
      truncatedVariants = expanded.length > 0 ? expanded : variants;
      break;
    }
    variants = prunePackageVariants(
      expanded,
      input,
      limits.packageVariantWidth,
      stats,
      scoreCache,
    );
  }
  if (completed.length > 0) return completed;
  if (truncatedVariants.length > 0) {
    return prunePackageVariants(
      truncatedVariants,
      input,
      limits.packageVariantWidth,
      stats,
      scoreCache,
    ).map((variant) => {
      const truncated = clonePlacementState(variant.state);
      if (variant.remaining === 0) {
        const latest = [...variant.packageIntervals]
          .sort((first, second) => second.endAt.getTime() - first.endAt.getTime())[0];
        if (latest) truncated.packageFinish.set(workPackage.id, latest.endAt);
      } else {
        truncated.unplannedWorkPackages.push({
          workPackageId: workPackage.id,
          projectId: project.id,
          name: workPackage.name,
          unplannedMinutes: variant.remaining,
          reason: "Placement search limit reached",
        });
      }
      return truncated;
    });
  }
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
  staticIndex: PlacementStaticIndex,
  order: PackageEntry[],
  stats: PlacementSearchStats,
  scoreCache?: ComparisonScoreCache,
) {
  const limits = placementLimits(input);
  let beam = [initialPlacementState(input)];
  for (const entry of order) {
    const expanded = beam.flatMap((state) =>
      schedulePackageVariants(input, staticIndex, state, entry, stats, scoreCache),
    );
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
  const staticIndex = placementStaticIndex(input);
  const scoreCache = comparisonScoreCache(input);
  const orders = [...orderSearch.uniqueOrders.values()].slice(0, limits.orderLimit);
  for (const order of orders) {
    for (const candidate of placementSearchForOrder(
      input,
      staticIndex,
      order,
      stats,
      scoreCache,
    )) {
      evaluatedPlans += 1;
      const vector = profileVector(
        scoreCache.score(candidate),
        input.planningProfile ?? "BALANCED",
      );
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
      algorithmVersion: "portfolio-beam-v3",
      strategy: "PLACEMENT_AWARE_BOUNDED_BEAM_SEARCH",
      planningProfile: input.planningProfile ?? "BALANCED",
      searchMode: input.searchMode ?? "FULL",
      beamWidth: limits.beamWidth,
      packageVariantWidth: limits.packageVariantWidth,
      branchWidth: limits.branchWidth,
      orderExploredStates: orderSearch.exploredStates,
      placementExploredStates: stats.exploredStates,
      orderPrunedStates: orderSearch.prunedStates,
      placementPrunedStates: stats.prunedStates,
      placementStateLimit: limits.maxStates,
      exploredStates: orderSearch.exploredStates + stats.exploredStates,
      prunedStates: orderSearch.prunedStates + stats.prunedStates,
      dominancePrunedStates: stats.dominancePrunedStates,
      evaluatedPlans,
      searchLimitReached: orderSearch.searchLimitReached || stats.searchLimitReached,
      dependencyCyclePackageIds: orderSearch.dependencyCyclePackageIds,
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
  const staticIndex = placementStaticIndex(sharedInput);
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
    for (const candidate of placementSearchForOrder(
      sharedInput,
      staticIndex,
      order,
      stats,
      scoreCache,
    )) {
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
        algorithmVersion: "portfolio-pareto-beam-v4",
        strategy: "INDEXED_SHARED_MULTI_OBJECTIVE_PARETO_BEAM_SEARCH",
        planningProfile: profile,
        searchMode: "COMPARISON",
        beamWidth: limits.beamWidth,
        packageVariantWidth: limits.packageVariantWidth,
        branchWidth: limits.branchWidth,
        orderExploredStates: orderSearch.exploredStates,
        placementExploredStates: stats.exploredStates,
        orderPrunedStates: orderSearch.prunedStates,
        placementPrunedStates: stats.prunedStates,
        placementStateLimit: limits.maxStates,
        exploredStates: orderSearch.exploredStates + stats.exploredStates,
        prunedStates: orderSearch.prunedStates + stats.prunedStates,
        dominancePrunedStates: stats.dominancePrunedStates,
        evaluatedPlans: candidates.length,
        searchLimitReached: orderSearch.searchLimitReached || stats.searchLimitReached,
        dependencyCyclePackageIds: orderSearch.dependencyCyclePackageIds,
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
