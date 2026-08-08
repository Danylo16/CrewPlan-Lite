import "dotenv/config";
import {
  DayOfWeek,
  PrismaClient,
  RequirementPriority,
} from "../generated/prisma/client.js";

const prisma = new PrismaClient();

const WEEKDAYS = [
  DayOfWeek.MONDAY,
  DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY,
  DayOfWeek.THURSDAY,
  DayOfWeek.FRIDAY,
];

const employeeDefinitions = [
  {
    name: "Anna Mueller",
    email: "anna.mueller@crewplan.at",
    role: "Frontend Developer",
    preferredWeeklyMinutes: 1920,
    maxWeeklyMinutes: 2400,
    skills: { React: 4, TypeScript: 4 },
    availability: WEEKDAYS.map((dayOfWeek) => ({
      dayOfWeek,
      startMinute: 540,
      endMinute: 1020,
    })),
  },
  {
    name: "Lukas Webber",
    email: "zdanilevich@gmail.com",
    role: "Technical Architect",
    preferredWeeklyMinutes: 2160,
    maxWeeklyMinutes: 2400,
    skills: { "Node.js": 5, PostgreSQL: 4, DevOps: 4 },
    availability: WEEKDAYS.map((dayOfWeek) => ({
      dayOfWeek,
      startMinute: 540,
      endMinute: 1080,
    })),
  },
  {
    name: "David Novak",
    email: "david.novak@crewplan.at",
    role: "Backend Developer",
    preferredWeeklyMinutes: 2160,
    maxWeeklyMinutes: 2400,
    skills: { "Node.js": 4, PostgreSQL: 4, TypeScript: 3 },
    availability: [
      ...WEEKDAYS.slice(0, 4).map((dayOfWeek) => ({
        dayOfWeek,
        startMinute: 540,
        endMinute: 1020,
      })),
      {
        dayOfWeek: DayOfWeek.FRIDAY,
        startMinute: 540,
        endMinute: 900,
      },
    ],
  },
  {
    name: "Sofia Bauer",
    email: "sofia.bauer@crewplan.at",
    role: "QA Engineer",
    preferredWeeklyMinutes: 1800,
    maxWeeklyMinutes: 2160,
    skills: { Testing: 5, TypeScript: 3 },
    availability: WEEKDAYS.slice(1).map((dayOfWeek) => ({
      dayOfWeek,
      startMinute: 600,
      endMinute: 1080,
    })),
  },
  {
    name: "Marko Huber",
    email: "marko.huber@crewplan.at",
    role: "DevOps Engineer",
    preferredWeeklyMinutes: 1200,
    maxWeeklyMinutes: 1800,
    skills: { DevOps: 5, PostgreSQL: 3 },
    availability: [
      DayOfWeek.MONDAY,
      DayOfWeek.WEDNESDAY,
      DayOfWeek.FRIDAY,
    ].map((dayOfWeek) => ({
      dayOfWeek,
      startMinute: 540,
      endMinute: 1020,
    })),
  },
] as const;

const requirementDefinitions = [
  {
    project: "Mobile Banking",
    dayOfWeek: DayOfWeek.MONDAY,
    startMinute: 540,
    endMinute: 1020,
    requiredEmployees: 2,
    skill: "Node.js",
    minimumSkillLevel: 3,
    priority: RequirementPriority.CRITICAL,
  },
  {
    project: "Mobile Banking",
    dayOfWeek: DayOfWeek.TUESDAY,
    startMinute: 540,
    endMinute: 1020,
    requiredEmployees: 1,
    skill: "PostgreSQL",
    minimumSkillLevel: 4,
    priority: RequirementPriority.HIGH,
  },
  {
    project: "Internal Dashboard",
    dayOfWeek: DayOfWeek.MONDAY,
    startMinute: 540,
    endMinute: 1020,
    requiredEmployees: 1,
    skill: "React",
    minimumSkillLevel: 3,
    priority: RequirementPriority.HIGH,
  },
  {
    project: "Internal Dashboard",
    dayOfWeek: DayOfWeek.WEDNESDAY,
    startMinute: 600,
    endMinute: 1020,
    requiredEmployees: 2,
    skill: "TypeScript",
    minimumSkillLevel: 3,
    priority: RequirementPriority.NORMAL,
  },
  {
    project: "Customer Portal",
    dayOfWeek: DayOfWeek.THURSDAY,
    startMinute: 600,
    endMinute: 1080,
    requiredEmployees: 1,
    skill: "Testing",
    minimumSkillLevel: 4,
    priority: RequirementPriority.HIGH,
  },
  {
    project: "Customer Portal",
    dayOfWeek: DayOfWeek.FRIDAY,
    startMinute: 540,
    endMinute: 1020,
    requiredEmployees: 3,
    skill: "DevOps",
    minimumSkillLevel: 4,
    priority: RequirementPriority.CRITICAL,
  },
] as const;

async function seedDemo() {
  const summary = await prisma.$transaction(async (transaction) => {
    const skillNames = [
      "React",
      "TypeScript",
      "Node.js",
      "PostgreSQL",
      "Testing",
      "DevOps",
    ];
    const skills = new Map<string, number>();

    for (const name of skillNames) {
      const skill = await transaction.skill.upsert({
        where: { name },
        update: {},
        create: { name },
      });
      skills.set(name, skill.id);
    }

    for (const definition of employeeDefinitions) {
      const employee = await transaction.employee.upsert({
        where: { email: definition.email },
        update: {
          name: definition.name,
          role: definition.role,
          preferredWeeklyMinutes: definition.preferredWeeklyMinutes,
          maxWeeklyMinutes: definition.maxWeeklyMinutes,
        },
        create: {
          name: definition.name,
          email: definition.email,
          role: definition.role,
          preferredWeeklyMinutes: definition.preferredWeeklyMinutes,
          maxWeeklyMinutes: definition.maxWeeklyMinutes,
        },
      });

      await transaction.employeeSkill.deleteMany({
        where: { employeeId: employee.id },
      });
      await transaction.employeeAvailability.deleteMany({
        where: { employeeId: employee.id },
      });

      await transaction.employeeSkill.createMany({
        data: Object.entries(definition.skills).map(([name, level]) => ({
          employeeId: employee.id,
          skillId: skills.get(name)!,
          level,
        })),
      });
      await transaction.employeeAvailability.createMany({
        data: definition.availability.map((availability) => ({
          employeeId: employee.id,
          ...availability,
        })),
      });
    }

    const projectNames = [...new Set(
      requirementDefinitions.map((requirement) => requirement.project),
    )];
    const projects = await transaction.project.findMany({
      where: { name: { in: projectNames } },
      orderBy: { id: "asc" },
    });
    const projectIds = new Map(
      projects.map((project) => [project.name, project.id]),
    );

    if (projectIds.size !== projectNames.length) {
      const missing = projectNames.filter((name) => !projectIds.has(name));
      throw new Error(`Missing demo projects: ${missing.join(", ")}`);
    }

    await transaction.projectRequirement.deleteMany({
      where: { projectId: { in: [...projectIds.values()] } },
    });
    await transaction.projectRequirement.createMany({
      data: requirementDefinitions.map((requirement) => ({
        projectId: projectIds.get(requirement.project)!,
        dayOfWeek: requirement.dayOfWeek,
        startMinute: requirement.startMinute,
        endMinute: requirement.endMinute,
        requiredEmployees: requirement.requiredEmployees,
        requiredSkillId: skills.get(requirement.skill)!,
        minimumSkillLevel: requirement.minimumSkillLevel,
        priority: requirement.priority,
      })),
    });

    return {
      employees: employeeDefinitions.length,
      skills: skillNames.length,
      requirements: requirementDefinitions.length,
      requestedPositions: requirementDefinitions.reduce(
        (total, requirement) => total + requirement.requiredEmployees,
        0,
      ),
    };
  }, {
    timeout: 20_000,
  });

  console.log("CrewPlan demo scenario is ready:", summary);
}

seedDemo()
  .catch((error) => {
    console.error("Failed to seed CrewPlan demo scenario:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });