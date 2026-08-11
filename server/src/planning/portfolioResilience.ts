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
const MAX_REPLACEMENT_BRANCHES = 8;

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
}

interface RepairState {
  occupiedByEmployee: Map<number, Interval[]>;
  weeklyMinutes: Map<string, number>;
  lostMinutes: number;
  lostCriticalKeys: Set<string>;
  replacementCostCents: number;
  replacementCount: number;
  signature: string;
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}

function minutes(interval: Interval) {
  return Math.round((interval.endAt.getTime() - interval.startAt.getTime()) / 60_000);
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
    signature: state.signature,
  };
}

function compareRepairStates(first: RepairState, second: RepairState) {
  return first.lostCriticalKeys.size - second.lostCriticalKeys.size
    || first.lostMinutes - second.lostMinutes
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
  state: RepairState,
) {
  if (task.kind === "RETAINED_COMMITMENT") return false;
  if (!employeeQualifiedForTask(employee, task)) return false;
  if (!employeeAvailableForInterval(employee, task)) return false;
  if ((state.occupiedByEmployee.get(employee.id) ?? []).some((item) => overlaps(item, task))) {
    return false;
  }
  const key = `${employee.id}:${weekKey(task.startAt)}`;
  return (state.weeklyMinutes.get(key) ?? 0) + minutes(task) <= employee.maxWeeklyMinutes;
}

function repairCandidateAbsence(
  candidateId: number,
  tasks: RepairTask[],
  employees: OptimizerEmployee[],
  baselineIntervals: Array<Interval & { employeeId: number }>,
) {
  const remainingEmployees = employees.filter((employee) => employee.id !== candidateId);
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
    signature: "",
  }];
  const orderedTasks = [...tasks].sort((first, second) => {
    const firstCandidates = remainingEmployees.filter((employee) =>
      employeeQualifiedForTask(employee, first)
        && employeeAvailableForInterval(employee, first),
    ).length;
    const secondCandidates = remainingEmployees.filter((employee) =>
      employeeQualifiedForTask(employee, second)
        && employeeAvailableForInterval(employee, second),
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
      const candidates = remainingEmployees
        .filter((employee) => employeeCanTakeTask(employee, task, state))
        .map((employee) => {
          const key = `${employee.id}:${weekKey(task.startAt)}`;
          const cost = allocationCostBreakdown(
            employee,
            state.weeklyMinutes.get(key) ?? 0,
            duration,
          ).totalCostCents;
          return { employee, cost };
        })
        .sort((first, second) =>
          first.cost - second.cost || first.employee.id - second.employee.id,
        )
        .slice(0, MAX_REPLACEMENT_BRANCHES);

      for (const { employee, cost } of candidates) {
        const next = cloneState(state);
        next.occupiedByEmployee.get(employee.id)?.push(task);
        const key = `${employee.id}:${weekKey(task.startAt)}`;
        next.weeklyMinutes.set(key, (next.weeklyMinutes.get(key) ?? 0) + duration);
        next.replacementCostCents += cost;
        next.replacementCount += 1;
        next.signature += `${task.id}:${employee.id};`;
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
  for (const assignment of baseline.assignments) {
    const entry = workPackageById.get(assignment.workPackageId);
    if (!entry) continue;
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
    algorithmVersion: "portfolio-resilience-n-minus-one-v3",
    strategy: "DETERMINISTIC_INCREMENTAL_BASELINE_REPAIR",
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
