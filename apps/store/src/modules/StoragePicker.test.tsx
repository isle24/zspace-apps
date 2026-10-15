import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StoragePicker, type StorageCandidate } from "./StoragePicker";
import { api } from "../api/client";
const ssd: StorageCandidate = {
  path: "/ssd",
  mountPoint: "/ssd",
  source: "/dev/sda1",
  filesystem: "ext4",
  identity: "disk-a",
  volumeType: "ssd",
  freeBytes: 400e9,
  totalBytes: 500e9,
  systemDisk: false,
  verifiedDataPool: true,
  installAllowed: true,
  reason: "已验证数据盘",
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  api.storeSession = "";
});
it("blocks system disks and unsafe Docker storage while showing real disk details", async () => {
  api.storeSession = "synthetic";
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              items: [
                {
                  ...ssd,
                  path: "/system",
                  systemDisk: true,
                  installAllowed: false,
                  reason: "系统盘禁止使用",
                },
                ssd,
              ],
              dockerStorage: {
                ...ssd,
                path: "/var/lib/docker",
                systemDisk: true,
                installAllowed: false,
              },
              dockerStorageSafe: false,
              message: "Docker 位于系统盘",
            },
          }),
        ),
      ),
  );
  const safety = vi.fn();
  render(
    <StoragePicker
      roots={[]}
      rootId=""
      onSelect={() => {}}
      onRegistered={() => {}}
      onSafety={safety}
    />,
  );
  expect(
    await screen.findByRole("button", { name: /系统盘禁止使用/ }),
  ).toBeDisabled();
  expect(screen.getAllByText(/dev\/sda1/).length).toBeGreaterThan(0);
  expect(screen.getByText("Docker 位于系统盘")).toBeInTheDocument();
  expect(safety).toHaveBeenLastCalledWith(false);
});
it("registers only the exact user supplied existing dedicated directory", async () => {
  api.storeSession = "synthetic";
  const fetcher = vi.fn(
    async (input: string, init: RequestInit) =>
      new Response(
        JSON.stringify({
          ok: true,
          data: String(input).endsWith("/storage")
            ? {
                items: [ssd],
                dockerStorage: ssd,
                dockerStorageSafe: true,
                message: "",
              }
            : {
                id: "root-new",
                name: "SSD应用",
                path: "/ssd/space-apps",
                roles: ["data"],
                storage: ssd,
              },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const selected = vi.fn();
  render(
    <StoragePicker
      roots={[]}
      rootId=""
      onSelect={selected}
      onRegistered={() => {}}
      onSafety={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /SSD ·/ }));
  fireEvent.change(
    screen.getByRole("textbox", { name: /应用专用目录的绝对路径/ }),
    { target: { value: "/ssd/space-apps" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "添加已有目录" }));
  await waitFor(() => expect(selected).toHaveBeenCalledWith("root-new"));
  const call = fetcher.mock.calls.find((c) => String(c[0]).endsWith("/roots"));
  expect(JSON.parse(String(call?.[1].body)).path).toBe("/ssd/space-apps");
});
it("fills the exact discovered directory so it can be added without guessing a path", async () => {
  api.storeSession = "synthetic";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ok:true,data:{items:[ssd],dockerStorage:ssd,dockerStorageSafe:true,message:""}}))));
  render(<StoragePicker roots={[]} rootId="" onSelect={()=>{}} onRegistered={()=>{}} onSafety={()=>{}}/>);
  fireEvent.click(await screen.findByRole("button", {name:/SSD ·/}));
  expect(screen.getByRole("textbox", {name:/专用目录.*绝对路径/})).toHaveValue("/ssd");
});
it("allows manual creation when automatic discovery fails and ends the checking message", async () => {
  api.storeSession = "synthetic";
  const fetcher=vi.fn(async (input:string,init:RequestInit) => {
    if(String(input).endsWith("/storage")) throw Error("discovery unavailable");
    return new Response(JSON.stringify({ok:true,data:{id:"new",path:"/ssd/apps",roles:["data"],storage:ssd}}));
  });
  vi.stubGlobal("fetch",fetcher);
  const selected=vi.fn();
  render(<StoragePicker roots={[]} rootId="" onSelect={selected} onRegistered={()=>{}} onSafety={()=>{}}/>);
  fireEvent.change(screen.getByRole("textbox", {name:/专用目录.*绝对路径/}), {target:{value:"/ssd/apps"}});
  fireEvent.click(screen.getByRole("checkbox", {name:/创建新.*目录/}));
  fireEvent.click(screen.getByRole("button", {name:"创建并添加目录"}));
  await waitFor(()=>expect(selected).toHaveBeenCalledWith("new"));
  const call=fetcher.mock.calls.find(c=>String(c[0]).endsWith("/roots"));
  expect(JSON.parse(String(call?.[1].body))).toMatchObject({path:"/ssd/apps",create:true});
  expect(screen.queryByText("正在检查存储安全状态")).not.toBeInTheDocument();
});

it('keeps discovery, directory selection, registration and retry from submitting the install form', async () => {
  api.storeSession = 'synthetic';
  let unavailable = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input).endsWith('/storage')) {
      if (unavailable) throw Error('offline');
      return new Response(JSON.stringify({ok:true,data:{items:[ssd],dockerStorage:ssd,dockerStorageSafe:true,message:''}}));
    }
    return new Response(JSON.stringify({ok:true,data:{id:'new',path:'/ssd/apps',roles:['data'],storage:ssd}}));
  }));
  const submit = vi.fn(), selected = vi.fn();
  render(<form onSubmit={event => { event.preventDefault(); submit(); }}><StoragePicker roots={[]} rootId="" onSelect={selected} onRegistered={()=>{}} onSafety={()=>{}} /></form>);
  fireEvent.click(await screen.findByRole('button', {name:/SSD ·/}));
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name:'添加已有目录'}));
  await waitFor(()=>expect(selected).toHaveBeenCalledWith('new'));
  expect(submit).not.toHaveBeenCalled();
  unavailable = true;
  fireEvent.click(screen.getByRole('button', {name:'重新检测存储设备'}));
  expect(submit).not.toHaveBeenCalled();
  const retry = await screen.findByRole('button', {name:'重新读取'});
  unavailable = false;
  fireEvent.click(retry);
  await screen.findByRole('button', {name:/SSD ·/});
  expect(submit).not.toHaveBeenCalled();
});
