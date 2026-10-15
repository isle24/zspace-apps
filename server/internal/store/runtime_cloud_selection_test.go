package store

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func cloudParameterPlan(t *testing.T, r *testRig, client *http.Client, token, directory, mode string, port int) RuntimePlan {
	t.Helper()
	body, err := json.Marshal(map[string]any{"appId": "test-app", "rootId": "storage", "name": directory, "hostPort": port, "parameters": map[string]string{"mode": mode}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/store/v2/cloud/install-plan", bytes.NewReader(body))
	req.Header.Set("X-Store-Session", r.token)
	req.Header.Set("X-Cloud-Session", token)
	w := httptest.NewRecorder()
	r.s.auth(func(w http.ResponseWriter, req *http.Request) { r.s.runtimeCloudInstallPlanWithClient(w, req, client) })(w, req)
	if w.Code != 201 {
		t.Fatalf("cloud plan returned HTTP %d: %s", w.Code, w.Body.String())
	}
	var out struct {
		Data RuntimePlan `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Data
}

func TestRuntimeCloudPlanKeepsRequestedParametersWhenRevisionAlreadyExists(t *testing.T) {
	r, client, token := runtimeCloudFixture(t)
	first := cloudParameterPlan(t, r, client, token, "parameters-a", "first", 32320)
	second := cloudParameterPlan(t, r, client, token, "parameters-b", "second", 32321)
	third := cloudParameterPlan(t, r, client, token, "parameters-a-again", "first", 32322)
	if first.Recipe.Services[0].Environment["MODE"] != "first" || second.Recipe.Services[0].Environment["MODE"] != "second" {
		t.Fatal("fixture did not create different parameter revisions")
	}
	if third.Recipe.Services[0].Environment["MODE"] != "first" || third.Recipe.Revision != first.Recipe.Revision {
		t.Fatal("reusing a prior parameter set selected another installation's latest recipe")
	}
}

func TestRuntimeCloudRetryKeepsFailedPlansParameterRevision(t *testing.T) {
	r, client, token := runtimeCloudFixture(t)
	first := cloudParameterPlan(t, r, client, token, "retry-parameters-a", "first", 32323)
	job := controllerFailedReview(t, r, first, "failed")
	cloudParameterPlan(t, r, client, token, "retry-parameters-b", "second", 32324)
	retry := controllerRetry(t, r, job)
	if !reflect.DeepEqual(retry.Recipe, first.Recipe) {
		t.Fatal("retry changed the failed plan's reviewed parameter values")
	}
}
