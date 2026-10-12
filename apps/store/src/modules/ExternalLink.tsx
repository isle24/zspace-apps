import type { ReactNode } from "react";
export function ExternalLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return <a href={href} className={className} target="_blank" rel="noopener noreferrer">{children}</a>;
}
