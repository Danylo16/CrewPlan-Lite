import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

export const projectRequirementRouter = Router();

const requirementIdSchema = z.coerce.number().int().positive();
const projectIdSchema = z.coerce.number().int().positive();

const dayOfWeekSchema = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);

const requirementBodySchema = z.object({
  projectId: z.number().int().positive(),
  dayOfWeek: dayOfWeekSchema,
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  requiredEmployees: z.number().int().min(1).max(100),
  requiredSkillId: z.number().int().positive().nullable().default(null),
  minimumSkillLevel: z.number().int().min(1).max(5).default(1),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
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

projectRequirementRouter.get("/", async (request, response) => {
  const projectIdResult = projectIdSchema.optional().safeParse(request.query.projectId);

  if (!projectIdResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid project id",
    });
  }

  const requirements = await prisma.projectRequirement.findMany({
    ...(projectIdResult.data === undefined
      ? {}
      : { where: { projectId: projectIdResult.data } }),
    include: { project: true, requiredSkill: true },
    orderBy: [
      { dayOfWeek: "asc" },
      { startMinute: "asc" },
      { id: "asc" },
    ],
  });

  return response.json(requirements);
});

projectRequirementRouter.post("/", async (request, response) => {
  const result = requirementBodySchema.safeParse(request.body);

  if (!result.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid project requirement",
      errors: result.error.issues,
    });
  }

  const { projectId, requiredSkillId } = result.data;
  const [project, requiredSkill] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }),
    requiredSkillId === null
      ? Promise.resolve(null)
      : prisma.skill.findUnique({ where: { id: requiredSkillId }, select: { id: true } }),
  ]);

  if (!project) {
    return response.status(404).json({
      code: "PROJECT_NOT_FOUND",
      message: "Project does not exist",
    });
  }

  if (requiredSkillId !== null && !requiredSkill) {
    return response.status(400).json({
      code: "UNKNOWN_SKILL",
      message: "Required skill does not exist",
    });
  }

  const requirement = await prisma.projectRequirement.create({
    data: result.data,
    include: { project: true, requiredSkill: true },
  });

  return response.status(201).json(requirement);
});

projectRequirementRouter.patch("/:id", async (request, response) => {
  const idResult = requirementIdSchema.safeParse(request.params.id);
  const bodyResult = requirementBodySchema.safeParse(request.body);

  if (!idResult.success || !bodyResult.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid project requirement",
      errors: bodyResult.success ? [] : bodyResult.error.issues,
    });
  }

  try {
    const requirement = await prisma.projectRequirement.update({
      where: { id: idResult.data },
      data: bodyResult.data,
      include: { project: true, requiredSkill: true },
    });
    return response.json(requirement);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2025"
    ) {
      return response.status(404).json({
        code: "REQUIREMENT_NOT_FOUND",
        message: "Project requirement does not exist",
      });
    }

    throw error;
  }
});

projectRequirementRouter.delete("/:id", async (request, response) => {
  const result = requirementIdSchema.safeParse(request.params.id);

  if (!result.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid requirement id",
    });
  }

  try {
    await prisma.projectRequirement.delete({ where: { id: result.data } });
    return response.status(204).send();
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2025"
    ) {
      return response.status(404).json({
        code: "REQUIREMENT_NOT_FOUND",
        message: "Project requirement does not exist",
      });
    }

    throw error;
  }
});
