package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

func (s *Service) readRoots() ([]StorageRoot, error) {
	rows, err := s.db.Query(`SELECT body FROM storage_roots ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StorageRoot{}
	for rows.Next() {
		var b string
		var r StorageRoot
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(b), &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *Service) root(id string) (StorageRoot, error) {
	var b string
	var root StorageRoot
	err := s.db.QueryRow(`SELECT body FROM storage_roots WHERE id=?`, id).Scan(&b)
	if err == nil {
		err = json.Unmarshal([]byte(b), &root)
	}
	return root, err
}
func (s *Service) storage(w http.ResponseWriter, r *http.Request) {
	e, ok := s.engine.(storageInspector)
	if !ok {
		fail(w, 503, "storage_discovery_unavailable", "执行引擎缺少可靠的卷与Docker缓存位置发现能力。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	items, err := e.DiscoverStorage(ctx)
	if err != nil {
		fail(w, 503, "storage_discovery_unavailable", err.Error())
		return
	}
	if roots, readErr := s.readRoots(); readErr == nil {
		seen := map[string]bool{}
		for _, item := range items {
			seen[item.Path] = true
		}
		for _, root := range roots {
			if !seen[root.Path] {
				if candidate, inspectErr := e.InspectStorage(ctx, root.Path); inspectErr == nil {
					items = append(items, candidate)
					seen[root.Path] = true
				}
			}
		}
	}
	docker, err := e.DockerStorage(ctx)
	msg := "请选择SSD上的专用既有目录，或明确核验的NAS虚拟数据池；镜像缓存也必须在非系统SSD/HDD上。"
	var d any = docker
	safe := err == nil && safeDockerStorage(docker)
	if err != nil {
		d = nil
		msg = "Docker镜像缓存位置无法可靠核验，安装已阻止。"
	} else if !safe {
		msg = "Docker镜像缓存位于系统盘或介质未知，安装已阻止；请先由管理员调整Docker数据位置。"
	}
	s.requestRespond(w, r, 200, map[string]any{"items": items, "dockerStorage": d, "dockerStorageSafe": safe, "message": msg})
}
func (s *Service) registerRoot(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !s.requestAuthorized(w, r) {
		return
	}
	if len(in.Name) > 128 || !filepath.IsAbs(in.Path) || filepath.Clean(in.Path) != in.Path || strings.ContainsAny(in.Path, "\x00\r\n,") {
		fail(w, 400, "unsafe_storage_root", "请输入规范绝对目录；不会自动创建或修改该目录。")
		return
	}
	e, ok := s.engine.(storageInspector)
	if !ok {
		fail(w, 503, "storage_discovery_unavailable", "引擎缺少卷发现能力。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	candidate, err := e.InspectStorage(ctx, in.Path)
	if err != nil || (!safeDataStorage(candidate) && !safeMediaStorage(candidate)) {
		msg := "所选路径不存在、属于系统盘或不是可确认的数据卷。"
		if err == nil && candidate.Reason != "" {
			msg = candidate.Reason
		}
		fail(w, 400, "unsafe_storage_root", msg)
		return
	}
	roots, err := s.readRoots()
	if err != nil {
		fail(w, 500, "storage_failed", "无法读取登记目录。")
		return
	}
	for _, root := range roots {
		if root.Path == in.Path {
			if root.Storage.Identity != "" && root.Storage.Identity != candidate.Identity {
				fail(w, 409, "storage_identity_changed", "登记目录的设备、inode或卷身份已变化，拒绝接管。")
				return
			}
			root.Storage = candidate
			root.Roles = storageRoles(candidate)
			b, _ := json.Marshal(root)
			mutationErr, authorized := s.requestDBMutation(w, r, `UPDATE storage_roots SET body=? WHERE id=?`, string(b), root.ID)
			if !authorized {
				return
			}
			if mutationErr != nil {
				fail(w, 500, "storage_failed", "无法刷新登记目录。")
				return
			}
			s.requestRespond(w, r, 201, root)
			return
		}
	}
	if in.Name == "" {
		in.Name = filepath.Base(in.Path)
	}
	root := StorageRoot{ID: randomID(), Name: in.Name, Path: in.Path, Roles: storageRoles(candidate), Storage: candidate}
	b, _ := json.Marshal(root)
	mutationErr, authorized := s.requestDBMutation(w, r, `INSERT INTO storage_roots(id,path,body)VALUES(?,?,?)`, root.ID, root.Path, string(b))
	if !authorized {
		return
	}
	if mutationErr != nil {
		fail(w, 409, "storage_registration_conflict", "目录已有登记，请刷新目录列表。")
		return
	}
	s.requestRespond(w, r, 201, root)
}
func safeDockerStorage(d StorageCandidate) bool {
	return d.Identity != "" && !d.SystemDisk && (d.VolumeType == "ssd" || d.VolumeType == "hdd") && d.InstallAllowed
}
func safeDataStorage(d StorageCandidate) bool {
	return d.Identity != "" && !d.SystemDisk && d.InstallAllowed && ((d.VolumeType == "ssd" || d.VolumeType == "hdd") || (d.VerifiedDataPool && d.VolumeType == "virtual"))
}
func safeMediaStorage(d StorageCandidate) bool {
	return d.Identity != "" && !d.SystemDisk && d.MediaReadAllowed && ((d.VolumeType == "ssd" || d.VolumeType == "hdd") || (d.VerifiedDataPool && d.VolumeType == "virtual"))
}
func storageRoles(d StorageCandidate) []string {
	roles := []string{}
	if safeDataStorage(d) {
		roles = append(roles, "data")
	}
	if safeMediaStorage(d) {
		roles = append(roles, "mediaReadOnly")
	}
	return roles
}
func (s *Service) checkStorage(ctx context.Context, root StorageRoot) (StorageCandidate, StorageCandidate, error) {
	e, ok := s.engine.(storageInspector)
	if !ok {
		return StorageCandidate{}, StorageCandidate{}, errors.New("执行引擎无法确认卷与Docker镜像缓存位置，拒绝安装。")
	}
	candidate, err := e.InspectStorage(ctx, root.Path)
	if err != nil || !safeDataStorage(candidate) {
		return candidate, StorageCandidate{}, errors.New("用户所选数据目录不在可确认的数据卷上，或目录无法访问。")
	}
	if root.Storage.Identity != "" && root.Storage.Identity != candidate.Identity {
		return candidate, StorageCandidate{}, errors.New("登记目录的设备、inode或卷身份已变化，拒绝接管。")
	}
	docker, err := e.DockerStorage(ctx)
	if err != nil || !safeDockerStorage(docker) {
		return candidate, docker, errors.New("Docker镜像缓存不在可确认的非系统SSD/HDD上，拒绝拉取镜像以保护eMMC。")
	}
	if candidate.FreeBytes < 1<<30 || docker.FreeBytes < 2<<30 {
		return candidate, docker, errors.New("用户数据卷至少需1GiB、Docker镜像卷至少需2GiB可用空间。")
	}
	return candidate, docker, nil
}
func (s *Service) inspectMediaRoot(ctx context.Context, root StorageRoot) (StorageCandidate, error) {
	e, ok := s.engine.(storageInspector)
	if !ok {
		return StorageCandidate{}, errors.New("媒体根缺少真实卷校验能力。")
	}
	c, err := e.InspectStorage(ctx, root.Path)
	if err != nil || !safeMediaStorage(c) {
		return c, errors.New("媒体根须是已确认的非系统数据卷。")
	}
	if root.Storage.Identity != "" && root.Storage.Identity != c.Identity {
		return c, errors.New("已登记媒体根的设备或inode身份已变化。")
	}
	return c, nil
}
func (s *Service) checkMediaPlan(ctx context.Context, p Plan) error {
	if p.MediaPath == "" {
		return nil
	}
	root, err := s.root(p.MediaRootID)
	if err != nil || root.Path != p.MediaRootPath {
		return errors.New("媒体根登记与安装计划不一致。")
	}
	c, err := s.inspectMediaRoot(ctx, root)
	if err != nil {
		return err
	}
	if p.MediaStorageIdentity == "" || c.Identity != p.MediaStorageIdentity {
		return errors.New("媒体根设备、inode或卷身份已改变，拒绝挂载。")
	}
	return s.engine.ValidatePath(ctx, p.MediaRootPath, p.MediaPath, false)
}
func (s *Service) checkInstanceMedia(ctx context.Context, i Instance) error {
	for _, m := range i.Mounts {
		if m.Target != "/music" {
			continue
		}
		e, ok := s.engine.(storageInspector)
		if !ok || i.MediaRootPath == "" || i.MediaStorageIdentity == "" {
			return errors.New("实例媒体根尚无可靠身份，拒绝启动。")
		}
		c, err := e.InspectStorage(ctx, i.MediaRootPath)
		if err != nil || !safeMediaStorage(c) || c.Identity != i.MediaStorageIdentity {
			return errors.New("媒体根身份已改变，拒绝启动。")
		}
		if !m.ReadOnly {
			return errors.New("拒绝可写媒体挂载。")
		}
		return s.engine.ValidatePath(ctx, i.MediaRootPath, m.Source, false)
	}
	return nil
}

// Linux/NAS discovery is read-only. It relies on actual mount + block-device identity,
// never names such as nvme11 for virtual-pool SSD claims.
const storageBodyScript = `
mode=sys.argv[1];requested=sys.argv[2] if len(sys.argv)>2 else ""
try: host_policy=own_storage_policy()
except Exception: sys.exit(3)
def cmd(args):
 if host_policy and args[0]=="findmnt": args=[args[0]]+host_policy["findmnt"]+args[1:]
 if host_policy and args[0]=="docker": args=[args[0]]+host_policy["docker"]+args[1:]
 return subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL)
def flatten(items):
 out=[]
 for x in items:
  out.append(x);out.extend(flatten(x.get("children",[])))
 return out
def mount(path):
 items=flatten(json.loads(cmd(["findmnt","-J","-T",path,"-o","TARGET,SOURCE,FSTYPE,MAJ:MIN,FSROOT"])).get("filesystems",[]))
 if len(items)==1: return items[0]
 # NAS can report lower tmpfs and active kufs at the same target. Verify
 # the actual mounted inode device at each mountpoint rather than taking first.
 matches=[]
 for m in items:
  target=m.get("target","");dev=os.stat(path if host_policy else target).st_dev
  if m.get("maj:min")==str(os.major(dev))+":"+str(os.minor(dev)): matches.append(m)
 if matches:
  longest=max(len(m.get("target","")) for m in matches)
  matches=[m for m in matches if len(m.get("target",""))==longest]
 if len(matches)!=1: raise ValueError("ambiguous actual mount")
 return matches[0]
blocks=flatten(json.loads(cmd(["lsblk","-J","-o","NAME,KNAME,PATH,TYPE,ROTA,PKNAME,MAJ:MIN"])).get("blockdevices",[]))
byname={x.get("kname",x.get("name")):x for x in blocks}
def disk(source):
 name=os.path.basename(source.split("[")[0]);b=byname.get(name)
 visited=set()
 while b and b.get("pkname") and b.get("pkname") not in visited:
  visited.add(b.get("pkname"));b=byname.get(b.get("pkname"))
 return b
rootmount=mount("/");rootdisk=disk(rootmount.get("source",""))
all_mounts=flatten(json.loads(cmd(["findmnt","-J","-o","TARGET,SOURCE,FSTYPE,MAJ:MIN,FSROOT"])).get("filesystems",[]))
system_disks=set()
if rootdisk is not None: system_disks.add(rootdisk.get("path"))
for mounted in all_mounts:
 target=mounted.get("target","")
 if target=="/" or re.match(r"^/boot(?:/|$)",target) or target in ("/zspace","/zspace/applications/logs","/usr","/etc","/var","/home","/root"):
  backing=disk(mounted.get("source",""))
  if backing is not None: system_disks.add(backing.get("path"))
# An overlay with no physical host system evidence cannot prove cache safety.
if (host_policy or rootmount.get("fstype","")=="overlay") and not system_disks: sys.exit(3)
def no_links(path):
 q="/"
 for part in path.split("/")[1:]:
  if part:
   q=os.path.join(q,part)
   st=os.lstat(q)
   if not __import__("stat").S_ISDIR(st.st_mode): raise ValueError("symlink or non-directory")
 return os.stat(path)
def btrfs_bind_mount_verified(path,host_mount,permitted):
 # Btrfs stat reports a subvolume anonymous device number; mountinfo reports
 # the filesystem superblock's number. Verify both kernel mount views instead
 # of treating those different numbers as a different physical data device.
 if host_mount.get("fstype")!="btrfs": return False
 try:
  raw=subprocess.check_output(["findmnt","--kernel","-J","-T",path,"-o","TARGET,SOURCE,FSTYPE,MAJ:MIN,FSROOT"],text=True,stderr=subprocess.DEVNULL,timeout=10)
  if len(raw)>65536:return False
  entries=flatten(json.loads(raw).get("filesystems",[]))
  if len(entries)!=1:return False
  own=entries[0]
  source=host_mount.get("source","").split("[")[0]
  host_target=host_mount.get("target","");host_root=host_mount.get("fsroot","");own_root=own.get("fsroot","")
  def canonical_mount_path(value):
   return isinstance(value,str) and value.startswith("/") and not value.startswith("//") and "\x00" not in value and os.path.normpath(value)==value
  if not all(canonical_mount_path(value) for value in (host_target,host_root,own_root,permitted)):return False
  if host_target=="/":relative=permitted.lstrip("/")
  elif permitted==host_target:relative=""
  elif permitted.startswith(host_target+"/"):relative=permitted[len(host_target)+1:]
  else:return False
  expected_root=os.path.normpath(os.path.join(host_root,relative))
  if own_root!=expected_root:return False
  return source.startswith("/dev/") and own.get("target")==permitted and own.get("fstype")=="btrfs" and own.get("maj:min")==host_mount.get("maj:min") and own.get("source","").split("[")[0]==source
 except Exception:return False
def inspect(path,for_docker=False):
 if not os.path.isabs(path) or os.path.normpath(path)!=path: raise ValueError("noncanonical path")
 st=no_links(path);m=mount(path);source=m.get("source","");fs=m.get("fstype","");target=m.get("target","")
 if host_policy:
  permitted=host_policy["cache"] if for_docker else host_policy["data"]
  if path!=permitted and not path.startswith(permitted+"/"): raise ValueError("host_storage_unverified")
  if m.get("maj:min")!=str(os.major(st.st_dev))+":"+str(os.minor(st.st_dev)) and not btrfs_bind_mount_verified(path,m,permitted): raise ValueError("host_storage_unverified")
 b=disk(source);medium="unknown"
 if b and b.get("type")=="disk" and b.get("rota") in (False,0,True,1): medium="hdd" if b.get("rota") else "ssd"
 pool=bool(re.match(r"^/tmp/zfsv3/[^/]+(?:/|$)",path) and (target=="/tmp/zfsv3" or re.match(r"^/tmp/zfsv3/[^/]+(?:/|$)",target)) and ("kufs" in fs.lower() or "ku_fs" in fs.lower()))
 if pool: medium="virtual"
 system=(source==rootmount.get("source") or (b is not None and b.get("path") in system_disks) or "mmcblk" in source)
 if pool: system=False
 forbidden=(path=="/" or bool(re.match(r"^/(root|home|boot|zspace|usr|etc|bin|sbin|var|opt|run|proc|sys|dev)(/|$)",path)) or (bool(re.match(r"^/tmp(/|$)",path)) and not pool))
 allowed=not system and (for_docker or not forbidden) and (medium in ("ssd","hdd") or pool) and (for_docker or os.access(path,os.W_OK|os.X_OK))
 media_read=not system and not forbidden and (medium in ("ssd","hdd") or pool) and os.access(path,os.R_OK|os.X_OK)
 reason="" if allowed else "目录属于系统盘、受保护路径、不可写卷，或无法确认数据卷身份。"
 v=os.statvfs(path)
 ident=str(st.st_dev)+":"+str(st.st_ino)+"|"+m.get("maj:min","")+"|"+source+"|"+target
 return {"path":path,"mountPoint":target,"source":source,"filesystem":fs,"identity":ident,"volumeType":medium,"freeBytes":v.f_bavail*v.f_frsize,"totalBytes":v.f_blocks*v.f_frsize,"systemDisk":bool(system),"verifiedDataPool":pool,"installAllowed":bool(allowed),"mediaReadAllowed":bool(media_read),"reason":reason}
try:
 if mode=="docker":
  info=json.loads(cmd(["docker","info","--format","{{json .}}"]))
  path=info.get("DockerRootDir","")
  if not path: raise ValueError("missing DockerRootDir")
  result=inspect(path,True)
  driver=info.get("Driver","")
  classic=driver in ("overlay2","fuse-overlayfs","vfs","btrfs","zfs") and "containerd" not in json.dumps(info.get("DriverStatus",[])).lower()
  if not classic:
   result["installAllowed"]=False
   result["reason"]="Docker image store may use independent containerd storage; cache location unverified, install blocked."
 elif mode=="inspect": result=inspect(requested)
 elif host_policy: result=[inspect(host_policy["data"])]
 else:
  mounts=all_mounts;result=[];seen=set()
  for m in mounts:
   p=m.get("target","")
   if p in seen: continue
   seen.add(p)
   if p=="/tmp/zfsv3":
    try:
     active=mount(p)
     if "kufs" in active.get("fstype","").lower() or "ku_fs" in active.get("fstype","").lower():
      for leaf in sorted(os.listdir(p))[:128]:
       if not re.match(r"^(?:nvme|sata|usb)[0-9]+$",leaf): continue
       try: result.append(inspect(os.path.join(p,leaf)))
       except Exception: pass
    except Exception: pass
    continue
   backing=disk(m.get("source",""))
   separate=backing is not None and backing.get("type")=="disk" and (rootdisk is None or backing.get("path")!=rootdisk.get("path"))
   if separate or p.startswith("/data_") or p.startswith("/tmp/zfsv3/"):
    try: result.append(inspect(p))
    except Exception: pass
 print(json.dumps(result))
except Exception: sys.exit(3)
`

func (e *commandEngine) storageCommand(ctx context.Context, mode, path string) (string, error) {
	if e.mode == "disabled" {
		return "", errors.New("执行引擎未配置，尚不能发现真实数据卷。")
	}
	var out string
	var err error
	if e.mode == "sshbind" {
		out, _, err = e.remote(ctx, "python3", "-c", storageScript, mode, path)
	} else {
		out, _, err = e.runner(ctx, "python3", "-c", storageScript, mode, path)
	}
	if err != nil {
		return "", errors.New("无法通过findmnt、lsblk与Docker确认存储；未执行写入。")
	}
	return out, nil
}
func (e *commandEngine) DiscoverStorage(ctx context.Context) ([]StorageCandidate, error) {
	out, err := e.storageCommand(ctx, "discover", "")
	if err != nil {
		return nil, err
	}
	items := []StorageCandidate{}
	if err = json.Unmarshal([]byte(out), &items); err != nil {
		return nil, errors.New("存储发现结果无效。")
	}
	return items, nil
}
func (e *commandEngine) InspectStorage(ctx context.Context, path string) (StorageCandidate, error) {
	out, err := e.storageCommand(ctx, "inspect", path)
	var c StorageCandidate
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal([]byte(out), &c); err != nil || c.Path != path || c.Identity == "" {
		return c, errors.New("存储目录身份无法确认。")
	}
	return c, nil
}
func (e *commandEngine) DockerStorage(ctx context.Context) (StorageCandidate, error) {
	out, err := e.storageCommand(ctx, "docker", "")
	var c StorageCandidate
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal([]byte(out), &c); err != nil || c.Path == "" || c.Identity == "" {
		return c, errors.New("Docker镜像缓存身份无法确认。")
	}
	return c, nil
}
