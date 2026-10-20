package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func nativeSpeechConfig(api string) ttsConfig {
	for _, a := range speechAdapters() {
		if a.capabilities.ID == api {
			c := a.capabilities.Defaults
			c.APIKey = "native-secret"
			c.Voice = "speaker-1"
			c.Format = "wav"
			return c
		}
	}
	panic("unknown API")
}
func TestNativeSpeechAdaptersAudioAndAuthentication(t *testing.T) {
	wav := speechWAV(t)
	for _, api := range []string{"doubao-tts", "doubao-audio"} {
		for _, auth := range []string{"api-key", "app-token"} {
			t.Run(api+"/"+auth, func(t *testing.T) {
				a := aiFixture(t)
				c := nativeSpeechConfig(api)
				c.AuthMode = auth
				c.AppID = "app-123"
				c.Speed = .85
				c.Instructions = "耐心讲课"
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "" || len(r.Header.Get("X-Api-Request-Id")) != 36 {
						t.Error("wrong native authentication/request ID")
					}
					if auth == "api-key" {
						if r.Header.Get("X-Api-Key") != "native-secret" || r.Header.Get("X-Api-Access-Key") != "" {
							t.Error("API key mode")
						}
					} else if r.Header.Get("X-Api-Key") != "" || r.Header.Get("X-Api-Access-Key") != "native-secret" || r.Header.Get("X-Api-App-Id") != "app-123" {
						t.Error("legacy auth mode")
					}
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					if api == "doubao-tts" {
						if r.URL.Path != "/api/v3/tts/unidirectional" || r.Header.Get("X-Api-Resource-Id") != "seed-tts-2.0" {
							t.Error("TTS route/resource")
						}
						params := body["req_params"].(map[string]any)
						audio := params["audio_params"].(map[string]any)
						if (params["text"] != "Hello，同学。" && !strings.Contains(params["text"].(string), "同学你好")) || params["speaker"] != "speaker-1" || audio["format"] != "pcm" || audio["speech_rate"] != float64(-15) || params["model"] != nil {
							t.Error("native TTS parameter mapping")
						}
						var additions map[string]any
						_ = json.Unmarshal([]byte(params["additions"].(string)), &additions)
						if additions["context_texts"].([]any)[0] != "耐心讲课" {
							t.Error("style mapping")
						}
						encoded := base64.StdEncoding.EncodeToString(wav[44:])
						// Deliberately split a JSON record across HTTP writes and omit newlines.
						first, _ := json.Marshal(map[string]any{"code": 0, "data": encoded})
						w.Write(first[:20])
						w.(http.Flusher).Flush()
						w.Write(first[20:])
						w.Write([]byte(`{"code":0,"sentence":{"text":"metadata"}}{"code":20000000}`))
					} else {
						if r.URL.Path != "/api/v3/tts/create" || r.Header.Get("X-Api-Resource-Id") != "" {
							t.Error("audio route")
						}
						if body["model"] != "seed-audio-1.0" || (!strings.Contains(body["text_prompt"].(string), "Hello，同学。") && !strings.Contains(body["text_prompt"].(string), "同学你好")) || !strings.Contains(body["text_prompt"].(string), "耐心讲课") || !strings.Contains(body["text_prompt"].(string), "@音频1") {
							t.Error("audio generation prompt")
						}
						if body["references"].([]any)[0].(map[string]any)["speaker"] != "speaker-1" || body["audio_config"].(map[string]any)["speech_rate"] != float64(-15) {
							t.Error("audio voice/speed")
						}
						jsonResponse(w, 200, map[string]any{"audio": base64.StdEncoding.EncodeToString(wav)})
					}
				}))
				defer provider.Close()
				c.BaseURL = provider.URL + "/api/v3"
				path := filepath.Join(t.TempDir(), "out.wav")
				if duration, err := a.ai.synthesizeSpeech(context.Background(), c, "Hello，同学。", path); err != nil || duration <= 0 {
					t.Fatalf("native synthesis: %v", err)
				}
				data, _ := os.ReadFile(path)
				if !bytes.Equal(data, wav) {
					t.Fatal("adapter changed output audio")
				}
				if w := aiRequest(t, a, "POST", "/api/settings/ai/providers/tts", map[string]any{"id": "native", "name": "原生语音", "config": c}); w.Code != 200 {
					t.Fatal(w.Body.String())
				}
				cfg := providerView(t, a).Providers.savedTTS("native")
				if cfg.APIKey != "" || !cfg.KeySet {
					t.Fatal("native key leaked")
				}
				if w := aiRequest(t, a, "POST", "/api/settings/ai/tts/preview", map[string]any{"providerId": "native", "config": cfg}); w.Code != 200 {
					t.Fatal(w.Body.String())
				}
				if w := aiRequest(t, a, "POST", "/api/settings/ai/models", providerSettingsRequest{Group: "tts", ProviderID: "native", APIType: "openai", Config: cfg.modelConfig}); w.Code != 400 {
					t.Fatal("model query reused a native credential for OpenAI")
				}
				cfg.APIType = "openai"
				cfg.Model = "other"
				if w := aiRequest(t, a, "POST", "/api/settings/ai/tts/preview", map[string]any{"providerId": "native", "config": cfg}); w.Code != 400 {
					t.Fatal("protocol change inherited native credentials")
				}
			})
		}
	}
}
func TestNativeSpeechFailuresNeverPublishPartialAudio(t *testing.T) {
	wav := speechWAV(t)
	cases := []struct {
		api, body string
		status    int
	}{
		{"doubao-tts", `{"code":0,"data":"` + base64.StdEncoding.EncodeToString(wav[44:]) + `"}`, 200},
		{"doubao-tts", `{"code":45000001,"message":"native-secret"}`, 200},
		{"doubao-tts", `{"code":0,"data":"???"}{"code":20000000}`, 200},
		{"doubao-tts", `{"data":"aaa"}`, 200},
		{"doubao-audio", `{"code":45001001,"message":"native-secret"}`, 200},
		{"doubao-audio", `{"audio":"???"}`, 200},
		{"doubao-audio", `{"url":"https://example.com/temporary.mp3"}`, 200},
		{"doubao-audio", `{"audio":"` + base64.StdEncoding.EncodeToString(wav) + `"} trailing`, 200},
		{"doubao-audio", `{"audio":"` + base64.StdEncoding.EncodeToString([]byte("invalid audio")) + `"}`, 200},
		{"doubao-audio", `{"message":"native-secret"}`, 401},
	}
	for _, tc := range cases {
		t.Run(tc.api+tc.body[:min(24, len(tc.body))], func(t *testing.T) {
			a := aiFixture(t)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); io.WriteString(w, tc.body) }))
			defer provider.Close()
			c := nativeSpeechConfig(tc.api)
			c.BaseURL = provider.URL
			path := filepath.Join(t.TempDir(), "out.wav")
			if _, err := a.ai.synthesizeSpeech(context.Background(), c, "hello", path); err == nil || strings.Contains(err.Error(), "native-secret") {
				t.Fatalf("invalid response accepted/secret leaked: %v", err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("failed audio published")
			}
		})
	}
}
func TestNativeSpeechValidationAndLimits(t *testing.T) {
	for _, api := range []string{"doubao-tts", "doubao-audio"} {
		for _, mutate := range []func(*ttsConfig){func(c *ttsConfig) { c.Speed = .25 }, func(c *ttsConfig) { c.Speed = 4 }, func(c *ttsConfig) { c.AuthMode = "invalid" }, func(c *ttsConfig) { c.Extra = map[string]any{"model": "override"} }, func(c *ttsConfig) {
			field := "audio_params"
			if api == "doubao-audio" {
				field = "audio_config"
			}
			c.Extra = map[string]any{field: map[string]any{"format": "mp3"}}
		}} {
			c := nativeSpeechConfig(api)
			mutate(&c)
			if err := validateTTS(c); err == nil {
				t.Fatal("invalid native options accepted")
			}
		}
	}
	w := &limitedSpeechWriter{writer: io.Discard, remaining: 2}
	if _, err := w.Write([]byte("123")); err == nil {
		t.Fatal("audio limit ignored")
	}
	a := aiFixture(t)
	c := nativeSpeechConfig("doubao-audio")
	c.BaseURL = "http://127.0.0.1:1"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if _, err := a.ai.synthesizeSpeech(ctx, c, "hello", filepath.Join(t.TempDir(), "cancel.wav")); err == nil || time.Since(start) > time.Second {
		t.Fatal("cancellation ignored")
	}
}

func TestNativeSpeechRejectsOversizedAndCancelledResponses(t *testing.T) {
	for _, mode := range []string{"oversized", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			a := aiFixture(t)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "cancelled" {
					io.WriteString(w, `{"code":0,"data":"AAAA"}`)
					w.(http.Flusher).Flush()
					<-r.Context().Done()
					return
				}
				frame, _ := json.Marshal(map[string]any{"code": 0, "data": base64.StdEncoding.EncodeToString(make([]byte, 1<<20))})
				for i := 0; i < 33; i++ {
					if _, err := w.Write(frame); err != nil {
						return
					}
				}
				io.WriteString(w, `{"code":20000000}`)
			}))
			defer provider.Close()
			c := nativeSpeechConfig("doubao-tts")
			c.BaseURL = provider.URL
			ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			if mode == "oversized" {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
			}
			defer cancel()
			path := filepath.Join(t.TempDir(), "output.wav")
			if _, err := a.ai.synthesizeSpeech(ctx, c, "hello", path); err == nil {
				t.Fatal("oversized/cancelled audio accepted")
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("partial audio published")
			}
		})
	}
}

func TestSeedAudioRejectsOversizedStyleAtSave(t *testing.T) {
	a := aiFixture(t)
	c := nativeSpeechConfig("doubao-audio")
	c.Instructions = strings.Repeat("讲", 2501)
	if w := aiRequest(t, a, "POST", "/api/settings/ai/providers/tts", map[string]any{"id": "audio", "name": "音频老师", "config": c}); w.Code != 400 || !strings.Contains(w.Body.String(), "2500") {
		t.Fatalf("oversized style saved: %d %s", w.Code, w.Body.String())
	}
	if len(providerView(t, a).Providers.TTS) != 1 {
		t.Fatal("rejected provider changed settings")
	}
	c.Instructions = strings.Repeat("讲", 2500)
	if err := validateTTS(c); err != nil {
		t.Fatal("valid style rejected", err)
	}
}
