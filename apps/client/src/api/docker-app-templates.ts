/** Data-only contracts extracted from current official vendor init forms.
 * Source names and hashes are recorded in the research contract; no vendor JS
 * or archive material is bundled, evaluated, or committed. */
export type DockerInstallField = { key: string; label: string; type: "directory" | "port" | "password" | "text" | "select"; minLength?: number; validation?: "mixed" | "nonNumeric" | "halo"; options?: string[]; defaultValue?: string; hint?: string };
export type DockerAppTemplate = { dataField: string; primaryLabel?: string; portField?: string; autoStart: boolean; risk?: boolean; fields?: DockerInstallField[] };
const password = (key: string, label: string, minLength = 1, validation?: DockerInstallField["validation"]): DockerInstallField => ({ key, label, type: "password", minLength, validation });
const port = (key: string, label: string): DockerInstallField => ({ key, label, type: "port", hint: "50000–65535，与其他端口不同" });
const directory = (key: string, label: string): DockerInstallField => ({ key, label, type: "directory" });
export const dockerAppTemplates: Readonly<Record<string, DockerAppTemplate>> = {
  OpenWebUI: { dataField: "docker_openwebui_data", autoStart: true },
  EasyNVR: { dataField: "docker_easynvr_data", autoStart: true, risk: true },
  Halo: { dataField: "docker_halo_data", autoStart: false, risk: true, fields: [{ ...password("docker_halo_dbpassword", "数据库密码", 12, "halo"), hint: "至少 12 位，含大小写字母和数字" }] },
  HermesAgent: { dataField: "docker_hermesagent_data", autoStart: true, risk: true, fields: [{ key: "hermesagent_dashboard_username", label: "控制台用户名", type: "text", minLength: 3 }, password("hermesagent_dashboard_password", "控制台密码", 3), port("docker_apiserver_port", "API 服务端口"), password("docker_apiserver_key", "API 服务密钥", 16)] },
  Jellyfin: { dataField: "docker_jellyfin_config", primaryLabel: "应用配置", autoStart: false, fields: [directory("docker_jellyfin_media", "影音媒体")] },
  ddnsgo: { dataField: "docker_ddns-go_data", autoStart: true },
  dockercopilot: { dataField: "docker_dc_data", autoStart: false, risk: true, fields: [{ ...password("docker_dc_auth", "访问密码", 8, "nonNumeric"), hint: "至少 8 位，不能全部为数字" }] },
  komga: { dataField: "docker_komga_config", primaryLabel: "应用配置", autoStart: false, risk: true, fields: [directory("docker_komga_data", "漫画书库")] },
  lobechat: { dataField: "docker_lobechat_data", autoStart: false, risk: true, fields: [port("rustfs_port", "RustFS 服务端口")] },
  moltbot: { dataField: "docker_moltbot_data", autoStart: true, risk: true, fields: [port("openclaw_bridge_port", "Bridge 服务端口"), port("openclaw_msteams_port", "Teams 服务端口")] },
  octop: { dataField: "appstore_vol_0", autoStart: false, risk: true, fields: [{ key: "appstore_username", label: "应用用户名", type: "text", minLength: 1 }, { ...password("appstore_password", "应用密码", 8, "mixed"), hint: "至少 8 位，含字母和数字" }] },
  ollama: { dataField: "docker_ollama_data", portField: "docker_ollama_port", autoStart: false, fields: [{ key: "docker_ollama_cl", label: "上下文长度", type: "select", options: ["4096", "8192", "16384", "32768"], defaultValue: "4096" }, { key: "docker_ollama_igpu", label: "核显加速", type: "select", options: ["0", "1"], defaultValue: "0" }] },
  openlist: { dataField: "docker_openlist_data", autoStart: true, fields: [password("docker_openlist_password", "管理员密码")] },
  siyuan: { dataField: "docker_siyuan_data", autoStart: false, fields: [password("docker_siyuan_auth", "访问授权密码")] },
};
export const supportsOfficialDockerInstall = (appName: string) => Object.hasOwn(dockerAppTemplates, appName);
export function dockerFieldValid(field: DockerInstallField, value: string): boolean {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000\r\n]/.test(value)) return false;
  if (field.type === "directory") return value.startsWith("/") && value.length > 1;
  if (field.type === "port") return /^\d+$/.test(value) && Number(value) >= 50000 && Number(value) <= 65535;
  if (field.type === "select") return !!field.options?.includes(value);
  if (!value || value.length < (field.minLength ?? 1)) return false;
  if (field.validation === "halo") return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$/.test(value);
  if (field.validation === "mixed") return /^(?=.*[a-zA-Z])(?=.*\d).{8,}$/.test(value);
  if (field.validation === "nonNumeric") return !/^\d+$/.test(value);
  return true;
}
