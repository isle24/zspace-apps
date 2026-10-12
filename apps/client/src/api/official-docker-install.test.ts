import { describe, expect, it } from "vitest";
import { OfficialNas } from "./official-nas";
import { officialFixture, officialJson } from "./direct-test-fixture";
const reply = (data: unknown) => officialJson({ code: 200, data });
function fixture(options: { dependency?: boolean; portBusy?: boolean; changedVersion?: boolean; onPreinstall?: () => Promise<Response>; appName?: string } = {}) {
  const calls: Array<{ path: string; form: URLSearchParams }> = []; let installed = false;
  const nas = new OfficialNas(officialFixture((url, init) => {
    const form = new URLSearchParams(String(init.body || url.search)); calls.push({ path: url.pathname, form });
    if (url.pathname === "/AppStore/v1/list") return reply({ list: [{ app_name: "docker", installed: 1, status: "running" }] });
    if (url.pathname === "/zdocker/AppStore/v1/list") return reply({ list: [{ app_name: options.appName || "OpenWebUI", is_docker: 1, installed: +installed, status: installed ? "running" : "stop", latest_version: { version: { version_int: options.changedVersion ? 102 : 101 } } }] });
    if (url.pathname.endsWith("/depend/check")) return reply(options.dependency ? { apps: [{ app_name: "docker" }] } : { apps: [] });
    if (url.pathname === "/system/polling2") return reply({ pools: [{ key: "nvme1", name: "SSD", mounted: true }, { key: "sata1", name: "HDD", mounted: true }] });
    if (url.pathname === "/v2/file/info") return reply({ path: form.get("path"), name: "openwebui", is_dir: true });
    if (url.pathname === "/zdocker/app_check_port") return options.portBusy ? officialJson({ code: "N202003", msg: "synthetic busy" }) : reply({});
    if (url.pathname.endsWith("/pkg/preinstall") && options.onPreinstall) return options.onPreinstall();
    if (url.pathname.endsWith("/pkg/install")) installed = true;
    return reply({});
  }));
  return { nas, calls };
}
describe("official vendor Docker installation", () => {
  it("uses the verified OpenWebUI fields and selected NAS disk directory, never an invented mp", async () => {
    const { nas, calls } = fixture(); await nas.login("http://nas.test:5055", "fixture", "synthetic-password");
    const plan = await nas.prepareDockerApp("OpenWebUI"); expect(plan.roots.map(r => r.path)).toEqual(["/nvme1/my/data", "/sata1/my/data"]);
    const result = await nas.installDockerApp({ appName: "OpenWebUI", version: plan.version, dataPath: "/sata1/my/data/openwebui", port: 58080, autoStart: true });
    expect(result.installed).toBe(true); const install = calls.find(c => c.path.endsWith("/pkg/install"))!.form;
    expect(install.get("docker_openwebui_data")).toBe("/tmp/zfsv3/sata1/_fixture/data/openwebui"); expect(install.get("appstore_port")).toBe("58080"); expect(install.get("appstore_restart_policy")).toBe("always"); expect(install.get("upgrade")).toBe("0"); expect(install.has("mp")).toBe(false);
    expect(calls.findIndex(c => c.path.endsWith("/pkg/preinstall"))).toBeLessThan(calls.findIndex(c => c.path.endsWith("/pkg/install")));
  });
  it("blocks port conflict before preinstall or install", async () => {
    const { nas, calls } = fixture({ portBusy: true }); await nas.login("http://nas.test:5055", "fixture", "synthetic-password");
    await expect(nas.installDockerApp({ appName: "OpenWebUI", version: 101, dataPath: "/nvme1/my/data/openwebui", port: 58080, autoStart: false })).rejects.toThrow(); expect(calls.some(c => /pkg\/(preinstall|install)$/.test(c.path))).toBe(false);
  });
  it("rejects stale versions, unmet dependencies and paths outside a mounted data pool", async () => {
    const { nas, calls } = fixture({ changedVersion: true }); await nas.login("http://nas.test:5055", "fixture", "synthetic-password");
    await expect(nas.installDockerApp({ appName: "OpenWebUI", version: 101, dataPath: "/nvme1/my/data/openwebui", port: 58080, autoStart: false })).rejects.toThrow();
    await expect(nas.installDockerApp({ appName: "OpenWebUI", version: 102, dataPath: "/etc/user-data", port: 58080, autoStart: false })).rejects.toThrow(); expect(calls.some(c => /pkg\/(preinstall|install)$/.test(c.path))).toBe(false);
    const blocked = fixture({ dependency: true }); await blocked.nas.login("http://nas.test:5055", "fixture", "synthetic-password"); await expect(blocked.nas.prepareDockerApp("OpenWebUI")).rejects.toThrow();
  });
  it("keeps unknown vendor initialization unsupported rather than guessing its data key", async () => {
    const { nas, calls } = fixture(); await nas.login("http://nas.test:5055", "fixture", "synthetic-password");
    await expect(nas.prepareDockerApp("unverified_vendor")).rejects.toMatchObject({ code: "APP_DOCKER_TEMPLATE_UNSUPPORTED" }); expect(calls.some(c => /pkg\/(preinstall|install)$/.test(c.path))).toBe(false);
  });
});

it("stops before installing when logout occurs during vendor preparation", async () => {
  let finish!: (response: Response) => void;
  const { nas, calls } = fixture({ onPreinstall: () => new Promise<Response>(resolve => { finish = resolve; }) });
  await nas.login("http://nas.test:5055", "fixture", "synthetic-password");
  const operation = nas.installDockerApp({ appName: "OpenWebUI", version: 101, dataPath: "/nvme1/my/data/openwebui", port: 58080, autoStart: true });
  while (!finish) await Promise.resolve(); nas.logout(); finish(reply({}));
  await expect(operation).rejects.toMatchObject({ code: "REQUEST_CANCELLED" }); expect(calls.some(c => c.path.endsWith("/pkg/install"))).toBe(false);
});

const vendorSettings: Record<string, Record<string,string>> = {
 Halo: {docker_halo_dbpassword:"SyntheticStrong123"}, HermesAgent: {hermesagent_dashboard_username:"fixture",hermesagent_dashboard_password:"Synthetic123",docker_apiserver_port:"58081",docker_apiserver_key:"Synthetic-API-Key-Value"}, Jellyfin: {docker_jellyfin_media:"/nvme1/my/data/media"}, dockercopilot: {docker_dc_auth:"Synthetic123"}, komga: {docker_komga_data:"/nvme1/my/data/comics"}, lobechat: {rustfs_port:"58081"}, moltbot: {openclaw_bridge_port:"58081",openclaw_msteams_port:"58082"}, octop: {appstore_username:"fixture",appstore_password:"Synthetic123"}, openlist: {docker_openlist_password:"Synthetic123"}, siyuan: {docker_siyuan_auth:"Synthetic123"}
};
const vendorData:Record<string,string>={EasyNVR:"docker_easynvr_data",Halo:"docker_halo_data",HermesAgent:"docker_hermesagent_data",Jellyfin:"docker_jellyfin_config",ddnsgo:"docker_ddns-go_data",dockercopilot:"docker_dc_data",komga:"docker_komga_config",lobechat:"docker_lobechat_data",moltbot:"docker_moltbot_data",octop:"appstore_vol_0",ollama:"docker_ollama_data",openlist:"docker_openlist_data",siyuan:"docker_siyuan_data"};
it.each(Object.keys(vendorData))("uses current verified initialization for %s", async appName => {
 const {nas,calls}=fixture({appName});await nas.login("http://nas.test:5055","fixture","synthetic-password");
 await nas.installDockerApp({appName,version:101,dataPath:"/sata1/my/data/app",port:58080,autoStart:false,settings:vendorSettings[appName]||{},riskAccepted:true});
 const form=calls.find(c=>c.path.endsWith("/pkg/install"))!.form;
 expect(form.get(vendorData[appName])).toBe("/tmp/zfsv3/sata1/_fixture/data/app");
 expect(form.get(appName==="ollama"?"docker_ollama_port":"appstore_port")).toBe("58080");
 if(appName==="ollama"){expect(form.get("docker_ollama_cl")).toBe("4096");expect(form.get("docker_ollama_igpu")).toBe("0");expect(form.has("appstore_port")).toBe(false)}
 if(appName==="Jellyfin")expect(form.get("docker_jellyfin_media")).toBe("/tmp/zfsv3/nvme1/_fixture/data/media");
});
it("refuses missing credentials, unknown fields, duplicate ports and absent vendor acknowledgement", async()=>{
 for(const settings of ([{rustfs_port:"58080"},{rustfs_port:"58081",unverified_field:"x"},{}] as Record<string,string>[])){const {nas,calls}=fixture({appName:"lobechat"});await nas.login("http://nas.test:5055","fixture","synthetic-password");await expect(nas.installDockerApp({appName:"lobechat",version:101,dataPath:"/sata1/my/data/app",port:58080,autoStart:false,settings,riskAccepted:true})).rejects.toThrow();expect(calls.some(c=>c.path.endsWith("/pkg/install"))).toBe(false)}
 const {nas}=fixture({appName:"Halo"});await nas.login("http://nas.test:5055","fixture","synthetic-password");await expect(nas.installDockerApp({appName:"Halo",version:101,dataPath:"/sata1/my/data/app",port:58080,autoStart:false,settings:{docker_halo_dbpassword:"weak"},riskAccepted:true})).rejects.toThrow();
});

it("requires the current vendor acknowledgement before preparing an installation",async()=>{
 const {nas,calls}=fixture({appName:"Halo"});await nas.login("http://nas.test:5055","fixture","synthetic-password");
 await expect(nas.installDockerApp({appName:"Halo",version:101,dataPath:"/sata1/my/data/app",port:58080,autoStart:false,settings:{docker_halo_dbpassword:"SyntheticStrong123"}})).rejects.toThrow();expect(calls.some(c=>c.path.endsWith("/pkg/preinstall"))).toBe(false);
});
