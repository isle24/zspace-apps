import {
  validateSnapshotProof,
  verifySnapshotBlob,
  type SnapshotProof,
} from "./snapshot-integrity";
import {
  loadStoreAddress,
  normalizeStoreAddress,
  persistStoreAddress,
} from "./store-address";
export class GatewayError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
// Accept the RFC3339 contract, rejecting dates that Date.parse silently normalizes.
function sessionDeadline(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) return NaN;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] =
    parts;
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  const days = [
    31,
    y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > days[m - 1] ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour || 0) > 23 ||
    Number(offsetMinute || 0) > 59
  )
    return NaN;
  return Date.parse(value);
}
export class Gateway {
  private address = loadStoreAddress();
  private session = "";
  private authSource = "password";
  private generation = 0;
  private expiresAt = 0;
  private cancelExpiry?: () => void;
  private checkExpiry = () => {
    if (this.expiresAt && Date.now() >= this.expiresAt) this.storeSession = "";
  };
  get storeAddress() {
    return this.address;
  }
  get storeSession() {
    return this.session;
  }
  set storeSession(value: string) {
    this.installSession(value, "password");
  }
  private installSession(value: string, source: "password" | "nas-grant", reason?: "logout") {
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    this.expiresAt = 0;
    this.session = value;
    this.authSource = source;
    this.generation++;
    window.dispatchEvent(new CustomEvent("space-store-session", { detail: { reason } }));
  }
  get storeAuthSource() {
    return this.session ? this.authSource : "";
  }
  captureStoreScope() {
    this.checkExpiry();
    return { storeAddress: this.address, generation: this.generation };
  }
  /** Trusted host integration: accepts an already issued grant, never NAS credentials. */
  adoptStoreGrant(
    grant: {
      sessionId: string;
      expiresAt: string;
      storeAddress: string;
    },
    issuedFor: { storeAddress: string; generation: number },
  ) {
    this.checkExpiry();
    if (
      !issuedFor ||
      issuedFor.generation !== this.generation ||
      issuedFor.storeAddress !== this.address
    )
      throw new Error("商店服务或会话已改变，请重新取得授权");
    const deadline = sessionDeadline(grant.expiresAt);
    if (
      typeof grant.storeAddress !== "string" ||
      normalizeStoreAddress(grant.storeAddress) !== this.address
    )
      throw new Error("商店授权服务地址不一致");
    if (
      typeof grant.sessionId !== "string" ||
      !grant.sessionId ||
      !Number.isFinite(deadline) ||
      deadline <= Date.now()
    )
      throw new Error("商店授权会话或有效期无效");
    this.installSession(grant.sessionId, "nas-grant");
    this.watchExpiry(deadline);
  }
  async init() {}
  async setStoreAddress(value: string) {
    const normalized = normalizeStoreAddress(value);
    if (normalized === this.address) return;
    const oldAddress = this.address,
      oldSession = this.session;
    this.address = normalized;
    persistStoreAddress(normalized);
    this.storeSession = "";
    window.dispatchEvent(new Event("space-store-address"));
    if (oldSession)
      void this.revokeSession(oldAddress, oldSession).catch(() => {
        /* Best effort: local scope is already closed. */
      });
  }
  async store<T = any>(
    operation: string,
    body?: unknown,
    publicRead = false,
    cloudSession?: string,
  ): Promise<T> {
    if (cloudSession && (operation !== "v2/cloud/install-plan" || !/^[a-f0-9]{48}$/.test(cloudSession))) throw new Error("云端授权仅用于生成应用安装计划");
    this.checkExpiry();
    const allowedPublic = ["bootstrap", "login", "setup"];
    if (publicRead && !allowedPublic.includes(operation))
      throw new GatewayError("此接口需要商店登录", "NO_SESSION", 401);
    const generation = this.generation,
      session = this.session,
      address = this.address;
    const current = () => {
      this.checkExpiry();
      if (generation !== this.generation || address !== this.address)
        throw new GatewayError(
          "商店服务或会话已改变，请重新读取并确认计划",
          "STORE_SESSION_CHANGED",
          409,
        );
    };
    if (!publicRead && !session)
      throw new GatewayError("请先登录商店管理员", "NO_SESSION", 401);
    let response: Response;
    try {
      response = await fetch(address + "/api/store/" + operation, {
        method: body === undefined ? "GET" : "POST",
        credentials: "omit",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(!publicRead ? { "X-Store-Session": session } : {}),
          ...(cloudSession ? { "X-Cloud-Session": cloudSession } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      current();
      throw new GatewayError(
        "无法连接独立商店服务，请检查服务地址与网络",
        "NETWORK_ERROR",
        0,
      );
    }
    current();
    let json: any;
    try {
      json = await response.json();
    } catch {
      current();
      throw new GatewayError(
        "商店服务返回无效数据",
        "INVALID_RESPONSE",
        response.status,
      );
    }
    current();
    if (!response.ok || json.ok !== true) {
      if (!publicRead && response.status === 401) this.storeSession = "";
      throw new GatewayError(
        json.error?.message || "商店请求失败",
        json.error?.code || "REQUEST_FAILED",
        response.status,
      );
    }
    if (operation === "login") {
      const deadline = sessionDeadline(json.data?.expiresAt);
      if (
        typeof json.data?.sessionId !== "string" ||
        !json.data.sessionId ||
        !Number.isFinite(deadline) ||
        deadline <= Date.now()
      )
        throw new Error("商店登录响应会话或有效期无效");
      this.storeSession = json.data.sessionId;
      this.watchExpiry(deadline);
    }
    return json.data as T;
  }
  private async protectedRead(operation: string, signal?: AbortSignal) {
    this.checkExpiry();
    const generation = this.generation,
      session = this.session,
      address = this.address;
    if (!session)
      throw new GatewayError("请先登录商店管理员", "NO_SESSION", 401);
    const controller = new AbortController();
    const current = () => {
      this.checkExpiry();
      if (generation !== this.generation || address !== this.address)
        throw new GatewayError(
          "商店服务或会话已改变，请重新读取并确认计划",
          "STORE_SESSION_CHANGED",
          409,
        );
    };
    const abort = () => controller.abort();
    const scopeChanged = () => {
      if (generation !== this.generation || address !== this.address) abort();
    };
    signal?.addEventListener("abort", abort);
    window.addEventListener("space-store-session", scopeChanged);
    window.addEventListener("space-store-address", scopeChanged);
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      window.removeEventListener("space-store-session", scopeChanged);
      window.removeEventListener("space-store-address", scopeChanged);
    };
    if (signal?.aborted) controller.abort();
    try {
      const response = await fetch(address + "/api/store/" + operation, {
        credentials: "omit",
        redirect: "error",
        headers: { "X-Store-Session": session },
        signal: controller.signal,
      });
      current();
      if (!response.ok) {
        if (response.status === 401) this.storeSession = "";
        throw new GatewayError(
          "无法读取商店数据",
          "REQUEST_FAILED",
          response.status,
        );
      }
      return { response, current, cleanup, signal: controller.signal };
    } catch (error) {
      cleanup();
      current();
      throw error;
    }
  }
  async downloadStore(
    operation: string,
    proof?: SnapshotProof,
    signal?: AbortSignal,
    onProgress?: (verified: number, total: number) => void,
  ): Promise<Blob> {
    if (proof) validateSnapshotProof(proof);
    const scope = await this.protectedRead(operation, signal);
    try {
      if (proof) {
        const length = scope.response.headers.get("Content-Length");
        if (
          length !== null &&
          (!/^\d+$/.test(length) || Number(length) !== proof.sizeBytes)
        )
          throw new Error(
            "快照大小不一致，服务返回的长度未匹配记录，未保存文件",
          );
      }
      const blob = await scope.response.blob();
      scope.current();
      if (scope.signal.aborted)
        throw new DOMException("快照下载已取消", "AbortError");
      if (proof)
        await verifySnapshotBlob(
          blob,
          proof,
          scope.signal,
          scope.current,
          onProgress,
        );
      scope.current();
      return blob;
    } finally {
      scope.cleanup();
    }
  }
  async streamStore(
    operation: string,
    onEvent: (value: unknown) => void,
    signal: AbortSignal,
  ) {
    const scope = await this.protectedRead(operation, signal);
    const reader = scope.response.body?.getReader();
    if (!reader) {
      scope.cleanup();
      throw new Error("商店任务流不可用");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        scope.current();
        if (scope.signal.aborted)
          throw new DOMException("任务流已取消", "AbortError");
        if (chunk.done) break;
        buffer = (
          buffer + decoder.decode(chunk.value, { stream: true })
        ).replace(/\r\n/g, "\n");
        if (buffer.length > 1048576) throw new Error("商店任务流数据超出限制");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (
            event
              .split("\n")
              .some((line) => /^event:\s*auth-expired\s*$/.test(line))
          ) {
            scope.current();
            this.storeSession = "";
            throw new GatewayError("商店登录已失效", "NO_SESSION", 401);
          }
          if (data) {
            scope.current();
            onEvent(JSON.parse(data));
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      scope.cleanup();
    }
  }
  private watchExpiry(deadline: number) {
    this.expiresAt = deadline;
    const generation = this.generation;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      if (generation !== this.generation) return;
      if (Date.now() >= deadline) this.storeSession = "";
    };
    const schedule = () => {
      check();
      if (generation === this.generation)
        timer = setTimeout(
          schedule,
          Math.min(deadline - Date.now(), 2147483647),
        );
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    this.cancelExpiry = () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
    schedule();
  }
  async logoutStore() {
    const session = this.session,
      address = this.address;
    this.installSession("", "password", "logout");
    if (!session) return;
    await this.revokeSession(address, session);
  }
  private async revokeSession(address: string, session: string) {
    // This never mutates current session/address, including on a late failure.
    const response = await fetch(address + "/api/store/logout", {
      method: "POST",
      // The host may unmount this frame as soon as local logout is announced.
      keepalive: true,
      credentials: "omit",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-Store-Session": session,
      },
      body: "{}",
    });
    const json = await response.json();
    if (!response.ok || json.ok !== true)
      throw new GatewayError(
        json.error?.message || "服务端注销失败",
        json.error?.code || "REQUEST_FAILED",
        response.status,
      );
  }
}
export const api = new Gateway();
export const message = (error: unknown) =>
  error instanceof Error ? error.message : "请求失败，请重试";
export async function confirmInstallation(
  client: Gateway,
  plan: { id?: string; planId?: string },
  reviewedId: string,
  requestId: string,
) {
  if (!client.storeSession) throw new Error("请先登录商店管理员");
  const id = plan.id || plan.planId;
  if (!id || id !== reviewedId) throw new Error("请重新查看并确认安装计划");
  return client.store("install", { planId: id, requestId });
}
