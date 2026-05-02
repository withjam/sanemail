import { resetDemoData } from "./demo-data.mjs";

const { account, result } = await resetDemoData();
console.log(`Reset demo data for ${account.email}: ${result.count} messages.`);
