package store

import (
	"os/exec"
	"testing"
)

func TestRuntimeHostSnapshotAndOwnershipFixtures(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	for _, fixture := range []string{"runtime_host_test.py", "runtime_registry_host_test.py", "runtime_owner_test.py"} {
		out, err := exec.Command(python, fixture).CombinedOutput()
		if err != nil {
			t.Fatalf("guarded host fixture %s: %v\n%s", fixture, err, out)
		}
	}
}
