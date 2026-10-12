//go:build linux || darwin

package store

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"strings"
)

func nativeControllerDirectory(path string) (*os.File, error) {
	fd, e := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	for _, part := range strings.Split(strings.TrimPrefix(filepath.Clean(path), "/"), "/") {
		next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return nil, err
		}
		fd = next
		var st unix.Stat_t
		if err = unix.Fstat(fd, &st); err != nil {
			unix.Close(fd)
			return nil, err
		}
		// Sticky shared ancestors (/tmp) cannot replace another user's directory.
		if st.Mode&0022 != 0 && !(st.Mode&unix.S_ISVTX != 0 && st.Uid == 0) {
			unix.Close(fd)
			return nil, errMaintenanceUnverified
		}
	}
	return os.NewFile(uintptr(fd), path), nil
}
func nativeControllerMkdir(parent *os.File, name string) error {
	return unix.Mkdirat(int(parent.Fd()), name, 0700)
}
func nativeControllerChild(parent *os.File, name string, directory, create bool) (*os.File, error) {
	if name == "" {
		name = "."
	}
	flags := unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC | unix.O_RDWR
	if directory {
		flags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	}
	fd, e := -1, error(nil)
	if create {
		fd, e = unix.Openat(int(parent.Fd()), name, flags|unix.O_CREAT|unix.O_EXCL, 0600)
		if errors.Is(e, unix.EEXIST) {
			fd, e = unix.Openat(int(parent.Fd()), name, flags, 0)
		}
	} else {
		fd, e = unix.Openat(int(parent.Fd()), name, flags, 0)
	}
	if e != nil {
		return nil, e
	}
	return os.NewFile(uintptr(fd), filepath.Join(parent.Name(), name)), nil
}
func nativeControllerValidate(f *os.File, directory, private bool) error {
	var st unix.Stat_t
	if e := unix.Fstat(int(f.Fd()), &st); e != nil {
		return e
	}
	if st.Uid != uint32(os.Getuid()) {
		return errMaintenanceUnverified
	}
	if directory {
		if st.Mode&unix.S_IFMT != unix.S_IFDIR || st.Mode&0022 != 0 || (private && st.Mode&07777 != 0700) {
			return errMaintenanceUnverified
		}
	} else if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || st.Mode&07777 != 0600 {
		return errMaintenanceUnverified
	}
	return nil
}
func nativeControllerLock(f *os.File, exclusive bool) error {
	flags := unix.LOCK_SH | unix.LOCK_NB
	if exclusive {
		flags = unix.LOCK_EX | unix.LOCK_NB
	}
	e := unix.Flock(int(f.Fd()), flags)
	if errors.Is(e, unix.EWOULDBLOCK) || errors.Is(e, unix.EAGAIN) {
		return errControllerBusy
	}
	return e
}

func nativeControllerSnapshotRead(root *os.Root, path string) (*os.File, error) {
	if !filepath.IsLocal(path) {
		return nil, errMaintenanceUnverified
	}
	dir, e := nativeControllerDirectory(root.Name())
	if e != nil {
		return nil, e
	}
	defer dir.Close()
	expected, e := root.Stat(".")
	if e != nil {
		return nil, e
	}
	current, e := dir.Stat()
	if e != nil || !os.SameFile(expected, current) {
		return nil, errMaintenanceUnverified
	}
	parts := strings.Split(filepath.Clean(path), string(filepath.Separator))
	fd, e := unix.Dup(int(dir.Fd()))
	if e != nil {
		return nil, e
	}
	defer func() { unix.Close(fd) }()
	for _, part := range parts[:len(parts)-1] {
		next, e := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if e != nil {
			return nil, e
		}
		unix.Close(fd)
		fd = next
	}
	file, e := unix.Openat(fd, parts[len(parts)-1], unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	return os.NewFile(uintptr(file), filepath.Join(root.Name(), path)), nil
}
