/*
 * 空间商店窗口 = Codex 的独立第三方商店（`modules/Store.tsx`）。
 *
 * 用户要求把它和**极空间官方商店**分成两个独立的应用/图标：
 *   - 应用商店（appId `store`）→ 设备自己的应用，见 StoreWindow.tsx
 *   - 空间商店（appId `space-store`）→ 本文件
 *
 * 商店实现本身由 Codex 负责，这里**只做容器**：按需加载 + 实例回调转发。
 * 按需加载是必要的 —— 商店组件有 465 KB（gzip 138 KB），
 * 不该让"只想看文件"的用户也下载它。
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { api, isNative } from "../api/client";
import { StoreFrame } from "./StoreFrame";
import type { Instance } from "./Store";

const Store = lazy(() => import("./Store").then((mod) => ({ default: mod.Store })));

export function SpaceStoreWindow({
  onInstances,
}: {
  onInstances: (items: Instance[]) => void;
}) {
  const [session,setSession]=useState(api.storeSession);
  const [ready,setReady]=useState(!isNative() || !!api.storeAddress || !api.nasSession);
  useEffect(()=>{
    const update=()=>setSession(api.storeSession);window.addEventListener("space-store-session",update);
    let active=true;
    if(isNative() && !api.storeAddress && api.nas.session()) {
      void api.setStoreAddress(api.nas.session()!.baseUrl).finally(()=>{if(active)setReady(true)});
    }
    return()=>{active=false;window.removeEventListener("space-store-session",update)};
  },[]);
  return (
    <div className="store-window">
      <div className="store-body">
        <Suspense
          fallback={
            <p className="store-loading" role="status">
              正在载入空间商店…
            </p>
          }
        >
          {!ready ? <p role="status">正在连接当前 NAS 的商店…</p> : session ? <StoreFrame key={session} /> : <Store embedded initialTab="catalog" onInstances={onInstances} />}
        </Suspense>
      </div>
    </div>
  );
}
