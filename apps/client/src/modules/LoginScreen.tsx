import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowSquareOut,
  Eye,
  EyeSlash,
  Planet,
} from "@phosphor-icons/react";
import { api, isNative, message, type NasSession } from "../api/client";
import { OfficialNasVerificationRequired, type LoginVerificationChallenge } from "../api/official-nas";
import { saveLoginPreference, type SavedCredentials } from "../api/credentials";
import {
  loadRuntimeConfig,
  originFacts,
  resolveNasOrigin,
  type RuntimeConfig,
} from "../api/same-origin";

/**
 * 登录页。
 *
 * 三条规则值得记在这里：
 * 1. 部署期配置给了 NAS 地址（容器部署 / 原生客户端）就不再让用户填地址，
 *    但仍留"更改设备地址"入口，免得换设备时没路走；
 * 2. 地址栏隐藏时副标题显示已知地址，让用户知道连的是哪台；
 * 3. 配置读取要静默降级：读不到就按同源规则处理，不能因此让整个应用崩掉。
 */
export function LoginScreen({
  onLogin,
  onPreview,
  onStore,
  saved,
  initialError,
}: {
  onLogin: (s: NasSession, warning?: string) => void;
  onPreview: () => void;
  onStore: () => void;
  saved?: SavedCredentials;
  initialError?: string;
}) {
  // 部署期配置（容器部署时由 runtime-config.json 指定 NAS 接口地址）
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  useEffect(() => {
    let alive = true;
    // 用 async/await 而不是链式 then：fetch 不可用或被替换成非 Promise 时要静默降级，
    // 不能因为读不到部署配置就让整个应用崩掉。
    void loadRuntimeConfig().then((config) => {
      if (alive && config) setRuntimeConfig(config);
    });
    return () => {
      alive = false;
    };
  }, []);
  const [origin] = useState(() => resolveNasOrigin(null, isNative(), originFacts()));
  const [baseUrl, setBaseUrl] = useState(
    saved?.baseUrl || resolveNasOrigin(null, isNative(), originFacts()),
  );
  const configuredOrigin = resolveNasOrigin(runtimeConfig, isNative(), originFacts());
  /*
   * 已经知道 NAS 地址时不再显示地址栏：
   * - 网页版跑在 NAS 上（同源）→ origin 立刻有值；
   * - 原生客户端/容器部署 → runtime-config.json 给出 nasOrigin。
   * 两者都没有才让用户填。地址仍可通过卡片底部的「更改设备地址」临时展开，
   * 不会变成死路。
   */
  const knownOrigin = origin || configuredOrigin;
  const [showAddress, setShowAddress] = useState(false);
  const askForAddress = !knownOrigin || showAddress;
  useEffect(() => {
    if (!configuredOrigin) return;
    if ((!baseUrl || baseUrl === origin) && baseUrl !== configuredOrigin) {
      resetVerification();
      setBaseUrl(configuredOrigin);
    }
  }, [configuredOrigin, origin]);
  const [username, setUsername] = useState(saved?.username || "");
  const [password, setPassword] = useState(saved?.password || "");
  const [visible, setVisible] = useState(false);
  const [remember, setRemember] = useState(!!saved);
  const [autoLogin, setAutoLogin] = useState(saved?.autoLogin || false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError || "");
  const [verification, setVerification] = useState<LoginVerificationChallenge | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const loginVersion = useRef(0);
  const completed = useRef(false);
  const resendSeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  function resetVerification() {
    loginVersion.current++;
    api.cancelLoginVerification();
    setVerification(null); setVerificationCode(""); setCodeSent(false); setRetryAt(0); setBusy(false);
  }
  useEffect(() => () => {
    loginVersion.current++;
    if (!completed.current) api.cancelLoginVerification();
  }, []);
  useEffect(() => {
    if (!verification) return;
    const expiry = setTimeout(() => { resetVerification(); setError("本次验证已过期，请重新登录"); }, Math.max(0, verification.expiresAt - Date.now()));
    return () => clearTimeout(expiry);
  }, [verification]);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const [probing, setProbing] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("");
  const probeVersion = useRef(0);
  async function probe() {
    const version = ++probeVersion.current;
    setProbing(true);
    setError("");
    setConnectionStatus("");
    try {
      await api.checkConnection(baseUrl);
      if (version === probeVersion.current)
        setConnectionStatus("官方 API 可达，尚未登录。公钥连接测试已通过。");
    } catch (e) {
      if (version === probeVersion.current) setError(message(e));
    } finally {
      if (version === probeVersion.current) setProbing(false);
    }
  }
  async function sendVerificationCode() {
    if (!verification || busy || resendSeconds > 0) return;
    const version = ++loginVersion.current;
    setBusy(true); setError("");
    try {
      const result = await api.sendLoginVerificationCode(verification.id, baseUrl, username);
      if (version !== loginVersion.current) return;
      setCodeSent(true); setRetryAt(result.retryAt); setNow(Date.now());
    } catch (e) {
      if (version === loginVersion.current) setError(message(e));
    } finally { if (version === loginVersion.current) setBusy(false); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || (verification && (!codeSent || !/^(?:\d{4}|\d{6})$/.test(verificationCode)))) return;
    const version = ++loginVersion.current;
    setError(""); setBusy(true);
    try {
      const session = verification
        ? await api.completeLoginVerification(verification.id, { baseUrl, username, password, code: verificationCode })
        : await api.login(baseUrl, username, password);
      if (version !== loginVersion.current) return;
      const warning = await saveLoginPreference(remember && isNative(), { baseUrl, username, password, autoLogin });
      if (version !== loginVersion.current) return;
      completed.current = true;
      setPassword(""); setVerification(null); setVerificationCode("");
      onLogin(session, warning);
    } catch (e) {
      if (version !== loginVersion.current) return;
      if (e instanceof OfficialNasVerificationRequired) {
        setVerification(e.verification); setVerificationCode(""); setCodeSent(false); setRetryAt(0);
      }
      setError(message(e));
    } finally { if (version === loginVersion.current) setBusy(false); }
  }
  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="login-mark">
            <Planet weight="duotone" />
          </span>
          <h1>空间桌面</h1>
          <p className="login-sub">
            {knownOrigin ? knownOrigin.replace(/^https?:\/\//, "") : "连接你的 NAS"}
          </p>
        </div>
        {askForAddress && (
          <label className="field">
            <span className="field-label">设备地址</span>
            <input
              type="url"
              autoComplete="url"
              required
              placeholder="http://你的 NAS 地址:5055"
              value={baseUrl}
              onChange={(e) => {
                resetVerification();
                setBaseUrl(e.target.value);
                probeVersion.current++;
                setProbing(false);
                setConnectionStatus("");
              }}
            />
          </label>
        )}
        {/* 测试连接只在开发期与自填地址时出现，正式同源部署不显示 */}
        {askForAddress && (import.meta.env.DEV || isNative()) && (
          <>
            <button
              className="connection-test"
              type="button"
              disabled={probing || busy || !baseUrl.trim()}
              onClick={probe}
            >
              {probing ? "测试连接中…" : "测试连接"}
            </button>
            {connectionStatus && (
              <p role="status" className="connection-result">
                {connectionStatus}
              </p>
            )}
          </>
        )}
        <label className="field">
          <span className="field-label">账号</span>
          <input
            required
            autoComplete="username"
            placeholder="请输入 NAS 账号"
            value={username}
            onChange={(e) => { resetVerification(); setUsername(e.target.value); setError(""); }}
          />
        </label>
        <label className="field">
          <span className="field-label">密码</span>
          <span className="password-field">
            <input
              type={visible ? "text" : "password"}
              required
              autoComplete="current-password"
              placeholder="请输入登录密码"
              value={password}
              onChange={(e) => { resetVerification(); setPassword(e.target.value); setError(""); }}
            />
            <button
              type="button"
              aria-label={visible ? "隐藏密码" : "显示密码"}
              onClick={() => setVisible(!visible)}
            >
              {visible ? <EyeSlash /> : <Eye />}
            </button>
          </span>
        </label>
        {verification && (
          <section className="login-verification" aria-label="新设备短信验证">
            <p className="connection-result">通过极空间官方服务向账号绑定的手机号发送验证码。</p>
            <button className="connection-test" type="button" disabled={busy || resendSeconds > 0} onClick={sendVerificationCode}>
              {resendSeconds > 0 ? `${resendSeconds} 秒后重新发送` : codeSent ? "重新发送验证码" : "发送验证码"}
            </button>
            {codeSent && <p role="status" className="connection-result">验证码已发送，请查看账号绑定的手机。</p>}
            <label className="field">
              <span className="field-label">短信验证码</span>
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="(?:[0-9]{4}|[0-9]{6})"
                placeholder="4 位或 6 位数字" value={verificationCode} disabled={busy || !codeSent}
                onChange={(e) => setVerificationCode(e.target.value.replace(/[^0-9]/g, ""))} />
            </label>
            <button className="preview-button" type="button" onClick={() => { resetVerification(); setError(""); }}>取消验证</button>
          </section>
        )}
        <label className="check-field">
          <input
            type="checkbox"
            checked={remember}
            disabled={!isNative()}
            /* 网页版不保存凭据（没有原生钥匙串）所以置灰 —— 灰着不说话最像 bug，把原因写出来 */
            title={isNative() ? undefined : "网页版不保存凭据；桌面客户端可勾选"}
            onChange={(e) => {
              setRemember(e.target.checked);
              if (!e.target.checked) setAutoLogin(false);
            }}
          />
          保持登录
          {!isNative() && <small className="check-hint">网页版不保存凭据</small>}
        </label>
        {isNative() && (
          <label className="check-field">
            <input
              type="checkbox"
              checked={autoLogin}
              disabled={!remember}
              onChange={(e) => setAutoLogin(e.target.checked)}
            />
            启动时自动登录
          </label>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <button className="primary login-submit" disabled={busy || probing || !!verification && (!codeSent || !/^(?:\d{4}|\d{6})$/.test(verificationCode))}>
          {busy ? "正在连接…" : verification ? "验证并登录" : "登录"}
        </button>
        <div className="login-links">
          {/* 地址已知时隐藏了地址栏，这里留一个入口，换设备时不至于没路走 */}
          {knownOrigin && (
            <button
              className="preview-button"
              type="button"
              aria-expanded={showAddress}
              onClick={() => setShowAddress((current) => !current)}
            >
              {showAddress ? "收起设备地址" : "更改设备地址"}
            </button>
          )}
          <button className="preview-button" type="button" onClick={onStore}>
            独立应用商店
            <ArrowSquareOut />
          </button>
          {import.meta.env.DEV && (
            <button className="preview-button" type="button" onClick={onPreview}>
              先体验桌面
              <ArrowSquareOut />
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
