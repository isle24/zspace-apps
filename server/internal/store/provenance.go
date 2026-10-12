package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

const ownershipMarker = ".space-store-owner"

type PathProvenance struct {
	RootIdentity      string `json:"rootIdentity"`
	DirectoryIdentity string `json:"directoryIdentity"`
	Marker            string `json:"marker"`
}
type directoryProtector interface {
	PinDirectory(context.Context, string, string, string) (PathProvenance, error)
	VerifyDirectory(context.Context, string, string, PathProvenance) error
}

func fileIdentity(info os.FileInfo) (string, error) {
	v := reflect.ValueOf(info.Sys())
	if v.Kind() == reflect.Pointer {
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return "", errors.New("本平台尚不能可靠校验目录身份。")
	}
	parts := []string{}
	for _, name := range []string{"Dev", "Ino"} {
		f := v.FieldByName(name)
		if !f.IsValid() {
			return "", errors.New("本平台尚不能可靠校验目录身份，拒绝安装。")
		}
		var n any
		if f.Kind() >= reflect.Int && f.Kind() <= reflect.Int64 {
			n = f.Int()
		} else if f.Kind() >= reflect.Uint && f.Kind() <= reflect.Uint64 {
			n = f.Uint()
		} else {
			return "", errors.New("目录身份不受支持。")
		}
		b, _ := json.Marshal(n)
		parts = append(parts, string(b))
	}
	return strings.Join(parts, ":"), nil
}
func localPin(root, p, marker string) (PathProvenance, error) {
	if err := validateLocalPath(root, p, false); err != nil {
		return PathProvenance{}, err
	}
	entries, err := os.ReadDir(p)
	if err != nil || len(entries) != 0 {
		return PathProvenance{}, errors.New("全新实例目录在绑定前已包含数据，拒绝接管。")
	}
	rf, err := os.Stat(root)
	if err != nil {
		return PathProvenance{}, err
	}
	df, err := os.Stat(p)
	if err != nil {
		return PathProvenance{}, err
	}
	rid, err := fileIdentity(rf)
	if err != nil {
		return PathProvenance{}, err
	}
	did, err := fileIdentity(df)
	if err != nil {
		return PathProvenance{}, err
	}
	dir, err := os.OpenRoot(p)
	if err != nil {
		return PathProvenance{}, err
	}
	defer dir.Close()
	f, err := dir.OpenFile(ownershipMarker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return PathProvenance{}, errors.New("实例所有权标记已存在，拒绝接管。")
	}
	_, err = f.WriteString(marker)
	if err == nil {
		err = f.Sync()
	}
	f.Close()
	if err != nil {
		return PathProvenance{}, err
	}
	pin := PathProvenance{RootIdentity: rid, DirectoryIdentity: did, Marker: marker}
	if err = localVerify(root, p, pin); err != nil {
		return PathProvenance{}, err
	}
	return pin, nil
}
func localVerify(root, p string, pin PathProvenance) error {
	if err := validateLocalPath(root, p, false); err != nil {
		return err
	}
	rf, err := os.Stat(root)
	if err != nil {
		return err
	}
	df, err := os.Stat(p)
	if err != nil {
		return err
	}
	rid, err := fileIdentity(rf)
	if err != nil {
		return err
	}
	did, err := fileIdentity(df)
	if err != nil {
		return err
	}
	if pin.Marker == "" || pin.RootIdentity != rid || pin.DirectoryIdentity != did {
		return errors.New("实例目录或存储根身份发生变化，拒绝挂载已有数据。")
	}
	mp := filepath.Join(p, ownershipMarker)
	fi, err := os.Lstat(mp)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode()&os.ModeSymlink != 0 {
		return errors.New("实例所有权标记无效。")
	}
	b, err := os.ReadFile(mp)
	if err != nil || string(b) != pin.Marker {
		return errors.New("实例所有权标记不匹配，拒绝接管。")
	}
	return nil
}
func (s *Service) pinDirectory(ctx context.Context, root, p, marker string) (PathProvenance, error) {
	if e, ok := s.engine.(directoryProtector); ok {
		return e.PinDirectory(ctx, root, p, marker)
	}
	if s.opts.EngineMode == "sshbind" {
		return PathProvenance{}, errors.New("远端引擎缺少目录身份校验能力。")
	}
	return localPin(root, p, marker)
}
func (s *Service) verifyDirectory(ctx context.Context, root, p string, pin PathProvenance) error {
	if e, ok := s.engine.(directoryProtector); ok {
		return e.VerifyDirectory(ctx, root, p, pin)
	}
	if s.opts.EngineMode == "sshbind" {
		return errors.New("远端引擎缺少目录身份校验能力。")
	}
	return localVerify(root, p, pin)
}

const remoteProvenanceScript = `import os,sys,json
root,p,mode,payload=sys.argv[1:]
def opened(path):
 fd=os.open("/",os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in path.split("/")[1:]:
   if part:
    new=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=new
  return fd
 except Exception:
  os.close(fd);raise
def identity(fd):
 s=os.fstat(fd);return str(s.st_dev)+":"+str(s.st_ino)
try:
 if os.path.dirname(p)!=root or os.path.normpath(root)!=root or os.path.normpath(p)!=p: sys.exit(3)
 rf=opened(root);df=opened(p)
 ri=identity(rf);di=identity(df)
 if mode=="pin":
  if os.listdir(df): sys.exit(3)
  f=os.open(".space-store-owner",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=df)
  os.write(f,payload.encode());os.fsync(f);os.close(f)
  result={"rootIdentity":ri,"directoryIdentity":di,"marker":payload}
 else:
  result=json.loads(payload)
  if result["rootIdentity"]!=ri or result["directoryIdentity"]!=di: sys.exit(3)
  f=os.open(".space-store-owner",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=df);data=os.read(f,1024).decode();os.close(f)
  if data!=result["marker"]: sys.exit(3)
 os.close(df);os.close(rf);print(json.dumps(result))
except Exception: sys.exit(3)
`

func (e *commandEngine) PinDirectory(ctx context.Context, root, p, marker string) (PathProvenance, error) {
	if e.mode != "sshbind" {
		return localPin(root, p, marker)
	}
	out, _, err := e.remote(ctx, "python3", "-c", remoteProvenanceScript, root, p, "pin", marker)
	var pin PathProvenance
	if err != nil || json.Unmarshal([]byte(out), &pin) != nil || pin.Marker != marker || pin.DirectoryIdentity == "" || pin.RootIdentity == "" {
		return pin, errors.New("无法锁定新实例目录身份与所有权，拒绝挂载。")
	}
	return pin, nil
}
func (e *commandEngine) VerifyDirectory(ctx context.Context, root, p string, pin PathProvenance) error {
	if e.mode != "sshbind" {
		return localVerify(root, p, pin)
	}
	b, _ := json.Marshal(pin)
	if _, _, err := e.remote(ctx, "python3", "-c", remoteProvenanceScript, root, p, "verify", string(b)); err != nil {
		return errors.New("目录设备、inode或所有权标记已变化，拒绝接管已有数据。")
	}
	return nil
}
