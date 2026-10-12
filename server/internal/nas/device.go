package nas

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var deviceMu sync.Mutex
var processDeviceID = newDeviceID()

func newDeviceID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("secure random unavailable")
	}
	return hex.EncodeToString(b)
}

// Only the nonsecret installation identity is saved. Credentials and NAS
// sessions never use this file. Existing user directories are never chmodded.
func loadDeviceID(dataDir string) (string, error) {
	if dataDir == "" {
		return processDeviceID, nil
	}
	for _, part := range strings.Split(filepath.ToSlash(dataDir), "/") {
		if part == ".." {
			return "", errors.New("unsafe NAS identity path")
		}
	}
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return "", errors.New("invalid NAS identity directory")
	}
	deviceMu.Lock()
	defer deviceMu.Unlock()
	if err = os.MkdirAll(abs, 0700); err != nil {
		return "", errors.New("NAS identity directory unavailable")
	}
	info, err := os.Lstat(abs)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 {
		return "", errors.New("unsafe NAS identity directory")
	}
	root, err := os.OpenRoot(abs)
	if err != nil {
		return "", errors.New("NAS identity directory unavailable")
	}
	defer root.Close()
	if err = root.Mkdir("nas", 0700); err != nil && !os.IsExist(err) {
		return "", errors.New("NAS client directory unavailable")
	}
	info, err = root.Lstat("nas")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 {
		return "", errors.New("unsafe NAS client directory")
	}
	own, err := root.OpenRoot("nas")
	if err != nil {
		return "", errors.New("NAS client directory unavailable")
	}
	defer own.Close()
	info, err = own.Lstat("device-id")
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0600 || info.Size() != 32 {
			return "", errors.New("unsafe NAS device identity file")
		}
		f, err := own.Open("device-id")
		if err != nil {
			return "", errors.New("NAS device identity unavailable")
		}
		defer f.Close()
		actual, err := f.Stat()
		if err != nil || !os.SameFile(info, actual) {
			return "", errors.New("NAS device identity changed")
		}
		data, err := io.ReadAll(io.LimitReader(f, 33))
		if err != nil || len(data) != 32 {
			return "", errors.New("invalid NAS device identity")
		}
		decoded, err := hex.DecodeString(string(data))
		if err != nil || len(decoded) != 16 {
			return "", errors.New("invalid NAS device identity")
		}
		return string(data), nil
	}
	if !os.IsNotExist(err) {
		return "", errors.New("NAS device identity unavailable")
	}
	id := newDeviceID()
	f, err := own.OpenFile("device-id", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", errors.New("NAS device identity creation failed")
	}
	if _, err = f.WriteString(id); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return "", errors.New("NAS device identity write failed")
	}
	return id, nil
}
