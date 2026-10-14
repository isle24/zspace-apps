package store

import (
	"errors"
	"net/http"
)

func validateSetupMode(opts Options) error {
	if opts.SetupMode != "" && opts.SetupMode != "loopback" && opts.SetupMode != "lan" {
		return errors.New("setup mode must be loopback or lan")
	}
	if opts.SetupMode == "lan" && (opts.NASAdminOnly || opts.NASOrigin != "" || opts.CatalogOnly) {
		return errors.New("LAN setup is only available for an independent storefront")
	}
	return nil
}

func setupProxied(r *http.Request) bool {
	for _, name := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP"} {
		if len(r.Header.Values(name)) != 0 {
			return true
		}
	}
	return false
}
