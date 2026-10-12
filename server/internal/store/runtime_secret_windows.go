//go:build windows

package store

import "os"

// NAS secret persistence is Linux-only; portable previews fail closed.
func runtimeSecretOwned(os.FileInfo) bool { return false }
