import { useState, type ReactNode } from "react";
import { isNative, message } from "../api/client";
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const [error, setError] = useState("");
  return (
    <>
      <a
        className={className}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={async (e) => {
          if (isNative()) {
            e.preventDefault();
            setError("");
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("open_external", { url: href });
            } catch (e) {
              setError(message(e));
            }
          }
        }}
      >
        {children}
      </a>
      {error && (
        <span role="alert" className="error-text">
          {error}
        </span>
      )}
    </>
  );
}
