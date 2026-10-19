package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func aiFixture(t *testing.T) *App {
	t.Helper()
	root := t.TempDir()
	a, err := New(Config{DataRoot: root, TextbookRoot: filepath.Join(root, "source")})
	if err != nil {
		t.Fatal(err)
	}
	l := TextLesson{Book: 1, Lesson: 1, TitleEn: "Whose bag?", Duration: 20, Revision: "audio-v1", Paragraphs: []TextParagraph{{ID: "p1", Sentences: []TextSentence{
		{ID: "s1", Text: "Is this your handbag?", Start: number(1), End: number(4), Words: []TextWord{{ID: "s1-w0", Text: "Is", Start: number(1), End: number(2)}, {ID: "s1-w1", Text: "this", Before: " ", Start: number(2), End: number(3)}}},
		{ID: "s2", Text: "Is this your handbag?", Start: number(5), End: number(8), Words: []TextWord{{ID: "s2-w0", Text: "Is", Start: number(5), End: number(6)}}},
	}}}, Vocabulary: []TextVocabulary{{ID: "v0", Word: "handbag", Meaning: "手提包"}}}
	if err = writeJSONAtomic(filepath.Join(a.libraryRoot(), "book1", "001.json"), l); err != nil {
		t.Fatal(err)
	}
	if err = writeJSONAtomic(filepath.Join(a.libraryRoot(), "book1", "index.json"), TextBook{Book: 1, Lessons: []TextLessonSummary{{Lesson: 1}}}); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(a.cfg.TextbookRoot, "audio/book1"), 0750); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(a.cfg.TextbookRoot, audioRelative(1, 1)), []byte("audio fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	return a
}
func aiRequest(t *testing.T, a *App, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var raw string
	if body != nil {
		b, _ := json.Marshal(body)
		raw = string(b)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, req)
	return w
}
func jobFromResponse(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var data struct {
		JobID string `json:"jobId"`
	}
	if json.Unmarshal(w.Body.Bytes(), &data) != nil || data.JobID == "" {
		t.Fatalf("expected job, got %d %s", w.Code, w.Body.String())
	}
	return data.JobID
}
func waitAIJob(t *testing.T, a *App, id string) jobSnapshot {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		a.ai.mu.Lock()
		j := a.ai.jobs[id]
		a.ai.mu.Unlock()
		state := j.snapshot()
		if state.Status != "running" {
			return state
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("AI job timed out")
	return jobSnapshot{}
}
func setProvider(a *App, base, protocol string, stream bool) {
	a.ai.mu.Lock()
	defer a.ai.mu.Unlock()
	a.ai.settings.Text.modelConfig = modelConfig{BaseURL: base, APIKey: "text-secret", Model: "test-model"}
	a.ai.settings.Text.Protocol = protocol
	a.ai.settings.Text.Stream = stream
}
func chatJSON(w http.ResponseWriter, text string) {
	jsonResponse(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": text}}}, "usage": map[string]int{"total_tokens": 12}})
}
func responseJSON(w http.ResponseWriter, text string) {
	jsonResponse(w, 200, map[string]any{"status": "completed", "output": []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]string{"type": "output_text", "text": text}}}}})
}
func TestAISettingsKeepSecretsAndPersist(t *testing.T) {
	a := aiFixture(t)
	c := defaultAISettings()
	c.Text.APIKey = "private-key"
	c.Text.BaseURL = "https://example.com/v1"
	c.Text.Model = "model"
	c.Image.APIKey = "image-key"
	if w := aiRequest(t, a, "PUT", "/api/settings/ai", c); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w := aiRequest(t, a, "GET", "/api/settings/ai", nil)
	if strings.Contains(w.Body.String(), "private-key") || strings.Contains(w.Body.String(), "image-key") || !strings.Contains(w.Body.String(), `"keySet":true`) {
		t.Fatal("settings exposed or lost key status")
	}
	c.Text.APIKey = ""
	c.Image.APIKey = ""
	if w := aiRequest(t, a, "PUT", "/api/settings/ai", c); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if a.ai.settingsSnapshot().Text.APIKey != "private-key" {
		t.Fatal("blank update cleared secret")
	}
	info, err := os.Stat(filepath.Join(a.ai.root, "settings.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("settings permissions")
	}
	restarted, err := New(a.cfg)
	if err != nil || restarted.ai.settingsSnapshot().Text.APIKey != "private-key" {
		t.Fatal("settings did not survive restart")
	}
	c.Text.ClearKey = true
	aiRequest(t, a, "PUT", "/api/settings/ai", c)
	if a.ai.settingsSnapshot().Text.APIKey != "" {
		t.Fatal("explicit clear failed")
	}
	req := httptest.NewRequest("PUT", "/api/settings/ai", strings.NewReader("{}"))
	req.Header.Set("Origin", "https://untrusted.example")
	w = httptest.NewRecorder()
	a.Handler().ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatal("cross-origin settings mutation allowed")
	}
	c.Text.BaseURL = "file:///etc/passwd"
	if aiRequest(t, a, "PUT", "/api/settings/ai", c).Code != 400 {
		t.Fatal("invalid base URL allowed")
	}
}
func TestAIExplanationCachePersonalizationAndFailures(t *testing.T) {
	a := aiFixture(t)
	var calls atomic.Int32
	var fail atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		if !fail.Load() && mockRequiredAIToolRead(w, input) {
			return
		}
		calls.Add(1)
		if fail.Load() {
			http.Error(w, "text-secret upstream credentials", 401)
			return
		}
		encoded, _ := json.Marshal(input)
		if strings.Contains(string(encoded), "learningContext") || !strings.Contains(string(encoded), "handbag") {
			t.Error("context was injected or lesson tool result missing")
		}
		chatJSON(w, "# 详解\n这是个性化解释。")
	}))
	defer provider.Close()
	setProvider(a, provider.URL, "chat", false)
	req := explainRequest{Book: 1, Lesson: 1, Target: aiTarget{Kind: "lesson"}, Active: map[string]any{"position": 3, "sentence": "s1"}}
	first := waitAIJob(t, a, jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", req)))
	if first.Status != "done" {
		t.Fatal(first.Error)
	}
	result := copyValue(first.Result).(map[string]any)
	id := result["id"].(string)
	a.ai.mu.Lock()
	a.ai.settings.Prompts.System = "changed"
	a.ai.settings.Text.Model = "changed-model"
	a.ai.mu.Unlock()
	w := aiRequest(t, a, "POST", "/api/ai/explanations", req)
	if w.Code != 200 || calls.Load() != 1 {
		t.Fatalf("configuration change missed cache: %d %d", w.Code, calls.Load())
	}
	req.Active["position"] = 9
	w = aiRequest(t, a, "POST", "/api/ai/explanations", req)
	if w.Code != 200 || calls.Load() != 1 {
		t.Fatal("playback progress invalidated cache")
	}
	a.ai.mu.Lock()
	p := copyValue(a.ai.state.Profile.profileData)
	p.Level = 1
	a.ai.applyProfile(p, "test")
	a.ai.mu.Unlock()
	second := waitAIJob(t, a, jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", req)))
	if second.Status != "done" || calls.Load() != 2 {
		t.Fatal("profile change did not separate cache")
	}
	restarted, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(restarted.ai.explanationPath(id)); err != nil {
		t.Fatal("cache did not persist")
	}
	fail.Store(true)
	req.Regenerate = true
	failed := waitAIJob(t, a, jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", req)))
	if failed.Status != "error" || strings.Contains(failed.Error, "text-secret") {
		t.Fatal("failure not sanitized")
	}
	req.Regenerate = false
	w = aiRequest(t, a, "POST", "/api/ai/explanations", req)
	if w.Code != 200 {
		t.Fatal("failed regeneration destroyed prior result")
	}
	query := "/api/ai/explanations?book=1&lesson=1&target=" + url.QueryEscape(`{"kind":"lesson"}`)
	w = aiRequest(t, a, "GET", query, nil)
	if !strings.Contains(w.Body.String(), "history") {
		t.Fatal("missing historical personalized result")
	}
	req.Target = aiTarget{Kind: "selection", ID: "s1", EndID: "s1", Text: "unrelated instructions"}
	if aiRequest(t, a, "POST", "/api/ai/explanations", req).Code != 400 {
		t.Fatal("accepted unrelated selection")
	}
}
func TestAIConcurrentGenerationAndSnapshotStream(t *testing.T) {
	a := aiFixture(t)
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(started)
		<-release
		chatJSON(w, "completed")
	}))
	defer provider.Close()
	setProvider(a, provider.URL, "chat", false)
	req := explainRequest{Book: 1, Lesson: 1, Target: aiTarget{Kind: "sentence", ID: "s1"}}
	id1 := jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", req))
	<-started
	id2 := jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", req))
	if id1 != id2 {
		t.Fatal("concurrent requests were not coalesced")
	}
	close(release)
	if waitAIJob(t, a, id1).Status != "done" || calls.Load() != 1 {
		t.Fatal("duplicate provider call")
	}
	w := aiRequest(t, a, "GET", "/api/ai/jobs/"+id1+"/events", nil)
	if w.Header().Get("Content-Type") != "text/event-stream" || !strings.Contains(w.Body.String(), "event: snapshot") || !strings.Contains(w.Body.String(), `"status":"done"`) {
		t.Fatal("cannot reconnect to snapshot stream")
	}
}
func TestAIProtocolsStreamingAndImageTools(t *testing.T) {
	for _, protocol := range []string{"chat", "responses"} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/%v", protocol, stream), func(t *testing.T) {
				a := aiFixture(t)
				var textCalls, imageCalls atomic.Int32
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var input map[string]any
					_ = json.NewDecoder(r.Body).Decode(&input)
					if r.Header.Get("Authorization") != "Bearer text-secret" && r.Header.Get("Authorization") != "Bearer image-secret" {
						t.Error("missing provider authorization")
					}
					if r.URL.Path == "/images/generations" {
						imageCalls.Add(1)
						png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
						jsonResponse(w, 200, map[string]any{"data": []any{map[string]string{"b64_json": base64.StdEncoding.EncodeToString(png)}}})
						return
					}
					n := textCalls.Add(1)
					call := map[string]any{"id": "call-1", "type": "function", "function": map[string]string{"name": "generate_image", "arguments": `{"prompt":"a handbag on a table","caption":"手提包"}`}}
					if n == 1 {
						if _, ok := input["tools"]; !ok {
							t.Error("image tool not registered")
						}
					}
					if protocol == "chat" {
						if !stream {
							if n == 1 {
								jsonResponse(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "tool_calls", "message": map[string]any{"role": "assistant", "content": "", "tool_calls": []any{call}}}}})
							} else {
								messages := input["messages"].([]any)
								if !strings.Contains(fmt.Sprint(messages), "tool_call_id:call-1") {
									t.Error("tool output missing call ID")
								}
								chatJSON(w, "图片已生成，继续详解。")
							}
							return
						}
						w.Header().Set("Content-Type", "text/event-stream")
						if n == 1 {
							for _, args := range []string{`{"prompt":"a handbag`, ` on a table","caption":"手提包"}`} {
								chunk := map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call-1", "function": map[string]string{"name": "", "arguments": args}}}}}}}
								if strings.HasPrefix(args, `{"prompt`) {
									chunk["choices"].([]any)[0].(map[string]any)["delta"].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)["function"].(map[string]string)["name"] = "generate_image"
								}
								b, _ := json.Marshal(chunk)
								fmt.Fprintf(w, "data: %s\n\n", b)
							}
							fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
						} else {
							fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"流式详解\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
						}
						return
					}
					if n == 1 {
						obj := map[string]any{"status": "completed", "output": []any{map[string]any{"type": "reasoning", "id": "reasoning-1", "encrypted_content": "opaque"}, map[string]string{"type": "function_call", "call_id": "call-1", "name": "generate_image", "arguments": `{"prompt":"a handbag on a table","caption":"手提包"}`}}}
						if stream {
							w.Header().Set("Content-Type", "text/event-stream")
							b, _ := json.Marshal(map[string]any{"type": "response.completed", "response": obj})
							fmt.Fprintf(w, "data: %s\n\n", b)
						} else {
							jsonResponse(w, 200, obj)
						}
					} else {
						serialized, _ := json.Marshal(input)
						if !strings.Contains(string(serialized), "reasoning-1") || !strings.Contains(string(serialized), "function_call_output") {
							t.Error("Responses continuation lost reasoning or tool result")
						}
						if stream {
							w.Header().Set("Content-Type", "text/event-stream")
							response := map[string]any{"status": "completed", "output": []any{map[string]any{"type": "message", "content": []any{map[string]string{"type": "output_text", "text": "Responses 详解"}}}}}
							fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Responses 详解\"}\n\n")
							b, _ := json.Marshal(map[string]any{"type": "response.completed", "response": response})
							fmt.Fprintf(w, "data: %s\n\n", b)
						} else {
							responseJSON(w, "Responses 详解")
						}
					}
				}))
				defer provider.Close()
				setProvider(a, provider.URL, protocol, stream)
				a.ai.mu.Lock()
				a.ai.settings.Image.Enabled = true
				a.ai.settings.Image.modelConfig = modelConfig{BaseURL: provider.URL, APIKey: "image-secret", Model: "image-model"}
				a.ai.mu.Unlock()
				state := waitAIJob(t, a, jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", explainRequest{Book: 1, Lesson: 1, Target: aiTarget{Kind: "sentence", ID: "s1"}})))
				if state.Status != "done" {
					t.Fatal(state.Error)
				}
				if textCalls.Load() != 2 || imageCalls.Load() != 1 {
					t.Fatalf("calls: text %d images %d", textCalls.Load(), imageCalls.Load())
				}
				result := copyValue(state.Result).(map[string]any)
				image := result["images"].([]any)[0].(map[string]any)
				w := aiRequest(t, a, "GET", image["url"].(string), nil)
				if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "image/png") {
					t.Fatalf("image unavailable: %d", w.Code)
				}
			})
		}
	}
}
func TestProgressFieldConflictsMigrationAndRestart(t *testing.T) {
	a := aiFixture(t)
	patch := progressPatch{OperationID: "op-1", Track: "text", ID: "1:1", Base: map[string]uint64{}, Values: map[string]any{"position": 2, "duration": 20, "completed": true}}
	w := aiRequest(t, a, "PATCH", "/api/learner/progress", map[string]any{"patches": []progressPatch{patch}})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	revision := a.ai.state.Progress.Revision
	aiRequest(t, a, "PATCH", "/api/learner/progress", map[string]any{"patches": []progressPatch{patch}})
	if a.ai.state.Progress.Revision != revision {
		t.Fatal("duplicate operation reapplied")
	}
	patch.OperationID = "stale-op"
	patch.Values = map[string]any{"completed": false, "sentence": "s2"}
	w = aiRequest(t, a, "PATCH", "/api/learner/progress", map[string]any{"patches": []progressPatch{patch}})
	if !strings.Contains(w.Body.String(), "conflicts") || a.ai.state.Progress.Tracks["text"]["1:1"].Values["completed"] != true || a.ai.state.Progress.Tracks["text"]["1:1"].Values["sentence"] != "s2" {
		t.Fatal("field conflict lost unrelated update or completion")
	}
	patch.OperationID = "legacy-import"
	patch.Migration = true
	patch.Values = map[string]any{"position": 19}
	aiRequest(t, a, "PATCH", "/api/learner/progress", map[string]any{"patches": []progressPatch{patch}})
	if a.ai.state.Progress.Tracks["text"]["1:1"].Values["position"] != float64(2) {
		t.Fatal("migration overwrote server progress")
	}
	restarted, err := New(a.cfg)
	if err != nil || restarted.ai.state.Progress.Revision != a.ai.state.Progress.Revision {
		t.Fatal("progress did not persist")
	}
}
func TestAdaptiveAssessmentHidesAnswerResumesAndHonorsLocks(t *testing.T) {
	a := aiFixture(t)
	var calls atomic.Int32
	var sawUnknownInQuestion, sawUnknownInEvaluation atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		if mockRequiredAIToolRead(w, input) {
			return
		}
		calls.Add(1)
		messages := input["messages"].([]any)
		last := messages[len(messages)-1].(map[string]any)["content"].(string)
		var payload struct {
			PriorAnswers []assessmentAnswer `json:"priorAnswers"`
			Evidence     []assessmentAnswer `json:"evidence"`
		}
		_ = json.Unmarshal([]byte(last), &payload)
		for _, answer := range payload.PriorAnswers {
			if answer.Unknown && answer.Choice == -2 && !answer.Correct && !answer.Skipped {
				sawUnknownInQuestion.Store(true)
			}
		}
		if len(payload.Evidence) > 0 {
			unknown := 0
			for _, answer := range payload.Evidence {
				if answer.Unknown && answer.Choice == -2 && !answer.Correct && !answer.Skipped {
					unknown++
				}
			}
			sawUnknownInEvaluation.Store(unknown == 4)
			chatJSON(w, `{"level":2,"abilities":{"vocabulary":2,"grammar":2,"reading":2,"listening":2},"weaknesses":["时态"],"reason":"依据测评答题记录"}`)
			return
		}
		chatJSON(w, `{"text":"请选择正确答案","options":["this","these","those","them"],"answer":0,"explanation":"this 指代单数","difficulty":1,"audioIndex":0}`)
	}))
	defer provider.Close()
	setProvider(a, provider.URL, "chat", false)
	a.ai.mu.Lock()
	p := copyValue(a.ai.state.Profile.profileData)
	p.Abilities["vocabulary"] = ability{Level: 0, Source: "manual", Locked: true}
	a.ai.applyProfile(p, "manual")
	a.ai.mu.Unlock()
	w := aiRequest(t, a, "POST", "/api/assessments", map[string]bool{"new": true})
	job := jobFromResponse(t, w)
	state := waitAIJob(t, a, job)
	if state.Status != "done" {
		t.Fatal(state.Error)
	}
	var created struct {
		Session struct {
			ID string `json:"id"`
		} `json:"session"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	id := created.Session.ID
	w = aiRequest(t, a, "GET", "/api/assessments/"+id, nil)
	if strings.Contains(w.Body.String(), `"answer":0`) || strings.Contains(w.Body.String(), "this 指代单数") {
		t.Fatal("unanswered assessment leaked key or explanation")
	}
	for i := 0; i < 16; i++ {
		a.ai.mu.Lock()
		q := copyValue(*a.ai.state.Assessments[id].Question)
		a.ai.mu.Unlock()
		if q.Dimension != dimensions[i%4] {
			t.Fatal("assessment dimensions not balanced")
		}
		choice := 0
		if q.Unavailable {
			choice = -1
		}
		answer := map[string]any{"questionId": q.ID, "choice": choice}
		if i < 4 && !q.Unavailable {
			delete(answer, "choice")
			answer["unknown"] = true
		}
		w = aiRequest(t, a, "POST", "/api/assessments/"+id+"/answers", answer)
		state = waitAIJob(t, a, jobFromResponse(t, w))
		if state.Status != "done" {
			t.Fatal(state.Error)
		}
		before := calls.Load()
		replay := aiRequest(t, a, "POST", "/api/assessments/"+id+"/answers", answer)
		if replay.Code != 200 || calls.Load() != before {
			t.Fatal("answer replay regenerated question")
		}
	}
	if !sawUnknownInQuestion.Load() || !sawUnknownInEvaluation.Load() {
		t.Fatal("unknown answers were not supplied to adaptive questions and final evaluation")
	}
	restarted, err := New(a.cfg)
	if err != nil || !restarted.ai.state.Assessments[id].Answers[0].Unknown {
		t.Fatal("unknown answer did not survive restart")
	}
	a.ai.mu.Lock()
	defer a.ai.mu.Unlock()
	if len(a.ai.state.Assessments[id].Answers) != 16 || a.ai.state.Assessments[id].Status != "done" || a.ai.state.Profile.Level != 2 {
		t.Fatal("assessment did not complete and update profile")
	}
	if a.ai.state.Profile.Abilities["vocabulary"].Level != 0 || a.ai.state.Profile.Abilities["speaking"].Level != -1 {
		t.Fatal("evaluation overwrote lock or untested ability")
	}
	if a.ai.state.Profile.Abilities["grammar"].Level != 2 {
		t.Fatal("unknown answers must count as answered evidence, rather than unscored skips")
	}
	if len(a.ai.state.Progress.Tracks) != 0 {
		t.Fatal("assessment modified course progress")
	}
}

func TestAssessmentRejectsMissingOrConflictingUnknownAnswers(t *testing.T) {
	a := aiFixture(t)
	a.ai.state.Assessments["session"] = &assessmentSession{ID: "session", Status: "active", Question: &assessmentQuestion{ID: "q1", Dimension: "grammar", Options: []string{"a", "b", "c", "d"}}}
	for _, answer := range []map[string]any{
		{"questionId": "q1"},
		{"questionId": "q1", "choice": 0, "unknown": true},
		{"questionId": "q1", "choice": -2},
		{"questionId": "q1", "choice": 4},
	} {
		w := aiRequest(t, a, "POST", "/api/assessments/session/answers", answer)
		if w.Code < 400 || len(a.ai.state.Assessments["session"].Answers) != 0 || a.ai.state.Assessments["session"].Question == nil {
			t.Fatalf("invalid answer recorded: %d %s", w.Code, w.Body.String())
		}
	}
}
func TestImageFailureKeepsPreviousVersionAndDownloadHasNoKey(t *testing.T) {
	a := aiFixture(t)
	var fail atomic.Bool
	var downloaded atomic.Bool
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	download := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloaded.Store(true)
		if r.Header.Get("Authorization") != "" {
			t.Error("API key forwarded to image host")
		}
		w.Write(png)
	}))
	defer download.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "secret", 500)
			return
		}
		jsonResponse(w, 200, map[string]any{"data": []any{map[string]string{"url": download.URL + "/image"}}})
	}))
	defer provider.Close()
	cfg := defaultAISettings()
	cfg.Image.modelConfig = modelConfig{BaseURL: provider.URL, APIKey: "image-secret", Model: "image"}
	im := aiImage{ID: contentHash("image"), Prompt: "a bag", Caption: "bag"}
	result, err := a.ai.makeImage(context.Background(), cfg, im, false)
	if err != nil || !downloaded.Load() {
		t.Fatalf("download image: %v", err)
	}
	fail.Store(true)
	if _, err = a.ai.makeImage(context.Background(), cfg, result, true); err == nil {
		t.Fatal("expected image failure")
	}
	var after aiImage
	if loadJSON(filepath.Join(a.ai.root, "images", im.ID+".json"), &after) != nil || after.Version != result.Version {
		t.Fatal("failed regeneration replaced prior image")
	}
	if aiRequest(t, a, "GET", result.URL, nil).Code != 200 {
		t.Fatal("old image lost after failure")
	}
}

func TestFeedbackAutomaticallyUpdatesOnlyEvidencedAbilitiesAndCanUndo(t *testing.T) {
	a := aiFixture(t)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		if mockRequiredAIToolRead(w, input) {
			return
		}
		calls.Add(1)
		chatJSON(w, `{"level":4,"abilities":{"vocabulary":4,"grammar":4,"reading":4,"listening":4},"weaknesses":["定语从句"],"reason":"三次语法困难反馈，增加语法支持"}`)
	}))
	defer provider.Close()
	setProvider(a, provider.URL, "chat", false)
	a.ai.mu.Lock()
	p := copyValue(a.ai.state.Profile.profileData)
	p.Level = 1
	for _, d := range dimensions[:4] {
		p.Abilities[d] = ability{Level: 1, Source: "assessment"}
	}
	p.Abilities["vocabulary"] = ability{Level: 1, Source: "manual", Locked: true}
	a.ai.applyProfile(p, "initial assessment")
	a.ai.mu.Unlock()
	var last string
	for i := 0; i < 3; i++ {
		last = contentHash(fmt.Sprint("explanation", i))
		if err := writeJSONAtomic(a.ai.explanationPath(last), explanation{ID: last}); err != nil {
			t.Fatal(err)
		}
		w := aiRequest(t, a, "POST", "/api/learner/feedback", learningFeedback{ExplanationID: last, Rating: "hard", Dimension: "grammar"})
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		if i == 2 {
			state := waitAIJob(t, a, jobFromResponse(t, w))
			if state.Status != "done" {
				t.Fatal(state.Error)
			}
		}
	}
	a.ai.mu.Lock()
	profile := copyValue(a.ai.state.Profile)
	a.ai.mu.Unlock()
	if profile.Level != 2 || profile.Abilities["grammar"].Level != 2 || profile.Abilities["reading"].Level != 1 || profile.Abilities["vocabulary"].Level != 1 || profile.Abilities["speaking"].Level != -1 || profile.Style != "foundation" {
		t.Fatalf("unexpected adaptive profile: %+v", profile)
	}
	aiRequest(t, a, "POST", "/api/learner/feedback", learningFeedback{ExplanationID: last, Rating: "hard", Dimension: "grammar"})
	if calls.Load() != 1 {
		t.Fatal("repeated feedback charged another evaluation")
	}
	w := aiRequest(t, a, "PUT", "/api/learner/profile", map[string]any{"undoId": profile.History[0].ID, "revision": profile.Revision})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	a.ai.mu.Lock()
	restored := a.ai.state.Profile.Level
	a.ai.mu.Unlock()
	if restored != 1 {
		t.Fatal("cannot undo AI ability update")
	}
}

func TestTruncatedAndInvalidToolResponsesNeverBecomeSuccessfulCache(t *testing.T) {
	for _, finish := range []string{"length", "broken-stream"} {
		t.Run(finish, func(t *testing.T) {
			a := aiFixture(t)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if finish == "length" {
					jsonResponse(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "length", "message": map[string]string{"role": "assistant", "content": "partial"}}}})
				} else {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
				}
			}))
			defer provider.Close()
			setProvider(a, provider.URL, "chat", true)
			state := waitAIJob(t, a, jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", explainRequest{Book: 1, Lesson: 1, Target: aiTarget{Kind: "lesson"}})))
			if state.Status != "error" {
				t.Fatal("partial content marked complete")
			}
			files, _ := filepath.Glob(filepath.Join(a.ai.root, "explanations", "*.json"))
			if len(files) != 0 {
				t.Fatal("partial answer cached")
			}
		})
	}
}

func TestImageToolBudgetIsEnforcedOnMultipleCalls(t *testing.T) {
	a := aiFixture(t)
	var calls, images atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/images/generations" {
			images.Add(1)
			jsonResponse(w, 200, map[string]any{"data": []any{map[string]string{"b64_json": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}}})
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if calls.Add(1) == 1 {
			list := []any{}
			for i := 0; i < 3; i++ {
				list = append(list, map[string]any{"id": fmt.Sprint("call-", i), "type": "function", "function": map[string]string{"name": "generate_image", "arguments": `{"prompt":"bag","caption":"手提包"}`}})
			}
			jsonResponse(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "tool_calls", "message": map[string]any{"role": "assistant", "content": "", "tool_calls": list}}}})
		} else {
			for _, tool := range body["tools"].([]any) {
				if tool.(map[string]any)["function"].(map[string]any)["name"] == "generate_image" {
					t.Error("image tool still enabled after its budget was reached")
				}
			}
			chatJSON(w, "完成文字解释")
		}
	}))
	defer provider.Close()
	setProvider(a, provider.URL, "chat", false)
	a.ai.mu.Lock()
	a.ai.settings.Image.Enabled = true
	a.ai.settings.Image.MaxCalls = 1
	a.ai.settings.Image.modelConfig = modelConfig{BaseURL: provider.URL, Model: "image"}
	a.ai.mu.Unlock()
	state := waitAIJob(t, a, jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", explainRequest{Book: 1, Lesson: 1, Target: aiTarget{Kind: "sentence", ID: "s1"}})))
	if state.Status != "done" || images.Load() != 1 || calls.Load() != 2 {
		t.Fatalf("tool budget failed: %s %d images %d text", state.Error, images.Load(), calls.Load())
	}
}
