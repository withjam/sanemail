import { loadConfig } from "./config.mjs";
import { resetDemoData } from "./demo-data.mjs";
import { ensureUserRecord } from "./store.mjs";

const config = loadConfig();
const userId = process.argv[2] || config.auth.devUserId;
if (!userId) {
  console.error(
    "Missing user id. Set DEV_USER_ID in .env or pass it as the first argument: bun run seed <userId>",
  );
  process.exit(1);
}

const { account, result } = await resetDemoData({ userId });
await ensureUserRecord(userId, config.auth.devUserEmail || null);
console.log(
  `Reset demo data for ${account.email} (user ${userId}): ${result.count} messages.`,
);
