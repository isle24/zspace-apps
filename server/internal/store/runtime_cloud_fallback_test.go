package store

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type fallbackTransport struct {
	deny     bool
	t        *testing.T
	requests int
}

func (f *fallbackTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	f.requests++
	if r.URL.Host == "zstore.2iwm.com" {
		status := 503
		if f.deny {
			status = 401
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("{}")), Header: http.Header{}}, nil
	}
	if r.Header.Get("Authorization") != "" {
		f.t.Fatal("token leaked to GitHub")
	}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"publicKey":"public"}`)), Header: http.Header{}}, nil
}
func TestCloudGithubFallbackDoesNotBypassDeniedAuthentication(t *testing.T) {
	transport := &fallbackTransport{t: t}
	client := &http.Client{Transport: transport}
	if _, err := runtimeCloudGet(context.Background(), client, "catalog-key", strings.Repeat("a", 48), 16384); err != nil || transport.requests != 2 {
		t.Fatal("public fallback failed", err)
	}
	transport.deny = true
	transport.requests = 0
	if _, err := runtimeCloudGet(context.Background(), client, "catalog-key", strings.Repeat("a", 48), 16384); err == nil || transport.requests != 1 {
		t.Fatal("denied authentication bypassed")
	}
}
