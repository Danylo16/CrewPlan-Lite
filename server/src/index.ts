import "dotenv/config";
import { app } from "./app.js";
import { prisma } from "./lib/prisma.js";

const PORT = process.env.PORT || 3000;

const databaseStartedAt = performance.now();
await prisma.$connect();
console.log(`Database ready in ${Math.round(performance.now() - databaseStartedAt)} ms`);

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

async function shutdown() {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  await prisma.$disconnect();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
