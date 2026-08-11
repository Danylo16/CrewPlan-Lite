import { DateTime } from "luxon";
import { allocationCostBreakdown } from "../scheduling/scoring.js";
import { SCHEDULE_TIME_ZONE } from "../scheduling/timeAdapter.js";

const MAX_ASSIGNMENTS = 4_000;
const MAX_BLOCK_MINUTES = 480;
const BEAM_WIDTH = 32;
const MAX_EXPLORED_STATES = 50_000;
const COMPARISON_BEAM_WIDTH = 8;
const COMPARISON_MAX_EXPLORED_STATES = 2_000;

export interface Interval {
  startAt: Date;
  endAt: Date;
}

export interface PlanAssignment extends Interval {
  employeeId: number;
  employeeName: string;
  projectId: number;
  projectName: string;
  workPackageId: number;
  workPackageName: string;
  regularMinutes: number;
  overtimeMinutes: number;
  regularCostCents: number;
  overtimeCostCents: number;
  plannedCostCents: number;
}

export interface OptimizerEmployee {
  id: number;
  name: string;
  hourlyCostCents: number;
  overtimeRateBasisPoints: number;
  preferredWeeklyMinutes: number;
  maxWeeklyMinutes: number;
  skills: Array<{ skillId: number; level: number }>;
  availability: Array<{ dayOfWeek: string; startMinute: number; endMinute: number }>;
}

export interface OptimizerDependency {
  predecessorId: number;
  lagMinutes: number;
  predecessor: { status: string; name: string };
}

export interface OptimizerWorkPackage {
  id: number;
  name: string;
  remainingMinutes: number;
  requiredSkillId: number;
  minimumSkillLevel: number;
  maxParallelEmployees: number;
  sortOrder: number;
  earliestStartDate: Date | null;
  targetEndDate: Date | null;
  incomingDependencies: OptimizerDependency[];
}

export interface OptimizerProject {
  id: number;
  name: string;
  priority: string;
  optimizationStrategy: string;
  startDate: Date | null;
  targetEndDate: Date | null;
  deadlineType: string;
  workPackages: OptimizerWorkPackage[];
}

export type PlanningProfile =
  | "BALANCED"
  | "COST_FIRST"
  | "DEADLINE_FIRST"
  | "RESILIENCE_FIRST";

export type OptimizerSearchMode = "FULL" | "COMPARISON";

export interface PortfolioOptimizerInput {
  start: DateTime;
  end: DateTime;
  employees: OptimizerEmployee[];
  projects: OptimizerProject[];
  occupiedIntervals: Array<Interval & { employeeId: number }>;
  futurePlannedByPackage: Map<number, number>;
  futurePlannedIntervalsByPackage: Map<number, Interval[]>;
  planningProfile?: PlanningProfile;
  searchMode?: OptimizerSearchMode;
  comparisonProfiles?: PlanningProfile[];
}

export interface UnplannedWorkPackage {
  workPackageId: number;
  projectId: number;
  name: string;
  unplannedMinutes: number;
  reason: string;
}

export function overlaps(first: Interval, second: Interval) {
  return first.startAt < second.endAt && first.endAt > second.startAt;
}

export function weekKey(date: Date) {
  return DateTime.fromJSDate(date, { zone: SCHEDULE_TIME_ZONE })
    .startOf("week")
    .toISODate()!;
}

export function localDateAtMinute(date: DateTime, minute: number) {
  return date.startOf("day").plus({ minutes: minute }).toUTC().toJSDate();
}

function priorityRank(priority: string) {
  return ({ CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as Record<string, number>)[priority] ?? 2;
}

export function freeSegments(window: Interval, occupied: Interval[]) {
  const relevant = occupied.filter((item) => overlaps(item, window))
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const segments: Interval[] = [];
  let cursor = window.startAt;
  for (const interval of relevant) {
    if (interval.startAt > cursor) segments.push({ startAt: cursor, endAt: interval.startAt });
    if (interval.endAt > cursor) cursor = interval.endAt;
  }
  if (cursor < window.endAt) segments.push({ startAt: cursor, endAt: window.endAt });
  return segments;
}

function orderedWorkPackages(projects: OptimizerProject[]) {
  const workPackages = projects.flatMap((project) =>
    project.workPackages.map((workPackage) => ({ project, workPackage })),
  );
  const comparePackages = (first: typeof workPackages[number], second: typeof workPackages[number]) =>
    priorityRank(first.project.priority) - priorityRank(second.project.priority)
    || (first.project.targetEndDate?.getTime() ?? Number.MAX_SAFE_INTEGER)
      - (second.project.targetEndDate?.getTime() ?? Number.MAX_SAFE_INTEGER)
    || first.workPackage.sortOrder - second.workPackage.sortOrder
    || first.workPackage.id - second.workPackage.id;
  const ordered: typeof workPackages = [];
  const pending = [...workPackages];
  const orderedIds = new Set<number>();
  while (pending.length > 0) {
    const candidates = pending.filter(({ workPackage }) => workPackage.incomingDependencies.every(
      (dependency) => dependency.predecessor.status === "COMPLETED"
        || orderedIds.has(dependency.predecessorId),
    )).sort(comparePackages);
    const next = candidates[0] ?? pending.sort(comparePackages)[0]!;
    ordered.push(next);
    orderedIds.add(next.workPackage.id);
    pending.splice(pending.findIndex((item) => item.workPackage.id === next.workPackage.id), 1);
  }
  return ordered;
}

export function allocatePortfolioWorkGreedy(
  input: PortfolioOptimizerInput,
  packageOrder?: ReturnType<typeof orderedWorkPackages>,
) {
  const {
    start,
    end,
    employees,
    projects,
    futurePlannedByPackage,
    futurePlannedIntervalsByPackage,
  } = input;
  const employeeOccupied = new Map<number, Interval[]>(
    employees.map((employee) => [employee.id, []]),
  );
  const weeklyMinutes = new Map<string, number>();
  function reserve(employeeId: number, interval: Interval) {
    employeeOccupied.get(employeeId)?.push(interval);
    const key = `${employeeId}:${weekKey(interval.startAt)}`;
    weeklyMinutes.set(
      key,
      (weeklyMinutes.get(key) ?? 0)
        + Math.round((interval.endAt.getTime() - interval.startAt.getTime()) / 60_000),
    );
  }
  input.occupiedIntervals.forEach((interval) => reserve(interval.employeeId, interval));

  const assignments: PlanAssignment[] = [];
  const packageFinish = new Map<number, Date>();
  const unplannedWorkPackages: UnplannedWorkPackage[] = [];

  for (const { project, workPackage } of packageOrder ?? orderedWorkPackages(projects)) {
    let remaining = Math.max(
      0,
      workPackage.remainingMinutes - (futurePlannedByPackage.get(workPackage.id) ?? 0),
    );
    const existingPackageIntervals = futurePlannedIntervalsByPackage.get(workPackage.id) ?? [];
    const incompleteDependency = workPackage.incomingDependencies.find(
      (dependency) => dependency.predecessor.status !== "COMPLETED"
        && !packageFinish.has(dependency.predecessorId),
    );
    if (incompleteDependency) {
      unplannedWorkPackages.push({
        workPackageId: workPackage.id,
        projectId: project.id,
        name: workPackage.name,
        unplannedMinutes: remaining,
        reason: `Blocked by ${incompleteDependency.predecessor.name}`,
      });
      continue;
    }
    if (remaining === 0) {
      const latest = existingPackageIntervals
        .sort((first, second) => second.endAt.getTime() - first.endAt.getTime())[0];
      if (latest) packageFinish.set(workPackage.id, latest.endAt);
      continue;
    }

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
      const finish = packageFinish.get(dependency.predecessorId);
      if (finish) {
        earliest = DateTime.max(
          earliest,
          DateTime.fromJSDate(finish).setZone(SCHEDULE_TIME_ZONE)
            .plus({ minutes: dependency.lagMinutes }),
        );
      }
    }

    const packageIntervals: Interval[] = [...existingPackageIntervals];
    for (let day = earliest.startOf("day"); day < end && remaining > 0; day = day.plus({ days: 1 })) {
      if (
        project.deadlineType === "HARD"
        && project.targetEndDate
        && day.startOf("day") > DateTime.fromJSDate(project.targetEndDate, { zone: "utc" })
          .setZone(SCHEDULE_TIME_ZONE).startOf("day")
      ) break;
      const dayName = day.toFormat("cccc").toUpperCase();
      const earliestDate = earliest.toUTC().toJSDate();
      const candidates = employees.flatMap((employee) => {
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
            return freeSegments(window, employeeOccupied.get(employee.id) ?? [])
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
        .filter(({ employee, segment }) => {
          const used = weeklyMinutes.get(`${employee.id}:${weekKey(segment.startAt)}`) ?? 0;
          return segment.endAt > segment.startAt && used < employee.maxWeeklyMinutes;
        })
        .sort((first, second) => {
          if (input.planningProfile === "COST_FIRST") {
            const firstUsed = weeklyMinutes.get(
              `${first.employee.id}:${weekKey(first.segment.startAt)}`,
            ) ?? 0;
            const secondUsed = weeklyMinutes.get(
              `${second.employee.id}:${weekKey(second.segment.startAt)}`,
            ) ?? 0;
            const firstCost = allocationCostBreakdown(first.employee, firstUsed, 60);
            const secondCost = allocationCostBreakdown(second.employee, secondUsed, 60);
            return firstCost.overtimeMinutes - secondCost.overtimeMinutes
              || firstCost.totalCostCents - secondCost.totalCostCents
              || first.segment.startAt.getTime() - second.segment.startAt.getTime()
              || first.employee.id - second.employee.id;
          }
          if (input.planningProfile === "RESILIENCE_FIRST") {
            const firstUsed = weeklyMinutes.get(
              `${first.employee.id}:${weekKey(first.segment.startAt)}`,
            ) ?? 0;
            const secondUsed = weeklyMinutes.get(
              `${second.employee.id}:${weekKey(second.segment.startAt)}`,
            ) ?? 0;
            return firstUsed / Math.max(1, first.employee.maxWeeklyMinutes)
              - secondUsed / Math.max(1, second.employee.maxWeeklyMinutes)
              || first.employee.skills.length - second.employee.skills.length
              || first.segment.startAt.getTime() - second.segment.startAt.getTime()
              || first.employee.hourlyCostCents - second.employee.hourlyCostCents
              || first.employee.id - second.employee.id;
          }
          if (project.optimizationStrategy === "MINIMIZE_COST") {
            const firstUsed = weeklyMinutes.get(
              `${first.employee.id}:${weekKey(first.segment.startAt)}`,
            ) ?? 0;
            const secondUsed = weeklyMinutes.get(
              `${second.employee.id}:${weekKey(second.segment.startAt)}`,
            ) ?? 0;
            const firstCost = allocationCostBreakdown(first.employee, firstUsed, 60);
            const secondCost = allocationCostBreakdown(second.employee, secondUsed, 60);
            return firstCost.overtimeMinutes - secondCost.overtimeMinutes
              || firstCost.overtimeCostCents - secondCost.overtimeCostCents
              || firstCost.totalCostCents - secondCost.totalCostCents
              || first.segment.startAt.getTime() - second.segment.startAt.getTime();
          }
          if (project.optimizationStrategy === "BALANCED") {
            const firstUsed = weeklyMinutes.get(
              `${first.employee.id}:${weekKey(first.segment.startAt)}`,
            ) ?? 0;
            const secondUsed = weeklyMinutes.get(
              `${second.employee.id}:${weekKey(second.segment.startAt)}`,
            ) ?? 0;
            return first.segment.startAt.getTime() - second.segment.startAt.getTime()
              || firstUsed / Math.max(1, first.employee.preferredWeeklyMinutes)
                - secondUsed / Math.max(1, second.employee.preferredWeeklyMinutes)
              || first.employee.hourlyCostCents - second.employee.hourlyCostCents
              || first.employee.id - second.employee.id;
          }
          return first.segment.startAt.getTime() - second.segment.startAt.getTime()
            || first.employee.hourlyCostCents - second.employee.hourlyCostCents
            || first.employee.id - second.employee.id;
        });

      for (const candidate of candidates) {
        if (remaining <= 0 || assignments.length >= MAX_ASSIGNMENTS) break;
        const key = `${candidate.employee.id}:${weekKey(candidate.segment.startAt)}`;
        const used = weeklyMinutes.get(key) ?? 0;
        const availableWeekly = candidate.employee.maxWeeklyMinutes - used;
        const segmentMinutes = Math.round(
          (candidate.segment.endAt.getTime() - candidate.segment.startAt.getTime()) / 60_000,
        );
        const minutes = Math.min(
          remaining,
          availableWeekly,
          segmentMinutes,
          MAX_BLOCK_MINUTES,
        );
        if (minutes <= 0) continue;
        const interval = {
          startAt: candidate.segment.startAt,
          endAt: new Date(candidate.segment.startAt.getTime() + minutes * 60_000),
        };
        const parallel = packageIntervals.filter((item) => overlaps(item, interval)).length;
        if (parallel >= workPackage.maxParallelEmployees) continue;
        const cost = allocationCostBreakdown(candidate.employee, used, minutes);
        const assignment: PlanAssignment = {
          ...interval,
          employeeId: candidate.employee.id,
          employeeName: candidate.employee.name,
          projectId: project.id,
          projectName: project.name,
          workPackageId: workPackage.id,
          workPackageName: workPackage.name,
          regularMinutes: cost.regularMinutes,
          overtimeMinutes: cost.overtimeMinutes,
          regularCostCents: cost.regularCostCents,
          overtimeCostCents: cost.overtimeCostCents,
          plannedCostCents: cost.totalCostCents,
        };
        assignments.push(assignment);
        packageIntervals.push(interval);
        reserve(candidate.employee.id, interval);
        remaining -= minutes;
      }
    }
    if (remaining === 0 && packageIntervals.length > 0) {
      packageFinish.set(
        workPackage.id,
        packageIntervals.sort(
          (first, second) => second.endAt.getTime() - first.endAt.getTime(),
        )[0]!.endAt,
      );
    }
    if (remaining > 0) {
      unplannedWorkPackages.push({
        workPackageId: workPackage.id,
        projectId: project.id,
        name: workPackage.name,
        unplannedMinutes: remaining,
        reason: assignments.length >= MAX_ASSIGNMENTS
          ? "Planner assignment limit reached"
          : "Insufficient qualified capacity in horizon",
      });
    }
  }

  return { assignments, unplannedWorkPackages };
}

export type PackageEntry = ReturnType<typeof orderedWorkPackages>[number];

interface OrderState {
  ordered: PackageEntry[];
  pending: PackageEntry[];
  orderedIds: Set<number>;
}

function qualifiedEmployeeCount(entry: PackageEntry, employees: OptimizerEmployee[]) {
  return employees.filter((employee) => employee.skills.some(
    (skill) => skill.skillId === entry.workPackage.requiredSkillId
      && skill.level >= entry.workPackage.minimumSkillLevel,
  )).length;
}

function orderHeuristic(state: OrderState, employees: OptimizerEmployee[]) {
  return state.ordered.reduce((score, entry, index) => {
    const positionWeight = state.ordered.length - index;
    const deadline = entry.workPackage.targetEndDate ?? entry.project.targetEndDate;
    const deadlineDay = deadline === null
      ? 1_000_000
      : Math.floor(deadline.getTime() / 86_400_000);
    const scarcity = qualifiedEmployeeCount(entry, employees);
    const itemScore = priorityRank(entry.project.priority) * 1_000_000_000
      + Math.min(1_000, scarcity) * 1_000_000
      + Math.min(999_999, deadlineDay);
    return score + itemScore * positionWeight;
  }, 0);
}

function compareOrderStates(
  first: OrderState,
  second: OrderState,
  employees: OptimizerEmployee[],
) {
  const firstSignature = first.ordered.map((item) => item.workPackage.id).join(",");
  const secondSignature = second.ordered.map((item) => item.workPackage.id).join(",");
  return orderHeuristic(first, employees) - orderHeuristic(second, employees)
    || (firstSignature < secondSignature ? -1 : firstSignature > secondSignature ? 1 : 0);
}

function readyEntries(state: OrderState) {
  const ready = state.pending.filter(({ workPackage }) =>
    workPackage.incomingDependencies.every(
      (dependency) => dependency.predecessor.status === "COMPLETED"
        || state.orderedIds.has(dependency.predecessorId),
    ));
  return ready.length > 0 ? ready : state.pending;
}

export function objectiveVector(
  result: ReturnType<typeof allocatePortfolioWorkGreedy>,
  input: PortfolioOptimizerInput,
) {
  const profile = input.planningProfile ?? "BALANCED";
  const components = objectiveComponents(result, input, profile === "RESILIENCE_FIRST");
  if (profile === "COST_FIRST") {
    return [
      components.criticalUnplannedMinutes,
      components.highUnplannedMinutes,
      components.normalUnplannedMinutes,
      components.lowUnplannedMinutes,
      components.hardDeadlineExposureMinutes,
      components.overtimeMinutes,
      components.laborCostCents,
      components.softDeadlineExposureMinutes,
      components.imbalanceBasisPoints,
    ];
  }
  if (profile === "DEADLINE_FIRST") {
    return [
      components.criticalUnplannedMinutes,
      components.hardDeadlineExposureMinutes,
      components.softDeadlineExposureMinutes,
      components.highUnplannedMinutes,
      components.normalUnplannedMinutes,
      components.lowUnplannedMinutes,
      components.overtimeMinutes,
      components.laborCostCents,
      components.imbalanceBasisPoints,
    ];
  }
  if (profile === "RESILIENCE_FIRST") {
    return [
      components.criticalUnplannedMinutes,
      components.highUnplannedMinutes,
      components.normalUnplannedMinutes,
      components.lowUnplannedMinutes,
      components.hardDeadlineExposureMinutes,
      components.singlePointExposureMinutes,
      components.maxRecoveryShortfallMinutes,
      components.skillConcentrationBasisPoints,
      components.softDeadlineExposureMinutes,
      components.overtimeMinutes,
      components.laborCostCents,
      components.imbalanceBasisPoints,
    ];
  }
  return [
    components.criticalUnplannedMinutes,
    components.highUnplannedMinutes,
    components.normalUnplannedMinutes,
    components.lowUnplannedMinutes,
    components.hardDeadlineExposureMinutes,
    components.softDeadlineExposureMinutes,
    components.overtimeMinutes,
    components.laborCostCents,
    components.imbalanceBasisPoints,
  ];
}

export function objectiveComponents(
  result: ReturnType<typeof allocatePortfolioWorkGreedy>,
  input: PortfolioOptimizerInput,
  includeResilienceProxy = true,
) {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const workPackageById = new Map(
    input.projects.flatMap((project) => project.workPackages.map((workPackage) => [
      workPackage.id,
      { project, workPackage },
    ] as const)),
  );
  const unplannedByPriority = [0, 0, 0, 0];
  let hardDeadlineExposureMinutes = 0;
  let softDeadlineExposureMinutes = 0;
  for (const item of result.unplannedWorkPackages) {
    const project = projectById.get(item.projectId);
    unplannedByPriority[priorityRank(project?.priority ?? "NORMAL")]! += item.unplannedMinutes;
    const entry = workPackageById.get(item.workPackageId);
    const deadline = entry?.workPackage.targetEndDate ?? project?.targetEndDate ?? null;
    if (deadline !== null && deadline < input.end.toUTC().toJSDate()) {
      if (project?.deadlineType === "HARD") {
        hardDeadlineExposureMinutes += item.unplannedMinutes;
      } else if (project?.deadlineType !== "NONE") {
        softDeadlineExposureMinutes += item.unplannedMinutes;
      }
    }
  }
  for (const assignment of result.assignments) {
    const entry = workPackageById.get(assignment.workPackageId);
    if (!entry) continue;
    const deadline = entry.workPackage.targetEndDate ?? entry.project.targetEndDate;
    if (deadline === null) continue;
    const deadlineEnd = DateTime.fromJSDate(deadline, { zone: "utc" })
      .setZone(SCHEDULE_TIME_ZONE).endOf("day").toUTC().toJSDate();
    if (assignment.endAt > deadlineEnd) {
      const exposedMinutes = Math.round(
        (assignment.endAt.getTime() - assignment.startAt.getTime()) / 60_000,
      );
      if (entry.project.deadlineType === "HARD") {
        hardDeadlineExposureMinutes += exposedMinutes;
      } else {
        softDeadlineExposureMinutes += exposedMinutes;
      }
    }
  }

  const overtimeMinutes = result.assignments.reduce(
    (total, assignment) => total + assignment.overtimeMinutes,
    0,
  );
  const plannedCostCents = result.assignments.reduce(
    (total, assignment) => total + assignment.plannedCostCents,
    0,
  );
  const assignedByEmployee = new Map<number, number>();
  for (const assignment of result.assignments) {
    const minutes = Math.round(
      (assignment.endAt.getTime() - assignment.startAt.getTime()) / 60_000,
    );
    assignedByEmployee.set(
      assignment.employeeId,
      (assignedByEmployee.get(assignment.employeeId) ?? 0) + minutes,
    );
  }
  const utilization = input.employees.map((employee) =>
    (assignedByEmployee.get(employee.id) ?? 0) / Math.max(1, employee.preferredWeeklyMinutes),
  );
  const imbalanceBasisPoints = utilization.length === 0
    ? 0
    : Math.round((Math.max(...utilization) - Math.min(...utilization)) * 10_000);

  const common = {
    criticalUnplannedMinutes: unplannedByPriority[0]!,
    highUnplannedMinutes: unplannedByPriority[1]!,
    normalUnplannedMinutes: unplannedByPriority[2]!,
    lowUnplannedMinutes: unplannedByPriority[3]!,
    hardDeadlineExposureMinutes,
    softDeadlineExposureMinutes,
    overtimeMinutes,
    laborCostCents: plannedCostCents,
    imbalanceBasisPoints,
  };
  if (!includeResilienceProxy) {
    return {
      ...common,
      singlePointExposureMinutes: 0,
      maxRecoveryShortfallMinutes: 0,
      skillConcentrationBasisPoints: 0,
    };
  }

  const horizonWeeks = Math.max(1, Math.ceil(input.end.diff(input.start, "weeks").weeks));
  const occupiedByEmployee = new Map<number, number>();
  for (const interval of input.occupiedIntervals) {
    occupiedByEmployee.set(
      interval.employeeId,
      (occupiedByEmployee.get(interval.employeeId) ?? 0)
        + Math.round((interval.endAt.getTime() - interval.startAt.getTime()) / 60_000),
    );
  }
  const totalAssignedByEmployee = new Map<number, number>();
  const demandBySkillEmployee = new Map<string, {
    skillId: number;
    minimumSkillLevel: number;
    byEmployee: Map<number, number>;
  }>();
  let singlePointExposureMinutes = 0;
  for (const assignment of result.assignments) {
    const entry = workPackageById.get(assignment.workPackageId);
    if (!entry) continue;
    const minutes = Math.round(
      (assignment.endAt.getTime() - assignment.startAt.getTime()) / 60_000,
    );
    totalAssignedByEmployee.set(
      assignment.employeeId,
      (totalAssignedByEmployee.get(assignment.employeeId) ?? 0) + minutes,
    );
    const qualified = input.employees.filter((employee) => employee.skills.some(
      (skill) => skill.skillId === entry.workPackage.requiredSkillId
        && skill.level >= entry.workPackage.minimumSkillLevel,
    ));
    if (qualified.length <= 1) singlePointExposureMinutes += minutes;
    const skillKey = `${entry.workPackage.requiredSkillId}:${entry.workPackage.minimumSkillLevel}`;
    const skillDemand = demandBySkillEmployee.get(skillKey) ?? {
      skillId: entry.workPackage.requiredSkillId,
      minimumSkillLevel: entry.workPackage.minimumSkillLevel,
      byEmployee: new Map<number, number>(),
    };
    const { byEmployee } = skillDemand;
    byEmployee.set(
      assignment.employeeId,
      (byEmployee.get(assignment.employeeId) ?? 0) + minutes,
    );
    demandBySkillEmployee.set(skillKey, skillDemand);
  }

  let maxRecoveryShortfallMinutes = 0;
  let weightedConcentration = 0;
  let totalSkillDemand = 0;
  for (const { skillId, minimumSkillLevel, byEmployee } of demandBySkillEmployee.values()) {
    const skillDemand = [...byEmployee.values()].reduce((total, minutes) => total + minutes, 0);
    totalSkillDemand += skillDemand;
    const concentration = [...byEmployee.values()].reduce((total, minutes) => {
      const share = minutes / Math.max(1, skillDemand);
      return total + share * share;
    }, 0);
    weightedConcentration += concentration * skillDemand;
    for (const [removedEmployeeId, removedMinutes] of byEmployee) {
      const backupCapacity = input.employees.filter((employee) =>
        employee.id !== removedEmployeeId
        && employee.skills.some((skill) => skill.skillId === skillId
          && skill.level >= minimumSkillLevel),
      ).reduce((total, employee) => {
        const horizonCapacity = employee.maxWeeklyMinutes * horizonWeeks;
        const alreadyUsed = (occupiedByEmployee.get(employee.id) ?? 0)
          + (totalAssignedByEmployee.get(employee.id) ?? 0);
        return total + Math.max(0, horizonCapacity - alreadyUsed);
      }, 0);
      maxRecoveryShortfallMinutes = Math.max(
        maxRecoveryShortfallMinutes,
        Math.max(0, removedMinutes - backupCapacity),
      );
    }
  }
  const skillConcentrationBasisPoints = totalSkillDemand === 0
    ? 0
    : Math.round((weightedConcentration / totalSkillDemand) * 10_000);

  return {
    ...common,
    singlePointExposureMinutes,
    maxRecoveryShortfallMinutes,
    skillConcentrationBasisPoints,
  };
}

export function compareVectors(first: number[], second: number[]) {
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function resultMetrics(result: ReturnType<typeof allocatePortfolioWorkGreedy>) {
  const plannedMinutes = result.assignments.reduce(
    (total, assignment) => total
      + Math.round((assignment.endAt.getTime() - assignment.startAt.getTime()) / 60_000),
    0,
  );
  return {
    plannedMinutes,
    unplannedMinutes: result.unplannedWorkPackages.reduce(
      (total, item) => total + item.unplannedMinutes,
      0,
    ),
    overtimeMinutes: result.assignments.reduce(
      (total, assignment) => total + assignment.overtimeMinutes,
      0,
    ),
    laborCostCents: result.assignments.reduce(
      (total, assignment) => total + assignment.plannedCostCents,
      0,
    ),
  };
}

export function searchPackageOrders(input: PortfolioOptimizerInput) {
  const beamWidth = input.searchMode === "COMPARISON"
    ? COMPARISON_BEAM_WIDTH
    : BEAM_WIDTH;
  const maxExploredStates = input.searchMode === "COMPARISON"
    ? COMPARISON_MAX_EXPLORED_STATES
    : MAX_EXPLORED_STATES;
  const defaultOrder = orderedWorkPackages(input.projects);
  let beam: OrderState[] = [{
    ordered: [],
    pending: [...defaultOrder],
    orderedIds: new Set<number>(),
  }];
  const completedOrders: PackageEntry[][] = [];
  let exploredStates = 0;
  let prunedStates = 0;
  let searchLimitReached = false;

  while (beam.length > 0 && beam[0]!.pending.length > 0) {
    const expanded: OrderState[] = [];
    for (const state of beam) {
      for (const next of readyEntries(state)) {
        if (exploredStates >= maxExploredStates) {
          searchLimitReached = true;
          break;
        }
        exploredStates += 1;
        const nextState: OrderState = {
          ordered: [...state.ordered, next],
          pending: state.pending.filter(
            (item) => item.workPackage.id !== next.workPackage.id,
          ),
          orderedIds: new Set([...state.orderedIds, next.workPackage.id]),
        };
        if (nextState.pending.length === 0) completedOrders.push(nextState.ordered);
        else expanded.push(nextState);
      }
      if (searchLimitReached) break;
    }
    if (searchLimitReached) break;
    expanded.sort((first, second) => compareOrderStates(first, second, input.employees));
    prunedStates += Math.max(0, expanded.length - beamWidth);
    beam = expanded.slice(0, beamWidth);
  }

  const uniqueOrders = new Map<string, PackageEntry[]>();
  for (const order of [defaultOrder, ...completedOrders]) {
    uniqueOrders.set(order.map((item) => item.workPackage.id).join(","), order);
  }
  return {
    defaultOrder,
    uniqueOrders,
    exploredStates,
    prunedStates,
    searchLimitReached,
    beamWidth,
  };
}

export function allocatePortfolioWorkV1(
  input: PortfolioOptimizerInput,
  orderSearch = searchPackageOrders(input),
) {
  const startedAt = Date.now();
  const { defaultOrder, uniqueOrders } = orderSearch;
  const greedyBaseline = allocatePortfolioWorkGreedy(input, defaultOrder);
  let best = greedyBaseline;
  let bestVector = objectiveVector(best, input);
  let bestSignature = defaultOrder.map((item) => item.workPackage.id).join(",");
  for (const [signature, order] of uniqueOrders) {
    if (signature === bestSignature) continue;
    const candidate = allocatePortfolioWorkGreedy(input, order);
    const vector = objectiveVector(candidate, input);
    if (
      compareVectors(vector, bestVector) < 0
      || (compareVectors(vector, bestVector) === 0 && signature < bestSignature)
    ) {
      best = candidate;
      bestVector = vector;
      bestSignature = signature;
    }
  }

  const baselineMetrics = resultMetrics(greedyBaseline);
  const optimizedMetrics = resultMetrics(best);
  const components = objectiveComponents(best, input);
  return {
    ...best,
    optimizerDiagnostics: {
      algorithmVersion: "portfolio-beam-v1",
      strategy: "BOUNDED_BEAM_SEARCH",
      planningProfile: input.planningProfile ?? "BALANCED",
      searchMode: input.searchMode ?? "FULL",
      beamWidth: orderSearch.beamWidth,
      exploredStates: orderSearch.exploredStates,
      prunedStates: orderSearch.prunedStates,
      evaluatedPlans: uniqueOrders.size,
      searchLimitReached: orderSearch.searchLimitReached,
      runtimeMs: Date.now() - startedAt,
      objectiveVector: components,
      greedyBaseline: baselineMetrics,
      optimized: optimizedMetrics,
      improvement: {
        plannedMinutes: optimizedMetrics.plannedMinutes - baselineMetrics.plannedMinutes,
        unplannedMinutes: baselineMetrics.unplannedMinutes - optimizedMetrics.unplannedMinutes,
        overtimeMinutes: baselineMetrics.overtimeMinutes - optimizedMetrics.overtimeMinutes,
        laborCostCents: baselineMetrics.laborCostCents - optimizedMetrics.laborCostCents,
      },
    },
  };
}
