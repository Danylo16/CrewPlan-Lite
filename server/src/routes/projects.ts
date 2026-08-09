import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import {
  canTransitionProject,
  DEADLINE_TYPES,
  OPTIMIZATION_STRATEGIES,
  PROJECT_PRIORITIES,
  PROJECT_STATUSES,
} from "../domain/portfolio.js";

export const projectRouter = Router();

const projectNameSchema = z.string().trim().min(2).max(100);

const projectColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Color must be a valid hex value");

const isoDateSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "Date must use YYYY-MM-DD",
).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), {
  message: "Date must be valid",
});

function dateValue(value: string | null) {
  return value === null
    ? null
    : new Date(`${value}T00:00:00.000Z`);
}

const requirementSchema = z.object({
  dayOfWeek: z.enum([
    "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY",
    "FRIDAY", "SATURDAY", "SUNDAY",
  ]),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  requiredEmployees: z.number().int().min(1).max(100),
  requiredSkillId: z.number().int().positive().nullable(),
  minimumSkillLevel: z.number().int().min(1).max(5),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]),
}).refine((data) => data.startMinute < data.endMinute, {
  message: "Requirement end must be after its start",
  path: ["endMinute"],
}).refine(
  (data) => data.requiredSkillId !== null || data.minimumSkillLevel === 1,
  {
    message: "A skill level above one requires a selected skill",
    path: ["minimumSkillLevel"],
  },
);

const createProjectSchema = z.object({
  name: projectNameSchema,
  color: projectColorSchema.default("#6366F1"),
  startDate: isoDateSchema.nullable().default(null),
  targetEndDate: isoDateSchema.nullable().default(null),
  deadlineType: z.enum(DEADLINE_TYPES).default("NONE"),
  priority: z.enum(PROJECT_PRIORITIES).default("NORMAL"),
  optimizationStrategy: z.enum(OPTIMIZATION_STRATEGIES).default("BALANCED"),
  totalLaborBudgetCents: z.number().int().min(0).nullable().default(null),
  weeklyLaborBudgetCents: z.number().int().min(0).nullable().default(null),
  requirements: z.array(requirementSchema).max(100).default([]),
});

const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    color: projectColorSchema.optional(),
    startDate: isoDateSchema.nullable().optional(),
    targetEndDate: isoDateSchema.nullable().optional(),
    deadlineType: z.enum(DEADLINE_TYPES).optional(),
    priority: z.enum(PROJECT_PRIORITIES).optional(),
    optimizationStrategy: z.enum(OPTIMIZATION_STRATEGIES).optional(),
    totalLaborBudgetCents: z.number().int().min(0).nullable().optional(),
    weeklyLaborBudgetCents: z.number().int().min(0).nullable().optional(),
  })
  .refine(
    (data) => data.name !== undefined
      || data.color !== undefined
      || data.startDate !== undefined
      || data.targetEndDate !== undefined
      || data.deadlineType !== undefined
      || data.priority !== undefined
      || data.optimizationStrategy !== undefined
      || data.totalLaborBudgetCents !== undefined
      || data.weeklyLaborBudgetCents !== undefined,
    {
      message: "At least one field must be provided",
    },
  );

const projectIdSchema = z.coerce.number().int().positive();
const transitionProjectSchema = z.object({
  status: z.enum(PROJECT_STATUSES),
});

function projectBusinessError(project: {
  startDate: Date | null;
  targetEndDate: Date | null;
  deadlineType: (typeof DEADLINE_TYPES)[number];
}) {
  if (project.startDate && project.targetEndDate && project.startDate > project.targetEndDate) {
    return "Project end date cannot be before its start date";
  }
  if (project.deadlineType === "NONE" && project.targetEndDate !== null) {
    return "A project without a deadline cannot have a target end date";
  }
  if (project.deadlineType !== "NONE" && project.targetEndDate === null) {
    return "A soft or hard deadline requires a target end date";
  }
  return null;
}

projectRouter.get("/", async (request, response) => {
  const includeArchived = request.query.includeArchived === "true";
  const projects = await prisma.project.findMany({
    ...(includeArchived ? {} : { where: { archivedAt: null } }),
    include: {
      _count: {
        select: {
          shifts: true,
          requirements: true,
          workPackages: true,
          workLogs: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const result = projects.map(({ _count, ...project }) => ({
    ...project,
    shiftCount: _count.shifts,
    requirementCount: _count.requirements,
    workPackageCount: _count.workPackages,
    workLogCount: _count.workLogs,
  }));

  return response.json(result);
});

projectRouter.get("/:id", async (request, response) => {
  const idResult = projectIdSchema.safeParse(request.params.id);
  if (!idResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid project id",
    });
  }

  const project = await prisma.project.findUnique({
    where: { id: idResult.data },
    include: {
      _count: {
        select: {
          shifts: true,
          requirements: true,
          workPackages: true,
          workLogs: true,
        },
      },
      workPackages: {
        include: {
          requiredSkill: true,
          incomingDependencies: true,
          workLogs: {
            where: { status: "CONFIRMED" },
            select: { startedAt: true, endedAt: true },
          },
        },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      },
      workLogs: {
        where: { status: "CONFIRMED" },
        select: { actualCostCents: true },
      },
    },
  });

  if (!project) {
    return response.status(404).json({
      code: "PROJECT_NOT_FOUND",
      message: "Project does not exist",
    });
  }

  const workPackages = project.workPackages.map(({ workLogs, ...workPackage }) => ({
    ...workPackage,
    completedMinutes: workLogs.reduce(
      (total, log) => total
        + Math.round((log.endedAt.getTime() - log.startedAt.getTime()) / 60_000),
      0,
    ),
  }));
  const completedMinutes = workPackages.reduce(
    (total, workPackage) => total + workPackage.completedMinutes,
    0,
  );
  const remainingMinutes = workPackages.reduce(
    (total, workPackage) => total + workPackage.remainingMinutes,
    0,
  );
  const estimatedMinutes = workPackages.reduce(
    (total, workPackage) => total + workPackage.estimatedMinutes,
    0,
  );
  const { _count, workLogs: projectWorkLogs, ...projectData } = project;
  const actualCostCents = projectWorkLogs.reduce(
    (total, workLog) => total + (workLog.actualCostCents ?? 0),
    0,
  );
  return response.json({
    ...projectData,
    workPackages,
    shiftCount: _count.shifts,
    requirementCount: _count.requirements,
    workPackageCount: _count.workPackages,
    workLogCount: _count.workLogs,
    progress: {
      estimatedMinutes,
      completedMinutes,
      remainingMinutes,
      forecastMinutes: completedMinutes + remainingMinutes,
      completionPercent: completedMinutes + remainingMinutes === 0
        ? 0
        : Math.round((completedMinutes / (completedMinutes + remainingMinutes)) * 10_000) / 100,
      actualCostCents,
      remainingBudgetCents: project.totalLaborBudgetCents === null
        ? null
        : project.totalLaborBudgetCents - actualCostCents,
    },
  });
});

projectRouter.post("/", async (request, response) => {
  const validationResult = createProjectSchema.safeParse(request.body);

  if (!validationResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid project data",
      errors: validationResult.error.issues,
    });
  }

  try {
    const data = validationResult.data;
    const businessError = projectBusinessError({
      startDate: dateValue(data.startDate),
      targetEndDate: dateValue(data.targetEndDate),
      deadlineType: data.deadlineType,
    });

    if (businessError) {
      return response.status(400).json({
        code: "INVALID_PROJECT_LIFECYCLE",
        message: businessError,
      });
    }
    const requiredSkillIds = [...new Set(
      data.requirements.flatMap((requirement) =>
        requirement.requiredSkillId === null
          ? []
          : [requirement.requiredSkillId],
      ),
    )];
    const skills = await prisma.skill.findMany({
      where: { id: { in: requiredSkillIds } },
      select: { id: true },
    });

    if (skills.length !== requiredSkillIds.length) {
      return response.status(400).json({
        code: "UNKNOWN_SKILL",
        message: "At least one required skill does not exist",
      });
    }

    const project = await prisma.project.create({
      data: {
        name: data.name,
        color: data.color,
        startDate: dateValue(data.startDate),
        targetEndDate: dateValue(data.targetEndDate),
        deadlineType: data.deadlineType,
        priority: data.priority,
        optimizationStrategy: data.optimizationStrategy,
        totalLaborBudgetCents: data.totalLaborBudgetCents,
        weeklyLaborBudgetCents: data.weeklyLaborBudgetCents,
        requirements: { create: data.requirements },
      },
      include: {
        _count: { select: { shifts: true, requirements: true, workPackages: true, workLogs: true } },
      },
    });

    const { _count, ...projectData } = project;

    return response.status(201).json({
      ...projectData,
      shiftCount: _count.shifts,
      requirementCount: _count.requirements,
      workPackageCount: _count.workPackages,
      workLogCount: _count.workLogs,
    });
  } catch (error) {
    console.error(error);

    return response.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
    });
  }
});

projectRouter.patch("/:id", async (request, response) => {
  const idResult = projectIdSchema.safeParse(request.params.id);
  const bodyResult = updateProjectSchema.safeParse(request.body);

  if (!idResult.success || !bodyResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid project data",
    });
  }
  const currentProject = await prisma.project.findUnique({
    where: { id: idResult.data },
  });

  if (!currentProject) {
    return response.status(404).json({
      code: "PROJECT_NOT_FOUND",
      message: "Project does not exist",
    });
  }

  const updateData: Prisma.ProjectUpdateInput = {};

  if (bodyResult.data.name !== undefined) {
    updateData.name = bodyResult.data.name;
  }

  if (bodyResult.data.color !== undefined) {
    updateData.color = bodyResult.data.color;
  }

  if (bodyResult.data.startDate !== undefined) {
    updateData.startDate = dateValue(bodyResult.data.startDate);
  }

  if (bodyResult.data.targetEndDate !== undefined) {
    updateData.targetEndDate = dateValue(bodyResult.data.targetEndDate);
  }

  if (bodyResult.data.deadlineType !== undefined) {
    updateData.deadlineType = bodyResult.data.deadlineType;
  }

  if (bodyResult.data.priority !== undefined) {
    updateData.priority = bodyResult.data.priority;
  }

  if (bodyResult.data.optimizationStrategy !== undefined) {
    updateData.optimizationStrategy = bodyResult.data.optimizationStrategy;
  }

  if (bodyResult.data.totalLaborBudgetCents !== undefined) {
    updateData.totalLaborBudgetCents = bodyResult.data.totalLaborBudgetCents;
  }

  if (bodyResult.data.weeklyLaborBudgetCents !== undefined) {
    updateData.weeklyLaborBudgetCents = bodyResult.data.weeklyLaborBudgetCents;
  }

  const businessError = projectBusinessError({
    startDate: bodyResult.data.startDate === undefined
      ? currentProject.startDate
      : dateValue(bodyResult.data.startDate),
    targetEndDate: bodyResult.data.targetEndDate === undefined
      ? currentProject.targetEndDate
      : dateValue(bodyResult.data.targetEndDate),
    deadlineType: bodyResult.data.deadlineType ?? currentProject.deadlineType,
  });

  if (businessError) {
    return response.status(400).json({
      code: "INVALID_PROJECT_LIFECYCLE",
      message: businessError,
    });
  }

  try {
    const project = await prisma.project.update({
      where: {
        id: idResult.data,
      },
      data: updateData,
      include: {
        _count: {
          select: {
          shifts: true,
          requirements: true,
          workPackages: true,
          workLogs: true,
          },
        },
      },
    });

    const { _count, ...projectData } = project;

    return response.json({
      ...projectData,
      shiftCount: _count.shifts,
      requirementCount: _count.requirements,
      workPackageCount: _count.workPackages,
      workLogCount: _count.workLogs,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return response.status(404).json({
        code: "PROJECT_NOT_FOUND",
        message: "Project does not exist",
      });
    }

    console.error(error);

    return response.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
    });
  }
});

projectRouter.post("/:id/transition", async (request, response) => {
  const idResult = projectIdSchema.safeParse(request.params.id);
  const bodyResult = transitionProjectSchema.safeParse(request.body);

  if (!idResult.success || !bodyResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid project transition",
    });
  }

  const project = await prisma.project.findUnique({
    where: { id: idResult.data },
    include: {
      _count: { select: { workPackages: true, requirements: true } },
      workPackages: { select: { id: true, name: true, status: true, remainingMinutes: true } },
    },
  });

  if (!project) {
    return response.status(404).json({
      code: "PROJECT_NOT_FOUND",
      message: "Project does not exist",
    });
  }

  const nextStatus = bodyResult.data.status;
  if (!canTransitionProject(project.status, nextStatus)) {
    return response.status(409).json({
      code: "INVALID_PROJECT_TRANSITION",
      message: `Project cannot transition from ${project.status} to ${nextStatus}`,
    });
  }

  if (
    nextStatus === "PLANNED"
    && (
      project.startDate === null
      || project._count.workPackages + project._count.requirements === 0
    )
  ) {
    return response.status(409).json({
      code: "PROJECT_NOT_READY",
      message: "A planned project needs a start date and at least one work package or fixed coverage requirement",
    });
  }

  if (nextStatus === "COMPLETED") {
    const unfinished = project.workPackages.filter(
      (workPackage) => workPackage.status !== "COMPLETED" && workPackage.status !== "CANCELLED",
    );
    if (unfinished.length > 0) {
      return response.status(409).json({
        code: "PROJECT_HAS_UNFINISHED_WORK",
        message: `Complete or cancel work packages first: ${unfinished.map((item) => item.name).join(", ")}`,
        workPackages: unfinished,
      });
    }
  }

  const now = new Date();
  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      status: nextStatus,
      ...(nextStatus === "COMPLETED" ? { completedAt: now } : {}),
      ...(nextStatus === "ARCHIVED" ? { archivedAt: now } : {}),
    },
  });

  return response.json(updated);
});

projectRouter.delete("/:id", async (request, response) => {
  const idResult = projectIdSchema.safeParse(request.params.id);

  if (!idResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid project id",
    });
  }

  const project = await prisma.project.findUnique({
    where: { id: idResult.data },
    select: {
      id: true,
      status: true,
      _count: { select: { shifts: true, workLogs: true } },
    },
  });

  if (!project) {
    return response.status(404).json({
      code: "PROJECT_NOT_FOUND",
      message: "Project does not exist",
    });
  }

  if (
    project.status !== "DRAFT"
    || project._count.shifts > 0
    || project._count.workLogs > 0
  ) {
    return response.status(409).json({
      code: "PROJECT_HAS_HISTORY",
      message: "Only a draft project without allocation or work history can be deleted",
      canArchive: true,
    });
  }

  await prisma.project.delete({ where: { id: project.id } });
  return response.status(204).send();
});
