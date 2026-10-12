/** Finite download-only classifications. Never carry upstream values into task rows. */
const labels = {
  DOWNLOAD_DISPOSITION_MISSING: "NAS 未提供下载文件名",
  DOWNLOAD_DISPOSITION_INVALID: "NAS 下载文件名格式无法验证",
  DOWNLOAD_FILENAME_MISMATCH: "NAS 返回的下载文件名与所选文件不一致",
  DOWNLOAD_ENCODING: "NAS 文件响应使用了不支持的编码",
  DOWNLOAD_LENGTH_INVALID: "NAS 文件长度格式无法验证",
  DOWNLOAD_RANGE_INVALID: "NAS 未提供可验证的完整文件范围",
  DOWNLOAD_SIZE_MISMATCH: "NAS 返回的文件长度与预期不一致",
  DOWNLOAD_HTTP: "NAS 文件请求未成功",
  DOWNLOAD_TRANSPORT: "NAS 文件传输已中断",
  DOWNLOAD_BODY_EMPTY: "NAS 未返回预期的文件内容",
} as const;
export type DownloadFailureDiagnostic = keyof typeof labels;
export function safeDownloadDiagnostic(value: unknown): DownloadFailureDiagnostic | undefined {
  return typeof value === "string" && Object.hasOwn(labels, value) ? value as DownloadFailureDiagnostic : undefined;
}
export function downloadDiagnosticLabel(value: unknown): string | undefined {
  const diagnostic = safeDownloadDiagnostic(value);
  return diagnostic ? labels[diagnostic] : undefined;
}
export function safeOfficialDownloadDiagnostic(code: string, value: unknown): DownloadFailureDiagnostic | undefined {
  const diagnostic = safeDownloadDiagnostic(value);
  if (code === "INVALID_DOWNLOAD_RESPONSE" && diagnostic && !["DOWNLOAD_HTTP", "DOWNLOAD_TRANSPORT"].includes(diagnostic)) return diagnostic;
  if (code === "DOWNLOAD_HTTP_ERROR" && diagnostic === "DOWNLOAD_HTTP") return diagnostic;
  if (code === "DOWNLOAD_NETWORK" && diagnostic === "DOWNLOAD_TRANSPORT") return diagnostic;
}
