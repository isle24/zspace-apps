import { useState } from "react";
import { Pulse, Cube, FilmSlate, FolderSimple, ImageSquare, MusicNote } from "@phosphor-icons/react";

/** 自带真实 logo 的商店应用（其余用语义字形，避免出现破图）。 */
const artwork: Record<string, string> = {
 nasreader:"/app-icons/nasreader.svg",
 datatotal:"/app-icons/datatotal.svg",
  "uptime-kuma": "/app-icons/uptime-kuma.svg",
  navidrome: "/app-icons/navidrome.png",
};
/** 商店目录里的 icon 字段是语义名而不是 URL，这里逐名映射到字形。 */
const glyphs: Record<string, typeof Cube> = {
  activity: Pulse,
  music: MusicNote,
  film: FilmSlate,
  image: ImageSquare,
  "folder-sync": FolderSimple,
};

export function AppArtwork({ appId, icon }: { appId: string; icon?: string }) {
  const [failed, setFailed] = useState(false);
  const source = Object.hasOwn(artwork, appId) ? artwork[appId] : undefined;
  const Glyph = typeof icon === "string" && Object.hasOwn(glyphs, icon) ? glyphs[icon] : Cube;
  // 图片加载失败时退回字形：目录新增应用时不会出现破图
  if (source && !failed)
    return (
      <img
        className="application-logo"
        src={source}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  return <Glyph weight="duotone" aria-hidden="true" />;
}
