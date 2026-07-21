import "dotenv/config";
import { loadConfig } from "./config/index.js";
import { createApp } from "./app.js";
import { JobWorker } from "./jobs/worker.js";
import { closePool } from "./db/pool.js";
import { logInfo } from "./utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);
  const worker = new JobWorker(config);
  worker.start();

  const server = app.listen(config.port, () => {
    logInfo("ManateeCaller listening", { port: config.port });
  });

  const shutdown = async () => {
    worker.stop();
    server.close();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
