import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
// 飞牛 fnOS 皮肤：令牌 → 外壳 → 各应用（按顺序覆盖既有样式）
import "./styles/fnos-theme.css";
import "./styles/fnos-controls.css";
import "./styles/fnos-shell.css";
import "./styles/fnos-media.css";
import "./styles/fnos-player.css";
import "./styles/fnos-files.css";
import "./styles/fnos-store.css";
import "./styles/fnos-system.css";
import "./styles/fnos-widget.css";
import "./styles/fnos-management.css";
import "./styles/fnos-dark.css"; // 深色覆盖必须最后加载
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
