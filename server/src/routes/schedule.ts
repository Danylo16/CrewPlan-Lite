import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { generateSchedule } from "../scheduling/generateSchedule.js";
import {
  getWeekWindowUtc,
  parseWeekStart,
  scheduleIntervalToUtc,
  SCHEDULE_TIME_ZONE,
  splitExistingShiftIntoDays,
} from "../scheduling/timeAdapter.js";
import type { SchedulingInput } from "../scheduling/types.js";

export const scheduleRouter = Router();

const MAX_EMPLOYEES = 50;
const MAX_REQUIREMENTS = 100;
const MAX_STAFFING_POSITIONS = 300;

const generateScheduleSchema = z.object({
  weekStart: z.string(),
  replaceExisting: z.boolean().default(false),
});

function hash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

scheduleRouter.post("/generate", async (request, response) => {
  const validationResult =
    generateScheduleSchema.safeParse(request.body);

  if (!validationResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid schedule generation request",
      errors: validationResult.error.issues,
    });
  }

  const {
    weekStart: weekStartValue,
    replaceExisting,
  } = validationResult.data;

  let weekStart;

  try {
    weekStart = parseWeekStart(weekStartValue);
  } catch (error) {
    const code =
      error instanceof Error
        ? error.message
        : "WEEK_START_INVALID";

    return response.status(400).json({
      code,
      message:
        code === "WEEK_START_NOT_MONDAY"
          ? "Week start must be a Monday"
          : "Week start must be a valid ISO date",
    });
  }

  const weekWindow = getWeekWindowUtc(weekStart);

  const [employees, requirements, shifts] =
    await Promise.all([
      prisma.employee.findMany({
        take: MAX_EMPLOYEES + 1,
        include: {
          skills: true,
          availability: true,
        },
        orderBy: {
          id: "asc",
        },
      }),

      prisma.projectRequirement.findMany({
        take: MAX_REQUIREMENTS + 1,
        orderBy: {
          id: "asc",
        },
      }),

      prisma.shift.findMany({
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
    return response.status(422).json({
      code: "SCHEDULE_INPUT_TOO_LARGE",
      message:
        "Schedule exceeds the portfolio solver limits",
      limits: {
        employees: MAX_EMPLOYEES,
        requirements: MAX_REQUIREMENTS,
        staffingPositions: MAX_STAFFING_POSITIONS,
      },
    });
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
    storedShiftIds: shifts.map((shift) => shift.id),
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

  return response.json({
    previewId,
    inputVersion,
    weekStart: weekStartValue,
    timezone: SCHEDULE_TIME_ZONE,
    replaceExisting,
    assignments,
    unfilledRequirements:
      result.unfilledPositions,
    metrics: result.metrics,
  });
});