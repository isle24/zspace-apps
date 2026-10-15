import type { UploadDestination, UploadSnapshot, UploadCallbacks } from "./official-upload";
import type { UploadSourceDescriptor } from "./upload-sources";
import { OfficialNas, type StoreNasBinding, type StoreNasSession, type PersonalSettingKey, type DockerEndpoint } from "./official-nas";
import {
  loadStoreAddress,
  normalizeStoreAddress,
  persistStoreAddress,
} from "./store-address";
export type Item = {
  id: string;
  name: string;
  kind?: string;
  path?: string;
  thumbnail?: string;
  backdrop?: string;
  stream?: string;
  size?: number;
  metadata?: Record<string, unknown>;
};
export type FileDownload = { id: string; name: string; size?: number; sessionId: string };
export type DirectoryCreation = {
  sessionId: string;
  outcome: "directory-ready";
  item: Item;
};
export type FileTransfer = {
  id: string; sessionId: string; name: string; received: number; total?: number;
  status: "choosing" | "running" | "completed" | "failed" | "cancelled";
  message?: string; retainedPartial?: boolean;
};
export type Collection = {
  items: Item[];
  total?: number;
  values?: Record<string, unknown>;
};
export type NasSession = {
  sessionId: string;
  baseUrl: string;
  user: Record<string, unknown>;
};
export const isNative = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export async function vault(
  action: "read" | "write" | "delete",
  scope: string,
  value?: string,
) {
  if (!isNative()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>(`vault_${action}`, {
    scope,
    ...(value === undefined ? {} : { value }),
  });
}
export class GatewayError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
export class Gateway {
  readonly nas: OfficialNas;
  get nasSession() {
    return this.nas.sessionId;
  }
  private storeFrameExpiry = "";
  private passwordFrameGrant?: {sessionId:string;expiresAt:string;base:string};
  private storeSessionValue = "";
  private storeSessionSource: "nas" | "password" | "" = "";
  private storeNasGeneration = 0;
  private storeNasPaused = false;
  private storeNasExpiry?: ReturnType<typeof setTimeout>;
  private presentedBinding?: { binding: StoreNasBinding; config: number; nas: number };
  private trustedBinding?: StoreNasBinding;
  private nasGrantBinding?: StoreNasBinding;
  get storeAuthSource() { return this.storeSessionSource; }
  get storeNasAutoLoginPaused() { return this.storeNasPaused; }
  pauseStoreNasAutoLogin() { this.storeNasPaused = true; this.cancelStoreNasConnection(); }
  resumeStoreNasAutoLogin() { this.storeNasPaused = false; }
  private storeSessionGeneration = 0;
  get storeSession() {
    return this.storeSessionValue;
  }
  set storeSession(value: string) {
    if (this.storeSessionSource === "nas" && value !== this.storeSessionValue) { this.nas.releaseStoreNasSession(); this.nasGrantBinding = undefined; }
    if (value !== this.storeSessionValue) this.storeSessionGeneration++;
    this.storeFrameExpiry = value && this.passwordFrameGrant?.sessionId === value && this.passwordFrameGrant.base === this.base ? this.passwordFrameGrant.expiresAt : "";
    this.storeSessionValue = value;
    this.storeSessionSource = value ? "password" : "";
    clearTimeout(this.storeNasExpiry);
    if (this.storeFrameExpiry) {
      const generation = this.storeSessionGeneration;
      this.storeNasExpiry = setTimeout(() => {
        if (generation === this.storeSessionGeneration) this.storeSession = "";
      }, Math.max(0, Date.parse(this.storeFrameExpiry) - Date.now()));
    }
    if (typeof window !== "undefined")
      window.dispatchEvent(new Event("space-store-session"));
  }
  base = "";
  storeAddress = loadStoreAddress();
  private initializedGeneration = -1;
  private configGeneration = 0;
  private addressChanging = 0;
  private initialization?: { generation: number; promise: Promise<void> };
  private fetcher: typeof fetch;
  constructor(fetcher?: typeof fetch) {
    this.fetcher = fetcher || ((...args) => fetch(...args));
    this.nas = new OfficialNas(fetcher, {
      onSessionChanged: () => this.nasSessionChanged(),
      storeSessionContext: () => this.storeSessionContext(),
      onNativeSessionExpired: () => this.expired("nas", new Error("NAS 登录已失效，请重新登录")),
    });
  }

  async setStoreAddress(value: string) {
    const address = normalizeStoreAddress(value);
    if (address === this.storeAddress) return;
    const change = ++this.configGeneration;
    this.addressChanging = change;
    this.cancelStoreNasConnection();
    let warning = "";
    try {
      await this.logoutStore();
    } catch {
      warning = "旧商店服务注销未完成，但本地会话已退出。";
    }
    if (change !== this.configGeneration) return;
    this.addressChanging = 0;
    this.storeAddress = address;
    this.storeNasPaused = false;
    this.base = "";
    this.configGeneration++;
    this.initializedGeneration = -1;
    this.initialization = undefined;
    persistStoreAddress(address);
    window.dispatchEvent(new Event("space-store-address"));
    if (warning) throw new Error(warning);
  }
  async init(): Promise<void> {
    const generation = this.configGeneration;
    if (this.initializedGeneration === generation) return;
    if (this.initialization?.generation === generation)
      return this.initialization.promise;
    const address = this.storeAddress;
    const promise = (async () => {
      let resolved = address;
      if (!address && isNative()) {
        const { invoke } = await import("@tauri-apps/api/core");
        resolved = (await invoke<string>("gateway_address")).replace(/\/$/, "");
      }
      if (generation !== this.configGeneration)
        throw new GatewayError(
          "商店服务已切换，请重新读取",
          "STORE_SERVICE_CHANGED",
          409,
        );
      this.base = resolved;
      this.initializedGeneration = generation;
    })();
    this.initialization = { generation, promise };
    try {
      await promise;
    } finally {
      if (this.initialization?.promise === promise)
        this.initialization = undefined;
    }
  }
  private nasSessionChanged() {
    this.storeNasPaused = false;
    this.cancelStoreNasConnection();
    if (this.storeSessionSource === "nas") this.storeSession = "";
    if (typeof window !== "undefined") window.dispatchEvent(new Event("space-nas-session"));
  }
  cancelStoreNasConnection() { this.storeNasGeneration++; }
  private bindingKey(binding: StoreNasBinding) { return JSON.stringify(binding); }
  isStoreNasTrusted(binding: StoreNasBinding) {
    let saved = "";
    try { saved = localStorage.getItem("space-store-nas-trust") || ""; } catch { /* Memory fallback. */ }
    return saved === this.bindingKey(binding) || (!!this.trustedBinding && this.bindingKey(this.trustedBinding) === this.bindingKey(binding));
  }
  trustStoreNasBinding(binding: StoreNasBinding) {
    const presented = this.presentedBinding;
    if (!presented || presented.config !== this.configGeneration || presented.nas !== this.nas.sessionGeneration || this.bindingKey(presented.binding) !== this.bindingKey(binding))
      throw new GatewayError("授权目标已改变，请重新确认", "STORE_SESSION_CHANGED", 409);
    this.trustedBinding = { ...presented.binding };
    try { localStorage.setItem("space-store-nas-trust", this.bindingKey(presented.binding)); } catch { /* Trust remains memory-only. */ }
  }
  async getStoreNasBinding(): Promise<StoreNasBinding> {
    const config = this.configGeneration, nas = this.nas.sessionGeneration, address = this.storeAddress;
    if (this.addressChanging) throw new GatewayError("商店服务正在切换", "STORE_SESSION_CHANGED", 409);
    const session = this.nas.session();
    if (!session) throw new GatewayError("请先连接 NAS", "NO_SESSION", 401);
    const status = await this.store<{ nasAuth?: { enabled?: unknown; origin?: unknown; storeId?: unknown } }>("bootstrap", undefined, true);
    if (this.addressChanging || address !== this.storeAddress || config !== this.configGeneration || nas !== this.nas.sessionGeneration || session.sessionId !== this.nasSession)
      throw new GatewayError("会话已改变，请重新连接商店", "STORE_SESSION_CHANGED", 409);
    const auth = status?.nasAuth;
    if (this.storeSessionSource === "nas" && this.nasGrantBinding && (auth?.enabled !== true || auth.origin !== this.nasGrantBinding.providerId || auth.storeId !== this.nasGrantBinding.storeId || (this.base || location.origin) !== this.nasGrantBinding.storeBase)) this.storeSession = "";
    if (auth?.enabled !== true) throw new GatewayError("商店尚未启用 NAS 管理员登录", "STORE_NAS_DISABLED", 403);
    if (auth.origin !== session.baseUrl || typeof auth.storeId !== "string" || !/^[a-f0-9]{48}$/.test(auth.storeId))
      throw new GatewayError("商店配置的 NAS 与当前设备不一致", "STORE_PROVIDER_MISMATCH", 403);
    const raw = this.base || (typeof location !== "undefined" ? location.origin : "");
    const base = new URL(raw);
    if (!["http:", "https:"].includes(base.protocol) || normalizeStoreAddress(raw) !== raw || base.username || base.password)
      throw new GatewayError("商店授权地址必须为独立服务来源", "STORE_PROVIDER_MISMATCH", 403);
    const binding = { providerId: session.baseUrl, storeBase: raw, storeId: auth.storeId };
    this.presentedBinding = { binding, config, nas };
    return { ...binding };
  }
  private async storeSessionContext() {
    const config = this.configGeneration, address = this.storeAddress, session = this.storeSessionGeneration, exchange = this.storeNasGeneration;
    let resolvedBase: string | undefined;
    const current = () => {
      if (this.addressChanging || (resolvedBase !== undefined && resolvedBase !== (this.base || location.origin)) || config !== this.configGeneration || address !== this.storeAddress || session !== this.storeSessionGeneration || exchange !== this.storeNasGeneration)
        throw new GatewayError("会话已改变，请重新连接商店", "STORE_SESSION_CHANGED", 409);
    };
    current();
    let binding: StoreNasBinding;
    try { binding = await this.getStoreNasBinding(); }
    catch (error) {
      current();
      if (error instanceof GatewayError && ["NO_SESSION", "STORE_NAS_DISABLED", "STORE_PROVIDER_MISMATCH", "STORE_SESSION_CHANGED", "STORE_SERVICE_CHANGED"].includes(error.code)) throw error;
      throw new GatewayError("无法读取商店授权配置", "STORE_NAS_AUTH_FAILED", 502);
    }
    current();
    resolvedBase = binding.storeBase;
    current();
    if (!this.isStoreNasTrusted(binding)) throw new GatewayError("请先确认 NAS 与商店授权目标", "STORE_TRUST_REQUIRED", 403);
    return { ...binding, assertCurrent: current, accept: (grant: StoreNasSession) => {
      current();
      this.storeSession = grant.sessionId;
      this.storeSessionSource = "nas";
      this.storeFrameExpiry = grant.expiresAt;
      this.nasGrantBinding = { ...binding };
      const generation = this.storeSessionGeneration;
      this.storeNasExpiry = setTimeout(() => { if (generation === this.storeSessionGeneration && this.storeSessionSource === "nas") this.storeSession = ""; }, Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
    } };
  }
  async grantForStoreFrame() {
    const session=this.storeSession, generation=this.storeSessionGeneration, address=this.storeAddress;
    await this.init();
    // Bootstrap is public; the frame receives only this store's accepted grant.
    await this.store("bootstrap", undefined, true);
    if (!session || generation!==this.storeSessionGeneration || address!==this.storeAddress || !this.storeFrameExpiry || Date.parse(this.storeFrameExpiry)<=Date.now()) throw new Error("请重新登录商店以获取有效授权");
    const base=this.base || location.origin;
    return {sessionId:session,expiresAt:this.storeFrameExpiry,storeAddress:new URL(base).origin};
  }
  connectStoreWithNas(options: { signal?: AbortSignal } = {}) { return this.nas.connectStoreWithNas(options); }
  private expired(scope: "nas" | "store", error: unknown) {
    if (typeof window !== "undefined")
      window.dispatchEvent(
        new CustomEvent("space-session-expired", {
          detail: { scope, message: message(error) },
        }),
      );
  }
  async request<T = unknown>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      scope?: "store";
      public?: boolean;
    } = {},
  ): Promise<T> {
    if (!path.startsWith("/api/store/"))
      throw new GatewayError(
        "此服务仅提供独立商店 API",
        "UNSUPPORTED_ROUTE",
        400,
      );
    const requestGeneration = this.configGeneration;
    const session = this.storeSession;
    const sessionGeneration = this.storeSessionGeneration;
    const requireCurrentScope = () => {
      if (requestGeneration !== this.configGeneration || (this.addressChanging && path !== "/api/store/logout"))
        throw new GatewayError(
          "商店服务已切换，请重新读取",
          "STORE_SERVICE_CHANGED",
          409,
        );
      if (!options.public && sessionGeneration !== this.storeSessionGeneration)
        throw new GatewayError(
          "商店会话已改变，请重新读取并确认计划",
          "STORE_SESSION_CHANGED",
          409,
        );
    };
    await this.init();
    requireCurrentScope();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (!options.public) {
      if (!session)
        throw new GatewayError("请先登录商店管理员", "NO_SESSION", 401);
      headers["X-Store-Session"] = session;
    }
    let response: Response;
    try {
      response = await this.fetcher(this.base + path, {
        method: options.method || "GET",
        credentials: "omit",
        redirect: "error",
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
    } catch {
      requireCurrentScope();
      throw new GatewayError(
        "无法连接独立商店服务，请检查服务地址与网络",
        "NETWORK_ERROR",
        0,
      );
    }
    requireCurrentScope();
    let json: any;
    try {
      json = await response.json();
    } catch {
      requireCurrentScope();
      throw new GatewayError(
        `商店服务返回无效数据（${response.status}）`,
        "INVALID_RESPONSE",
        response.status,
      );
    }
    requireCurrentScope();
    if (!response.ok || json.ok !== true) {
      const error = new GatewayError(
        json.error?.message || `商店请求失败（${response.status}）`,
        String(json.error?.code || "REQUEST_FAILED"),
        response.status,
      );
      if (
        !options.public &&
        session === this.storeSession &&
        (response.status === 401 ||
          ["NO_SESSION", "SESSION_EXPIRED", "UNAUTHORIZED"].includes(
            error.code,
          ))
      ) {
        this.storeSession = "";
        this.expired("store", error);
      }
      throw error;
    }
    if (path === "/api/store/login" && typeof json.data?.sessionId === "string" && /^[a-f0-9]{48}$/.test(json.data.sessionId) && typeof json.data.expiresAt === "string" && Date.parse(json.data.expiresAt)>Date.now()) {
      this.passwordFrameGrant={sessionId:json.data.sessionId,expiresAt:json.data.expiresAt,base:this.base};
    }
    return json.data as T;
  }
  async read(operation: string, params: Record<string, unknown> = {}) {
    const session = this.nasSession;
    const generation = this.nas.sessionGeneration;
    try {
      return await this.nas.read(operation, params);
    } catch (error) {
      const typed = error as { code?: string; status?: number };
      if (
        session && generation === this.nas.sessionGeneration &&
        (!this.nasSession || this.nasSession === session) &&
        (typed.status === 401 ||
          ["NO_SESSION", "SESSION_EXPIRED", "UNAUTHORIZED"].includes(
            typed.code || "",
          ))
      ) {
        this.nas.logout();
        this.expired("nas", error);
      }
      throw error;
    }
  }
  async controlApp(input: { appName: string; docker: boolean; action: "start" | "stop" | "restart" }): Promise<void> {
    return this.downloadOperation(() => this.nas.controlApp(input));
  }
  async createPhotoAlbum(input:Parameters<OfficialNas["createPhotoAlbum"]>[0]):Promise<Item>{return this.downloadOperation(()=>this.nas.createPhotoAlbum(input));}
  async musicArtwork(item:Item):Promise<Blob|null>{return this.downloadOperation(()=>this.nas.musicArtwork(item));}
  async imageOriginal(item: Item): Promise<string> { return this.downloadOperation(() => this.nas.imageOriginal(item)); }
  async downloadEngineState() { return this.downloadOperation(() => this.nas.downloadEngineState()); }
  async switchDownloadEngine(type: 1 | 2) { return this.downloadOperation(() => this.nas.switchDownloadEngine(type)); }
  async acknowledgeDownloadEngineSwitch() { return this.downloadOperation(() => this.nas.acknowledgeDownloadEngineSwitch()); }
  async remoteEntries() { return this.downloadOperation(() => this.nas.remoteEntries()); }
  async note(id: string) { return this.downloadOperation(() => this.nas.note(id)); }
  async saveNote(input: Parameters<OfficialNas['saveNote']>[0]) { return this.downloadOperation(() => this.nas.saveNote(input)); }
  async recycleAction(input: Parameters<OfficialNas['recycleAction']>[0]) { return this.downloadOperation(() => this.nas.recycleAction(input)); }
  async uninstallApp(input: Parameters<OfficialNas['uninstallApp']>[0]) { return this.downloadOperation(() => this.nas.uninstallApp(input)); }
  async prepareDockerApp(appName: string) { return this.downloadOperation(() => this.nas.prepareDockerApp(appName)); }
  async installDockerApp(input: Parameters<OfficialNas['installDockerApp']>[0]) { return this.downloadOperation(() => this.nas.installDockerApp(input)); }
  async saveSetting(key: PersonalSettingKey, value: string | number): Promise<void> {
    return this.downloadOperation(() => this.nas.saveSetting(key, value));
  }
  async docker<T = Record<string, unknown>>(endpoint: DockerEndpoint, body?: Record<string, unknown>): Promise<T> {
    return this.downloadOperation(() => this.nas.docker<T>(endpoint, body));
  }
  async prepareNativeApp(appName: string) {
    return this.downloadOperation(() => this.nas.prepareNativeApp(appName));
  }
  async installNativeApp(input: { appName: string; version: number; mp: string }) {
    return this.downloadOperation(() => this.nas.installNativeApp(input));
  }
  async fetchMedia(value: unknown, options: { range?: string; signal?: AbortSignal } = {}): Promise<Response> {
    const session = this.nasSession;
    const generation = this.nas.sessionGeneration;
    try {
      return await this.nas.fetchMedia(value, options);
    } catch (error) {
      const typed = error as { code?: string; status?: number };
      if (session && generation === this.nas.sessionGeneration && (!this.nasSession || this.nasSession === session) &&
        (typed.status === 401 || typed.code === "SESSION_EXPIRED")) {
        this.nas.logout();
        this.expired("nas", error);
      }
      throw error;
    }
  }
  async selectBrowserUploadSource(file: File): Promise<UploadSourceDescriptor> {
    return this.downloadOperation(() => this.nas.selectBrowserUploadSource(file));
  }
  async pickUploadSource(): Promise<UploadSourceDescriptor | null> {
    return this.downloadOperation(() => this.nas.pickUploadSource());
  }
  async releaseUploadSource(sourceId: string): Promise<void> {
    return this.downloadOperation(() => this.nas.releaseUploadSource(sourceId));
  }
  async prepareUpload(sourceId: string, destination: UploadDestination, options: { signal?: AbortSignal } = {}): Promise<UploadSnapshot> { return this.downloadOperation(() => this.nas.prepareUpload(sourceId, destination, options)); }
  async runUpload(taskId: string, callbacks: UploadCallbacks = {}): Promise<UploadSnapshot> { return this.downloadOperation(() => this.nas.runUpload(taskId, callbacks)); }
  async pauseUpload(taskId: string): Promise<UploadSnapshot> { return this.downloadOperation(() => this.nas.pauseUpload(taskId)); }
  async resumeUpload(taskId: string, callbacks: UploadCallbacks = {}): Promise<UploadSnapshot> { return this.downloadOperation(() => this.nas.resumeUpload(taskId, callbacks)); }
  async cancelUpload(taskId: string): Promise<void> { return this.downloadOperation(() => this.nas.cancelUpload(taskId)); }
  async prepareDownload(item: Item): Promise<FileDownload> {
    return this.downloadOperation(() => this.nas.prepareDownload(item));
  }
  async createDirectory(parent: Item, name: string, options: { signal?: AbortSignal } = {}): Promise<DirectoryCreation> {
    return this.downloadOperation(() => this.nas.createDirectory(parent, name, options));
  }
  /** 用 cookie 里的会话恢复登录态；由 nas.sessionGeneration 驱动界面刷新。 */
  async restoreNasSession(baseUrl: string, token: string, user: Record<string, unknown> = {}): Promise<NasSession> {
    return this.nas.restoreSession(baseUrl, token, user);
  }
  async downloadProtocols(): Promise<string[]> {
    return this.downloadOperation(() => this.nas.downloadProtocols());
  }
  async downloadDirectory(): Promise<string | undefined> {
    return this.downloadOperation(() => this.nas.downloadDirectory());
  }
  async addDownloadLink(uri: string, dir?: string): Promise<void> {
    return this.downloadOperation(() => this.nas.addDownloadLink(uri, dir));
  }
  async parseNasTorrent(path: string): Promise<Record<string, unknown>> {
    return this.downloadOperation(() => this.nas.parseNasTorrent(path));
  }
  async applyTorrentSelection(input: { hash: string; dir?: string; name?: string; ids: Array<number | string>; checked: "wanted" | "unwanted" }): Promise<void> {
    return this.downloadOperation(() => this.nas.applyTorrentSelection(input));
  }
  async fetchDownload(id: string, options: { signal?: AbortSignal } = {}): Promise<Response> {
    return this.downloadOperation(() => this.nas.fetchDownload(id, options));
  }
  private async downloadOperation<T>(operation: () => Promise<T>): Promise<T> {
    const session = this.nasSession, generation = this.nas.sessionGeneration;
    try { return await operation(); }
    catch (error) {
      const typed = error as { code?: string; status?: number };
      if (session && generation === this.nas.sessionGeneration && (!this.nasSession || this.nasSession === session) &&
        (typed.status === 401 || typed.code === "SESSION_EXPIRED")) {
        this.nas.logout(); this.expired("nas", error);
      }
      throw error;
    }
  }
  imagePreview(item: Pick<Item, "path" | "name" | "size" | "metadata">) {
    return this.nas.imagePreview(item);
  }
  login(baseUrl: string, username: string, password: string) {
    return this.nas.login(baseUrl, username, password);
  }
  checkConnection(baseUrl: string) {
    return this.nas.checkConnection(baseUrl);
  }
  logoutNas() {
    this.nas.logout();
  }
  async logoutStore() {
    this.pauseStoreNasAutoLogin();
    if (!this.storeSession) return;
    const generation = this.storeSessionGeneration;
    try {
      await this.store("logout", {});
    } finally {
      if (generation === this.storeSessionGeneration) this.storeSession = "";
    }
  }
  store<T = any>(path: string, body?: unknown, publicRead = false) {
    return this.request<T>(`/api/store/${path}`, {
      scope: "store",
      public: publicRead,
      method: body === undefined ? "GET" : "POST",
      body,
    });
  }
}
export function normalizeCollection(data: unknown): Collection {
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as Collection).items)
  )
    throw new Error("设备数据结构待验证，暂不能显示此内容");
  const d = data as Collection;
  if (
    d.items.some(
      (i) => !i || typeof i.id !== "string" || typeof i.name !== "string",
    )
  )
    throw new Error("设备数据结构待验证，缺少名称或标识");
  return d;
}
export async function confirmInstallation(
  api: Gateway,
  plan: { id?: string; planId?: string },
  reviewedId: string,
  requestId: string,
) {
  if (!api.storeSession) throw new Error("请先登录商店管理员");
  const id = plan.id || plan.planId;
  if (!id || id !== reviewedId) throw new Error("请重新查看并确认安装计划");
  return api.store("install", { planId: id, requestId });
}
export const api = new Gateway();
export const message = (e: unknown) =>
  e instanceof Error ? e.message : "请求失败，请重试";
export function safeMediaUrl(value: unknown): string | undefined {
  return api.nas.safeMediaUrl(value);
}
