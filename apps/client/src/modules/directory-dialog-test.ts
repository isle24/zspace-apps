import { afterAll, beforeAll } from "vitest";

// jsdom lacks these platform methods. Only model open/closed state; this does
// NOT emulate the native top layer, inert background, Tab navigation or focus
// restoration. Browser acceptance must verify those platform behaviors.
export function installMissingDialogMethods() {
  const prototype = HTMLDialogElement.prototype;
  const added: ("showModal" | "close")[] = [];
  beforeAll(() => {
    if (typeof prototype.showModal !== "function") {
      Object.defineProperty(prototype, "showModal", { configurable: true, writable: true,
        value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
      added.push("showModal");
    }
    if (typeof prototype.close !== "function") {
      Object.defineProperty(prototype, "close", { configurable: true, writable: true,
        value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
      added.push("close");
    }
  });
  afterAll(() => { for (const method of added) Reflect.deleteProperty(prototype, method); });
}
