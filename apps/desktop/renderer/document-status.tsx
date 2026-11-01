import { t as translateUI } from "@anote/i18n";
import React, {useEffect, useState} from "react";

export const successfulDocumentStatus = (message: string) => [translateUI("已同步"), translateUI("已保存"), translateUI("已保存到本地")].includes(message);

export function DocumentStatus({message, cached}: {message: string; cached: boolean}) {
  const success = successfulDocumentStatus(message), [settled, setSettled] = useState("");
  useEffect(() => {
    setSettled("");
    if (!success) return;
    const timer = setTimeout(() => setSettled(message), 2200);
    return () => clearTimeout(timer);
  }, [message, success]);
  return <span className="sync-indicator" data-testid="document-sync" data-kind={success ? "success" : /未完成|失败|incomplete|failed/i.test(message) ? "error" : "pending"} hidden={success && settled === message} role="status" aria-live="polite" title={cached ? translateUI("本地缓存已就绪") : translateUI("正在准备本地缓存")}>{message}</span>;
}
