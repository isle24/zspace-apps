import { Pulse, Cube, FilmSlate, FolderSimple, ImageSquare, MusicNote } from "@phosphor-icons/react";

const artwork: Record<string, string> = {
 nasreader:"/app-icons/nasreader.svg",
 datatotal:"/app-icons/datatotal.svg",
  "uptime-kuma": "/app-icons/uptime-kuma.svg",
  navidrome: "/app-icons/navidrome.png",
  jellyfin: "/app-icons/jellyfin.svg",
  immich: "/app-icons/immich.svg",
  syncthing: "/app-icons/syncthing.svg",
};
const glyphs: Record<string, typeof Cube> = {
  activity: Pulse,
  music: MusicNote,
  film: FilmSlate,
  image: ImageSquare,
  "folder-sync": FolderSimple,
};

export function AppArtwork({ appId, icon }: { appId: string; icon?: string }) {
  const source = Object.hasOwn(artwork, appId) ? artwork[appId] : undefined;
  if (source) return <img className="application-logo" src={source} alt="" referrerPolicy="no-referrer" />;
  const Glyph = typeof icon === "string" && Object.hasOwn(glyphs, icon) ? glyphs[icon] : Cube;
  return <Glyph weight="duotone" aria-hidden="true" />;
}
