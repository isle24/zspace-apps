import { describe, expect, it } from "vitest";
import { OfficialNas } from "./official-nas";
import { officialFixture, officialJson } from "./direct-test-fixture";
async function session(read: Parameters<typeof officialFixture>[0]) {
  const nas = new OfficialNas(officialFixture(read));
  await nas.login("http://nas.test:5055", "fixture", "synthetic-password");
  return nas;
}
describe("official application management", () => {
  it("reads the native catalogue without requesting the Docker list twice", async () => {
    const paths: string[] = [];
    const nas = await session((url) => {
      paths.push(url.pathname);
      return officialJson({ code: 200, data: { list: [{ app_name: "backup", installed: 1 }] } });
    });
    await nas.read("apps.native");
    expect(paths.filter(p => p.includes("AppStore"))).toEqual(["/AppStore/v1/list"]);
  });
  it("uses the observed package identity and source and reads back a start", async () => {
    const paths: string[] = [];
    let running = false;
    const nas = await session((url, init) => {
      if (url.pathname.includes("AppStore")) paths.push(url.pathname);
      if (url.pathname.endsWith("/list")) return officialJson({ code: 200, data: { list: [{ app_name: "komga", is_docker: 1, installed: 1, toggleable: 1, status: running ? "running" : "stop" }] } });
      if (url.pathname.endsWith("/pkg/start")) {
        expect(new URLSearchParams(String(init.body)).get("app_name")).toBe("komga");
        running = true;
      }
      return officialJson({ code: 200, data: {} });
    });
    await nas.controlApp({ appName: "komga", docker: true, action: "start" });
    expect(paths).toEqual(["/zdocker/AppStore/v1/list", "/zdocker/AppStore/v1/pkg/start", "/zdocker/AppStore/v1/list"]);
  });
  it("does not start uninstalled or untoggleable applications", async () => {
    const writes: string[] = [];
    const nas = await session((url) => {
      if (url.pathname.includes("pkg")) writes.push(url.pathname);
      return officialJson({ code: 200, data: { list: [{ app_name: "docker", installed: 1, toggleable: 0, status: "running" }] } });
    });
    await expect(nas.controlApp({ appName: "docker", docker: true, action: "stop" })).rejects.toThrow();
    expect(writes).toEqual([]);
  });
});

describe("personal settings protocol",()=>{
 it("maps the measured checksum setting and verifies the readback",async()=>{
  let checksum=0;const writes:URLSearchParams[]=[];
  const nas=await session((url,init)=>{
   if(url.pathname==="/setting/change"){const f=new URLSearchParams(String(init.body));writes.push(f);checksum=Number(f.get("file_hash_check"))}
   return officialJson({code:200,data:{file:{hash_check:checksum}}});
  });
  await nas.saveSetting("file_hash_check",1);expect(writes).toHaveLength(1);expect(writes[0].get("file_hash_check")).toBe("1");
 });
 it("refuses unknown settings and unsupported enum values",async()=>{
  const nas=await session(()=>officialJson({code:200,data:{}}));
  await expect(nas.saveSetting("trust_local" as never,"yes")).rejects.toThrow();
  await expect(nas.saveSetting("disk_stats_sec",60)).rejects.toThrow();
 });
});

describe("Docker adapter transport",()=>{
 it("binds requests to the selected NAS and never requests an anonymous local origin",async()=>{
  const requests:string[]=[];
  const nas=await session((url,init)=>{
   if(url.pathname.startsWith("/api/docker/")){requests.push(url.origin+url.pathname);expect(new Headers(init.headers).get("X-Space-Request")).toBe("1");return officialJson({containers:[]})}
   return officialJson({code:200,data:{list:[]}});
  });
  expect(await nas.docker("containers")).toEqual({containers:[]});expect(requests).toEqual(["http://nas.test:5055/api/docker/containers"]);
 });
});

describe("native installation",()=>{
 it("checks dependency and current disk before using the observed mp field",async()=>{
  const calls:string[]=[];let installed=false;
  const nas=await session((url,init)=>{
   calls.push(url.pathname);
   if(url.pathname==="/AppStore/v1/list")return officialJson({code:200,data:{list:[{app_name:"backup",installed:installed?1:0,status:installed?"running":"stop",latest_version:{version:{version_int:101}}}]}});
   if(url.pathname.endsWith("/disks"))return officialJson({code:200,data:{list:[{mp:"/data_n001",name:"nvme1",free:5000,size:10000}]}});
   if(url.pathname.endsWith("/depend/check"))return officialJson({code:200,data:{apps:[]}});
   if(url.pathname.endsWith("/install")){const form=new URLSearchParams(String(init.body));expect(form.get("mp")).toBe("/data_n001");expect(form.has("save_to")).toBe(false);expect(form.get("version_int")).toBe("101");installed=true}
   return officialJson({code:200,data:{}});
  });
  const plan=await nas.prepareNativeApp("backup");expect(plan.disks[0].mp).toBe("/data_n001");
  const result=await nas.installNativeApp({appName:"backup",version:101,mp:"/data_n001"});expect(result.installed).toBe(true);expect(calls.filter(p=>p.endsWith("/install"))).toHaveLength(1);
 });
 it("blocks dependency requirements and refuses a stale version",async()=>{
  const nas=await session(url=>officialJson({code:200,data:url.pathname.endsWith("/list")?{list:[{app_name:"backup",installed:0,latest_version:{version:{version_int:102}}}]}:url.pathname.endsWith("/disks")?{list:[]}:{sys_ver:"new version required",apps:[]}}));
  await expect(nas.prepareNativeApp("backup")).rejects.toThrow();
 });
});

it("sends Compose creation as an authenticated administrator write",async()=>{let seen=false;const nas=await session((url,init)=>{if(url.pathname==="/api/docker/compose-create"){seen=true;expect(init.method).toBe("POST");expect(new Headers(init.headers).get("X-Space-Request")).toBe("1");return new Response(JSON.stringify({plan:{name:"review",services:[]}}),{status:200})}return officialJson({code:200,data:{}})});await nas.docker("compose-create",{name:"review",yaml:"services: {}",preview:true});expect(seen).toBe(true)});
