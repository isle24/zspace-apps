import type { ReactNode } from "react";
import { createPortal } from "react-dom";
/** Modal controls must remain outside the desktop window's clipping boundary. */
export function ManagementOverlay({ children }: { children: ReactNode }) {
  return createPortal(<div className="management-overlay">{children}</div>, document.body);
}
