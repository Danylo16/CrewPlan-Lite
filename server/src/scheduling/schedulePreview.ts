import { createHash } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { generateSchedule } from "./generateSchedule.js";
import {
  getWeekWindowUtc,
  parseWeekStart,
  scheduleIntervalToUtc,
  SCHEDULE_TIME_ZONE,
  splitExistingShiftIntoDays,
} from "./timeAdapter.js";
import type {
  ExistingShiftInput,
  SchedulingEmployee,
  SchedulingInput,
  SchedulingRequirement,
} from "./types.js";

export const MAX_SCHEDULING_EMPLOYEES = 50;
const MAX_REQUIREMENTS = 100;
const MAX_STAFFING_POSITIONS = 300;

export type ScheduleDatabase = Pick<
  Prisma.TransactionClient,
  "employee" | "projectRequirement" | "shift"
>;

export class ScheduleInputTooLargeError extends Error {
  readonly limits = {
    employees: MAX_SCHEDULING_EMPLOYEES,
    requirements: MAX_REQUIREMENTS,
    staffingPositions: MAX_STAFFING_POSITIONS,
  };

  constructor() {
    super("SCHEDULE_INPUT_TOO_LARGE");
  }
}

function hash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

interface StoredShiftInterval extends ExistingShiftInput {
  id: number;
  origin: "MANUAL" | "SOLVER" | "LEGACY";
}

interface StoredEmployee {
  id: number;
  preferredWeeklyMinutes: number;
  maxWeeklyMinutes: number;
  hourlyCostCents: number;
  overtimeRateBasisPoints: number;
  skills: Array<{ skillId: number; level: number }>;
  availability: Array<{
    dayOfWeek: SchedulingEmployee["availability"][number]["dayOfWeek"];
    startMinute: number;
    endMinute: number;
  }>;
}

interface StoredRequirement {
  id: number;
  projectId: number;
  dayOfWeek: SchedulingRequirement["dayOfWeek"];
  startMinute: number;
  endMinute: number;
  requiredEmployees: number;
  requiredSkillId: number | null;
  minimumSkillLevel: number;
  priority: SchedulingRequirement["priority"];
  activeFrom: Date | null;
  activeUntil: Date | null;
}

interface StoredShift {
  id: number;
  employeeId: number;
  projectId: number;
  startAt: Date;
  endAt: Date;
  updatedAt: Date;
  origin: "MANUAL" | "SOLVER" | "LEGACY";
  status: string;
}

function employeeCanFulfil(
  employee: SchedulingEmployee | undefined,
  requirement: SchedulingRequirement,
) {
  if (!employee) {
    return false;
  }

  const isAvailable = employee.availability.some((availability) =>
    availability.dayOfWeek === requirement.dayOfWeek
      && availability.startMinute <= requirement.startMinute
      && availability.endMinute >= requirement.endMinute,
  );

  if (!isAvailable) {
    return false;
  }

  return requirement.requiredSkillId === null
    || employee.skills.some((skill) =>
      skill.skillId === requirement.requiredSkillId
        && skill.level >= requirement.minimumSkillLevel,
    );
}

function reconcileExistingShifts(
  employees: SchedulingEmployee[],
  requirements: SchedulingRequirement[],
  shifts: StoredShiftInterval[],
) {
  const employeeById = new Map(
    employees.map((employee) => [employee.id, employee]),
  );
  const usedShiftIds = new Set<number>();
  const matchedByRequirement = new Map<number, number>();
  const existingAssignments: Array<{
    shiftId: number;
    requirementId: number;
    positionIndex: number;
    employeeId: number;
    projectId: number;
  }> = [];

  for (const requirement of requirements) {
    const matches = shifts
      .filter((shift) =>
        !usedShiftIds.has(shift.id)
          && shift.projectId === requirement.projectId
          && shift.dayOfWeek === requirement.dayOfWeek
          && shift.startMinute === requirement.startMinute
          && shift.endMinute === requirement.endMinute
          && employeeCanFulfil(employeeById.get(shift.employeeId), requirement),
      )
      .slice(0, requirement.requiredEmployees);

    matches.forEach((shift, positionIndex) => {
      usedShiftIds.add(shift.id);
      existingAssignments.push({
        shiftId: shift.id,
        requirementId: requirement.id,
        positionIndex,
        employeeId: shift.employeeId,
        projectId: shift.projectId,
      });
    });
    matchedByRequirement.set(requirement.id, matches.length);
  }

  return { existingAssignments, matchedByRequirement };
}

function buildSchedulePreviewFromSnapshot(
  weekStartValue: string,
  replaceExisting: boolean,
  employees: StoredEmployee[],
  requirements: StoredRequirement[],
  shifts: StoredShift[],
  scheduleResultCache?: Map<string, ReturnType<typeof generateSchedule>>,
) {
  const weekStart = parseWeekStart(weekStartValue);

  const requestedPositions = requirements.reduce(
    (total, requirement) => total + requirement.requiredEmployees,
    0,
  );

  if (
    employees.length > MAX_SCHEDULING_EMPLOYEES
    || requirements.length > MAX_REQUIREMENTS
    || requestedPositions > MAX_STAFFING_POSITIONS
  ) {
    throw new ScheduleInputTooLargeError();
  }

  const schedulingEmployees: SchedulingEmployee[] = employees.map((employee) => ({
    id: employee.id,
    preferredWeeklyMinutes: employee.preferredWeeklyMinutes,
    maxWeeklyMinutes: employee.maxWeeklyMinutes,
    hourlyCostCents: employee.hourlyCostCents,
    overtimeRateBasisPoints: employee.overtimeRateBasisPoints,
    skills: employee.skills.map((skill) => ({
      skillId: skill.skillId,
      level: skill.level,
    })),
    availability: employee.availability.map((availability) => ({
      dayOfWeek: availability.dayOfWeek,
      startMinute: availability.startMinute,
      endMinute: availability.endMinute,
    })),
  }));
  const schedulingRequirements: SchedulingRequirement[] = requirements.map((requirement) => ({
    id: requirement.id,
    projectId: requirement.projectId,
    dayOfWeek: requirement.dayOfWeek,
    startMinute: requirement.startMinute,
    endMinute: requirement.endMinute,
    requiredEmployees: requirement.requiredEmployees,
    requiredSkillId: requirement.requiredSkillId,
    minimumSkillLevel: requirement.minimumSkillLevel,
    priority: requirement.priority,
  }));
  const storedShiftIntervals: StoredShiftInterval[] = shifts.flatMap((shift) =>
    splitExistingShiftIntoDays(shift, weekStart).map((interval) => ({
      ...interval,
      id: shift.id,
      origin: shift.origin,
    })),
  );
  const preservedShiftIntervals = replaceExisting
    ? storedShiftIntervals.filter((shift) => shift.origin !== "SOLVER")
    : storedShiftIntervals;
  const reconciliation = reconcileExistingShifts(
    schedulingEmployees,
    schedulingRequirements,
    preservedShiftIntervals,
  );
  const schedulingInput: SchedulingInput = {
    employees: schedulingEmployees,
    requirements: schedulingRequirements
      .map((requirement) => ({
        ...requirement,
        requiredEmployees: requirement.requiredEmployees
          - (reconciliation.matchedByRequirement.get(requirement.id) ?? 0),
      }))
      .filter((requirement) => requirement.requiredEmployees > 0),
    existingShifts: preservedShiftIntervals,
  };

  const inputVersion = hash({
    weekStart: weekStartValue,
    replaceExisting,
    schedulingInput,
    storedShifts: shifts.map((shift) => ({
      id: shift.id,
      employeeId: shift.employeeId,
      projectId: shift.projectId,
      startAt: shift.startAt.toISOString(),
      endAt: shift.endAt.toISOString(),
      updatedAt: shift.updatedAt.toISOString(),
      origin: shift.origin,
      status: shift.status,
    })),
  });
  const schedulingSignature = scheduleResultCache
    ? JSON.stringify(schedulingInput)
    : null;
  let result = schedulingSignature === null
    ? undefined
    : scheduleResultCache?.get(schedulingSignature);
  if (!result) {
    result = generateSchedule(schedulingInput);
    if (schedulingSignature !== null) {
      scheduleResultCache?.set(schedulingSignature, result);
    }
  }
  const assignments = result.assignments.map((assignment) => {
    const interval = scheduleIntervalToUtc(
      weekStart,
      assignment.dayOfWeek,
      assignment.startMinute,
      assignment.endMinute,
    );

    return {
      ...assignment,
      positionIndex: assignment.positionIndex
        + (reconciliation.matchedByRequirement.get(assignment.requirementId) ?? 0),
      startAt: interval.startAt.toISOString(),
      endAt: interval.endAt.toISOString(),
    };
  });
  const unfilledRequirements = result.unfilledPositions.map((position) => ({
    ...position,
    positionIndex: position.positionIndex
      + (reconciliation.matchedByRequirement.get(position.requirementId) ?? 0),
  }));
  const existingPositions = reconciliation.existingAssignments.length;
  const proposedPositions = assignments.length;
  const assignedPositions = existingPositions + proposedPositions;
  const existingMinutes = reconciliation.existingAssignments.reduce(
    (total, assignment) => {
      const requirement = schedulingRequirements.find(
        (item) => item.id === assignment.requirementId,
      );
      return total + (requirement
        ? requirement.endMinute - requirement.startMinute
        : 0);
    },
    0,
  );
  const metrics = {
    ...result.metrics,
    requestedPositions,
    assignedPositions,
    existingPositions,
    proposedPositions,
    unfilledPositions: unfilledRequirements.length,
    coveragePercent: requestedPositions === 0
      ? 100
      : Math.round((assignedPositions / requestedPositions) * 10_000) / 100,
    assignedMinutes: existingMinutes + result.metrics.assignedMinutes,
  };
  const previewId = hash({
    inputVersion,
    existingAssignments: reconciliation.existingAssignments,
    assignments,
    unfilledPositions: unfilledRequirements,
  });

  return {
    previewId,
    inputVersion,
    weekStart: weekStartValue,
    timezone: SCHEDULE_TIME_ZONE,
    replaceExisting,
    existingAssignments: reconciliation.existingAssignments,
    assignments,
    unfilledRequirements,
    metrics,
  };
}

export async function buildSchedulePreview(
  database: ScheduleDatabase,
  weekStartValue: string,
  replaceExisting: boolean,
  excludedEmployeeIds: readonly number[] = [],
) {
  const weekStart = parseWeekStart(weekStartValue);
  const weekWindow = getWeekWindowUtc(weekStart);
  const weekStartDate = new Date(`${weekStartValue}T00:00:00.000Z`);
  const weekEndDate = new Date(
    `${weekStart.plus({ days: 7 }).toISODate()}T00:00:00.000Z`,
  );

  const [employees, requirements, shifts] = await Promise.all([
    database.employee.findMany({
      where: {
        archivedAt: null,
        ...(excludedEmployeeIds.length > 0
          ? { id: { notIn: [...excludedEmployeeIds] } }
          : {}),
      },
      take: MAX_SCHEDULING_EMPLOYEES + 1,
      include: {
        skills: true,
        availability: true,
      },
      orderBy: { id: "asc" },
    }),
    database.projectRequirement.findMany({
      where: {
        project: {
          status: { in: ["PLANNED", "ACTIVE"] },
          archivedAt: null,
        },
        AND: [
          { OR: [{ activeFrom: null }, { activeFrom: { lt: weekEndDate } }] },
          { OR: [{ activeUntil: null }, { activeUntil: { gte: weekStartDate } }] },
        ],
      },
      take: MAX_REQUIREMENTS + 1,
      orderBy: { id: "asc" },
    }),
    database.shift.findMany({
      where: {
        status: "COMMITTED",
        startAt: { lt: weekWindow.endAt },
        endAt: { gt: weekWindow.startAt },
      },
      orderBy: { id: "asc" },
    }),
  ]);

  return buildSchedulePreviewFromSnapshot(
    weekStartValue,
    replaceExisting,
    employees,
    requirements,
    shifts,
  );
}

export async function buildSchedulePreviews(
  database: ScheduleDatabase,
  weekStartValues: readonly string[],
  replaceExisting: boolean,
  excludedEmployeeIds: readonly number[] = [],
) {
  if (weekStartValues.length === 0) return [];

  const weeks = weekStartValues.map((weekStartValue) => {
    const weekStart = parseWeekStart(weekStartValue);
    const weekWindow = getWeekWindowUtc(weekStart);
    return {
      weekStartValue,
      weekStart,
      weekWindow,
      requirementStart: new Date(`${weekStartValue}T00:00:00.000Z`),
      requirementEnd: new Date(
        `${weekStart.plus({ days: 7 }).toISODate()}T00:00:00.000Z`,
      ),
    };
  });
  const horizonStart = weeks.reduce(
    (earliest, week) => week.weekWindow.startAt < earliest
      ? week.weekWindow.startAt
      : earliest,
    weeks[0]!.weekWindow.startAt,
  );
  const horizonEnd = weeks.reduce(
    (latest, week) => week.weekWindow.endAt > latest
      ? week.weekWindow.endAt
      : latest,
    weeks[0]!.weekWindow.endAt,
  );
  const requirementStart = weeks.reduce(
    (earliest, week) => week.requirementStart < earliest
      ? week.requirementStart
      : earliest,
    weeks[0]!.requirementStart,
  );
  const requirementEnd = weeks.reduce(
    (latest, week) => week.requirementEnd > latest
      ? week.requirementEnd
      : latest,
    weeks[0]!.requirementEnd,
  );

  // Read one consistent horizon snapshot. Per-week filtering below reproduces
  // the original query boundaries without paying one database round-trip per
  // week for requirements and committed shifts.
  const [employees, requirements, shifts] = await Promise.all([
    database.employee.findMany({
      where: {
        archivedAt: null,
        ...(excludedEmployeeIds.length > 0
          ? { id: { notIn: [...excludedEmployeeIds] } }
          : {}),
      },
      take: MAX_SCHEDULING_EMPLOYEES + 1,
      include: {
        skills: true,
        availability: true,
      },
      orderBy: { id: "asc" },
    }),
    database.projectRequirement.findMany({
      where: {
        project: {
          status: { in: ["PLANNED", "ACTIVE"] },
          archivedAt: null,
        },
        AND: [
          { OR: [{ activeFrom: null }, { activeFrom: { lt: requirementEnd } }] },
          { OR: [{ activeUntil: null }, { activeUntil: { gte: requirementStart } }] },
        ],
      },
      take: MAX_REQUIREMENTS * weekStartValues.length + 1,
      orderBy: { id: "asc" },
    }),
    database.shift.findMany({
      where: {
        status: "COMMITTED",
        startAt: { lt: horizonEnd },
        endAt: { gt: horizonStart },
      },
      orderBy: { id: "asc" },
    }),
  ]);

  if (employees.length > MAX_SCHEDULING_EMPLOYEES) {
    throw new ScheduleInputTooLargeError();
  }

  const scheduleResultCache = new Map<
    string,
    ReturnType<typeof generateSchedule>
  >();
  // The solver operates on week-relative weekdays/minutes. If two weeks have
  // identical normalized requirements, employees and preserved shifts, their
  // solver result is identical; only the UTC projection and preview hashes are
  // rebuilt for the concrete week.
  return weeks.map((week) => buildSchedulePreviewFromSnapshot(
    week.weekStartValue,
    replaceExisting,
    employees,
    requirements.filter((requirement) => (
      (requirement.activeFrom === null || requirement.activeFrom < week.requirementEnd)
      && (requirement.activeUntil === null || requirement.activeUntil >= week.requirementStart)
    )),
    shifts.filter((shift) => (
      shift.startAt < week.weekWindow.endAt
      && shift.endAt > week.weekWindow.startAt
    )),
    scheduleResultCache,
  ));
}
