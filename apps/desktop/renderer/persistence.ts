import { t as translateUI } from "@anote/i18n";
import * as Y from "yjs";
import { type IndexeddbPersistence, storeState } from "y-indexeddb";
import type { HocuspocusProvider } from "@hocuspocus/provider";

export function waitForDocumentSync(provider: HocuspocusProvider) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      provider.off("synced", check);
      provider.off("unsyncedChanges", check);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (provider.isSynced && !provider.hasUnsyncedChanges) finish();
    };
    const timer = setTimeout(() => finish(new Error(translateUI("同步尚未完成，请稍后重试"))), 10000);
    provider.on("synced", check);
    provider.on("unsyncedChanges", check);
    check();
  });
}

export async function flushDocument(
  persistence: IndexeddbPersistence,
  document: Y.Doc,
) {
  await persistence.whenSynced;
  await storeState(persistence, true);
  if (!persistence.db) throw new Error(translateUI("本地数据库尚未就绪"));
  await new Promise<void>((resolve, reject) => {
    const transaction = persistence.db!.transaction("updates", "readwrite", {
      durability: "strict",
    });
    transaction.objectStore("updates").add(Y.encodeStateAsUpdate(document));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error(translateUI("本地保存失败")));
    transaction.onabort = () =>
      reject(transaction.error || new Error(translateUI("本地保存被中断")));
  });
}
