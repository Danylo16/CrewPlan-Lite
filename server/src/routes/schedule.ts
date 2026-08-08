import { Router } from "express";
import { z } from "zod";
import {
  Prisma,
} from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import {
  buildSchedulePreview,
  ScheduleInputTooLargeError,
} from "../scheduling/schedulePreview.js";
import {
  getWeekWindowUtc,
  parseWeekStart,
} from "../scheduling/timeAdapter.js";

export const scheduleRouter = Router();

const hashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/);

const scheduleRequestSchema = z.object({
  weekStart: z.string(),
  replaceExisting: z.boolean().default(false),
});

const applyScheduleSchema =
  scheduleRequestSchema.extend({
    previewId: hashSchema,
    inputVersion: hashSchema,
  });

function scheduleRequestError(
  error: unknown,
  response: Parameters<
    Parameters<typeof scheduleRouter.post>[1]
  >[1],
) {
  if (
    error instanceof ScheduleInputTooLargeError
  ) {
    return response.status(422).json({
      code: error.message,
      message:
        "Schedule exceeds the portfolio solver limits",
      limits: error.limits,
    });
  }

  const code =
    error instanceof Error
      ? error.message
      : "INTERNAL_SERVER_ERROR";

  if (
    code === "WEEK_START_INVALID" ||
    code === "WEEK_START_NOT_MONDAY"
  ) {
    return response.status(400).json({
      code,
      message:
        code === "WEEK_START_NOT_MONDAY"
          ? "Week start must be a Monday"
          : "Week start must be a valid ISO date",
    });
  }

  throw error;
}

scheduleRouter.post(
  "/generate",
  async (request, response) => {
    const validationResult =
      scheduleRequestSchema.safeParse(
        request.body,
      );

    if (!validationResult.success) {
      return response.status(400).json({
        code: "VALIDATION_ERROR",
        message:
          "Invalid schedule generation request",
        errors:
          validationResult.error.issues,
      });
    }

    try {
      const preview =
        await buildSchedulePreview(
          prisma,
          validationResult.data.weekStart,
          validationResult.data
            .replaceExisting,
        );

      return response.json(preview);
    } catch (error) {
      return scheduleRequestError(
        error,
        response,
      );
    }
  },
);

scheduleRouter.post(
  "/apply",
  async (request, response) => {
    const validationResult =
      applyScheduleSchema.safeParse(
        request.body,
      );

    if (!validationResult.success) {
      return response.status(400).json({
        code: "VALIDATION_ERROR",
        message:
          "Invalid schedule apply request",
        errors:
          validationResult.error.issues,
      });
    }

    const {
      weekStart: weekStartValue,
      replaceExisting,
      previewId,
      inputVersion,
    } = validationResult.data;

    try {
      const applied =
        await prisma.$transaction(
          async (transaction) => {
            const currentPreview =
              await buildSchedulePreview(
                transaction,
                weekStartValue,
                replaceExisting,
              );

            if (
              currentPreview.inputVersion !==
                inputVersion ||
              currentPreview.previewId !==
                previewId
            ) {
              throw new Error(
                "SCHEDULE_PREVIEW_STALE",
              );
            }

            let deletedShifts = 0;

            if (replaceExisting) {
              const weekStart =
                parseWeekStart(
                  weekStartValue,
                );

              const weekWindow =
                getWeekWindowUtc(weekStart);

              const deletion =
                await transaction.shift
                  .deleteMany({
                    where: {
                      origin: "SOLVER",
                      status: "COMMITTED",
                      startAt: {
                        lt: weekWindow.endAt,
                      },
                      endAt: {
                        gt: weekWindow.startAt,
                      },
                    },
                  });

              deletedShifts =
                deletion.count;
            }

            const creation =
              currentPreview.assignments
                .length === 0
                ? { count: 0 }
                : await transaction.shift
                    .createMany({
                      data: currentPreview
                        .assignments
                        .map(
                          (assignment) => ({
                            employeeId:
                              assignment
                                .employeeId,

                            projectId:
                              assignment
                                .projectId,

                            projectRequirementId:
                              assignment
                                .requirementId,

                            kind:
                              "FIXED_COVERAGE",

                            origin:
                              "SOLVER",

                            startAt:
                              new Date(
                                assignment
                                  .startAt,
                              ),

                            endAt:
                              new Date(
                                assignment
                                  .endAt,
                              ),

                            note:
                              "Generated by CrewPlan scheduler",
                          }),
                        ),
                    });

            return {
              previewId:
                currentPreview.previewId,

              inputVersion:
                currentPreview.inputVersion,

              createdShifts:
                creation.count,

              deletedShifts,

              metrics:
                currentPreview.metrics,
            };
          },
          {
            isolationLevel:
              Prisma
                .TransactionIsolationLevel
                .Serializable,

            maxWait: 5_000,
            timeout: 15_000,
          },
        );

      return response
        .status(201)
        .json(applied);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "SCHEDULE_PREVIEW_STALE"
      ) {
        return response.status(409).json({
          code:
            "SCHEDULE_PREVIEW_STALE",

          message:
            "Schedule data changed after the preview was generated",
        });
      }

      if (
        error instanceof
          Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      ) {
        return response.status(409).json({
          code:
            "SCHEDULE_CONCURRENT_MODIFICATION",

          message:
            "Schedule changed concurrently; generate a new preview",
        });
      }

      return scheduleRequestError(
        error,
        response,
      );
    }
  },
);
