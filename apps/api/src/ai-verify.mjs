import { runSyntheticVerification } from "./ai/verification.mjs";

const persist = process.argv.includes("--persist");
const run = await runSyntheticVerification({ persist });

console.log(
  `AI verification ${run.status}: ${run.summary.passedCases}/${run.summary.cases} cases, score ${run.score}`,
);

for (const testCase of run.cases) {
  const marker = testCase.passed ? "PASS" : "FAIL";
  console.log(`${marker} ${testCase.id}`);
  for (const check of testCase.checks.filter((item) => !item.passed)) {
    console.log(`  ${check.name}: expected ${check.expected}, got ${JSON.stringify(check.actual)}`);
  }
}

if (run.status !== "passed") process.exitCode = 1;
