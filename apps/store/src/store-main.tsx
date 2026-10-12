import React from "react";
import { installStoreHostBridge } from "./store-host-bridge";
installStoreHostBridge();
import ReactDOM from "react-dom/client";
import { StandaloneStore } from "./StandaloneStore";
import "./styles.css";
// 飞牛 fnOS 皮肤：独立商店页与客户端应用商店共用同一套令牌与商店皮肤
import "./styles/fnos-theme.css";
import "./styles/fnos-controls.css";
import "./styles/fnos-store.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StandaloneStore />
  </React.StrictMode>,
);
