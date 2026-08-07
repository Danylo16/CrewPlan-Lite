import { Router } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

export const skillRouter = Router();

const skillIdSchema = z.coerce.number().int().positive();
const createSkillSchema = z.object({
  name: z.string().trim().min(2).max(50),
});

skillRouter.get("/", async (_request, response) => {
  const skills = await prisma.skill.findMany({
    orderBy: { name: "asc" },
  });

  return response.json(skills);
});

skillRouter.post("/", async (request, response) => {
  const result = createSkillSchema.safeParse(request.body);

  if (!result.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid skill data",
      errors: result.error.issues,
    });
  }

  try {
    const skill = await prisma.skill.create({ data: result.data });
    return response.status(201).json(skill);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2002"
    ) {
      return response.status(409).json({
        code: "SKILL_ALREADY_EXISTS",
        message: "A skill with this name already exists",
      });
    }

    throw error;
  }
});

skillRouter.delete("/:id", async (request, response) => {
  const result = skillIdSchema.safeParse(request.params.id);

  if (!result.success) {
    return response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Invalid skill id",
    });
  }

  try {
    await prisma.skill.delete({ where: { id: result.data } });
    return response.status(204).send();
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2025"
    ) {
      return response.status(404).json({
        code: "SKILL_NOT_FOUND",
        message: "Skill does not exist",
      });
    }

    throw error;
  }
});
