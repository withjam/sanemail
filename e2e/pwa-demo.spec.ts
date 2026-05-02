import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/demo/reset");
  expect(response.ok()).toBeTruthy();
});

test("drives the local demo mailbox through Today, detail, feedback, and reset", async ({
  page,
  request,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByTestId("stat-synced").getByText("12")).toBeVisible();
  await expect(page.getByText("Can you review the lease renewal today?")).toBeVisible();
  await expect(page.getByText("Verify your account immediately")).not.toBeVisible();

  await page.getByTestId("nav-all-mail").click();
  await expect(page).toHaveURL(/\/mail$/);
  await expect(page.locator('[data-message-id="gmail:demo@example.com:message:demo-security-scam"]')).toBeVisible();
  await expect(page.locator('[data-message-id="gmail:demo@example.com:message:demo-sale"]')).toBeVisible();

  await page.locator('[data-message-id="gmail:demo@example.com:message:demo-lease-review"]').click();
  await expect(page.getByRole("heading", { name: "Can you review the lease renewal today?" })).toBeVisible();
  await expect(page.getByText("looks like it may need a reply")).toBeVisible();

  await page.getByTestId("feedback-important").click();
  await expect(page.getByText("Feedback: important")).toBeVisible();

  await page.getByTestId("nav-ai-ops").click();
  await expect(page).toHaveURL(/\/ai$/);
  await expect(page.getByRole("heading", { name: "AI Ops" })).toBeVisible();
  await expect(page.getByText("mail-triage")).toBeVisible();

  await page.getByTestId("ai-run-loop").click();
  await expect(page.getByTestId("ai-latest-run-status")).toContainText("succeeded");
  await expect(page.getByText("Can you review the lease renewal today?")).toBeVisible();

  await page.getByTestId("ai-verify").click();
  await expect(page.getByTestId("ai-verification-status")).toContainText("passed");

  await page.getByTestId("nav-settings").click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-stat-synced").getByText("12")).toBeVisible();

  await page.getByRole("button", { name: "Delete local data" }).click();
  await expect(page.getByTestId("settings-stat-synced").getByText("0")).toBeVisible();

  await page.getByTestId("settings-reset-demo").click();
  await expect(page.getByTestId("settings-stat-synced").getByText("12")).toBeVisible();

  const status = await request.get("/api/status");
  expect(await status.json()).toMatchObject({
    account: { email: "demo@example.com", demo: true },
    counts: { messages: 12 },
  });
});
