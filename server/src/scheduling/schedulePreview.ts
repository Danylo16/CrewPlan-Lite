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
import type { SchedulingInput } from "./types.js";

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

export async function buildSchedulePreview(
  database: ScheduleDatabase,
  weekStartValue: string,
  replaceExisting: boolean,
) {
  const weekStart = parseWeekStart(weekStartValue);
  const weekWindow = getWeekWindowUtc(weekStart);

  const [employees, requirements, shifts] =
    await Promise.all([
      database.employee.findMany({
        take: MAX_EMPLOYEES + 1,
        include: {
          skills: true,
          availability: true,
        },
        orderBy: {
          id: "asc",
        },
      }),

      database.projectRequirement.findMany({
        take: MAX_REQUIREMENTS + 1,
        orderBy: {
          id: "asc",
        },
      }),

      database.shift.findMany({
        where: {
          startAt: {
            lt: weekWindow.endAt,
          },
          endAt: {
            gt: weekWindow.startAt,
          },
        },
        orderBy: {
          id: "asc",
        },
      }),
    ]);

  const requestedPositions = requirements.reduce(
    (total, requirement) =>
      total + requirement.requiredEmployees,
    0,
  );

  if (
    employees.length > MAX_EMPLOYEES ||
    requirements.length > MAX_REQUIREMENTS ||
    requestedPositions > MAX_STAFFING_POSITIONS
  ) {
    throw new ScheduleInputTooLargeError();
  }

  const schedulingInput: SchedulingInput = {
    employees: employees.map((employee) => ({
      id: employee.id,

      preferredWeeklyMinutes:
        employee.preferredWeeklyMinutes,

      maxWeeklyMinutes:
        employee.maxWeeklyMinutes,

      skills: employee.skills.map((skill) => ({
        skillId: skill.skillId,
        level: skill.level,
      })),

      availability: employee.availability.map(
        (availability) => ({
          dayOfWeek: availability.dayOfWeek,
          startMinute: availability.startMinute,
          endMinute: availability.endMinute,
        }),
      ),
    })),

    requirements: requirements.map((requirement) => ({
      id: requirement.id,
      projectId: requirement.projectId,
      dayOfWeek: requirement.dayOfWeek,
      startMinute: requirement.startMinute,
      endMinute: requirement.endMinute,

      requiredEmployees:
        requirement.requiredEmployees,

      requiredSkillId:
        requirement.requiredSkillId,

      minimumSkillLevel:
        requirement.minimumSkillLevel,

      priority: requirement.priority,
    })),

    existingShifts: replaceExisting
      ? []
      : shifts.flatMap((shift) =>
          splitExistingShiftIntoDays(
            shift,
            weekStart,
          ),
        ),
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
    })),
  });

  const result = generateSchedule(schedulingInput);

  const assignments = result.assignments.map(
    (assignment) => {
      const interval = scheduleIntervalToUtc(
        weekStart,
        assignment.dayOfWeek,
        assignment.startMinute,
        assignment.endMinute,
      );

      return {
        ...assignment,
        startAt: interval.startAt.toISOString(),
        endAt: interval.endAt.toISOString(),
      };
    },
  );

  const previewId = hash({
    inputVersion,
    assignments,
    unfilledPositions: result.unfilledPositions,
  });

  return {
    previewId,
    inputVersion,
    weekStart: weekStartValue,
    timezone: SCHEDULE_TIME_ZONE,
    replaceExisting,
    assignments,
    unfilledRequirements:
      result.unfilledPositions,
    metrics: result.metrics,
  };
}