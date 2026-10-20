package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestProviderSingleMutationsAndGlobalPatch(t *testing.T) {
	a := aiFixture(t)
	if w := aiRequest(t, a, "PUT", "/api/settings/ai", twoProviders("https://example.com")); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	before := a.ai.settingsSnapshot()
	for _, group := range []string{"text", "image", "tts"} {
		defaults := defaultAISettings()
		configs := map[string]any{"text": defaults.Text, "image": defaults.Image, "tts": defaults.TTS}
		payload := map[string]any{"id": "new", "name": "新增服务", "config": configs[group]}
		path := "/api/settings/ai/providers/" + group
		if w := aiRequest(t, a, "POST", path, payload); w.Code != 200 || strings.Contains(w.Body.String(), "secret-") {
			t.Fatalf("create: %d %s", w.Code, w.Body.String())
		}
		if w := aiRequest(t, a, "POST", path, payload); w.Code != 409 {
			t.Fatalf("duplicate: %d", w.Code)
		}
		// An update to the new provider cannot reuse another provider's credentials.
		cfg, err := a.ai.providerPreview(providerSettingsRequest{Group: group, ProviderID: "new", Config: modelConfig{BaseURL: "https://example.com/a"}})
		if err != nil || cfg.APIKey != "" {
			t.Fatal("new draft inherited credentials")
		}
		payload["name"] = "已修改"
		if w := aiRequest(t, a, "PUT", path+"/new", payload); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		if w := aiRequest(t, a, "PUT", path+"/missing", payload); w.Code != 404 {
			t.Fatalf("missing update: %d", w.Code)
		}
		if w := aiRequest(t, a, "DELETE", path+"/a", nil); w.Code != 409 {
			t.Fatal("default provider deleted")
		}
		if w := aiRequest(t, a, "PUT", path+"/default", map[string]string{"providerId": "b"}); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		if w := aiRequest(t, a, "DELETE", path+"/new", nil); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	if w := aiRequest(t, a, "PATCH", "/api/settings/ai", map[string]any{"prompts": map[string]string{"system": "新提示词"}, "enabledTools": []string{}, "imageEnabled": false}); w.Code != 200 || strings.Contains(w.Body.String(), "secret-") {
		t.Fatalf("patch: %d %s", w.Code, w.Body.String())
	}
	after := a.ai.settingsSnapshot()
	if after.Prompts.System != "新提示词" || after.Prompts.Lesson != before.Prompts.Lesson || len(after.EnabledTools) != 0 || after.Image.Enabled || !after.TTS.Enabled {
		t.Fatal("global patch lost unrelated configuration")
	}
	if after.Providers.Text[0].Config.APIKey != before.Providers.Text[0].Config.APIKey || after.Providers.Defaults.Text != "b" || after.Text.Model != "text-b" {
		t.Fatal("single mutations corrupted providers")
	}
	snapshot := after
	for _, bad := range []any{map[string]any{"enabledTools": []string{"unknown"}}, map[string]any{"prompts": map[string]string{"unknown": "x"}}, map[string]any{"providers": map[string]any{}}, map[string]any{"prompts": map[string]string{"system": strings.Repeat("x", 32001)}}} {
		if w := aiRequest(t, a, "PATCH", "/api/settings/ai", bad); w.Code != 400 {
			t.Fatalf("bad patch: %d %s", w.Code, w.Body.String())
		}
		if !reflect.DeepEqual(snapshot, a.ai.settingsSnapshot()) {
			t.Fatal("invalid patch changed settings")
		}
	}
	restarted, err := New(a.cfg)
	if err != nil || !reflect.DeepEqual(snapshot, restarted.ai.settingsSnapshot()) {
		t.Fatal("single saves not durable")
	}
}
func TestProviderConcurrentMutationsPreserveOtherUpdates(t *testing.T) {
	a := aiFixture(t)
	var wg sync.WaitGroup
	for i, group := range []string{"text", "image", "tts"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d := defaultAISettings()
			configs := []any{d.Text, d.Image, d.TTS}
			w := aiRequest(t, a, "POST", "/api/settings/ai/providers/"+group, map[string]any{"id": "new", "name": group, "config": configs[i]})
			if w.Code != 200 {
				t.Errorf("concurrent save: %s", w.Body.String())
			}
		}()
	}
	wg.Wait()
	c := providerView(t, a)
	if len(c.Providers.Text) != 2 || len(c.Providers.Image) != 2 || len(c.Providers.TTS) != 2 {
		t.Fatal("concurrent mutations lost a provider")
	}
	if w := aiRequest(t, a, "DELETE", "/api/settings/ai/providers/text/legacy-text", nil); w.Code != 409 {
		t.Fatal("last/default guard failed")
	}
}
func TestProviderRejectsUnknownConfigurationFields(t *testing.T) {
	a := aiFixture(t)
	raw := json.RawMessage(`{"baseURL":"https://example.com","apiKey":"private","model":"x","unexpected":true}`)
	w := aiRequest(t, a, "POST", "/api/settings/ai/providers/text", map[string]any{"id": "new", "name": "new", "config": raw})
	if w.Code != 400 || len(providerView(t, a).Providers.Text) != 1 {
		t.Fatal("invalid config accepted")
	}
}
