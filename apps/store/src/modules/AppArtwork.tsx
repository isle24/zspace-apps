import { Pulse, Cube, FilmSlate, FolderSimple, ImageSquare, MusicNote } from "@phosphor-icons/react";
import { useState } from "react";
import { cloudArtworkSources } from "../api/cloud-artwork";

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
  const sources = Object.hasOwn(artwork, appId) ? [artwork[appId]] : cloudArtworkSources(icon || "");
  const key = sources.join("|");
  const [attempt, setAttempt] = useState({ key, index: 0 });
  const index = attempt.key === key ? attempt.index : 0;
  const source = sources[index];
  if (source) return <img className="application-logo" src={source} alt="" referrerPolicy="no-referrer" onError={() => setAttempt({ key, index: index + 1 })} />;
  const Glyph = typeof icon === "string" && Object.hasOwn(glyphs, icon) ? glyphs[icon] : Cube;
  return <Glyph weight="duotone" aria-hidden="true" />;
}
