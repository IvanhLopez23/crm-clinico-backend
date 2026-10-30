import { createDatabase } from "./db/client.js";
import { env } from "./env.js";
import { processDueReminders } from "./modules/reminders/engine.js";
import { createConsoleSender } from "./modules/reminders/sender.js";
import { expireWaitlistOffers } from "./modules/waitlist/service.js";

const connectionString = env.WORKER_DATABASE_URL ?? env.DATABASE_URL;
const { db, pool } = createDatabase(connectionString);
const sender = createConsoleSender();

let running = true;
const stop = (): void => {
  running = false;
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(
  JSON.stringify({
    event: "reminder_worker.started",
    intervalMs: env.WORKER_INTERVAL_MS,
  }),
);

while (running) {
  try {
    const summary = await processDueReminders(db, { sender });
    if (summary.claimed > 0) {
      console.log(
        JSON.stringify({ event: "reminder_worker.batch", ...summary }),
      );
    }

    const offers = await expireWaitlistOffers(db);
    if (offers.expired > 0) {
      console.log(
        JSON.stringify({ event: "waitlist.expired_offers", ...offers }),
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "reminder_worker.error",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  await new Promise((resolve) => setTimeout(resolve, env.WORKER_INTERVAL_MS));
}

await pool.end();
