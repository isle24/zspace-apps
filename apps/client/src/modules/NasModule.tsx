import { Files } from "./Files";
import { ImagePreview } from "./ImagePreview";
import { VideoDetails } from "./VideoDetails";
import { Pagination, pagedRequest, usePage, canPage, PAGE_SIZE } from "./Pagination";
import { useEffect, useState } from "react";
import { AppIcon, apps } from "../desktop/apps";
import {
  ArrowLeft,
  CaretRight,
  ArrowClockwise,
  Warning,
  Play,
  Pause,
  MusicNote,
  FilmSlate,
  ImageSquare,
  HardDrives,
  Gear,
  Globe,
  DownloadSimple,
} from "@phosphor-icons/react";
import {
  api,
  normalizeCollection,
  type Item,
  safeMediaUrl,
} from "../api/client";
import { aggregateVideoList, mediaRequest } from "../api/operations";
import { DataValues, formatBytes, Search, Status, useResource } from "./common";
import { StorageView, SystemOverview } from "./SystemOverview";
import { NetworkView, SettingsView } from "./SystemNetwork";
import { DockerView } from "./DockerView";
import { PhotoViewer } from "./PhotoViewer";
import { RemoteWindow } from "./RemoteWindow";
import { DownloadsWindow } from "./DownloadsWindow";
import { MediaWindow, type MediaSelection } from "./MediaWindow";
import { HelpWindow, SystemWindow } from "./SystemWindow";
import { NotesWindow } from "./NotesWindow";
import { RecycleWindow } from "./RecycleWindow";
export type { MediaSelection };
export function NasModule({
  id,
  connected,
  onPlay,
}: {
  id: string;
  connected: boolean;
  onPlay: (s: MediaSelection) => void;
}) {
  if (id === "files") return <Files connected={connected} />;
  if (id === "notes") return <NotesWindow connected={connected} />;
  if (id === "recycle") return <RecycleWindow connected={connected} />;
  if (["photos", "video", "music"].includes(id))
    return <MediaWindow id={id} connected={connected} onPlay={onPlay} />;
  if (id === "downloads") return <DownloadsWindow connected={connected} />;
  if (id === "remote") return <RemoteWindow connected={connected} />;
  if (["settings", "storage", "containers"].includes(id))
    return <SystemWindow id={id} connected={connected} />;
  return <HelpWindow />;
}
