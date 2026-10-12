import {
  FolderOpen,
  Images,
  FilmSlate,
  MusicNotes,
  DownloadSimple,
  ShoppingBag,
  SlidersHorizontal,
  ChartBar,
  HardDrives,
  Cube,
  GlobeHemisphereWest,
  Question,
  type Icon,
  Package,
  NotePencil,
  Trash,
} from "@phosphor-icons/react";
export type AppDefinition = {
  id: string;
  name: string;
  short: string;
  color: string;
  icon: Icon;
  /** 飞牛 fnOS 真实应用图标（取自用户本机 fnOS 的 /static/app/icons/<id>/icon.png） */
  iconSrc?: string;
};
export const apps: AppDefinition[] = [
  {id: "notes", name: "记事本", short: "记事本", color: "gold", icon: NotePencil},
  {id: "recycle", name: "回收站", short: "回收站", color: "slate", icon: Trash},
  {
    id: "files",
    name: "文件管理",
    short: "文件",
    color: "gold",
    icon: FolderOpen,
    iconSrc: "/app-icons/files.png",
  },
  {
    id: "photos",
    name: "相册",
    short: "相册",
    color: "cyan",
    icon: Images,
    iconSrc: "/app-icons/photos.png",
  },
  {
    id: "video",
    name: "影视中心",
    short: "影视",
    color: "purple",
    icon: FilmSlate,
    iconSrc: "/app-icons/video.png",
  },
  {
    id: "music",
    name: "音乐",
    short: "音乐",
    color: "pink",
    icon: MusicNotes,
    iconSrc: "/app-icons/music.png",
  },
  {
    id: "downloads",
    name: "下载中心",
    short: "下载",
    color: "green",
    icon: DownloadSimple,
    iconSrc: "/app-icons/downloads.png",
  },
  {
    id: "store",
    name: "应用商店",
    short: "商店",
    color: "blue",
    icon: ShoppingBag,
    iconSrc: "/app-icons/store.png",
  },
  {
    /* 与「应用商店」并列的第二个商店：Codex 的第三方独立商店，图标是自绘的 */
    id: "space-store",
    name: "空间商店",
    short: "空间商店",
    color: "purple",
    icon: Package,
    iconSrc: "/app-icons/space-store.png",
  },
  {
    id: "settings",
    name: "控制面板",
    short: "设置",
    color: "silver",
    icon: SlidersHorizontal,
    iconSrc: "/app-icons/settings.png",
  },
  {
    id: "tasks",
    name: "任务中心",
    short: "任务",
    color: "blue",
    icon: ChartBar,
    iconSrc: "/app-icons/tasks.png",
  },
  {
    id: "storage",
    name: "存储管理",
    short: "存储",
    color: "slate",
    icon: HardDrives,
    iconSrc: "/app-icons/storage.png",
  },
  {
    id: "containers",
    name: "Docker",
    short: "Docker",
    color: "cyan",
    icon: Cube,
    iconSrc: "/app-icons/docker.png",
  },
  {
    id: "remote",
    name: "远程访问",
    short: "远程",
    color: "blue",
    icon: GlobeHemisphereWest,
    iconSrc: "/app-icons/remote.png",
  },
  {
    id: "help",
    name: "使用帮助",
    short: "帮助",
    color: "silver",
    icon: Question,
    iconSrc: "/app-icons/help.png",
  },
];
export function AppIcon({
  app,
  small = false,
}: {
  app: AppDefinition;
  small?: boolean;
}) {
  const Icon = app.icon;
  return (
    <span
      aria-hidden="true"
      className={`app-icon ${app.color} ${small ? "small" : ""}${app.iconSrc ? " with-art" : ""}`}
    >
      {app.iconSrc ? (
        <img src={app.iconSrc} alt="" draggable={false} />
      ) : (
        <Icon weight="duotone" />
      )}
    </span>
  );
}
