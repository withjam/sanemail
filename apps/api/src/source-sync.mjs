import { loadConfig } from "./config.mjs";
import { syncMockSource } from "./demo-data.mjs";
import { refreshAccessToken, syncRecentMessages } from "./gmail.mjs";
import { getPrimaryAccount, readStore, upsertAccount, upsertSyncedMessages } from "./store.mjs";

function accountNeedsRefresh(account) {
  if (!account?.accessToken) return true;
  if (!account.tokenExpiresAt) return false;
  return new Date(account.tokenExpiresAt).getTime() - Date.now() < 60_000;
}

async function findAccount({ sourceConnectionId, accountId, provider } = {}) {
  const id = sourceConnectionId || accountId;
  if (!id && !provider) return getPrimaryAccount();

  const store = await readStore();
  const accounts = store.accounts || [];
  return accounts.find((account) => {
    if (id && account.id === id) return true;
    if (provider && account.provider === provider) return true;
    return false;
  }) || null;
}

async function freshGmailAccount(config, account) {
  if (!account) throw new Error("No Gmail account is connected.");
  if (!accountNeedsRefresh(account)) return account;

  const refreshed = await refreshAccessToken(config, account);
  return upsertAccount(refreshed);
}

export async function syncSourceConnection({
  sourceConnectionId,
  accountId,
  provider,
  trigger = "manual",
} = {}) {
  const config = loadConfig();
  const account = await findAccount({ sourceConnectionId, accountId, provider });
  const sourceProvider = provider || account?.provider;

  if (sourceProvider === "mock" || sourceConnectionId?.startsWith("mock:")) {
    const { account: mockAccount, result } = await syncMockSource();
    return {
      account: mockAccount,
      result,
      provider: "mock",
      trigger,
    };
  }

  const gmailAccount = await freshGmailAccount(config, account);
  if (gmailAccount.provider !== "gmail") {
    throw new Error(`Unsupported source provider for sync: ${gmailAccount.provider || sourceProvider}`);
  }

  const messages = await syncRecentMessages(config, gmailAccount);
  const result = await upsertSyncedMessages(gmailAccount, messages);
  return {
    account: gmailAccount,
    result,
    provider: "gmail",
    trigger,
  };
}
