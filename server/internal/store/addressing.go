package store

import (
	"errors"
	"net"
	"regexp"
	"strings"
)

var hostnameRE = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$`)
var numericHostRE = regexp.MustCompile(`^[0-9.]+$`)

func publishHost(host, mode string) (string, error) {
	if host == "" {
		if mode == "sshbind" {
			return "0.0.0.0", nil
		}
		return "127.0.0.1", nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return "", errors.New("PublishHost must be an IP address without port, path, zone or shell syntax")
	}
	return ip.String(), nil
}
func accessHost(host string) (string, error) {
	if host == "" {
		return "", nil
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsUnspecified() {
			return "", errors.New("AccessHost must be a reachable host, not a wildcard bind address")
		}
		return ip.String(), nil
	}
	if len(host) > 253 || !hostnameRE.MatchString(host) || numericHostRE.MatchString(host) {
		return "", errors.New("AccessHost must be a valid hostname or IP without URL scheme, port or path")
	}
	return strings.ToLower(host), nil
}
