import { t as translateUI } from "@anote/i18n";
export interface User {
  id: string;
  name: string;
  role: string;
  username?: string;
  is_admin?: boolean;
  email?: string | null;
  email_verified?: boolean;
  local_password_enabled?: boolean;
  theme?: "light" | "dark" | "auto";
}
export interface NativeState {
  personal?: boolean;
  desktop?: boolean;
  stateRevision: number;
  serverURL: string;
  user: User | null;
  token: string | null;
  offline: boolean;
  workspace: string;
  lastDoc: string | null;
  credentialWarning: string;
  validationMode?: boolean;
  testing?: boolean;
  sync: {
    running: boolean;
    pending: { docId: string; error?: string; blocked: boolean }[];
    documents: { id: string; title: string; directory: string; result?: any }[];
  };
}
export interface Bridge {
  setLocale(locale: "zh-CN" | "en"): Promise<void>;
  enterPersonal(): Promise<NativeState>;
  leavePersonal(): Promise<NativeState>;
  openPersonalFolder(): Promise<{ ok: boolean }>;
  onBeforeClose?(callback: () => Promise<void>): () => void;
  acceptRemote(id: string): Promise<{ backup: string }>;
  state(): Promise<NativeState>;
  connect(input: {
    serverURL: string;
    username: string;
    password: string;
  }): Promise<NativeState>;
  casdoorProviders(serverURL: string): Promise<{
    local?: boolean;
    casdoor: { enabled: boolean; start_url: string | null };
  }>;
  connectCasdoor(input: {
    serverURL: string;
    intent?: "login" | "link";
  }): Promise<NativeState>;
  cancelCasdoor(): Promise<{ ok: boolean }>;
  logout(): Promise<NativeState>;
  offline(value: boolean): Promise<NativeState>;
  chooseWorkspace(): Promise<string | null>;
  checkout(input: { id: string; title: string }): Promise<any>;
  sync(id: string): Promise<any>;
  selectDocument(id: string | null, scope?: string): Promise<void>;
  onState(callback: (state: NativeState) => void): () => void;
}
declare global {
  interface Window {
    anote: Bridge;
    __anoteTest?: any;
  }
}
export async function request(endpoint: string, method = "GET", body?: any) {
  const response = await fetch("/api/" + endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(translateUI(result.error || result.message || "请求失败")),
      { status: response.status, result },
    );
  return result;
}
