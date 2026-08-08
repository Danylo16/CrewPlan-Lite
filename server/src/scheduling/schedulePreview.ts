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

const MAX_EMPLOYEES = 50;
const MAX_REQUIREMENTS = 100;
const MAX_STAFFING_POSITIONS = 300;

type ScheduleDatabase = Pick<
  Prisma.TransactionClient,
  "employee" | "projectRequirement" | "shift"
>;

export class ScheduleInputTooLargeError extends Error {
  readonly limits = {
    employees: MAX_EMPLOYEES,
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

export async function buildSchedulePreview(
  database: ScheduleDatabase,
  weekStartValue: string,
  replaceExisting: boolean,
) {
  const weekStart = parseWeekStart(weekStartValue);
  const weekWindow = getWeekWindowUtc(weekStart);
  const weekStartDate = new Date(`${weekStartValue}T00:00:00.000Z`);
  const weekEndDate = new Date(
    `${weekStart.plus({ days: 7 }).toISODate()}T00:00:00.000Z`,
  );

  const [employees, requirements, shifts] = await Promise.all([
    database.employee.findMany({
      where: { archivedAt: null },
      take: MAX_EMPLOYEES + 1,
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

  const requestedPositions = requirements.reduce(
    (total, requirement) => total + requirement.requiredEmployees,
    0,
  );

  if (
    employees.length > MAX_EMPLOYEES
    || requirements.length > MAX_REQUIREMENTS
    || requestedPositions > MAX_STAFFING_POSITIONS
  ) {
    throw new ScheduleInputTooLargeError();
  }

  const schedulingEmployees: SchedulingEmployee[] = employees.map((employee) => ({
      id: employee.id,
      preferredWeeklyMinutes: employee.preferredWeeklyMinutes,
      maxWeeklyMinutes: employee.maxWeeklyMinutes,
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
  const result = generateSchedule(schedulingInput);
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
