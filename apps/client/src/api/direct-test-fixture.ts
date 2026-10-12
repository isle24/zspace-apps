import { JSEncrypt } from "jsencrypt";
const rsa = new JSEncrypt({ default_key_size: "1024" });
const publicKey = rsa.getPublicKey();
export const officialJson = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export function officialFixture(
  read: (url: URL, init: RequestInit) => Response | Promise<Response> = (url) =>
    officialJson({
      code: 200,
      data: url.pathname === "/system/polling2" ? { pools: [] } : { list: [], total: 0 },
    }),
): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/key/pub")
      return officialJson({
        code: 200,
        data: {
          key: publicKey,
          sign: "synthetic-challenge",
          nasid: "synthetic",
        },
      });
    if (url.pathname === "/auth/login")
      return officialJson({
        code: "S000200",
        data: {
          token: "synthetic-official-token",
          nasid: "synthetic",
          username: "fixture",
          nickname: "Synthetic",
        },
      });
    return read(url, init);
  };
}
