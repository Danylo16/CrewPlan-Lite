import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { costForMinutes, durationMinutes } from "../domain/portfolio.js";
import { prisma } from "../lib/prisma.js";

export const workLogRouter = Router();

const idSchema = z.coerce.number().int().positive();
const workLogBodySchema = z.object({
  employeeId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  workPackageId: z.number().int().positive(),
  plannedAllocationId: z.number().int().positive().nullable().default(null),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(1000).nullable().default(null),
});
const workLogQuerySchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  workPackageId: z.coerce.number().int().positive().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

function timeRange(body: { startedAt: string; endedAt: string }) {
  return {
    startedAt: new Date(body.startedAt),
    endedAt: new Date(body.endedAt),
  };
}

workLogRouter.get("/", async (request, response) => {
  const result = workLogQuerySchema.safeParse(request.query);
  if (!result.success) {
    return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid work log filters" });
  }

  const { employeeId, projectId, workPackageId, from, to } = result.data;
  const workLogs = await prisma.workLog.findMany({
    where: {
      ...(employeeId === undefined ? {} : { employeeId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(workPackageId === undefined ? {} : { workPackageId }),
      ...(from === undefined ? {} : { endedAt: { gt: new Date(from) } }),
      ...(to === undefined ? {} : { startedAt: { lt: new Date(to) } }),
    },
    include: { employee: true, project: true, workPackage: true },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
  });
  return response.json(workLogs.map((log) => ({
    ...log,
    minutes: durationMinutes(log.startedAt, log.endedAt),
  })));
});

workLogRouter.post("/", async (request, response) => {
  const result = workLogBodySchema.safeParse(request.body);
  if (!result.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid work log",
      errors: result.error.issues,
    });
  }

  const data = result.data;
  const { startedAt, endedAt } = timeRange(data);
  if (endedAt <= startedAt) {
    return response.status(400).json({ code: "INVALID_TIME_RANGE", message: "Work log end must be after its start" });
  }

  const [employee, project, workPackage, plannedAllocation] = await Promise.all([
    prisma.employee.findUnique({ where: { id: data.employeeId } }),
    prisma.project.findUnique({ where: { id: data.projectId } }),
    prisma.workPackage.findUnique({ where: { id: data.workPackageId } }),
    data.plannedAllocationId === null
      ? Promise.resolve(null)
      : prisma.shift.findUnique({ where: { id: data.plannedAllocationId } }),
  ]);
  if (!employee) return response.status(404).json({ code: "EMPLOYEE_NOT_FOUND", message: "Employee does not exist" });
  if (!project) return response.status(404).json({ code: "PROJECT_NOT_FOUND", message: "Project does not exist" });
  if (!workPackage) return response.status(404).json({ code: "WORK_PACKAGE_NOT_FOUND", message: "Work package does not exist" });
  if (workPackage.projectId !== project.id) {
    return response.status(400).json({ code: "WORK_PACKAGE_PROJECT_MISMATCH", message: "Work package does not belong to the project" });
  }
  if (data.plannedAllocationId !== null && !plannedAllocation) {
    return response.status(404).json({ code: "ALLOCATION_NOT_FOUND", message: "Planned allocation does not exist" });
  }
  if (
    plannedAllocation
    && (
      plannedAllocation.employeeId !== employee.id
      || plannedAllocation.projectId !== project.id
      || (
        plannedAllocation.workPackageId !== null
        && plannedAllocation.workPackageId !== workPackage.id
      )
    )
  ) {
    return response.status(400).json({ code: "ALLOCATION_MISMATCH", message: "Planned allocation does not match this work log" });
  }

  const workLog = await prisma.workLog.create({
    data: {
      employeeId: employee.id,
      projectId: project.id,
      workPackageId: workPackage.id,
      plannedAllocationId: data.plannedAllocationId,
      startedAt,
      endedAt,
      note: data.note,
    },
  });
  return response.status(201).json({
    ...workLog,
    minutes: durationMinutes(startedAt, endedAt),
  });
});

workLogRouter.post("/:id/confirm", async (request, response) => {
  const idResult = idSchema.safeParse(request.params.id);
  if (!idResult.success) {
    return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid work log id" });
  }

  try {
    const confirmed = await prisma.$transaction(async (transaction) => {
      const workLog = await transaction.workLog.findUnique({
        where: { id: idResult.data },
        include: { employee: true, workPackage: true },
      });
      if (!workLog) throw new Error("WORK_LOG_NOT_FOUND");
      if (workLog.status !== "DRAFT") throw new Error("WORK_LOG_NOT_DRAFT");

      const minutes = durationMinutes(workLog.startedAt, workLog.endedAt);
      const remainingMinutesApplied = Math.min(
        minutes,
        workLog.workPackage.remainingMinutes,
      );
      const confirmedAt = new Date();
      const actualCostCents = costForMinutes(
        workLog.employee.hourlyCostCents,
        minutes,
      );

      await transaction.workPackage.update({
        where: { id: workLog.workPackageId },
        data: { remainingMinutes: { decrement: remainingMinutesApplied } },
      });
      return transaction.workLog.update({
        where: { id: workLog.id },
        data: {
          status: "CONFIRMED",
          actualCostCents,
          remainingMinutesApplied,
          confirmedAt,
        },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    return response.json(confirmed);
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_LOG_NOT_FOUND") {
      return response.status(404).json({ code: error.message, message: "Work log does not exist" });
    }
    if (error instanceof Error && error.message === "WORK_LOG_NOT_DRAFT") {
      return response.status(409).json({ code: error.message, message: "Only a draft work log can be confirmed" });
    }
    throw error;
  }
});

workLogRouter.post("/:id/void", async (request, response) => {
  const idResult = idSchema.safeParse(request.params.id);
  if (!idResult.success) {
    return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid work log id" });
  }

  try {
    const voided = await prisma.$transaction(async (transaction) => {
      const workLog = await transaction.workLog.findUnique({ where: { id: idResult.data } });
      if (!workLog) throw new Error("WORK_LOG_NOT_FOUND");
      if (workLog.status !== "CONFIRMED") throw new Error("WORK_LOG_NOT_CONFIRMED");

      await transaction.workPackage.update({
        where: { id: workLog.workPackageId },
        data: {
          remainingMinutes: {
            increment: workLog.remainingMinutesApplied ?? 0,
          },
        },
      });
      return transaction.workLog.update({
        where: { id: workLog.id },
        data: { status: "VOID", voidedAt: new Date() },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    return response.json(voided);
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_LOG_NOT_FOUND") {
      return response.status(404).json({ code: error.message, message: "Work log does not exist" });
    }
    if (error instanceof Error && error.message === "WORK_LOG_NOT_CONFIRMED") {
      return response.status(409).json({ code: error.message, message: "Only a confirmed work log can be voided" });
    }
    throw error;
  }
});

workLogRouter.delete("/:id", async (request, response) => {
  const idResult = idSchema.safeParse(request.params.id);
  if (!idResult.success) return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid work log id" });

  const workLog = await prisma.workLog.findUnique({ where: { id: idResult.data } });
  if (!workLog) return response.status(404).json({ code: "WORK_LOG_NOT_FOUND", message: "Work log does not exist" });
  if (workLog.status !== "DRAFT") {
    return response.status(409).json({ code: "WORK_LOG_IMMUTABLE", message: "Confirmed or void work logs cannot be deleted" });
  }
  await prisma.workLog.delete({ where: { id: workLog.id } });
  return response.status(204).send();
});
