/*
 * 应用商店窗口 = **极空间官方商店**（设备自己登记的应用与容器）。
 *
 * 原先这个窗口里塞了两个来源，用顶部切换区分。用户要求拆开：
 * 官方商店留在「应用商店」，Codex 的第三方商店独立成「空间商店」
 * （见 SpaceStoreWindow.tsx），两个图标分得清清楚楚。
 *
 * 这里只渲染 OfficialStore；空间商店的容器在另一个文件里，互不影响。
 */
import type { Instance } from "./Store";
import { OfficialStore } from "./OfficialStore";

export function StoreWindow({
  onInstances,
}: {
  /* 官方商店没有独立实例概念，保留参数是为了不改变 App.tsx 的调用形状 */
  onInstances?: (items: Instance[]) => void;
}) {
  void onInstances;
  return (
    <div className="store-window">
      <div className="store-body">
        <OfficialStore />
      </div>
    </div>
  );
}
