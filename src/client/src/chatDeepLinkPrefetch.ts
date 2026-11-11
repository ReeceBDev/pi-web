import { api } from "./api";
import { readChatHistoryCache, writeChatHistoryCache } from "./chatHistoryCache";
import { machineSessionKey } from "./machineKeys";

// ponytail: page size duplicated from sessionController's MESSAGE_PAGE_SIZE —
// importing the controller would drag the whole app shell into a leaf module;
// keep the two in sync by name.
const DEEP_LINK_MESSAGE_PAGE_SIZE = 100;

/**
 * Box-launcher push taps boot at ?session=S&cwd=W&view=chat. The transcript
 * fetch needs only that session ref, so start it here, in parallel with the
 * machines → catalog → workspace selection chain, and land it in the chat
 * history cache. When route restore finally selects the session, the cached
 * page renders instantly and the normal live refresh keeps it current.
 */
export function prefetchDeepLinkChatHistory(): void {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session");
  const cwd = params.get("cwd");
  if (sessionId === null || sessionId === "" || cwd === null || cwd === "") return;
  const machineId = params.get("machine") ?? "local";
  const key = machineSessionKey(machineId, sessionId);
  // A fresh cache already renders instantly; don't refetch or overwrite it.
  if (readChatHistoryCache(key) !== undefined) return;
  void api
    .transcriptSnapshot({ id: sessionId, cwd }, { limit: DEEP_LINK_MESSAGE_PAGE_SIZE }, machineId)
    .then((snapshot) => { writeChatHistoryCache(key, snapshot.page); })
    .catch(() => undefined);
}
