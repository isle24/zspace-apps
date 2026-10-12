//go:build windows

package store

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strings"
	"unsafe"
)

func controllerWindowsUser() (*windows.SID, error) {
	token, e := windows.OpenCurrentProcessToken()
	if e != nil {
		return nil, e
	}
	defer token.Close()
	user, e := token.GetTokenUser()
	if e != nil {
		return nil, e
	}
	return user.User.Sid.Copy()
}
func controllerWindowsSecurity() (*windows.SecurityAttributes, error) {
	user, e := controllerWindowsUser()
	if e != nil {
		return nil, e
	}
	sd, e := windows.SecurityDescriptorFromString("O:" + user.String() + "D:P(A;OICI;FA;;;" + user.String() + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if e != nil {
		return nil, e
	}
	return &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}, nil
}
func controllerWindowsOpen(path string, directory, create bool) (*os.File, error) {
	name, e := windows.UTF16PtrFromString(path)
	if e != nil {
		return nil, e
	}
	access := uint32(windows.GENERIC_READ | windows.GENERIC_WRITE | windows.READ_CONTROL)
	flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT)
	if directory {
		access = windows.GENERIC_READ | windows.READ_CONTROL
		flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
	}
	disposition := uint32(windows.OPEN_EXISTING)
	var attrs *windows.SecurityAttributes
	if create {
		disposition = windows.CREATE_NEW
		attrs, e = controllerWindowsSecurity()
		if e != nil {
			return nil, e
		}
	}
	// No FILE_SHARE_DELETE: held handles prevent namespace replacement on Windows.
	h, e := windows.CreateFile(name, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, attrs, disposition, flags, 0)
	if create && (errors.Is(e, windows.ERROR_FILE_EXISTS) || errors.Is(e, windows.ERROR_ALREADY_EXISTS)) {
		h, e = windows.CreateFile(name, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, flags, 0)
	}
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(h), path)
	var info windows.ByHandleFileInformation
	if e = windows.GetFileInformationByHandle(h, &info); e != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		f.Close()
		return nil, errMaintenanceUnverified
	}
	return f, nil
}
func nativeControllerDirectory(path string) (*os.File, error) {
	clean := filepath.Clean(path)
	prefix := filepath.VolumeName(clean) + string(filepath.Separator)
	// Reject reparse points on every ancestor, not only the last component.
	for _, part := range strings.Split(strings.TrimPrefix(clean, prefix), string(filepath.Separator)) {
		prefix = filepath.Join(prefix, part)
		f, e := controllerWindowsOpen(prefix, true, false)
		if e != nil {
			return nil, e
		}
		e = controllerWindowsACL(f, false, false)
		f.Close()
		if e != nil {
			return nil, e
		}
	}
	return controllerWindowsOpen(clean, true, false)
}
func nativeControllerMkdir(parent *os.File, name string) error {
	path, e := windows.UTF16PtrFromString(filepath.Join(parent.Name(), name))
	if e != nil {
		return e
	}
	attrs, e := controllerWindowsSecurity()
	if e != nil {
		return e
	}
	return windows.CreateDirectory(path, attrs)
}
func nativeControllerChild(parent *os.File, name string, directory, create bool) (*os.File, error) {
	return controllerWindowsOpen(filepath.Join(parent.Name(), name), directory, create)
}
func controllerWindowsACL(f *os.File, private, currentOwner bool) error {
	user, e := controllerWindowsUser()
	if e != nil {
		return e
	}
	sd, e := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if e != nil {
		return e
	}
	owner, defaulted, e := sd.Owner()
	if e != nil || owner == nil || defaulted {
		return errMaintenanceUnverified
	}
	trusted := func(sid *windows.SID) bool {
		return windows.EqualSid(sid, user) || sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid)
	}
	if (currentOwner && !windows.EqualSid(owner, user)) || !trusted(owner) {
		return errMaintenanceUnverified
	}
	acl, defaulted, e := sd.DACL()
	if e != nil || acl == nil || defaulted || acl.AceCount == 0 {
		return errMaintenanceUnverified
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if e = windows.GetAce(acl, i, &ace); e != nil || ace == nil || ace.Header.AceSize < 20 {
			return errMaintenanceUnverified
		}
		// Reject object/callback/conditional ACEs whose access cannot be established here.
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE && ace.Header.AceType != windows.ACCESS_DENIED_ACE_TYPE {
			return errMaintenanceUnverified
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !sid.IsValid() {
			return errMaintenanceUnverified
		}
		if ace.Header.AceType == windows.ACCESS_ALLOWED_ACE_TYPE && !trusted(sid) {
			write := windows.ACCESS_MASK(windows.GENERIC_ALL | windows.GENERIC_WRITE | windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA | windows.FILE_WRITE_EA | windows.FILE_WRITE_ATTRIBUTES | 0x40)
			if private || ace.Mask&write != 0 {
				return errMaintenanceUnverified
			}
		}
	}
	return nil
}
func nativeControllerValidate(f *os.File, directory, private bool) error {
	var info windows.ByHandleFileInformation
	if e := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &info); e != nil {
		return e
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory || (!directory && info.NumberOfLinks != 1) {
		return errMaintenanceUnverified
	}
	return controllerWindowsACL(f, private, true)
}
func nativeControllerLock(f *os.File, exclusive bool) error {
	flags := uint32(windows.LOCKFILE_FAIL_IMMEDIATELY)
	if exclusive {
		flags |= windows.LOCKFILE_EXCLUSIVE_LOCK
	}
	e := windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &windows.Overlapped{})
	if errors.Is(e, windows.ERROR_LOCK_VIOLATION) {
		return errControllerBusy
	}
	return e
}

func nativeControllerSnapshotRead(root *os.Root, path string) (*os.File, error) {
	// Root containment is maintained; reject every reparse component before open.
	if !filepath.IsLocal(path) {
		return nil, errMaintenanceUnverified
	}
	base, e := nativeControllerDirectory(root.Name())
	if e != nil {
		return nil, e
	}
	defer base.Close()
	expected, e := root.Stat(".")
	if e != nil {
		return nil, e
	}
	current, e := base.Stat()
	if e != nil || !os.SameFile(expected, current) {
		return nil, errMaintenanceUnverified
	}
	target := filepath.Join(root.Name(), path)
	dir, e := nativeControllerDirectory(filepath.Dir(target))
	if e != nil {
		return nil, e
	}
	defer dir.Close()
	f, e := controllerWindowsOpen(target, false, false)
	if e != nil {
		return nil, e
	}
	return f, nil
}
