import { DateTime } from "luxon";
import { allocationCostBreakdown } from "../scheduling/scoring.js";
import { SCHEDULE_TIME_ZONE } from "../scheduling/timeAdapter.js";
import {
  overlaps,
  weekKey,
  type Interval,
  type OptimizerEmployee,
} from "./portfolioOptimizer.js";
import {
  buildPortfolioPlanPreview,
  createPlanningSnapshotDatabase,
} from "./portfolioPlan.js";
import type { PlanningDatabase, PortfolioPlanOptions } from "./portfolioPlan.js";

const REPAIR_BEAM_WIDTH = 64;
const MAX_REPLACEMENT_BRANCHES = 12;
const REPAIR_SLOT_STEP_MINUTES = 30;

export interface PortfolioResilienceOptions extends Omit<PortfolioPlanOptions, "excludedEmployeeIds"> {
  previewId: string;
  inputVersion: string;
}

interface RepairTask extends Interval {
  id: string;
  kind: "WORK_PACKAGE" | "FIXED_COVERAGE" | "RETAINED_COMMITMENT";
  requiredSkillId: number | null;
  minimumSkillLevel: number;
  criticalKey: string | null;
  plannedCostCents: number;
  movable: boolean;
  latestEndAt: Date;
}

interface RepairState {
  occupiedByEmployee: Map<number, Interval[]>;
  weeklyMinutes: Map<string, number>;
  lostMinutes: number;
  lostCriticalKeys: Set<string>;
  replacementCostCents: number;
  replacementCount: number;
  rescheduledCount: number;
  displacementMinutes: number;
  signature: string;
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}

function minutes(interval: Interval) {
  return Math.round((interval.endAt.getTime() - interval.startAt.getTime()) / 60_000);
}

function localTargetEnd(value: Date | null) {
  return value === null
    ? null
    : DateTime.fromJSDate(value, { zone: "utc" })
      .setZone(SCHEDULE_TIME_ZONE)
      .endOf("day")
      .toUTC()
      .toJSDate();
}

function cloneState(state: RepairState): RepairState {
  return {
    occupiedByEmployee: new Map(
      [...state.occupiedByEmployee].map(([employeeId, intervals]) => [
        employeeId,
        [...intervals],
      ]),
    ),
    weeklyMinutes: new Map(state.weeklyMinutes),
    lostMinutes: state.lostMinutes,
    lostCriticalKeys: new Set(state.lostCriticalKeys),
    replacementCostCents: state.replacementCostCents,
    replacementCount: state.replacementCount,
    rescheduledCount: state.rescheduledCount,
    displacementMinutes: state.displacementMinutes,
    signature: state.signature,
  };
}

function compareRepairStates(first: RepairState, second: RepairState) {
  return first.lostCriticalKeys.size - second.lostCriticalKeys.size
    || first.lostMinutes - second.lostMinutes
    || first.displacementMinutes - second.displacementMinutes
    || first.replacementCostCents - second.replacementCostCents
    || first.replacementCount - second.replacementCount
    || first.signature.localeCompare(second.signature);
}

function employeeAvailableForInterval(
  employee: OptimizerEmployee,
  interval: Interval,
) {
  const localStart = DateTime.fromJSDate(interval.startAt, { zone: "utc" })
    .setZone(SCHEDULE_TIME_ZONE);
  const localEnd = DateTime.fromJSDate(interval.endAt, { zone: "utc" })
    .setZone(SCHEDULE_TIME_ZONE);
  if (localStart.toISODate() !== localEnd.toISODate()) return false;
  const dayOfWeek = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ][localStart.weekday - 1];
  const startMinute = localStart.hour * 60 + localStart.minute;
  const endMinute = localEnd.hour * 60 + localEnd.minute;
  return employee.availability.some((availability) =>
    availability.dayOfWeek === dayOfWeek
      && availability.startMinute <= startMinute
      && availability.endMinute >= endMinute,
  );
}

function employeeQualifiedForTask(
  employee: OptimizerEmployee,
  task: RepairTask,
) {
  return task.requiredSkillId === null
    || employee.skills.some((skill) =>
      skill.skillId === task.requiredSkillId
        && skill.level >= task.minimumSkillLevel,
    );
}

function employeeCanTakeTask(
  employee: OptimizerEmployee,
  task: RepairTask,
  interval: Interval,
  state: RepairState,
) {
  if (task.kind === "RETAINED_COMMITMENT") return false;
  if (!employeeQualifiedForTask(employee, task)) return false;
  if (!employeeAvailableForInterval(employee, interval)) return false;
  if ((state.occupiedByEmployee.get(employee.id) ?? []).some((item) => overlaps(item, interval))) {
    return false;
  }
  const key = `${employee.id}:${weekKey(interval.startAt)}`;
  return (state.weeklyMinutes.get(key) ?? 0) + minutes(interval) <= employee.maxWeeklyMinutes;
}

function candidateIntervals(employee: OptimizerEmployee, task: RepairTask) {
  const bySignature = new Map<string, Interval>();
  function add(interval: Interval) {
    if (interval.startAt < task.startAt || interval.endAt > task.latestEndAt) return;
    if (!employeeAvailableForInterval(employee, interval)) return;
    bySignature.set(`${interval.startAt.toISOString()}:${interval.endAt.toISOString()}`, interval);
  }
  add({ startAt: task.startAt, endAt: task.endAt });
  if (!task.movable) return [...bySignature.values()];

  const duration = minutes(task);
  let day = DateTime.fromJSDate(task.startAt, { zone: "utc" })
    .setZone(SCHEDULE_TIME_ZONE)
    .startOf("day");
  const finalDay = DateTime.fromJSDate(task.latestEndAt, { zone: "utc" })
    .setZone(SCHEDULE_TIME_ZONE)
    .startOf("day");
  while (day <= finalDay) {
    const dayOfWeek = [
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
      "SUNDAY",
    ][day.weekday - 1];
    for (const availability of employee.availability.filter(
      (item) => item.dayOfWeek === dayOfWeek,
    )) {
      let cursor = day.plus({ minutes: availability.startMinute });
      const windowEnd = day.plus({ minutes: availability.endMinute });
      while (cursor.plus({ minutes: duration }) <= windowEnd) {
        add({
          startAt: cursor.toUTC().toJSDate(),
          endAt: cursor.plus({ minutes: duration }).toUTC().toJSDate(),
        });
        cursor = cursor.plus({ minutes: REPAIR_SLOT_STEP_MINUTES });
      }
    }
    day = day.plus({ days: 1 });
  }
  return [...bySignature.values()];
}

function repairCandidateAbsence(
  candidateId: number,
  tasks: RepairTask[],
  employees: OptimizerEmployee[],
  baselineIntervals: Array<Interval & { employeeId: number }>,
) {
  const remainingEmployees = employees.filter((employee) => employee.id !== candidateId);
  const intervalCache = new Map<string, Interval[]>();
  function intervalsFor(employee: OptimizerEmployee, task: RepairTask) {
    const key = `${employee.id}:${task.id}`;
    const existing = intervalCache.get(key);
    if (existing) return existing;
    const intervals = candidateIntervals(employee, task);
    intervalCache.set(key, intervals);
    return intervals;
  }
  const occupiedByEmployee = new Map<number, Interval[]>(
    remainingEmployees.map((employee) => [employee.id, []]),
  );
  const weeklyMinutes = new Map<string, number>();
  for (const interval of baselineIntervals) {
    if (interval.employeeId === candidateId) continue;
    occupiedByEmployee.get(interval.employeeId)?.push(interval);
    const key = `${interval.employeeId}:${weekKey(interval.startAt)}`;
    weeklyMinutes.set(key, (weeklyMinutes.get(key) ?? 0) + minutes(interval));
  }

  let beam: RepairState[] = [{
    occupiedByEmployee,
    weeklyMinutes,
    lostMinutes: 0,
    lostCriticalKeys: new Set(),
    replacementCostCents: 0,
    replacementCount: 0,
    rescheduledCount: 0,
    displacementMinutes: 0,
    signature: "",
  }];
  const orderedTasks = [...tasks].sort((first, second) => {
    const firstCandidates = remainingEmployees.filter((employee) =>
      employeeQualifiedForTask(employee, first)
        && intervalsFor(employee, first).length > 0,
    ).length;
    const secondCandidates = remainingEmployees.filter((employee) =>
      employeeQualifiedForTask(employee, second)
        && intervalsFor(employee, second).length > 0,
    ).length;
    return Number(second.criticalKey !== null) - Number(first.criticalKey !== null)
      || firstCandidates - secondCandidates
      || minutes(second) - minutes(first)
      || first.startAt.getTime() - second.startAt.getTime()
      || first.id.localeCompare(second.id);
  });

  for (const task of orderedTasks) {
    const expanded: RepairState[] = [];
    for (const state of beam) {
      const duration = minutes(task);
      const candidates = remainingEmployees.flatMap((employee) =>
        intervalsFor(employee, task).flatMap((interval) => {
          if (!employeeCanTakeTask(employee, task, interval, state)) return [];
          const key = `${employee.id}:${weekKey(interval.startAt)}`;
          const cost = allocationCostBreakdown(
            employee,
            state.weeklyMinutes.get(key) ?? 0,
            duration,
          ).totalCostCents;
          const displacement = Math.round(
            Math.abs(interval.startAt.getTime() - task.startAt.getTime()) / 60_000,
          );
          return [{ employee, interval, cost, displacement }];
        }),
      )
        .sort((first, second) =>
          first.displacement - second.displacement
          || first.cost - second.cost
          || first.interval.startAt.getTime() - second.interval.startAt.getTime()
          || first.employee.id - second.employee.id,
        )
        .slice(0, MAX_REPLACEMENT_BRANCHES);

      for (const { employee, interval, cost, displacement } of candidates) {
        const next = cloneState(state);
        next.occupiedByEmployee.get(employee.id)?.push(interval);
        const key = `${employee.id}:${weekKey(interval.startAt)}`;
        next.weeklyMinutes.set(key, (next.weeklyMinutes.get(key) ?? 0) + duration);
        next.replacementCostCents += cost;
        next.replacementCount += 1;
        next.rescheduledCount += displacement === 0 ? 0 : 1;
        next.displacementMinutes += displacement;
        next.signature += `${task.id}:${employee.id}:${interval.startAt.toISOString()};`;
        expanded.push(next);
      }

      const lost = cloneState(state);
      lost.lostMinutes += duration;
      if (task.criticalKey !== null) lost.lostCriticalKeys.add(task.criticalKey);
      lost.signature += `${task.id}:unfilled;`;
      expanded.push(lost);
    }
    beam = expanded.sort(compareRepairStates).slice(0, REPAIR_BEAM_WIDTH);
  }

  return beam.sort(compareRepairStates)[0]!;
}

export async function buildPortfolioResilienceReport(
  database: PlanningDatabase,
  options: PortfolioResilienceOptions,
) {
  const startedAt = Date.now();
  const snapshotDatabase = createPlanningSnapshotDatabase(database);
  const planOptions: PortfolioPlanOptions = {
    horizonStart: options.horizonStart,
    horizonWeeks: options.horizonWeeks,
    replaceGenerated: options.replaceGenerated,
    ...(options.planningProfile
      ? { planningProfile: options.planningProfile }
      : {}),
    ...(options.optimizerSearchMode
      ? { optimizerSearchMode: options.optimizerSearchMode }
      : {}),
    ...(options.optimizerRunner
      ? { optimizerRunner: options.optimizerRunner }
      : {}),
  };
  const baseline = await buildPortfolioPlanPreview(snapshotDatabase, planOptions);
  if (baseline.previewId !== options.previewId || baseline.inputVersion !== options.inputVersion) {
    throw new Error("PORTFOLIO_PREVIEW_STALE");
  }

  const horizonStart = DateTime.fromISO(options.horizonStart, {
    zone: SCHEDULE_TIME_ZONE,
  }).startOf("day").toUTC().toJSDate();
  const horizonEndExclusive = DateTime.fromISO(options.horizonStart, {
    zone: SCHEDULE_TIME_ZONE,
  }).startOf("day").plus({ weeks: options.horizonWeeks }).toUTC().toJSDate();
  const [storedEmployees, projects, horizonShifts] = await Promise.all([
    snapshotDatabase.employee.findMany({
      where: { archivedAt: null },
      include: { skills: true, availability: true },
      orderBy: { id: "asc" },
    }),
    snapshotDatabase.project.findMany({
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
    snapshotDatabase.shift.findMany({
      where: {
        status: "COMMITTED",
        startAt: { lt: horizonEndExclusive },
        endAt: { gt: horizonStart },
      },
      orderBy: { id: "asc" },
    }),
  ]);
  const employees = storedEmployees as OptimizerEmployee[];
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const workPackageById = new Map(projects.flatMap((project) =>
    project.workPackages.map((workPackage) => [workPackage.id, { project, workPackage }] as const),
  ));
  const requirementIds = [...new Set(
    baseline.fixedCoverageAssignments.map((assignment) => assignment.projectRequirementId),
  )];
  const requirements = requirementIds.length === 0 ? [] : await snapshotDatabase.projectRequirement.findMany({
    where: { id: { in: requirementIds } },
    orderBy: { id: "asc" },
  });
  const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const retainedShifts = horizonShifts.filter((shift) =>
    !options.replaceGenerated || shift.origin !== "SOLVER",
  );
  const baselineIntervals: Array<Interval & { employeeId: number }> = [
    ...baseline.assignments.map((assignment) => ({
      employeeId: assignment.employeeId,
      startAt: new Date(assignment.startAt),
      endAt: new Date(assignment.endAt),
    })),
    ...baseline.fixedCoverageAssignments.map((assignment) => ({
      employeeId: assignment.employeeId,
      startAt: new Date(assignment.startAt),
      endAt: new Date(assignment.endAt),
    })),
    ...retainedShifts.map((shift) => ({
      employeeId: shift.employeeId,
      startAt: shift.startAt,
      endAt: shift.endAt,
    })),
  ];
  const tasksByEmployee = new Map<number, RepairTask[]>();
  function addTask(employeeId: number, task: RepairTask) {
    tasksByEmployee.set(employeeId, [...(tasksByEmployee.get(employeeId) ?? []), task]);
  }
  const firstAssignmentByPackage = new Map<number, Date>();
  for (const assignment of [...baseline.assignments].sort((first, second) =>
    new Date(first.startAt).getTime() - new Date(second.startAt).getTime(),
  )) {
    if (!firstAssignmentByPackage.has(assignment.workPackageId)) {
      firstAssignmentByPackage.set(assignment.workPackageId, new Date(assignment.startAt));
    }
  }
  const successorBoundaryByPackage = new Map<number, Date>();
  for (const project of projects) {
    for (const successor of project.workPackages) {
      const successorStart = firstAssignmentByPackage.get(successor.id);
      if (!successorStart) continue;
      for (const dependency of successor.incomingDependencies) {
        const predecessorBoundary = new Date(
          successorStart.getTime() - dependency.lagMinutes * 60_000,
        );
        const existing = successorBoundaryByPackage.get(dependency.predecessorId);
        if (!existing || predecessorBoundary < existing) {
          successorBoundaryByPackage.set(dependency.predecessorId, predecessorBoundary);
        }
      }
    }
  }
  for (const assignment of baseline.assignments) {
    const entry = workPackageById.get(assignment.workPackageId);
    if (!entry) continue;
    const originalEnd = new Date(assignment.endAt);
    const laterSamePackageStart = baseline.assignments
      .filter((item) =>
        item.workPackageId === assignment.workPackageId
          && new Date(item.startAt) > new Date(assignment.startAt),
      )
      .map((item) => new Date(item.startAt))
      .sort((first, second) => first.getTime() - second.getTime())[0];
    const boundaries = [
      horizonEndExclusive,
      localTargetEnd(entry.workPackage.targetEndDate),
      entry.project.deadlineType === "NONE"
        ? null
        : localTargetEnd(entry.project.targetEndDate),
      laterSamePackageStart ?? null,
      successorBoundaryByPackage.get(assignment.workPackageId) ?? null,
    ].filter((value): value is Date => value !== null);
    const boundedEnd = boundaries.reduce(
      (earliest, boundary) => boundary < earliest ? boundary : earliest,
      horizonEndExclusive,
    );
    addTask(assignment.employeeId, {
      id: `work:${assignment.workPackageId}:${assignment.startAt}:${assignment.employeeId}`,
      kind: "WORK_PACKAGE",
      startAt: new Date(assignment.startAt),
      endAt: new Date(assignment.endAt),
      requiredSkillId: entry.workPackage.requiredSkillId,
      minimumSkillLevel: entry.workPackage.minimumSkillLevel,
      criticalKey: entry.project.priority === "CRITICAL"
        ? `work-package:${assignment.workPackageId}`
        : null,
      plannedCostCents: assignment.plannedCostCents,
      movable: true,
      latestEndAt: boundedEnd < originalEnd ? originalEnd : boundedEnd,
    });
  }
  for (const assignment of baseline.fixedCoverageAssignments) {
    const requirement = requirementById.get(assignment.projectRequirementId);
    addTask(assignment.employeeId, {
      id: `fixed:${assignment.projectRequirementId}:${assignment.startAt}:${assignment.employeeId}`,
      kind: "FIXED_COVERAGE",
      startAt: new Date(assignment.startAt),
      endAt: new Date(assignment.endAt),
      requiredSkillId: requirement?.requiredSkillId ?? null,
      minimumSkillLevel: requirement?.minimumSkillLevel ?? 0,
      criticalKey: requirement?.priority === "CRITICAL"
        ? `fixed:${assignment.projectRequirementId}:${assignment.startAt}`
        : null,
      plannedCostCents: assignment.plannedCostCents,
      movable: false,
      latestEndAt: new Date(assignment.endAt),
    });
  }
  for (const shift of retainedShifts) {
    addTask(shift.employeeId, {
      id: `retained:${shift.id}`,
      kind: "RETAINED_COMMITMENT",
      startAt: shift.startAt,
      endAt: shift.endAt,
      requiredSkillId: null,
      minimumSkillLevel: 0,
      criticalKey: projectById.get(shift.projectId)?.priority === "CRITICAL"
        ? `retained:${shift.id}`
        : null,
      plannedCostCents: shift.plannedCostCents ?? 0,
      movable: false,
      latestEndAt: shift.endAt,
    });
  }

  const baselineMinutes = baseline.metrics.allocatedMinutes;
  const scenarios = baseline.resilienceCandidates.map((candidate) => {
    const scenarioStartedAt = Date.now();
    const tasks = tasksByEmployee.get(candidate.employeeId) ?? [];
    const repair = repairCandidateAbsence(
      candidate.employeeId,
      tasks,
      employees,
      baselineIntervals,
    );
    const lostMinutes = repair.lostMinutes;
    const allocatedMinutes = Math.max(0, baselineMinutes - lostMinutes);
    const coveragePercent = baselineMinutes === 0
      ? 100
      : roundPercent((allocatedMinutes / baselineMinutes) * 100);
    const criticalGapsAtRisk = repair.lostCriticalKeys.size;
    const removedCostCents = tasks.reduce(
      (total, task) => total + task.plannedCostCents,
      0,
    );
    return {
      employeeId: candidate.employeeId,
      employeeName: candidate.employeeName,
      affectedAllocations: candidate.allocationCount,
      affectedMinutes: candidate.scheduledMinutes,
      recoveredMinutes: allocatedMinutes,
      lostMinutes,
      coveragePercent,
      criticalGapsAtRisk,
      additionalCostCents: lostMinutes === 0 && criticalGapsAtRisk === 0
        ? repair.replacementCostCents - removedCostCents
        : null,
      recoverable: lostMinutes === 0 && criticalGapsAtRisk === 0,
      reassignedAllocations: repair.replacementCount,
      rescheduledAllocations: repair.rescheduledCount,
      displacementMinutes: repair.displacementMinutes,
      runtimeMs: Date.now() - scenarioStartedAt,
    };
  });

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
    algorithmVersion: "portfolio-resilience-n-minus-one-v4",
    strategy: "DETERMINISTIC_BOUNDED_LOCAL_REPAIR",
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
