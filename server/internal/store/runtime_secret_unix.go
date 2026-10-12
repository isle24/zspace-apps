//go:build !windows

package store

import (
	"os"
	"syscall"
)

func runtimeSecretOwned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Getuid()
}
