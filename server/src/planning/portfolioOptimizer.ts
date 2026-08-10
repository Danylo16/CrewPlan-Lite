import { DateTime } from "luxon";
import { allocationCostBreakdown } from "../scheduling/scoring.js";
import { SCHEDULE_TIME_ZONE } from "../scheduling/timeAdapter.js";

const MAX_ASSIGNMENTS = 4_000;
const MAX_BLOCK_MINUTES = 480;

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

interface OptimizerEmployee {
  id: number;
  name: string;
  hourlyCostCents: number;
  overtimeRateBasisPoints: number;
  preferredWeeklyMinutes: number;
  maxWeeklyMinutes: number;
  skills: Array<{ skillId: number; level: number }>;
  availability: Array<{ dayOfWeek: string; startMinute: number; endMinute: number }>;
}

interface OptimizerDependency {
  predecessorId: number;
  lagMinutes: number;
  predecessor: { status: string; name: string };
}

interface OptimizerWorkPackage {
  id: number;
  name: string;
  remainingMinutes: number;
  requiredSkillId: number;
  minimumSkillLevel: number;
  maxParallelEmployees: number;
  sortOrder: number;
  earliestStartDate: Date | null;
  incomingDependencies: OptimizerDependency[];
}

interface OptimizerProject {
  id: number;
  name: string;
  priority: string;
  optimizationStrategy: string;
  startDate: Date | null;
  targetEndDate: Date | null;
  deadlineType: string;
  workPackages: OptimizerWorkPackage[];
}

interface PortfolioOptimizerInput {
  start: DateTime;
  end: DateTime;
  employees: OptimizerEmployee[];
  projects: OptimizerProject[];
  occupiedIntervals: Array<Interval & { employeeId: number }>;
  futurePlannedByPackage: Map<number, number>;
  futurePlannedIntervalsByPackage: Map<number, Interval[]>;
}

export interface UnplannedWorkPackage {
  workPackageId: number;
  projectId: number;
  name: string;
  unplannedMinutes: number;
  reason: string;
}

function overlaps(first: Interval, second: Interval) {
  return first.startAt < second.endAt && first.endAt > second.startAt;
}

function weekKey(date: Date) {
  return DateTime.fromJSDate(date, { zone: SCHEDULE_TIME_ZONE })
    .startOf("week")
    .toISODate()!;
}

function localDateAtMinute(date: DateTime, minute: number) {
  return date.startOf("day").plus({ minutes: minute }).toUTC().toJSDate();
}

function priorityRank(priority: string) {
  return ({ CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as Record<string, number>)[priority] ?? 2;
}

function freeSegments(window: Interval, occupied: Interval[]) {
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

export function allocatePortfolioWork(input: PortfolioOptimizerInput) {
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

  for (const { project, workPackage } of orderedWorkPackages(projects)) {
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
          regularMinutes: 0,
          overtimeMinutes: 0,
          regularCostCents: 0,
          overtimeCostCents: 0,
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
