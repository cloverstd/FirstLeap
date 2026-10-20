package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func providerView(t *testing.T, a *App) aiSettings {
	t.Helper()
	w := aiRequest(t, a, "GET", "/api/settings/ai", nil)
	var view struct {
		Settings aiSettings `json:"settings"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &view) != nil || view.Settings.Providers == nil {
		t.Fatalf("invalid provider view: %d %s", w.Code, w.Body.String())
	}
	return view.Settings
}

func twoProviders(base string) aiSettings {
	c := defaultAISettings()
	c.ensureProviders()
	for _, name := range []string{"a", "b"} {
		text, image, tts := c.Text, c.Image, c.TTS
		text.modelConfig = modelConfig{BaseURL: base + "/" + name, APIKey: "secret-text-" + name, Model: "text-" + name}
		text.Stream = false
		if name == "b" {
			text.Protocol = "responses"
			text.MaxTokens = 4096
		}
		image.modelConfig = modelConfig{BaseURL: base + "/" + name, APIKey: "secret-image-" + name, Model: "image-" + name}
		image.Size, image.Quality = "512x512", name
		tts.modelConfig = modelConfig{BaseURL: base + "/" + name, APIKey: "secret-tts-" + name, Model: "tts-" + name}
		tts.Voice, tts.Format = name, "wav"
		if name == "b" {
			tts.Speed = 0.85
			tts.Extra = map[string]any{"language": "zh"}
		}
		if name == "a" {
			c.Providers.Text = nil
			c.Providers.Image = nil
			c.Providers.TTS = nil
		}
		c.Providers.Text = append(c.Providers.Text, aiProvider[textConfig]{name, "文字" + name, text})
		c.Providers.Image = append(c.Providers.Image, aiProvider[imageConfig]{name, "图片" + name, image})
		c.Providers.TTS = append(c.Providers.TTS, aiProvider[ttsConfig]{name, "语音" + name, tts})
	}
	c.Providers.Defaults = providerDefaults{"a", "a", "a"}
	c.Image.Enabled, c.TTS.Enabled = true, true
	return c
}

func TestAIProviderLegacyMigrationAndPersistence(t *testing.T) {
	a := aiFixture(t)
	legacy := defaultAISettings()
	legacy.Text.modelConfig = modelConfig{BaseURL: "https://text.example/v1", APIKey: "old-text-secret", Model: "text"}
	legacy.Text.Protocol = "responses"
	legacy.Image.modelConfig = modelConfig{BaseURL: "https://image.example/v1", APIKey: "old-image-secret", Model: "image"}
	legacy.Image.Enabled = true
	legacy.TTS.modelConfig = modelConfig{BaseURL: "https://tts.example/v1", APIKey: "old-tts-secret", Model: "tts"}
	legacy.TTS.Enabled, legacy.TTS.Voice = true, "teacher"
	if err := writeJSONAtomic(filepath.Join(a.ai.root, "settings.json"), legacy); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	view := providerView(t, restarted)
	if view.Providers.Defaults != (providerDefaults{"legacy-text", "legacy-image", "legacy-tts"}) || len(view.Providers.Text) != 1 || view.Providers.Text[0].Config.Protocol != "responses" || view.Providers.TTS[0].Config.Voice != "teacher" {
		t.Fatal("legacy values not migrated")
	}
	if w := aiRequest(t, restarted, "PUT", "/api/settings/ai", view); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	again, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	c := again.ai.settingsSnapshot()
	if c.Providers == nil || c.Text.APIKey != legacy.Text.APIKey || c.Image.APIKey != legacy.Image.APIKey || c.TTS.APIKey != legacy.TTS.APIKey || !c.TTS.Enabled || !c.Image.Enabled {
		t.Fatal("migration lost credentials or feature flags after restart")
	}
	response := aiRequest(t, again, "GET", "/api/settings/ai", nil).Body.String()
	for _, key := range []string{legacy.Text.APIKey, legacy.Image.APIKey, legacy.TTS.APIKey} {
		if strings.Contains(response, key) {
			t.Fatal("migrated credentials leaked")
		}
	}
}

func TestAIProviderDefaultsRouteAllModalities(t *testing.T) {
	a := aiFixture(t)
	wav := speechWAV(t)
	seen := map[string]int{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		model, _ := input["model"].(string)
		seen[model]++
		if r.Header.Get("Authorization") != "Bearer secret-"+model {
			t.Error("wrong provider credential")
		}
		switch r.URL.Path {
		case "/b/responses":
			if input["max_output_tokens"] != float64(4096) {
				t.Error("text options not selected")
			}
			responseJSON(w, "provider b")
		case "/a/chat/completions":
			chatJSON(w, "provider a")
		case "/a/images/generations", "/b/images/generations":
			if input["size"] != "512x512" || input["quality"] != strings.TrimPrefix(model, "image-") {
				t.Error("image options not selected")
			}
			jsonResponse(w, 200, map[string]any{"data": []any{map[string]string{"b64_json": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}}})
		case "/a/audio/speech", "/b/audio/speech":
			if input["voice"] != strings.TrimPrefix(model, "tts-") {
				t.Error("voice belongs to another provider")
			}
			if model == "tts-b" && (input["speed"] != 0.85 || input["language"] != "zh") {
				t.Error("TTS options not selected")
			}
			w.Header().Set("Content-Type", "audio/wav")
			_, _ = w.Write(wav)
		default:
			t.Errorf("request routed to wrong provider: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()
	c := twoProviders(provider.URL)
	if w := aiRequest(t, a, "PUT", "/api/settings/ai", c); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	preview := providerView(t, a).Providers.TTS[1]
	if w := aiRequest(t, a, "POST", "/api/settings/ai/tts/preview", map[string]any{"providerId": preview.ID, "config": preview.Config}); w.Code != 200 {
		t.Fatal("non-default TTS preview failed", w.Body.String())
	}
	for _, id := range []string{"b", "a"} {
		view := providerView(t, a)
		view.Providers.Defaults = providerDefaults{id, id, id}
		if w := aiRequest(t, a, "PUT", "/api/settings/ai", view); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		cfg := a.ai.settingsSnapshot()
		if !cfg.Image.Enabled || !cfg.TTS.Enabled {
			t.Fatal("switching default disabled features")
		}
		if _, err := a.ai.turn(context.Background(), newProviderSession(cfg.Text, "system", "hello", nil), nil); err != nil {
			t.Fatal(err)
		}
		if _, err := a.ai.makeImage(context.Background(), cfg, aiImage{ID: uniqueID(), Prompt: "bag"}, true); err != nil {
			t.Fatal(err)
		}
		if _, err := a.ai.synthesizeSpeech(context.Background(), cfg.TTS, "hello", filepath.Join(t.TempDir(), "out.wav")); err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 6 {
		t.Fatalf("not all providers were used: %v", seen)
	}
	restarted, err := New(a.cfg)
	if err != nil || !reflect.DeepEqual(restarted.ai.settingsSnapshot(), a.ai.settingsSnapshot()) {
		t.Fatal("provider options not persisted")
	}
	// An older client changes only the active provider and preserves alternatives.
	view := providerView(t, a)
	view.Providers = nil
	view.Text.Model = "legacy-update"
	if w := aiRequest(t, a, "PUT", "/api/settings/ai", view); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if p := a.ai.settingsSnapshot().Providers; len(p.Text) != 2 || p.Text[0].Config.Model != "legacy-update" || p.Text[1].Config.APIKey != "secret-text-b" {
		t.Fatal("legacy update corrupted provider list")
	}
}

func TestAIProviderValidationAndCredentialIsolation(t *testing.T) {
	a := aiFixture(t)
	c := twoProviders("https://example.com")
	if w := aiRequest(t, a, "PUT", "/api/settings/ai", c); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	before := a.ai.settingsSnapshot()
	if response := aiRequest(t, a, "GET", "/api/settings/ai", nil).Body.String(); strings.Contains(response, "secret-") {
		t.Fatal("active or inactive provider credentials leaked")
	}
	for _, change := range []func(*aiSettings){
		func(c *aiSettings) { c.Providers.Defaults.Text = "missing" },
		func(c *aiSettings) { c.Providers.Image = nil },
		func(c *aiSettings) { c.Providers.Text[1].ID = "a" },
		func(c *aiSettings) { c.Providers.Text[1].Name = " " },
		func(c *aiSettings) { c.Providers.Text[1].Config.Protocol = "invalid" },
		func(c *aiSettings) { c.Providers.Image[1].Config.BaseURL = "file:///etc/passwd" },
		func(c *aiSettings) { c.Providers.TTS[1].Config.Extra["input"] = "override" },
		func(c *aiSettings) { c.Providers.TTS[1].Config.Timeout = 1 },
		func(c *aiSettings) { c.Providers.Text[1].Config.BaseURL += "/changed" },
		func(c *aiSettings) { c.Providers.Image[1].Config.BaseURL += "/changed" },
		func(c *aiSettings) { c.Providers.TTS[1].Config.BaseURL += "/changed" },
	} {
		view := providerView(t, a)
		change(&view)
		if w := aiRequest(t, a, "PUT", "/api/settings/ai", view); w.Code != 400 {
			t.Fatalf("invalid provider saved: %d %s", w.Code, w.Body.String())
		}
		if !reflect.DeepEqual(before, a.ai.settingsSnapshot()) {
			t.Fatal("failed validation modified saved settings")
		}
	}
	for _, group := range []string{"text", "image", "tts"} {
		for _, id := range []string{"a", "b", "new-provider"} {
			cfg, err := a.ai.providerPreview(providerSettingsRequest{Group: group, ProviderID: id, Config: modelConfig{BaseURL: "https://example.com/" + id}})
			if err != nil {
				t.Fatal(err)
			}
			want := "secret-" + group + "-" + id
			if id == "new-provider" {
				want = ""
			}
			if cfg.APIKey != want {
				t.Fatal("preview inherited another provider's key")
			}
		}
	}
	view := providerView(t, a)
	view.Providers.Text[1].Config.ClearKey = true
	view.Providers.Image[1].Config.APIKey = "replacement-key"
	if w := aiRequest(t, a, "PUT", "/api/settings/ai", view); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	stored := a.ai.settingsSnapshot().Providers
	if stored.Text[1].Config.APIKey != "" || stored.Text[0].Config.APIKey != "secret-text-a" || stored.Image[1].Config.APIKey != "replacement-key" || stored.TTS[1].Config.APIKey != "secret-tts-b" {
		t.Fatal("key update affected other providers")
	}
	view = providerView(t, a)
	view.Providers.Text = view.Providers.Text[:1]
	if w := aiRequest(t, a, "PUT", "/api/settings/ai", view); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if len(a.ai.settingsSnapshot().Providers.Text) != 1 {
		t.Fatal("provider deletion not persisted")
	}
}
