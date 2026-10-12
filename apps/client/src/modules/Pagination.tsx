import { useEffect, useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import type { ReadRequest } from "../api/operations";
export const PAGE_SIZE = 20;
export function canPage(operation: string) {
  return [
    "files.list",
    "files.search",
    "files.recent",
    "photos.timeline",
    "photos.feeds",
    "video.list",
    "music.songs",
    "music.albums",
    "music.playlists",
    "downloads.list",
  ].includes(operation);
}
export function pagedRequest(request: ReadRequest, page: number): ReadRequest {
  return canPage(request.operation)
    ? { ...request, params: { ...request.params, page, pageSize: PAGE_SIZE } }
    : request;
}
export function usePage(scope: unknown[]) {
  const key = JSON.stringify(scope);
  const [state, setState] = useState({ key, page: 1 });
  const page = state.key === key ? state.page : 1;
  useEffect(() => {
    if (state.key !== key) setState({ key, page: 1 });
  }, [key]);
  return {
    page,
    setPage: (value: number) => setState({ key, page: Math.max(1, value) }),
  };
}
export function Pagination({
  page,
  total,
  count,
  onPage,
  loading = false,
}: {
  page: number;
  total?: number;
  count: number;
  onPage: (page: number) => void;
  loading?: boolean;
}) {
  const known =
    typeof total === "number" && Number.isFinite(total) && total >= 0;
  const pages = known ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : undefined;
  const hasNext = known ? page * PAGE_SIZE < total : count >= PAGE_SIZE;
  return (
    <nav className="pagination" aria-label="列表分页">
      <span>
        第 {page} 页{pages ? ` / ${pages} 页` : ""} · 共 {known ? total : "—"}{" "}
        项
      </span>
      <div>
        <button
          className="secondary"
          disabled={loading || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <CaretLeft />
          上一页
        </button>
        <button
          className="secondary"
          disabled={loading || !hasNext}
          onClick={() => onPage(page + 1)}
        >
          下一页
          <CaretRight />
        </button>
      </div>
    </nav>
  );
}
