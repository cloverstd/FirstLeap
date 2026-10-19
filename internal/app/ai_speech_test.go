package app

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func speechWAV(t *testing.T) []byte {
	t.Helper()
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe required")
	}
	var b bytes.Buffer
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(36+4800))
	b.WriteString("WAVEfmt ")
	_ = binary.Write(&b, binary.LittleEndian, uint32(16))
	_ = binary.Write(&b, binary.LittleEndian, uint16(1))
	_ = binary.Write(&b, binary.LittleEndian, uint16(1))
	_ = binary.Write(&b, binary.LittleEndian, uint32(24000))
	_ = binary.Write(&b, binary.LittleEndian, uint32(48000))
	_ = binary.Write(&b, binary.LittleEndian, uint16(2))
	_ = binary.Write(&b, binary.LittleEndian, uint16(16))
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, uint32(4800))
	b.Write(make([]byte, 4800))
	return b.Bytes()
}

func speechFixture(t *testing.T, a *App, base string) explanation {
	t.Helper()
	c := a.ai.settingsSnapshot()
	c.Text.modelConfig = modelConfig{BaseURL: base, APIKey: "text-private", Model: "lecture-model"}
	c.Text.Stream = false
	c.TTS = defaultTTSConfig()
	c.TTS.modelConfig = modelConfig{BaseURL: base, APIKey: "tts-private", Model: "speech-model"}
	c.TTS.Enabled, c.TTS.Format, c.TTS.Voice = true, "wav", "teacher"
	c.TTS.Instructions, c.TTS.InstructionField = "耐心讲课", "instruct"
	c.TTS.Extra = map[string]any{"lang_code": "zh"}
	if w := aiRequest(t, a, "PUT", "/api/settings/ai", c); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	e := explanation{ID: uniqueID(), Content: "# 现在进行时\n\n**I am learning English.** 我正在学习英语。", Images: []aiImage{}}
	e.ContentVersion = contentHash(e.Content)
	if err := writeJSONAtomic(a.ai.explanationPath(e.ID), e); err != nil {
		t.Fatal(err)
	}
	return e
}

func readSpeechView(t *testing.T, a *App, e explanation) speechView {
	t.Helper()
	w := aiRequest(t, a, "GET", "/api/ai/explanations/"+e.ID+"/speech?version="+e.ContentVersion, nil)
	var v speechView
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &v) != nil {
		t.Fatalf("speech lookup: %d %s", w.Code, w.Body.String())
	}
	return v
}

func startSpeech(t *testing.T, a *App, e explanation, regenerate, retry bool) string {
	t.Helper()
	w := aiRequest(t, a, "POST", "/api/ai/explanations/"+e.ID+"/speech", map[string]any{"contentVersion": e.ContentVersion, "regenerate": regenerate, "retry": retry})
	return jobFromResponse(t, w)
}

func TestSpeechSettingsSecretsAndLegacyUpdates(t *testing.T) {
	a := aiFixture(t)
	c := a.ai.settingsSnapshot()
	c.TTS.modelConfig = modelConfig{BaseURL: "http://localhost:8001/v1", APIKey: "tts-private", Model: "teacher"}
	c.TTS.Enabled = true
	if aiRequest(t, a, "PUT", "/api/settings/ai", c).Code != 200 {
		t.Fatal("could not save TTS")
	}
	w := aiRequest(t, a, "GET", "/api/settings/ai", nil)
	if strings.Contains(w.Body.String(), "tts-private") || !strings.Contains(w.Body.String(), `"keySet":true`) {
		t.Fatal("TTS secret exposed")
	}
	// An older client does not know the TTS block or lecture prompt.
	legacy := map[string]any{"enabledTools": []string{}}
	if aiRequest(t, a, "PUT", "/api/settings/ai", legacy).Code != 200 || a.ai.settingsSnapshot().TTS.APIKey != "tts-private" {
		t.Fatal("legacy save lost TTS settings")
	}
	c = a.ai.settingsSnapshot()
	c.TTS.APIKey, c.TTS.BaseURL = "", "http://localhost:8002/v1"
	if aiRequest(t, a, "PUT", "/api/settings/ai", c).Code != 400 {
		t.Fatal("stored key could be sent to a different server")
	}
	c.TTS.ClearKey = true
	if aiRequest(t, a, "PUT", "/api/settings/ai", c).Code != 200 || a.ai.settingsSnapshot().TTS.APIKey != "" {
		t.Fatal("could not explicitly clear TTS key")
	}
	c.TTS.Extra["input"] = "override"
	if aiRequest(t, a, "PUT", "/api/settings/ai", c).Code != 400 {
		t.Fatal("extra parameters could override the lecture")
	}
	// Existing files without TTS receive defaults on startup.
	if err := writeJSONAtomic(filepath.Join(a.ai.root, "settings.json"), map[string]any{"enabledTools": []string{}}); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(a.cfg)
	if err != nil || restarted.ai.settingsSnapshot().TTS.Speed != 1 || restarted.ai.settingsSnapshot().TTS.Enabled {
		t.Fatal("old settings did not receive safe TTS defaults")
	}
}

func TestSpeechPipelineCacheReplacementAndRange(t *testing.T) {
	wav := speechWAV(t)
	a := aiFixture(t)
	var scripts, calls atomic.Int32
	var failing atomic.Bool
	gate := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		if r.URL.Path == "/chat/completions" {
			scripts.Add(1)
			chatJSON(w, strings.Repeat("我们先理解这个语法，再来看英文例句。", 22)+"I am learning English.")
			return
		}
		if r.URL.Path != "/audio/speech" || r.Header.Get("Authorization") != "Bearer tts-private" || input["instruct"] != "耐心讲课" || input["lang_code"] != "zh" || input["speed"] != float64(1) || input["response_format"] != "wav" {
			t.Error("unexpected speech request")
		}
		if calls.Add(1) == 1 {
			<-gate
		}
		if failing.Load() {
			http.Error(w, "tts-private upstream detail", 503)
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write(wav)
	}))
	defer provider.Close()
	e := speechFixture(t, a, provider.URL)
	id := startSpeech(t, a, e, false, false)
	if again := startSpeech(t, a, e, false, false); again != id {
		t.Fatal("concurrent speech generation was not merged")
	}
	close(gate)
	if state := waitAIJob(t, a, id); state.Status != "done" {
		t.Fatal(state.Error)
	}
	v := readSpeechView(t, a, e)
	if v.Audio == nil || v.Audio.Status != "ready" || len(v.Audio.Segments) < 2 || scripts.Load() != 1 {
		t.Fatal("lecture was not persisted in segments")
	}
	oldID, oldCalls := v.Audio.ID, calls.Load()
	req := httptest.NewRequest("GET", v.Audio.Segments[0].URL, nil)
	req.Header.Set("Range", "bytes=0-19")
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, req)
	if w.Code != 206 || w.Body.Len() != 20 || w.Header().Get("Content-Type") != "audio/wav" || w.Header().Get("ETag") == "" {
		t.Fatal("persisted speech does not support range playback")
	}
	info, err := os.Stat(filepath.Join(a.ai.speechDir(oldID), "0.wav"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("audio permissions")
	}
	restarted, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	cfg := restarted.ai.settingsSnapshot()
	cfg.TTS.Voice, cfg.TTS.APIKey = "new-teacher", ""
	if aiRequest(t, restarted, "PUT", "/api/settings/ai", cfg).Code != 200 {
		t.Fatal("could not change voice")
	}
	w = aiRequest(t, restarted, "POST", "/api/ai/explanations/"+e.ID+"/speech", map[string]any{"contentVersion": e.ContentVersion})
	if w.Code != 200 || readSpeechView(t, restarted, e).Audio.ID != oldID || calls.Load() != oldCalls {
		t.Fatal("restart or voice change missed audio cache")
	}
	failing.Store(true)
	state := waitAIJob(t, restarted, startSpeech(t, restarted, e, true, false))
	if state.Status != "error" || strings.Contains(state.Error, "tts-private") {
		t.Fatal("expected sanitized synthesis failure")
	}
	v = readSpeechView(t, restarted, e)
	if v.Audio.ID != oldID || v.Pending == nil || v.Pending.Status != "error" {
		t.Fatal("failed replacement lost old speech")
	}
	before := calls.Load()
	w = aiRequest(t, restarted, "POST", "/api/ai/explanations/"+e.ID+"/speech", map[string]any{"contentVersion": e.ContentVersion})
	if w.Code != 200 || calls.Load() != before {
		t.Fatal("opening failed speech retried a billed request")
	}
	failing.Store(false)
	if state = waitAIJob(t, restarted, startSpeech(t, restarted, e, false, true)); state.Status != "done" {
		t.Fatal(state.Error)
	}
	v = readSpeechView(t, restarted, e)
	if v.Audio.ID == oldID || v.Pending != nil || scripts.Load() != 1 {
		t.Fatal("replacement did not reuse lecture script")
	}
	if aiRequest(t, restarted, "POST", "/api/ai/explanations/"+e.ID+"/speech", map[string]any{"contentVersion": "outdated"}).Code != 409 {
		t.Fatal("outdated explanation could generate speech")
	}
}

func TestSpeechPartialResumeAndInvalidAudio(t *testing.T) {
	wav := speechWAV(t)
	a := aiFixture(t)
	var calls, scripts atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/chat/completions" {
			scripts.Add(1)
			chatJSON(w, strings.Repeat("我们来学习现在进行时。", 45))
			return
		}
		if calls.Add(1) == 2 {
			_, _ = w.Write([]byte(`{"error":"not audio"}`))
			return
		}
		_, _ = w.Write(wav)
	}))
	defer provider.Close()
	e := speechFixture(t, a, provider.URL)
	if state := waitAIJob(t, a, startSpeech(t, a, e, false, false)); state.Status != "error" {
		t.Fatal("invalid audio accepted")
	}
	v := readSpeechView(t, a, e)
	if v.Audio.Segments[0].URL == "" || v.Audio.Segments[1].URL != "" {
		t.Fatal("partial audio was not preserved")
	}
	oldURL := v.Audio.Segments[0].URL
	// Simulate process termination with a partially completed manifest.
	v.Audio.Status = "generating"
	if err := a.ai.saveSpeech(v.Audio); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if readSpeechView(t, restarted, e).Audio.Status != "interrupted" {
		t.Fatal("stale running state was not recognized")
	}
	if state := waitAIJob(t, restarted, startSpeech(t, restarted, e, false, false)); state.Status != "done" {
		t.Fatal(state.Error)
	}
	v = readSpeechView(t, restarted, e)
	if v.Audio.Segments[0].URL != oldURL || calls.Load() != int32(len(v.Audio.Segments)+1) || scripts.Load() != 1 {
		t.Fatal("resume regenerated saved segments or lecture")
	}
}

func TestNewExplanationAutomaticallyStartsSpeech(t *testing.T) {
	wav := speechWAV(t)
	a := aiFixture(t)
	var scripts atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/audio/speech" {
			_, _ = w.Write(wav)
			return
		}
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		if strings.Contains(input["messages"].([]any)[0].(map[string]any)["content"].(string), "你负责将已完成") {
			scripts.Add(1)
			chatJSON(w, "同学你好。I am learning English. 我正在学习英语。")
		} else {
			chatJSON(w, "# 详解\n这是句子详解。")
		}
	}))
	defer provider.Close()
	_ = speechFixture(t, a, provider.URL)
	c := a.ai.settingsSnapshot()
	c.EnabledTools = []string{}
	if aiRequest(t, a, "PUT", "/api/settings/ai", c).Code != 200 {
		t.Fatal("settings")
	}
	state := waitAIJob(t, a, jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", explainRequest{Book: 1, Lesson: 1, Target: aiTarget{Kind: "sentence", ID: "s1"}})))
	if state.Status != "done" {
		t.Fatal(state.Error)
	}
	var e explanation
	b, _ := json.Marshal(state.Result)
	_ = json.Unmarshal(b, &e)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		v := readSpeechView(t, a, e)
		if v.Audio != nil && v.Audio.Status == "ready" {
			if scripts.Load() != 1 {
				t.Fatal("automatic narration calls")
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("explanation did not automatically generate speech")
}

func TestSpeechSplitPreservesUnicodeAndWords(t *testing.T) {
	text := strings.Repeat("我们一起看这个例句。", 29) + "\n" + strings.Repeat("I am learning English. ", 30) + "\n末尾🙂"
	parts := splitSpeech(text)
	if len(parts) < 2 {
		t.Fatal("did not split long lecture")
	}
	for _, part := range parts {
		if !utf8.ValidString(part) || utf8.RuneCountInString(part) > 300 {
			t.Fatal("invalid split boundary")
		}
	}
	if strings.Join(strings.Fields(strings.Join(parts, " ")), " ") != strings.Join(strings.Fields(text), " ") {
		t.Fatal("split changed lecture content")
	}
}

func TestSpeechPreviewInstructionModesAndNoPersistence(t *testing.T) {
	wav := speechWAV(t)
	a := aiFixture(t)
	var expectedField string
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		if r.URL.Path != "/audio/speech" || r.Header.Get("Authorization") != "Bearer tts-private" || input["model"] != "speech-model" {
			t.Error("preview did not use draft settings and saved credentials")
		}
		if expectedField != "none" && input[expectedField] != "耐心讲课" {
			t.Error("instruction field mapping")
		}
		for _, field := range []string{"instructions", "instruct"} {
			if field != expectedField && input[field] != nil {
				t.Error("unsupported instruction field was sent")
			}
		}
		calls.Add(1)
		_, _ = w.Write(wav)
	}))
	defer provider.Close()
	_ = speechFixture(t, a, provider.URL)
	cfg := a.ai.settingsSnapshot().TTS
	cfg.APIKey = ""
	for _, field := range []string{"instructions", "instruct", "none"} {
		expectedField = field
		cfg.InstructionField = field
		w := aiRequest(t, a, "POST", "/api/settings/ai/tts/preview", map[string]any{"config": cfg})
		if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), wav) {
			t.Fatalf("preview: %d %s", w.Code, w.Body.String())
		}
	}
	if calls.Load() != 3 {
		t.Fatal("preview generated more than once")
	}
	if _, err := os.Stat(filepath.Join(a.ai.root, "speech")); !os.IsNotExist(err) {
		t.Fatal("preview persisted speech assets")
	}
	if a.ai.settingsSnapshot().TTS.InstructionField != "instruct" {
		t.Fatal("preview saved draft settings")
	}
}

func TestSpeechRejectsTruncatedLectureAndSerializesInference(t *testing.T) {
	wav := speechWAV(t)
	a := aiFixture(t)
	var truncated atomic.Bool
	var running, maximum atomic.Int32
	truncated.Store(true)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/chat/completions" {
			if truncated.Load() {
				jsonResponse(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "length", "message": map[string]any{"role": "assistant", "content": "不完整的讲稿"}}}})
			} else {
				chatJSON(w, "同学你好，今天我们来学习这个句子。")
			}
			return
		}
		n := running.Add(1)
		for old := maximum.Load(); n > old; old = maximum.Load() {
			if maximum.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(40 * time.Millisecond)
		running.Add(-1)
		_, _ = w.Write(wav)
	}))
	defer provider.Close()
	e := speechFixture(t, a, provider.URL)
	if state := waitAIJob(t, a, startSpeech(t, a, e, false, false)); state.Status != "error" || maximum.Load() != 0 {
		t.Fatal("truncated lecture was synthesized")
	}
	truncated.Store(false)
	other := e
	other.ID, other.Content = uniqueID(), "另一份详解"
	other.ContentVersion = contentHash(other.Content)
	if err := writeJSONAtomic(a.ai.explanationPath(other.ID), other); err != nil {
		t.Fatal(err)
	}
	first := startSpeech(t, a, e, false, true)
	second := startSpeech(t, a, other, false, false)
	for _, id := range []string{first, second} {
		if state := waitAIJob(t, a, id); state.Status != "done" {
			t.Fatal(state.Error)
		}
	}
	if maximum.Load() != 1 {
		t.Fatal("TTS inference exceeded one concurrent request")
	}
}
