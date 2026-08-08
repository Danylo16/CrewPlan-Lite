import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { WORK_PACKAGE_STATUSES } from "../domain/portfolio.js";
import { prisma } from "../lib/prisma.js";

export const projectWorkPackageRouter = Router({ mergeParams: true });
export const workPackageRouter = Router();

const idSchema = z.coerce.number().int().positive();
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)),
  "Date must be valid",
);

const workPackageFields = {
  name: z.string().trim().min(2).max(150),
  description: z.string().trim().max(2000).nullable(),
  requiredSkillId: z.number().int().positive(),
  minimumSkillLevel: z.number().int().min(1).max(5),
  estimatedMinutes: z.number().int().positive().max(1_000_000),
  remainingMinutes: z.number().int().min(0).max(1_000_000),
  maxParallelEmployees: z.number().int().min(1).max(20),
  earliestStartDate: isoDateSchema.nullable(),
  targetEndDate: isoDateSchema.nullable(),
  sortOrder: z.number().int().min(0).max(100_000),
};

const createWorkPackageSchema = z.object({
  ...workPackageFields,
  description: workPackageFields.description.default(null),
  minimumSkillLevel: workPackageFields.minimumSkillLevel.default(1),
  remainingMinutes: workPackageFields.remainingMinutes.optional(),
  maxParallelEmployees: workPackageFields.maxParallelEmployees.default(1),
  earliestStartDate: workPackageFields.earliestStartDate.default(null),
  targetEndDate: workPackageFields.targetEndDate.default(null),
  sortOrder: workPackageFields.sortOrder.default(0),
});

const updateWorkPackageSchema = z.object({
  name: workPackageFields.name.optional(),
  description: workPackageFields.description.optional(),
  status: z.enum(WORK_PACKAGE_STATUSES).optional(),
  requiredSkillId: workPackageFields.requiredSkillId.optional(),
  minimumSkillLevel: workPackageFields.minimumSkillLevel.optional(),
  estimatedMinutes: workPackageFields.estimatedMinutes.optional(),
  remainingMinutes: workPackageFields.remainingMinutes.optional(),
  maxParallelEmployees: workPackageFields.maxParallelEmployees.optional(),
  earliestStartDate: workPackageFields.earliestStartDate.optional(),
  targetEndDate: workPackageFields.targetEndDate.optional(),
  sortOrder: workPackageFields.sortOrder.optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

const dependenciesSchema = z.object({
  predecessors: z.array(z.object({
    workPackageId: z.number().int().positive(),
    lagMinutes: z.number().int().min(0).max(1_000_000).default(0),
  })).max(100),
}).superRefine((data, context) => {
  const ids = data.predecessors.map((item) => item.workPackageId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      message: "A predecessor can only appear once",
      path: ["predecessors"],
    });
  }
});

function dateValue(value: string | null | undefined) {
  return value === null || value === undefined
    ? value
    : new Date(`${value}T00:00:00.000Z`);
}

function createsCycle(
  workPackageId: number,
  projectPackageIds: number[],
  dependencies: Array<{ predecessorId: number; successorId: number }>,
) {
  const successors = new Map<number, number[]>();
  for (const id of projectPackageIds) successors.set(id, []);
  for (const dependency of dependencies) {
    successors.get(dependency.predecessorId)?.push(dependency.successorId);
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  function visit(id: number): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const successor of successors.get(id) ?? []) {
      if (visit(successor)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return visit(workPackageId);
}

projectWorkPackageRouter.get("/", async (request, response) => {
  const projectIdResult = idSchema.safeParse(
    (request.params as { projectId?: string }).projectId,
  );
  if (!projectIdResult.success) {
    return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid project id" });
  }

  const workPackages = await prisma.workPackage.findMany({
    where: { projectId: projectIdResult.data },
    include: {
      requiredSkill: true,
      incomingDependencies: true,
      workLogs: {
        where: { status: "CONFIRMED" },
        select: { startedAt: true, endedAt: true },
      },
    },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });

  return response.json(workPackages.map(({ workLogs, ...workPackage }) => ({
    ...workPackage,
    completedMinutes: workLogs.reduce(
      (total, log) => total + Math.round((log.endedAt.getTime() - log.startedAt.getTime()) / 60_000),
      0,
    ),
  })));
});

projectWorkPackageRouter.post("/", async (request, response) => {
  const projectIdResult = idSchema.safeParse(
    (request.params as { projectId?: string }).projectId,
  );
  const bodyResult = createWorkPackageSchema.safeParse(request.body);
  if (!projectIdResult.success || !bodyResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid work package",
      errors: bodyResult.success ? [] : bodyResult.error.issues,
    });
  }

  const [project, skill] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectIdResult.data } }),
    prisma.skill.findUnique({ where: { id: bodyResult.data.requiredSkillId } }),
  ]);
  if (!project) return response.status(404).json({ code: "PROJECT_NOT_FOUND", message: "Project does not exist" });
  if (!skill) return response.status(400).json({ code: "UNKNOWN_SKILL", message: "Required skill does not exist" });

  const earliestStartDate = dateValue(bodyResult.data.earliestStartDate) ?? null;
  const targetEndDate = dateValue(bodyResult.data.targetEndDate) ?? null;
  if (earliestStartDate && targetEndDate && earliestStartDate > targetEndDate) {
    return response.status(400).json({ code: "INVALID_DATE_RANGE", message: "Work package end cannot be before its start" });
  }

  const data = bodyResult.data;
  const workPackage = await prisma.workPackage.create({
    data: {
      projectId: project.id,
      name: data.name,
      description: data.description,
      requiredSkillId: data.requiredSkillId,
      minimumSkillLevel: data.minimumSkillLevel,
      estimatedMinutes: data.estimatedMinutes,
      remainingMinutes: data.remainingMinutes ?? data.estimatedMinutes,
      maxParallelEmployees: data.maxParallelEmployees,
      earliestStartDate,
      targetEndDate,
      sortOrder: data.sortOrder,
    },
    include: { requiredSkill: true },
  });
  return response.status(201).json({ ...workPackage, completedMinutes: 0 });
});

workPackageRouter.patch("/:id", async (request, response) => {
  const idResult = idSchema.safeParse(request.params.id);
  const bodyResult = updateWorkPackageSchema.safeParse(request.body);
  if (!idResult.success || !bodyResult.success) {
    return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid work package" });
  }

  const current = await prisma.workPackage.findUnique({ where: { id: idResult.data } });
  if (!current) return response.status(404).json({ code: "WORK_PACKAGE_NOT_FOUND", message: "Work package does not exist" });

  if (bodyResult.data.status === "COMPLETED" && (bodyResult.data.remainingMinutes ?? current.remainingMinutes) !== 0) {
    return response.status(409).json({ code: "WORK_PACKAGE_HAS_REMAINING_WORK", message: "Set remaining minutes to zero before completion" });
  }

  const earliestStartDate = bodyResult.data.earliestStartDate === undefined
    ? current.earliestStartDate
    : dateValue(bodyResult.data.earliestStartDate) ?? null;
  const targetEndDate = bodyResult.data.targetEndDate === undefined
    ? current.targetEndDate
    : dateValue(bodyResult.data.targetEndDate) ?? null;
  if (earliestStartDate && targetEndDate && earliestStartDate > targetEndDate) {
    return response.status(400).json({ code: "INVALID_DATE_RANGE", message: "Work package end cannot be before its start" });
  }

  const data: Prisma.WorkPackageUpdateInput = {};
  if (bodyResult.data.name !== undefined) data.name = bodyResult.data.name;
  if (bodyResult.data.description !== undefined) data.description = bodyResult.data.description;
  if (bodyResult.data.status !== undefined) data.status = bodyResult.data.status;
  if (bodyResult.data.requiredSkillId !== undefined) {
    data.requiredSkill = { connect: { id: bodyResult.data.requiredSkillId } };
  }
  if (bodyResult.data.minimumSkillLevel !== undefined) data.minimumSkillLevel = bodyResult.data.minimumSkillLevel;
  if (bodyResult.data.estimatedMinutes !== undefined) data.estimatedMinutes = bodyResult.data.estimatedMinutes;
  if (bodyResult.data.remainingMinutes !== undefined) data.remainingMinutes = bodyResult.data.remainingMinutes;
  if (bodyResult.data.maxParallelEmployees !== undefined) data.maxParallelEmployees = bodyResult.data.maxParallelEmployees;
  if (bodyResult.data.earliestStartDate !== undefined) data.earliestStartDate = earliestStartDate;
  if (bodyResult.data.targetEndDate !== undefined) data.targetEndDate = targetEndDate;
  if (bodyResult.data.sortOrder !== undefined) data.sortOrder = bodyResult.data.sortOrder;
  const updated = await prisma.workPackage.update({
    where: { id: current.id },
    data,
    include: { requiredSkill: true },
  });
  return response.json(updated);
});

workPackageRouter.put("/:id/dependencies", async (request, response) => {
  const idResult = idSchema.safeParse(request.params.id);
  const bodyResult = dependenciesSchema.safeParse(request.body);
  if (!idResult.success || !bodyResult.success) {
    return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid dependencies" });
  }

  const current = await prisma.workPackage.findUnique({ where: { id: idResult.data } });
  if (!current) return response.status(404).json({ code: "WORK_PACKAGE_NOT_FOUND", message: "Work package does not exist" });
  if (bodyResult.data.predecessors.some((item) => item.workPackageId === current.id)) {
    return response.status(400).json({ code: "SELF_DEPENDENCY", message: "A work package cannot depend on itself" });
  }

  const projectPackages = await prisma.workPackage.findMany({
    where: { projectId: current.projectId },
    select: { id: true },
  });
  const projectIds = new Set(projectPackages.map((item) => item.id));
  if (bodyResult.data.predecessors.some((item) => !projectIds.has(item.workPackageId))) {
    return response.status(400).json({ code: "CROSS_PROJECT_DEPENDENCY", message: "Dependencies must belong to the same project" });
  }

  const existing = await prisma.workPackageDependency.findMany({
    where: {
      predecessorId: { in: [...projectIds] },
      successorId: { in: [...projectIds], not: current.id },
    },
    select: { predecessorId: true, successorId: true },
  });
  const proposed = bodyResult.data.predecessors.map((item) => ({
    predecessorId: item.workPackageId,
    successorId: current.id,
  }));
  if (createsCycle(current.id, [...projectIds], [...existing, ...proposed])) {
    return response.status(409).json({ code: "DEPENDENCY_CYCLE", message: "Dependencies must form an acyclic graph" });
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.workPackageDependency.deleteMany({ where: { successorId: current.id } });
    if (bodyResult.data.predecessors.length > 0) {
      await transaction.workPackageDependency.createMany({
        data: bodyResult.data.predecessors.map((item) => ({
          predecessorId: item.workPackageId,
          successorId: current.id,
          lagMinutes: item.lagMinutes,
        })),
      });
    }
  });
  return response.status(204).send();
});

workPackageRouter.delete("/:id", async (request, response) => {
  const idResult = idSchema.safeParse(request.params.id);
  if (!idResult.success) return response.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid work package id" });

  const workPackage = await prisma.workPackage.findUnique({
    where: { id: idResult.data },
    select: { id: true, _count: { select: { shifts: true, workLogs: true } } },
  });
  if (!workPackage) return response.status(404).json({ code: "WORK_PACKAGE_NOT_FOUND", message: "Work package does not exist" });
  if (workPackage._count.shifts > 0 || workPackage._count.workLogs > 0) {
    return response.status(409).json({ code: "WORK_PACKAGE_HAS_HISTORY", message: "A work package with history cannot be deleted" });
  }

  await prisma.workPackage.delete({ where: { id: workPackage.id } });
  return response.status(204).send();
});
