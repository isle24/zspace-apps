package store

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
)

var errControllerBusy = errors.New("store controller lease is already held")
var errStoreUpdateInProgress = errors.New("store update lock is already held")

// These files are retained lock addresses. Their contents never indicate liveness.
type lockAddress struct {
	rootPath, directoryPath, name string
	root, directory, file         *os.File
	rootID, directoryID, fileID   os.FileInfo
}
type controllerLocks struct {
	mu     sync.Mutex
	leases []*lockAddress
	update *lockAddress
	closed bool
}

func newLockAddress(rootPath, subdir, name string) (_ *lockAddress, err error) {
	a := &lockAddress{rootPath: rootPath, directoryPath: filepath.Join(rootPath, subdir), name: name}
	defer func() {
		if err != nil {
			a.close()
		}
	}()
	a.root, err = nativeControllerDirectory(rootPath)
	if err != nil {
		return nil, err
	}
	if err = nativeControllerValidate(a.root, true, subdir == ""); err != nil {
		return nil, err
	}
	a.rootID, err = a.root.Stat()
	if err != nil {
		return nil, err
	}
	if subdir != "" {
		if err = nativeControllerMkdir(a.root, subdir); err != nil && !os.IsExist(err) {
			return nil, err
		}
	}
	a.directory, err = nativeControllerChild(a.root, subdir, true, false)
	if err != nil {
		return nil, err
	}
	if err = nativeControllerValidate(a.directory, true, true); err != nil {
		return nil, err
	}
	a.directoryID, err = a.directory.Stat()
	if err != nil {
		return nil, err
	}
	a.file, err = nativeControllerChild(a.directory, name, false, true)
	if err != nil {
		return nil, err
	}
	if err = nativeControllerValidate(a.file, false, true); err != nil {
		return nil, err
	}
	a.fileID, err = a.file.Stat()
	if err != nil {
		return nil, err
	}
	if err = a.verify(); err != nil {
		return nil, err
	}
	return a, nil
}
func (a *lockAddress) close() error {
	var e error
	for _, f := range []*os.File{a.file, a.directory, a.root} {
		if f != nil {
			e = errors.Join(e, f.Close())
		}
	}
	return e
}
func sameControllerNode(f *os.File, expected os.FileInfo, directory, private bool) error {
	if e := nativeControllerValidate(f, directory, private); e != nil {
		return e
	}
	current, e := f.Stat()
	if e != nil || !os.SameFile(current, expected) {
		return errMaintenanceUnverified
	}
	return nil
}
func (a *lockAddress) verify() error {
	root, e := nativeControllerDirectory(a.rootPath)
	if e != nil {
		return errMaintenanceUnverified
	}
	defer root.Close()
	if e = sameControllerNode(root, a.rootID, true, a.rootPath == a.directoryPath); e != nil {
		return errMaintenanceUnverified
	}
	subdir := ""
	if a.rootPath != a.directoryPath {
		subdir = ".space-store-control"
	}
	dir, e := nativeControllerChild(root, subdir, true, false)
	if e != nil {
		return errMaintenanceUnverified
	}
	defer dir.Close()
	if e = sameControllerNode(dir, a.directoryID, true, true); e != nil {
		return errMaintenanceUnverified
	}
	file, e := nativeControllerChild(dir, a.name, false, false)
	if e != nil {
		return errMaintenanceUnverified
	}
	defer file.Close()
	if e = sameControllerNode(file, a.fileID, false, true); e != nil {
		return errMaintenanceUnverified
	}
	return sameControllerNode(a.file, a.fileID, false, true)
}
func (a *lockAddress) lock(exclusive bool) (*os.File, error) {
	if e := a.verify(); e != nil {
		return nil, e
	}
	f, e := nativeControllerChild(a.directory, a.name, false, false)
	if e != nil {
		return nil, errMaintenanceUnverified
	}
	if e = sameControllerNode(f, a.fileID, false, true); e == nil {
		e = nativeControllerLock(f, exclusive)
	}
	if e == nil {
		e = a.verify()
	}
	if e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func acquireControllerLocks(opts Options) (_ *controllerLocks, err error) {
	l := &controllerLocks{}
	defer func() {
		if err != nil {
			l.Close()
		}
	}()
	domain := opts.StorageRoot
	if opts.EngineMode == "sshbind" {
		domain = opts.DataDir
	}
	for _, spec := range [][3]string{{opts.DataDir, "", ".space-store-controller.lock"}, {domain, ".space-store-control", "controller.lock"}} {
		// sshbind proves only this process's local metadata controller.
		if opts.EngineMode == "sshbind" && spec[2] == "controller.lock" {
			continue
		}
		a, e := newLockAddress(spec[0], spec[1], spec[2])
		if e != nil {
			return nil, errMaintenanceUnverified
		}
		l.leases = append(l.leases, a)
		locked, e := a.lock(true)
		if e != nil {
			return nil, e
		}
		a.file.Close()
		a.file = locked
	}
	l.update, err = newLockAddress(domain, ".space-store-control", "update.lock")
	if err != nil {
		return nil, errMaintenanceUnverified
	}
	return l, nil
}
func (l *controllerLocks) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	var e error
	for _, a := range l.leases {
		e = errors.Join(e, a.close())
	}
	if l.update != nil {
		e = errors.Join(e, l.update.close())
	}
	return e
}
func (l *controllerLocks) MaintenanceChange() (func(), error) {
	if l == nil {
		return nil, errMaintenanceUnverified
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil, errMaintenanceUnverified
	}
	for _, a := range l.leases {
		if e := a.verify(); e != nil {
			return nil, errMaintenanceUnverified
		}
	}
	f, e := l.update.lock(false)
	if errors.Is(e, errControllerBusy) {
		return nil, errStoreUpdateInProgress
	}
	if e != nil {
		return nil, errMaintenanceUnverified
	}
	return func() { f.Close() }, nil
}
