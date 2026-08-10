import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import type { Prisma } from "../generated/prisma/client.js";
import { buildSchedulePreview } from "../scheduling/schedulePreview.js";
import { allocationCostBreakdown } from "../scheduling/scoring.js";
import { SCHEDULE_TIME_ZONE } from "../scheduling/timeAdapter.js";

const MAX_HORIZON_WEEKS = 12;
const MAX_WORK_PACKAGES = 150;
const MAX_ASSIGNMENTS = 4_000;
const MAX_BLOCK_MINUTES = 480;

type PlanningDatabase = Pick<
  Prisma.TransactionClient,
  "employee" | "project" | "projectRequirement" | "shift"
>;

export interface PortfolioPlanOptions {
  horizonStart: string;
  horizonWeeks: number;
  replaceGenerated: boolean;
}

interface Interval {
  startAt: Date;
  endAt: Date;
}

interface PlanAssignment extends Interval {
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

function marginalCost(
  employee: { hourlyCostCents: number; overtimeRateBasisPoints: number; preferredWeeklyMinutes: number },
  currentWeeklyMinutes: number,
  minutes: number,
) {
  return marginalCostBreakdown(
    employee,
    currentWeeklyMinutes,
    minutes,
  ).totalCostCents;
}

function marginalCostBreakdown(
  employee: { hourlyCostCents: number; overtimeRateBasisPoints: number; preferredWeeklyMinutes: number },
  currentWeeklyMinutes: number,
  minutes: number,
) {
  return allocationCostBreakdown(
    employee,
    currentWeeklyMinutes,
    minutes,
  );
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
    )),
  );

  const [employees, projects, horizonShifts, futureWorkPackageShifts] = await Promise.all([
    database.employee.findMany({
      where: { archivedAt: null },
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

  const employeeOccupied = new Map<number, Interval[]>(employees.map((employee) => [employee.id, []]));
  const weeklyMinutes = new Map<string, number>();
  function reserve(employeeId: number, interval: Interval) {
    employeeOccupied.get(employeeId)?.push(interval);
    const key = `${employeeId}:${weekKey(interval.startAt)}`;
    weeklyMinutes.set(key, (weeklyMinutes.get(key) ?? 0) + Math.round((interval.endAt.getTime() - interval.startAt.getTime()) / 60_000));
  }
  preservedHorizonShifts.forEach((shift) => reserve(shift.employeeId, shift));
  proposedFixed.forEach((shift) => reserve(shift.employeeId, shift));

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

  const assignments: PlanAssignment[] = [];
  const packageFinish = new Map<number, Date>();
  const unplannedWorkPackages: Array<{ workPackageId: number; projectId: number; name: string; unplannedMinutes: number; reason: string }> = [];
  const comparePackages = (first: typeof workPackages[number], second: typeof workPackages[number]) =>
    priorityRank(first.project.priority) - priorityRank(second.project.priority)
    || (first.project.targetEndDate?.getTime() ?? Number.MAX_SAFE_INTEGER) - (second.project.targetEndDate?.getTime() ?? Number.MAX_SAFE_INTEGER)
    || first.workPackage.sortOrder - second.workPackage.sortOrder
    || first.workPackage.id - second.workPackage.id;
  const ordered: typeof workPackages = [];
  const pending = [...workPackages];
  const orderedIds = new Set<number>();
  while (pending.length > 0) {
    const candidates = pending.filter(({ workPackage }) => workPackage.incomingDependencies.every(
      (dependency) => dependency.predecessor.status === "COMPLETED" || orderedIds.has(dependency.predecessorId),
    )).sort(comparePackages);
    const next = candidates[0] ?? pending.sort(comparePackages)[0]!;
    ordered.push(next);
    orderedIds.add(next.workPackage.id);
    pending.splice(pending.findIndex((item) => item.workPackage.id === next.workPackage.id), 1);
  }

  for (const { project, workPackage } of ordered) {
    let remaining = Math.max(0, workPackage.remainingMinutes - (futurePlannedByPackage.get(workPackage.id) ?? 0));
    const existingPackageIntervals = futurePlannedIntervalsByPackage.get(workPackage.id) ?? [];
    const incompleteDependency = workPackage.incomingDependencies.find(
      (dependency) => dependency.predecessor.status !== "COMPLETED" && !packageFinish.has(dependency.predecessorId),
    );
    if (incompleteDependency) {
      unplannedWorkPackages.push({ workPackageId: workPackage.id, projectId: project.id, name: workPackage.name, unplannedMinutes: remaining, reason: `Blocked by ${incompleteDependency.predecessor.name}` });
      continue;
    }
    if (remaining === 0) {
      const latest = existingPackageIntervals.sort((first, second) => second.endAt.getTime() - first.endAt.getTime())[0];
      if (latest) packageFinish.set(workPackage.id, latest.endAt);
      continue;
    }
    let earliest = start;
    if (project.startDate) earliest = DateTime.max(earliest, DateTime.fromJSDate(project.startDate, { zone: "utc" }).setZone(SCHEDULE_TIME_ZONE));
    if (workPackage.earliestStartDate) earliest = DateTime.max(earliest, DateTime.fromJSDate(workPackage.earliestStartDate, { zone: "utc" }).setZone(SCHEDULE_TIME_ZONE));
    for (const dependency of workPackage.incomingDependencies) {
      const finish = packageFinish.get(dependency.predecessorId);
      if (finish) earliest = DateTime.max(earliest, DateTime.fromJSDate(finish).setZone(SCHEDULE_TIME_ZONE).plus({ minutes: dependency.lagMinutes }));
    }

    const packageAssignments: PlanAssignment[] = [];
    const packageIntervals: Interval[] = [...existingPackageIntervals];
    for (let day = earliest.startOf("day"); day < end && remaining > 0; day = day.plus({ days: 1 })) {
      if (project.deadlineType === "HARD" && project.targetEndDate && day.startOf("day") > DateTime.fromJSDate(project.targetEndDate, { zone: "utc" }).setZone(SCHEDULE_TIME_ZONE).startOf("day")) break;
      const dayName = day.toFormat("cccc").toUpperCase();
      const candidates = employees.flatMap((employee) => {
        const qualified = employee.skills.some((skill) => skill.skillId === workPackage.requiredSkillId && skill.level >= workPackage.minimumSkillLevel);
        if (!qualified) return [];
        return employee.availability.filter((availability) => availability.dayOfWeek === dayName).flatMap((availability) => {
          const window = { startAt: localDateAtMinute(day, availability.startMinute), endAt: localDateAtMinute(day, availability.endMinute) };
          return freeSegments(window, employeeOccupied.get(employee.id) ?? []).map((segment) => ({ employee, segment }));
        });
      }).filter(({ segment }) => segment.endAt > earliest.toUTC().toJSDate())
        .map(({ employee, segment }) => ({ employee, segment: { ...segment, startAt: segment.startAt < earliest.toUTC().toJSDate() ? earliest.toUTC().toJSDate() : segment.startAt } }))
        .filter(({ employee, segment }) => {
          const used = weeklyMinutes.get(`${employee.id}:${weekKey(segment.startAt)}`) ?? 0;
          return segment.endAt > segment.startAt && used < employee.maxWeeklyMinutes;
        })
        .sort((first, second) => {
          if (project.optimizationStrategy === "MINIMIZE_COST") {
            const firstUsed = weeklyMinutes.get(`${first.employee.id}:${weekKey(first.segment.startAt)}`) ?? 0;
            const secondUsed = weeklyMinutes.get(`${second.employee.id}:${weekKey(second.segment.startAt)}`) ?? 0;
            const firstCost = marginalCostBreakdown(first.employee, firstUsed, 60);
            const secondCost = marginalCostBreakdown(second.employee, secondUsed, 60);
            return firstCost.overtimeMinutes - secondCost.overtimeMinutes
              || firstCost.overtimeCostCents - secondCost.overtimeCostCents
              || firstCost.totalCostCents - secondCost.totalCostCents
              || first.segment.startAt.getTime() - second.segment.startAt.getTime();
          }
          if (project.optimizationStrategy === "BALANCED") {
            const firstUsed = weeklyMinutes.get(`${first.employee.id}:${weekKey(first.segment.startAt)}`) ?? 0;
            const secondUsed = weeklyMinutes.get(`${second.employee.id}:${weekKey(second.segment.startAt)}`) ?? 0;
            return first.segment.startAt.getTime() - second.segment.startAt.getTime()
              || firstUsed / Math.max(1, first.employee.preferredWeeklyMinutes) - secondUsed / Math.max(1, second.employee.preferredWeeklyMinutes)
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
        const segmentMinutes = Math.round((candidate.segment.endAt.getTime() - candidate.segment.startAt.getTime()) / 60_000);
        const minutes = Math.min(remaining, availableWeekly, segmentMinutes, MAX_BLOCK_MINUTES);
        if (minutes <= 0) continue;
        const interval = { startAt: candidate.segment.startAt, endAt: new Date(candidate.segment.startAt.getTime() + minutes * 60_000) };
        const parallel = packageIntervals.filter((item) => overlaps(item, interval)).length;
        if (parallel >= workPackage.maxParallelEmployees) continue;
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
          plannedCostCents: marginalCost(candidate.employee, used, minutes),
        };
        assignments.push(assignment);
        packageAssignments.push(assignment);
        packageIntervals.push(interval);
        reserve(candidate.employee.id, interval);
        remaining -= minutes;
      }
    }
    if (remaining === 0 && packageIntervals.length > 0) {
      packageFinish.set(workPackage.id, packageIntervals.sort((first, second) => second.endAt.getTime() - first.endAt.getTime())[0]!.endAt);
    }
    if (remaining > 0) unplannedWorkPackages.push({ workPackageId: workPackage.id, projectId: project.id, name: workPackage.name, unplannedMinutes: remaining, reason: assignments.length >= MAX_ASSIGNMENTS ? "Planner assignment limit reached" : "Insufficient qualified capacity in horizon" });
  }

  const retainedAllocations: CostedInterval[] = preservedHorizonShifts.map((shift) => ({
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
    const committedMinutes = preservedHorizonShifts.filter((item) => weekKey(item.startAt) === key)
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
  return {
    previewId,
    inputVersion,
    horizonStart: options.horizonStart,
    horizonEndExclusive: end.toISODate()!,
    horizonWeeks: options.horizonWeeks,
    timezone: SCHEDULE_TIME_ZONE,
    replaceGenerated: options.replaceGenerated,
    assignments: serializedAssignments,
    fixedCoverageAssignments,
    unplannedWorkPackages,
    weekSummaries,
    projectCostSummaries,
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
    },
  };
}
