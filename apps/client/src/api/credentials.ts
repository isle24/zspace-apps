import { vault, type NasSession } from "./client";
export type SavedCredentials = {
  baseUrl: string;
  username: string;
  password: string;
  autoLogin: boolean;
};
export async function restoreCredentials(
  saved: string,
  login: (
    baseUrl: string,
    username: string,
    password: string,
  ) => Promise<NasSession>,
): Promise<{
  credentials: SavedCredentials;
  session?: NasSession;
  error?: string;
}> {
  const data = JSON.parse(saved);
  if (
    !data ||
    typeof data.baseUrl !== "string" ||
    typeof data.username !== "string" ||
    typeof data.password !== "string"
  )
    throw new Error("保存的凭据无效，请重新登录");
  const credentials: SavedCredentials = {
    baseUrl: data.baseUrl,
    username: data.username,
    password: data.password,
    autoLogin: data.autoLogin === true,
  };
  if (!credentials.autoLogin) return { credentials };
  try {
    return {
      credentials,
      session: await login(
        credentials.baseUrl,
        credentials.username,
        credentials.password,
      ),
    };
  } catch {
    return { credentials, error: "自动登录未成功，请检查设备连接后重新登录" };
  }
}

export async function saveLoginPreference(
  remember: boolean,
  credentials: SavedCredentials,
  storage: typeof vault = vault,
): Promise<string> {
  try {
    if (remember)
      await storage("write", "nas:credentials", JSON.stringify(credentials));
    else await storage("delete", "nas:credentials");
    return "";
  } catch {
    return remember
      ? "已连接，但系统凭据保存失败，本次登录不会被保存。"
      : "已连接，但保存的凭据清除失败，请稍后在系统凭据保险库中移除。";
  }
}
