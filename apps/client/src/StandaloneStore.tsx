import { Store } from "./modules/Store";
import { ShoppingBag, ShieldCheck } from "@phosphor-icons/react";
const ignoreInstances = () => {};
export function StandaloneStore() {
  return (
    <main className="standalone-store">
      <header className="standalone-brand">
        <ShoppingBag weight="duotone" />
        <div>
          <strong>空间应用商店</strong>
          <p>独立的第三方应用服务</p>
        </div>
        <span>
          <ShieldCheck />
          独立管理员账号
        </span>
      </header>
      <div className="standalone-intro">
        <span className="eyebrow">YOUR APPS. YOUR STORAGE.</span>
        <h1>让自己的服务器，多一些可能</h1>
        <p>
          登录后浏览、安装和管理应用。支持已配置的 NAS 管理员身份或独立商店账号；安装目标以服务的配置和检测结果为准。
        </p>
      </div>
      <section className="standalone-content">
        <Store onInstances={ignoreInstances} />
      </section>
      <footer className="standalone-footer">
        空间应用商店 · 现有媒体只读挂载，应用数据独立保存
      </footer>
    </main>
  );
}
