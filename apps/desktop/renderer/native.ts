import { t as translateUI } from "@anote/i18n";
import type {RichDoc} from "@anote/document-model";
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
  workspaceSwitching?:boolean;
  backupRestoring?:boolean;
  backupBusy?:boolean;
  connectionWorkspace?:{serverURL:string;userId:string|null;teams:{id:string;name:string;archived?:boolean}[]};
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
  updates?: ClientUpdateState;
  offlineStorage?: OfflineStorageState;
  connectionServerURL?: string;
  storageMigrating?: boolean;
  storageError?: string;
  sync: {
    running: boolean;
    pending: { docId: string; error?: string; blocked: boolean }[];
    documents: { id: string; title: string; directory: string; result?: any }[];
  };
}
export interface ClientUpdateState {
  status: "idle"|"checking"|"available"|"up-to-date"|"downloading"|"verifying"|"ready"|"preparing"|"installing"|"error";
  currentVersion: string;
  latestVersion: string|null;
  downloadedBytes: number;
  totalBytes: number;
  progress: number;
  error: string|null;
  checkedAt: string|null;
  downloadPath: string|null;
  canInstall: boolean;
  needsAuth: boolean;
  release: {version:string;file:string;platform:string;arch:string;bytes:number;sha256:string}|null;
}
export interface OfflineStorageState {
  config: {enabled:boolean;scope:"all-readable"|"selected";libraryIds:string[];includeAssets:boolean;backupDirectory:string;retention:number;backupIntervalMinutes?:number};
  enabled: boolean;
  pullState: "disabled"|"idle"|"running"|"error";
  complete: boolean;
  lastPullAttempt: string|null;
  lastCacheUpdate: string|null;
  unavailable: number;
  availableDocuments: number;
  assetsTotal: number;
  assetsMissing: number;
  running: boolean;
  configured: boolean;
  libraries: any[];
  downloadedLibraryIds?: string[];
  backups: LocalBackup[];
  progress: {completed:number;total:number;assetsCompleted:number;assetsTotal:number;currentTitle:string}|null;
  automaticOffline?: boolean;
  networkOnline?: boolean;
  lastError: string;
  lastDownload: string|null;
  lastBackup: string|null;
  documents: number;
  pending: number;
  conflicts: {id:string;title:string;error:string;kind?:"permission"|"title"|"validation"|"archive";baseTitle?:string;remoteTitle?:string}[];
  assets: number;
}
export interface LocalBackup { id:string;createdAt?:string;at?:string;documents?:number;assets?:number;bytes?:number;name?:string;incremental?:boolean;addedBytes?:number }
export interface LocalBackupResult { id:string;directory:string;documents:number;assets:number;incremental?:boolean;skipped?:boolean;addedBytes?:number;reusedBytes?:number }
export interface Bridge {
  localMcpState?():Promise<any>;
  configureLocalMcp?(input:{enabled?:boolean;rotate?:boolean;port?:number}):Promise<any>;
  exportNoteMarkdown?(input:{content:string;title:string;snapshot?:RichDoc;exportId?:string}):Promise<{saved:boolean;archive?:boolean}>;
  onNoteExportProgress?(callback:(value:{id:string;message:string})=>void):()=>void;
  rendererReady?():Promise<unknown>;
  updateState?():Promise<ClientUpdateState>;
  checkUpdates?():Promise<ClientUpdateState>;
  downloadUpdate?():Promise<ClientUpdateState>;
  installUpdate?():Promise<void>;
  openUpdateFolder?():Promise<void>;
  offlineStatus?():Promise<OfflineStorageState>;
  configureOffline?(config:Partial<OfflineStorageState["config"]>):Promise<OfflineStorageState>;
  downloadOffline?():Promise<OfflineStorageState>;
  syncOffline?():Promise<OfflineStorageState>;
  cacheOfflineDocument?(input:{id:string;ystate:string;metadata?:any;serverURL:string;userId:string;local?:boolean}):Promise<void>;
  chooseBackupDirectory?():Promise<string|null>;
  createBackup?():Promise<LocalBackupResult|undefined>;
  listBackups?():Promise<LocalBackup[]>;
  deleteBackup?(id:string):Promise<OfflineStorageState>;
  restoreBackup?(id:string):Promise<OfflineStorageState>;
  openBackupFolder?():Promise<void>;
  resolveOfflineConflict?(id:string,choice:"local-title"|"remote-title"):Promise<OfflineStorageState>;
  storageDirectory?():Promise<{directory:string;kind:"personal"|"server";migrating:boolean}>;
  retryStorageDirectory?():Promise<NativeState>;
  migrateStorageDirectory?():Promise<NativeState>;
  exportNotePDF?(input:{html:string;title:string}):Promise<{saved:boolean}>;
  enterPersonal(): Promise<NativeState>;
  openLocalWorkspace?():Promise<NativeState>;
  serverWorkspaces?():Promise<NonNullable<NativeState["connectionWorkspace"]>>;
  openServerWorkspace?(input:{scope?:string;page?:"home"|"friends"|"teams"}):Promise<boolean>;
  leavePersonal(): Promise<NativeState>;
  openPersonalFolder(): Promise<{ ok: boolean }>;
  onBeforeClose?(callback: () => Promise<void>): () => void;
  acceptRemote(id: string): Promise<{ backup: string }>;
  setLocale(locale: "zh-CN" | "en"): Promise<void>;
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
      new Error(result.error || result.message || translateUI("请求失败")),
      { status: response.status, result },
    );
  return result;
}
