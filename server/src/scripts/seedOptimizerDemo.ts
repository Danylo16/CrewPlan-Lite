import "dotenv/config";
import { DateTime } from "luxon";
import { PrismaClient, type Prisma } from "../generated/prisma/client.js";
import { DayOfWeek } from "../generated/prisma/enums.js";

const CONFIRMATION = "OPTIMIZER_DEMO_V2";
const DEMO_PREFIX = "[OPT-DEMO]";
const TIME_ZONE = "Europe/Vienna";

if (process.env.CONFIRM_OPTIMIZER_DEMO_SEED !== CONFIRMATION) {
  throw new Error(`Refusing to seed. Set CONFIRM_OPTIMIZER_DEMO_SEED=${CONFIRMATION}`);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
const databaseHost = new URL(databaseUrl).host;

if ((process.env.NODE_ENV === "production" || process.env.RENDER === "true")
  && process.env.ALLOW_PRODUCTION_DEMO_SEED !== "true") {
  throw new Error("Refusing to seed a production environment without ALLOW_PRODUCTION_DEMO_SEED=true");
}

const prisma = new PrismaClient();
const weekDays = [
  DayOfWeek.MONDAY,
  DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY,
  DayOfWeek.THURSDAY,
  DayOfWeek.FRIDAY,
];
const configuredHorizonStart = process.env.OPTIMIZER_DEMO_HORIZON_START;
const horizonStart = configuredHorizonStart === undefined
  ? DateTime.now().setZone(TIME_ZONE).plus({ weeks: 1 }).startOf("week")
  : DateTime.fromISO(configuredHorizonStart, { zone: TIME_ZONE }).startOf("day");

if (!horizonStart.isValid || horizonStart.weekday !== 1) {
  throw new Error("OPTIMIZER_DEMO_HORIZON_START must be a valid ISO Monday, for example 2026-08-17");
}

const dateAt = (weeks: number, days = 0) => horizonStart.plus({ weeks, days }).toUTC().toJSDate();

const skillNames = {
  flexible: `${DEMO_PREFIX} Flexible Delivery`,
  scarce: `${DEMO_PREFIX} Scarce Platform`,
  frontend: `${DEMO_PREFIX} Frontend`,
  backend: `${DEMO_PREFIX} Backend`,
  devops: `${DEMO_PREFIX} DevOps`,
  deadline: `${DEMO_PREFIX} Deadline Delivery`,
  continuity: `${DEMO_PREFIX} Service Continuity`,
} as const;

const employeeDefinitions = [
  {
    name: "Mira Kovacs",
    email: "optimizer.mira@crewplan.demo",
    role: "Principal Generalist",
    preferredWeeklyMinutes: 480,
    maxWeeklyMinutes: 480,
    hourlyCostCents: 5_000,
    overtimeRateBasisPoints: 15_000,
    skills: { [skillNames.flexible]: 5, [skillNames.scarce]: 5 },
    availability: weekDays,
  },
  {
    name: "Leon Fischer",
    email: "optimizer.leon@crewplan.demo",
    role: "Delivery Specialist",
    preferredWeeklyMinutes: 480,
    maxWeeklyMinutes: 480,
    hourlyCostCents: 5_000,
    overtimeRateBasisPoints: 15_000,
    skills: { [skillNames.flexible]: 5 },
    availability: weekDays,
  },
  {
    name: "Eva Nowak",
    email: "optimizer.eva@crewplan.demo",
    role: "Senior Full-Stack Engineer",
    preferredWeeklyMinutes: 2_400,
    maxWeeklyMinutes: 2_400,
    hourlyCostCents: 6_000,
    overtimeRateBasisPoints: 15_000,
    skills: { [skillNames.frontend]: 5, [skillNames.backend]: 5, [skillNames.continuity]: 5 },
    availability: weekDays,
  },
  {
    name: "Theo Berger",
    email: "optimizer.theo@crewplan.demo",
    role: "Frontend Engineer",
    preferredWeeklyMinutes: 2_400,
    maxWeeklyMinutes: 2_400,
    hourlyCostCents: 4_000,
    overtimeRateBasisPoints: 15_000,
    skills: { [skillNames.frontend]: 5, [skillNames.continuity]: 5 },
    availability: weekDays,
  },
  {
    name: "Nina Horvat",
    email: "optimizer.nina@crewplan.demo",
    role: "Backend Engineer",
    preferredWeeklyMinutes: 2_400,
    maxWeeklyMinutes: 2_400,
    hourlyCostCents: 4_500,
    overtimeRateBasisPoints: 15_000,
    skills: { [skillNames.backend]: 5, [skillNames.continuity]: 5 },
    availability: weekDays,
  },
  {
    name: "Omar Haddad",
    email: "optimizer.omar@crewplan.demo",
    role: "Platform Engineer",
    preferredWeeklyMinutes: 1_800,
    maxWeeklyMinutes: 2_400,
    hourlyCostCents: 5_500,
    overtimeRateBasisPoints: 15_000,
    skills: { [skillNames.backend]: 5, [skillNames.devops]: 5 },
    availability: weekDays,
  },
  {
    name: "Pia Schneider",
    email: "optimizer.pia@crewplan.demo",
    role: "DevOps Engineer",
    preferredWeeklyMinutes: 2_400,
    maxWeeklyMinutes: 2_400,
    hourlyCostCents: 4_200,
    overtimeRateBasisPoints: 15_000,
    skills: { [skillNames.devops]: 5 },
    availability: weekDays,
  },
  {
    name: "Sara Lindner",
    email: "optimizer.sara@crewplan.demo",
    role: "Senior Delivery Lead",
    preferredWeeklyMinutes: 960,
    maxWeeklyMinutes: 960,
    hourlyCostCents: 6_500,
    overtimeRateBasisPoints: 15_000,
    skills: { [skillNames.deadline]: 5 },
    availability: [DayOfWeek.MONDAY, DayOfWeek.TUESDAY],
  },
  {
    name: "Ben Rossi",
    email: "optimizer.ben@crewplan.demo",
    role: "Delivery Analyst",
    preferredWeeklyMinutes: 960,
    maxWeeklyMinutes: 960,
    hourlyCostCents: 3_800,
    overtimeRateBasisPoints: 15_000,
    skills: { [skillNames.deadline]: 5 },
    availability: [DayOfWeek.THURSDAY, DayOfWeek.FRIDAY],
  },
] as const;

interface WorkPackageDefinition {
  name: string;
  skill: string;
  minutes: number;
  sortOrder: number;
  earliestWeek?: number;
  targetWeek?: number;
  targetDay?: number;
  dependsOn?: string[];
}

interface ProjectDefinition {
  name: string;
  color: string;
  priority: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  deadlineType: "NONE" | "SOFT" | "HARD";
  optimizationStrategy: "BALANCED" | "EARLIEST_COMPLETION" | "MINIMIZE_COST" | "MAXIMIZE_THROUGHPUT";
  targetWeek: number;
  totalBudgetCents: number;
  weeklyBudgetCents: number;
  workPackages: WorkPackageDefinition[];
}

interface DemoEntityUsage {
  name: string;
  _count: { shifts: number; workLogs: number };
}

const projectDefinitions: ProjectDefinition[] = [
  {
    name: `${DEMO_PREFIX} Deadline Trade-off`,
    color: "#EA580C",
    priority: "HIGH",
    deadlineType: "SOFT",
    optimizationStrategy: "BALANCED",
    targetWeek: 0,
    totalBudgetCents: 60_000,
    weeklyBudgetCents: 35_000,
    workPackages: [
      { name: "Executive readiness pack", skill: skillNames.deadline, minutes: 480, sortOrder: 0, targetWeek: 0, targetDay: 1 },
    ],
  },
  {
    name: `${DEMO_PREFIX} Critical Release Train`,
    color: "#DC2626",
    priority: "CRITICAL",
    deadlineType: "HARD",
    optimizationStrategy: "BALANCED",
    targetWeek: 0,
    totalBudgetCents: 160_000,
    weeklyBudgetCents: 160_000,
    workPackages: [
      { name: "Architecture groundwork", skill: skillNames.flexible, minutes: 480, sortOrder: 0 },
      { name: "Production deployment", skill: skillNames.scarce, minutes: 480, sortOrder: 1, dependsOn: ["Architecture groundwork"] },
    ],
  },
  {
    name: `${DEMO_PREFIX} Critical Product Launch`,
    color: "#7C3AED",
    priority: "CRITICAL",
    deadlineType: "HARD",
    optimizationStrategy: "EARLIEST_COMPLETION",
    targetWeek: 2,
    totalBudgetCents: 360_000,
    weeklyBudgetCents: 180_000,
    workPackages: [
      { name: "Launch infrastructure", skill: skillNames.devops, minutes: 960, sortOrder: 0, targetWeek: 0, targetDay: 2 },
      { name: "Launch backend", skill: skillNames.backend, minutes: 960, sortOrder: 1 },
    ],
  },
  {
    name: `${DEMO_PREFIX} Customer Workspace`,
    color: "#2563EB",
    priority: "HIGH",
    deadlineType: "SOFT",
    optimizationStrategy: "MINIMIZE_COST",
    targetWeek: 3,
    totalBudgetCents: 420_000,
    weeklyBudgetCents: 140_000,
    workPackages: [
      { name: "Workspace frontend", skill: skillNames.frontend, minutes: 1_440, sortOrder: 0 },
      { name: "Workspace API", skill: skillNames.backend, minutes: 960, sortOrder: 1 },
      { name: "Delivery pipeline", skill: skillNames.devops, minutes: 480, sortOrder: 2, dependsOn: ["Workspace API"] },
    ],
  },
  {
    name: `${DEMO_PREFIX} Internal Tooling`,
    color: "#64748B",
    priority: "LOW",
    deadlineType: "SOFT",
    optimizationStrategy: "MINIMIZE_COST",
    targetWeek: 4,
    totalBudgetCents: 140_000,
    weeklyBudgetCents: 70_000,
    workPackages: [
      { name: "Operations dashboard", skill: skillNames.frontend, minutes: 960, sortOrder: 0 },
    ],
  },
  {
    name: `${DEMO_PREFIX} Analytics Roadmap`,
    color: "#059669",
    priority: "NORMAL",
    deadlineType: "SOFT",
    optimizationStrategy: "BALANCED",
    targetWeek: 5,
    totalBudgetCents: 900_000,
    weeklyBudgetCents: 180_000,
    workPackages: [
      { name: "Data foundation", skill: skillNames.backend, minutes: 2_400, sortOrder: 0 },
      { name: "Insight experience", skill: skillNames.frontend, minutes: 2_400, sortOrder: 1, earliestWeek: 1, dependsOn: ["Data foundation"] },
      { name: "Observability rollout", skill: skillNames.devops, minutes: 1_440, sortOrder: 2, earliestWeek: 2 },
      { name: "Portfolio hardening", skill: skillNames.frontend, minutes: 1_440, sortOrder: 3, earliestWeek: 3, dependsOn: ["Insight experience"] },
    ],
  },
  {
    name: `${DEMO_PREFIX} Service Continuity`,
    color: "#0891B2",
    priority: "NORMAL",
    deadlineType: "SOFT",
    optimizationStrategy: "BALANCED",
    targetWeek: 3,
    totalBudgetCents: 110_000,
    weeklyBudgetCents: 70_000,
    workPackages: [
      { name: "Continuity safeguards", skill: skillNames.continuity, minutes: 1_440, sortOrder: 0, targetWeek: 2 },
    ],
  },
];

async function seedOptimizerDemo() {
  console.log(`Preparing optimizer demo on ${databaseHost}`);
  console.log(`Rolling horizon starts ${horizonStart.toISODate()} (${TIME_ZONE})`);

  const summary = await prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
    const existingDemoProjects = await transaction.project.findMany({
      where: { name: { startsWith: DEMO_PREFIX } },
      include: { _count: { select: { shifts: true, workLogs: true } } },
    }) as DemoEntityUsage[];
    const usedProject = existingDemoProjects.find((project) => project._count.shifts > 0 || project._count.workLogs > 0);
    if (usedProject) {
      throw new Error(`${usedProject.name} already has allocations or work logs; refusing to rewrite its scenario`);
    }

    const demoEmails = employeeDefinitions.map((employee) => employee.email);
    const existingDemoEmployees = await transaction.employee.findMany({
      where: { email: { in: [...demoEmails] } },
      include: { _count: { select: { shifts: true, workLogs: true } } },
    }) as DemoEntityUsage[];
    const usedEmployee = existingDemoEmployees.find((employee) => employee._count.shifts > 0 || employee._count.workLogs > 0);
    if (usedEmployee) {
      throw new Error(`${usedEmployee.name} already has allocations or work logs; refusing to rewrite the employee`);
    }

    const skills = new Map<string, number>();
    for (const name of Object.values(skillNames)) {
      const skill = await transaction.skill.upsert({ where: { name }, update: {}, create: { name } });
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
          hourlyCostCents: definition.hourlyCostCents,
          overtimeRateBasisPoints: definition.overtimeRateBasisPoints,
          archivedAt: null,
          archiveReason: null,
        },
        create: {
          name: definition.name,
          email: definition.email,
          role: definition.role,
          preferredWeeklyMinutes: definition.preferredWeeklyMinutes,
          maxWeeklyMinutes: definition.maxWeeklyMinutes,
          hourlyCostCents: definition.hourlyCostCents,
          overtimeRateBasisPoints: definition.overtimeRateBasisPoints,
        },
      });
      await transaction.employeeSkill.deleteMany({ where: { employeeId: employee.id } });
      await transaction.employeeAvailability.deleteMany({ where: { employeeId: employee.id } });
      await transaction.employeeSkill.createMany({
        data: Object.entries(definition.skills).map(([name, level]) => ({
          employeeId: employee.id,
          skillId: skills.get(name)!,
          level,
        })),
      });
      await transaction.employeeAvailability.createMany({
        data: definition.availability.map((dayOfWeek) => ({ employeeId: employee.id, dayOfWeek, startMinute: 540, endMinute: 1_020 })),
      });
    }

    const packageIds = new Map<string, number>();
    for (const definition of projectDefinitions) {
      const existing = await transaction.project.findFirst({ where: { name: definition.name }, orderBy: { id: "asc" } });
      const project = existing
        ? await transaction.project.update({
            where: { id: existing.id },
            data: {
              color: definition.color,
              status: "ACTIVE",
              startDate: dateAt(0),
              targetEndDate: dateAt(definition.targetWeek, 4),
              deadlineType: definition.deadlineType,
              priority: definition.priority,
              optimizationStrategy: definition.optimizationStrategy,
              totalLaborBudgetCents: definition.totalBudgetCents,
              weeklyLaborBudgetCents: definition.weeklyBudgetCents,
              archivedAt: null,
              completedAt: null,
            },
          })
        : await transaction.project.create({
            data: {
              name: definition.name,
              color: definition.color,
              status: "ACTIVE",
              startDate: dateAt(0),
              targetEndDate: dateAt(definition.targetWeek, 4),
              deadlineType: definition.deadlineType,
              priority: definition.priority,
              optimizationStrategy: definition.optimizationStrategy,
              totalLaborBudgetCents: definition.totalBudgetCents,
              weeklyLaborBudgetCents: definition.weeklyBudgetCents,
            },
          });

      await transaction.workPackage.deleteMany({ where: { projectId: project.id } });
      for (const workPackage of definition.workPackages) {
        const created = await transaction.workPackage.create({
          data: {
            projectId: project.id,
            name: workPackage.name,
            description: "Optimizer demonstration scope",
            status: "TODO",
            requiredSkillId: skills.get(workPackage.skill)!,
            minimumSkillLevel: 3,
            estimatedMinutes: workPackage.minutes,
            remainingMinutes: workPackage.minutes,
            maxParallelEmployees: 1,
            earliestStartDate: workPackage.earliestWeek === undefined ? null : dateAt(workPackage.earliestWeek),
            targetEndDate: workPackage.targetWeek === undefined
              ? null
              : dateAt(workPackage.targetWeek, workPackage.targetDay ?? 4),
            sortOrder: workPackage.sortOrder,
          },
        });
        packageIds.set(`${definition.name}:${workPackage.name}`, created.id);
      }
    }

    for (const definition of projectDefinitions) {
      for (const workPackage of definition.workPackages) {
        const successorId = packageIds.get(`${definition.name}:${workPackage.name}`)!;
        for (const predecessorName of workPackage.dependsOn ?? []) {
          await transaction.workPackageDependency.create({
            data: {
              predecessorId: packageIds.get(`${definition.name}:${predecessorName}`)!,
              successorId,
              lagMinutes: 0,
            },
          });
        }
      }
    }

    return {
      endpoint: databaseHost,
      horizonStart: horizonStart.toISODate(),
      employees: employeeDefinitions.length,
      skills: Object.keys(skillNames).length,
      projects: projectDefinitions.length,
      workPackages: projectDefinitions.reduce((total, project) => total + project.workPackages.length, 0),
      dependencies: projectDefinitions.reduce((total, project) => total + project.workPackages.reduce((sum, item) => sum + (item.dependsOn?.length ?? 0), 0), 0),
      decisionStories: [
        "deadline: €520 before Tuesday vs €304 after Tuesday",
        "resilience: concentrated cheap delivery vs diversified delivery",
      ],
    };
  }, { timeout: 30_000 });

  console.log("Optimizer portfolio demo is ready:", summary);
}

seedOptimizerDemo()
  .catch((error) => {
    console.error("Failed to seed optimizer portfolio demo:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
