import { loadConfig } from "./config.mjs";
import { syncMockSource } from "./demo-data.mjs";
import { refreshAccessToken, syncRecentMessages } from "./gmail.mjs";
import {
  getPrimarySourceConnection,
  readStoreFor,
  upsertAccount,
  upsertSyncedMessages,
} from "./store.mjs";

function accountNeedsRefresh(account) {
  if (!account?.accessToken) return true;
  if (!account.tokenExpiresAt) return false;
  return new Date(account.tokenExpiresAt).getTime() - Date.now() < 60_000;
}

async function findAccount({ userId, sourceConnectionId, accountId, provider } = {}) {
  if (!userId) throw new Error("findAccount requires a userId");
  const id = sourceConnectionId || accountId;
  if (!id && !provider) return getPrimarySourceConnection(userId);

  const store = await readStoreFor(userId);
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
  return upsertAccount({ ...refreshed, userId: account.userId });
}

export async function syncSourceConnection({
  userId,
  sourceConnectionId,
  accountId,
  provider,
  trigger = "manual",
} = {}) {
  if (!userId) throw new Error("syncSourceConnection requires a userId");
  const config = loadConfig();
  const account = await findAccount({ userId, sourceConnectionId, accountId, provider });
  const sourceProvider = provider || account?.provider;

  if (sourceProvider === "mock" || sourceConnectionId?.startsWith("mock:")) {
    const { account: mockAccount, result } = await syncMockSource({ userId });
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
