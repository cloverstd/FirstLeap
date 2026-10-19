package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAIProviderDraftModelsAndConnection(t *testing.T) {
	a := aiFixture(t)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer draft-secret" {
			t.Errorf("unexpected model listing request: %s %s", r.Method, r.URL.Path)
		}
		jsonResponse(w, 200, map[string]any{"data": []map[string]string{{"id": "z-image"}, {"id": "a-text"}, {"id": "a-text"}, {"id": ""}, {"id": "bad\nmodel"}}})
	}))
	defer provider.Close()
	before := a.ai.settingsSnapshot()
	for _, action := range []string{"models", "test"} {
		req := providerSettingsRequest{Group: "text", Config: modelConfig{BaseURL: provider.URL + "/v1/", APIKey: "draft-secret", Model: "a-text"}}
		w := aiRequest(t, a, "POST", "/api/settings/ai/"+action, req)
		var result struct {
			Models         []string `json:"models"`
			Elapsed        int64    `json:"elapsedMs"`
			ModelAvailable bool     `json:"modelAvailable"`
			Message        string   `json:"message"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatalf("%s: %d %s", action, w.Code, w.Body.String())
		}
		if !reflect.DeepEqual(result.Models, []string{"a-text", "z-image"}) || !result.ModelAvailable || result.Elapsed < 0 {
			t.Fatalf("unexpected model listing: %+v", result)
		}
		if strings.Contains(w.Body.String(), "draft-secret") {
			t.Fatal("draft key leaked")
		}
		if action == "test" && !strings.Contains(result.Message, "连接成功") {
			t.Fatal("missing connectivity result")
		}
	}
	if calls.Load() != 2 || !reflect.DeepEqual(before, a.ai.settingsSnapshot()) {
		t.Fatal("preview must only list models and must not change settings")
	}
	if _, err := os.Stat(filepath.Join(a.ai.root, "settings.json")); !os.IsNotExist(err) {
		t.Fatal("draft was persisted")
	}
	w := aiRequest(t, a, "POST", "/api/settings/ai/test", providerSettingsRequest{Group: "image", Config: modelConfig{BaseURL: provider.URL + "/v1", APIKey: "draft-secret", Model: "removed-model"}})
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"modelAvailable":false`) || !strings.Contains(w.Body.String(), "请重新选择") {
		t.Fatal("missing model must be reported separately from successful connection", w.Body.String())
	}
}

func TestAIProviderPreviewCredentialsAndOrigin(t *testing.T) {
	a := aiFixture(t)
	var authorization string
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		authorization = r.Header.Get("Authorization")
		jsonResponse(w, 200, map[string]any{"data": []map[string]string{{"id": "model"}}})
	}))
	defer provider.Close()
	a.ai.settings.Text.modelConfig = modelConfig{BaseURL: provider.URL + "/v1", APIKey: "saved-text"}
	a.ai.settings.Image.modelConfig = modelConfig{BaseURL: provider.URL + "/v1", APIKey: "saved-image"}
	for _, tc := range []struct {
		group, key, expected string
		clear                bool
	}{
		{"text", "", "Bearer saved-text", false},
		{"image", "", "Bearer saved-image", false},
		{"text", "new-key", "Bearer new-key", false},
		{"text", "", "", true},
	} {
		w := aiRequest(t, a, "POST", "/api/settings/ai/models", providerSettingsRequest{Group: tc.group, Config: modelConfig{BaseURL: provider.URL + "/v1/", APIKey: tc.key, ClearKey: tc.clear}})
		if w.Code != 200 || authorization != tc.expected {
			t.Fatalf("wrong credential selection for %s: %d", tc.group, w.Code)
		}
	}
	if a.ai.settingsSnapshot().Text.APIKey != "saved-text" || a.ai.settingsSnapshot().Image.APIKey != "saved-image" {
		t.Fatal("preview changed stored credentials")
	}
	before := calls.Load()
	for _, config := range []providerSettingsRequest{
		{Group: "text", Config: modelConfig{BaseURL: provider.URL + "/different"}},
		{Group: "other", Config: modelConfig{BaseURL: provider.URL}},
		{Group: "text", Config: modelConfig{BaseURL: "file:///tmp/secret"}},
		{Group: "image", Config: modelConfig{BaseURL: "https://user:password@example.com"}},
	} {
		if w := aiRequest(t, a, "POST", "/api/settings/ai/models", config); w.Code != 400 {
			t.Fatalf("invalid preview allowed: %d", w.Code)
		}
	}
	for _, action := range []string{"models", "test"} {
		req := httptest.NewRequest("POST", "/api/settings/ai/"+action, strings.NewReader(`{"group":"text","config":{}}`))
		req.Header.Set("Origin", "https://untrusted.example")
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, req)
		if w.Code != 403 {
			t.Fatal("cross-origin preview allowed")
		}
	}
	if calls.Load() != before {
		t.Fatal("invalid preview sent credentials upstream")
	}
}

func TestAIProviderModelsErrorsAndRedirects(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"unauthorized", 401, "upstream-secret", "认证失败"},
		{"forbidden", 403, "upstream-secret", "认证失败"},
		{"unsupported", 404, "upstream-secret", "/models"},
		{"rate limited", 429, "upstream-secret", "已达上限"},
		{"server error", 503, "upstream-secret", "HTTP 503"},
		{"html", 200, "<html>upstream-secret</html>", "有效的模型列表"},
		{"error json", 200, `{"error":{"message":"upstream-secret"}}`, "有效的模型列表"},
		{"empty", 200, `{"data":[]}`, "没有返回可用模型"},
		{"oversize", 200, strings.Repeat("x", (4<<20)+1), "响应过大"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := aiFixture(t)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer provider.Close()
			w := aiRequest(t, a, "POST", "/api/settings/ai/test", providerSettingsRequest{Group: "text", Config: modelConfig{BaseURL: provider.URL, APIKey: "upstream-secret"}})
			if w.Code != 502 || !strings.Contains(w.Body.String(), tc.want) || strings.Contains(w.Body.String(), "upstream-secret") {
				t.Fatalf("unexpected error %d %s", w.Code, w.Body.String())
			}
		})
	}
	a := aiFixture(t)
	var destinationCalls atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls.Add(1) }))
	defer destination.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+"/models", http.StatusFound)
	}))
	defer provider.Close()
	w := aiRequest(t, a, "POST", "/api/settings/ai/models", providerSettingsRequest{Group: "text", Config: modelConfig{BaseURL: provider.URL, APIKey: "private"}})
	if w.Code != 502 || destinationCalls.Load() != 0 {
		t.Fatal("followed provider redirect")
	}
}

func TestAIProviderModelListingCancellation(t *testing.T) {
	a := aiFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer provider.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := a.ai.providerModels(ctx, modelConfig{BaseURL: provider.URL})
	if err == nil || !strings.Contains(err.Error(), "超时") {
		t.Fatal("request cancellation was not respected")
	}
}
