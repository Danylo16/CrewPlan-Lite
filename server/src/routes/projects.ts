import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

export const projectRouter = Router();

const projectNameSchema = z.string().trim().min(2).max(100);

const projectColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Color must be a valid hex value");

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
  weeklyLaborBudgetCents: z.number().int().min(0).nullable(),
  requirements: z.array(requirementSchema).min(1).max(100),
});

const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    color: projectColorSchema.optional(),
    weeklyLaborBudgetCents: z.number().int().min(0).nullable().optional(),
  })
  .refine(
    (data) => data.name !== undefined
      || data.color !== undefined
      || data.weeklyLaborBudgetCents !== undefined,
    {
      message: "At least one field must be provided",
    },
  );

const projectIdSchema = z.coerce.number().int().positive();

projectRouter.get("/", async (_request, response) => {
  const projects = await prisma.project.findMany({
    include: {
      _count: {
        select: {
          shifts: true,
          requirements: true,
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
  }));

  return response.json(result);
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
        weeklyLaborBudgetCents: data.weeklyLaborBudgetCents,
        requirements: { create: data.requirements },
      },
      include: {
        _count: { select: { shifts: true, requirements: true } },
      },
    });

    const { _count, ...projectData } = project;

    return response.status(201).json({
      ...projectData,
      shiftCount: _count.shifts,
      requirementCount: _count.requirements,
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
  const updateData: Prisma.ProjectUpdateInput = {};

  if (bodyResult.data.name !== undefined) {
    updateData.name = bodyResult.data.name;
  }

  if (bodyResult.data.color !== undefined) {
    updateData.color = bodyResult.data.color;
  }

  if (bodyResult.data.weeklyLaborBudgetCents !== undefined) {
    updateData.weeklyLaborBudgetCents = bodyResult.data.weeklyLaborBudgetCents;
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
          },
        },
      },
    });

    const { _count, ...projectData } = project;

    return response.json({
      ...projectData,
      shiftCount: _count.shifts,
      requirementCount: _count.requirements,
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
