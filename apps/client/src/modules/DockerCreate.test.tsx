import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../api/client";
import { DockerCreate } from "./DockerCreate";
afterEach(()=>{cleanup();vi.restoreAllMocks()});
it("creates from a selected local image and uses form values",async()=>{
 const id="a".repeat(64),image="sha256:"+"b".repeat(64);
 const call=vi.spyOn(api,"docker").mockImplementation(async(endpoint,body)=>{
  if(endpoint==="images")return {images:[{id:image,tags:["reader:1"]}]} as never;
  if(endpoint==="create"){expect(body).toMatchObject({name:"review",imageId:image,ports:[{host:58080,container:8080,protocol:"tcp"}]});return {id,state:"created"} as never}
  return {id,state:"running"} as never;
 });const finished=vi.fn();render(<DockerCreate close={()=>{}} finished={finished}/>);
 fireEvent.change(await screen.findByLabelText("容器名称"),{target:{value:"review"}});fireEvent.change(await screen.findByLabelText("本地镜像"),{target:{value:image}});
 fireEvent.click(screen.getByRole("button",{name:"添加端口映射"}));fireEvent.change(screen.getByLabelText("主机端口 1"),{target:{value:"58080"}});fireEvent.change(screen.getByLabelText("容器端口 1"),{target:{value:"8080"}});
 fireEvent.click(screen.getByRole("button",{name:"创建并启动"}));expect(await screen.findByText("容器已创建，运行状态已确认。")).toBeInTheDocument();expect(finished).toHaveBeenCalledOnce();expect(call.mock.calls.filter(c=>c[0]==="create")).toHaveLength(1);
});
it("refreshes the parent list only after startup has been confirmed",async()=>{
 const image='sha256:'+'b'.repeat(64),id='a'.repeat(64);let finishStart!:()=>void;
 const start=new Promise<void>(resolve=>{finishStart=resolve});
 const call=vi.spyOn(api,'docker').mockImplementation(async(endpoint)=>{
  if(endpoint==='images')return {images:[{id:image,tags:['redis:fixture']}]} as never;
  if(endpoint==='create')return {id,state:'created'} as never;
  await start;return {id,state:'running'} as never;
 });const finished=vi.fn();render(<DockerCreate close={()=>{}} finished={finished}/>);
 fireEvent.change(await screen.findByLabelText('容器名称'),{target:{value:'review'}});fireEvent.change(screen.getByLabelText('本地镜像'),{target:{value:image}});fireEvent.click(screen.getByRole('button',{name:'创建并启动'}));
 await screen.findByText('正在创建并确认…');await new Promise(resolve=>setTimeout(resolve,20));expect(call.mock.calls.some(c=>c[0]==='control')).toBe(true);expect(finished).not.toHaveBeenCalled();finishStart();expect(await screen.findByText('容器已创建，运行状态已确认。')).toBeInTheDocument();expect(finished).toHaveBeenCalledOnce();
});

it("labels untagged images without displaying an ID as the application name",async()=>{
 const image="sha256:"+"b".repeat(64);vi.spyOn(api,"docker").mockResolvedValue({images:[{id:image,tags:[],size:1024,created:1750000000}]} as never);
 render(<DockerCreate close={()=>{}} finished={()=>{}}/>);expect(await screen.findByRole("option",{name:/未命名镜像/})).not.toHaveTextContent("bbbbbbbb");
});
