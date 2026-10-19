package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

func mockAIToolReply(w http.ResponseWriter, protocol string, calls ...toolCall) {
	items := []any{}
	for _, call := range calls {
		if protocol == "responses" {
			items = append(items, map[string]any{"type": "function_call", "call_id": call.ID, "name": call.Name, "arguments": call.Arguments})
		} else {
			items = append(items, map[string]any{"type": "function", "id": call.ID, "function": map[string]any{"name": call.Name, "arguments": call.Arguments}})
		}
	}
	if protocol == "responses" {
		jsonResponse(w, 200, map[string]any{"status": "completed", "output": items})
	} else {
		jsonResponse(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "tool_calls", "message": map[string]any{"role": "assistant", "content": "", "tool_calls": items}}}})
	}
}

// Existing workflow tests focus on grading, caching and persistence. Let their
// provider doubles obtain the required task material before producing output.
func mockRequiredAIToolRead(w http.ResponseWriter, input map[string]any) bool {
	messages, _ := input["messages"].([]any)
	protocol := "chat"
	if messages == nil {
		messages, _ = input["input"].([]any)
		protocol = "responses"
	}
	var task map[string]any
	for _, message := range messages {
		m := message.(map[string]any)
		if m["role"] == "tool" || m["type"] == "function_call_output" {
			return false
		}
		if m["role"] == "user" {
			_ = json.Unmarshal([]byte(fmt.Sprint(m["content"])), &task)
		}
	}
	name := ""
	switch task["task"] {
	case "assessment":
		name = "get_assessment_context"
	case "evaluation":
		name = "get_evaluation_evidence"
	default:
		if target, ok := task["target"].(map[string]any); ok && target["kind"] == "lesson" {
			name = "get_current_lesson"
		}
	}
	if name == "" {
		return false
	}
	mockAIToolReply(w, protocol, toolCall{ID: "read-material", Name: name, Arguments: "{}"})
	return true
}

func TestAIToolSettingsCompatibilityAndEmptySelection(t *testing.T) {
	a := aiFixture(t)
	w := aiRequest(t, a, "GET", "/api/settings/ai", nil)
	var data struct {
		Settings aiSettings   `json:"settings"`
		Tools    []aiToolInfo `json:"tools"`
	}
	if json.Unmarshal(w.Body.Bytes(), &data) != nil || len(data.Tools) != 7 || !slices.Equal(data.Settings.EnabledTools, allAIToolIDs()) {
		t.Fatal("tool catalog or default selection missing")
	}
	legacy := copyValue(data.Settings)
	legacy.EnabledTools = nil
	if err := writeJSONAtomic(filepath.Join(a.ai.root, "settings.json"), legacy); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(a.cfg)
	if err != nil || !slices.Equal(restarted.ai.settingsSnapshot().EnabledTools, allAIToolIDs()) {
		t.Fatal("legacy settings did not enable all tools")
	}
	cfg := data.Settings
	cfg.EnabledTools = []string{}
	if aiRequest(t, a, "PUT", "/api/settings/ai", cfg).Code != 200 {
		t.Fatal("cannot disable all tools")
	}
	// An older client omits the new field: it must preserve an explicit all-off.
	oldClient := map[string]any{}
	b, _ := json.Marshal(cfg)
	_ = json.Unmarshal(b, &oldClient)
	delete(oldClient, "enabledTools")
	if aiRequest(t, a, "PUT", "/api/settings/ai", oldClient).Code != 200 || len(a.ai.settingsSnapshot().EnabledTools) != 0 {
		t.Fatal("old client reset the selection")
	}
	restarted, err = New(a.cfg)
	if err != nil || restarted.ai.settingsSnapshot().EnabledTools == nil || len(restarted.ai.settingsSnapshot().EnabledTools) != 0 {
		t.Fatal("all-off selection did not survive restart")
	}
	cfg.EnabledTools = []string{"not_supported"}
	if aiRequest(t, a, "PUT", "/api/settings/ai", cfg).Code != 400 {
		t.Fatal("unknown tool accepted")
	}
	cfg.EnabledTools = []string{"get_learning_progress", "get_learner_profile", "get_learning_progress"}
	if aiRequest(t, a, "PUT", "/api/settings/ai", cfg).Code != 200 || !slices.Equal(a.ai.settingsSnapshot().EnabledTools, []string{"get_learner_profile", "get_learning_progress"}) {
		t.Fatal("tool selection not canonicalized")
	}
}

func TestAIReadToolsAreOnDemandAcrossProtocols(t *testing.T) {
	for _, protocol := range []string{"chat", "responses"} {
		t.Run(protocol, func(t *testing.T) {
			a := aiFixture(t)
			a.ai.state.Profile.Goals = "profile-only-goal"
			a.ai.state.Progress.Tracks["text"] = map[string]progressRecord{"1:1": {Values: map[string]any{"completed": true, "position": 4.0}}}
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var input map[string]any
				_ = json.NewDecoder(r.Body).Decode(&input)
				encoded, _ := json.Marshal(input)
				switch calls.Add(1) {
				case 1:
					for _, secret := range []string{"profile-only-goal", "Whose bag?", "handbag", `"learningContext"`, `"saved"`, `"stage"`} {
						if strings.Contains(string(encoded), secret) {
							t.Errorf("initial request injected task data: %s", secret)
						}
					}
					if strings.Contains(string(encoded), "get_assessment_context") || strings.Contains(string(encoded), "get_evaluation_evidence") || strings.Contains(string(encoded), "generate_image") {
						t.Error("tools for unavailable workflows injected")
					}
					mockAIToolReply(w, protocol, toolCall{"profile", "get_learner_profile", "{}"}, toolCall{"progress", "get_learning_progress", "{}"})
				case 2:
					if !strings.Contains(string(encoded), "profile-only-goal") || !strings.Contains(string(encoded), "completedCount") || strings.Contains(string(encoded), "handbag") {
						t.Error("read tools returned incorrect or extra data")
					}
					mockAIToolReply(w, protocol, toolCall{"state", "get_current_learning_state", "{}"}, toolCall{"lesson", "get_current_lesson", "{}"})
				case 3:
					if !strings.Contains(string(encoded), "handbag") || !strings.Contains(string(encoded), "复习") || !strings.Contains(string(encoded), "position") {
						t.Error("current lesson or active state missing from tool output")
					}
					if protocol == "chat" {
						chatJSON(w, "适合当前学习者的详解")
					} else {
						responseJSON(w, "适合当前学习者的详解")
					}
				default:
					t.Error("unexpected provider round")
				}
			}))
			defer provider.Close()
			setProvider(a, provider.URL, protocol, false)
			req := explainRequest{Book: 1, Lesson: 1, Target: aiTarget{Kind: "lesson"}, Active: map[string]any{"position": 7.0, "sentence": "s1", "mode": "text"}}
			state := waitAIJob(t, a, jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", req)))
			if state.Status != "done" || calls.Load() != 3 {
				t.Fatalf("on-demand tools failed: %s", state.Error)
			}
			b, _ := json.Marshal(state.Result)
			var result explanation
			_ = json.Unmarshal(b, &result)
			if !slices.Equal(result.ToolsUsed, []string{"get_learner_profile", "get_learning_progress", "get_current_learning_state", "get_current_lesson"}) {
				t.Fatalf("incorrect successful tool record: %v", result.ToolsUsed)
			}
			if aiRequest(t, a, "POST", "/api/ai/explanations", req).Code != 200 || calls.Load() != 3 {
				t.Fatal("tool-based result did not reuse cache")
			}
			// Different tool selections cannot reuse this result. Order and duplicates
			// are ignored so semantically identical choices still share a cache key.
			cfg := a.ai.settingsSnapshot()
			lesson, _ := a.textLesson(1, 1)
			_, original := a.ai.explainContext(req, lesson, cfg)
			cfg.EnabledTools = []string{"get_current_lesson"}
			_, limited := a.ai.explainContext(req, lesson, cfg)
			cfg.EnabledTools = []string{"get_current_lesson", "get_current_lesson"}
			_, reordered := a.ai.explainContext(req, lesson, cfg)
			if original == limited || limited != reordered {
				t.Fatal("cache does not distinguish effective tool choices")
			}
		})
	}
}

func TestAIToolPermissionsArgumentsAndBudgets(t *testing.T) {
	cfg := defaultAISettings()
	cfg.EnabledTools = []string{"get_learner_profile", "get_current_lesson", "get_evaluation_evidence"}
	rt := &aiToolRuntime{Config: cfg, Workflow: "explanation", Values: map[string]any{"get_learner_profile": "private-profile", "get_current_lesson": "private-lesson", "get_evaluation_evidence": "private-evidence"}}
	for _, call := range []toolCall{
		{"disabled", "get_learning_progress", "{}"},
		{"wrong-workflow", "get_evaluation_evidence", "{}"},
		{"unknown", "read_any_file", "{}"},
		{"extra-args", "get_current_lesson", `{"lesson":2}`},
		{"null", "get_learner_profile", "null"},
		{"trailing", "get_learner_profile", "{} {}"},
	} {
		if !strings.Contains(fmt.Sprint(rt.execute(call)), "error:") || len(rt.Used) != 0 {
			t.Fatalf("invalid call accessed data: %s", call.ID)
		}
	}
	for rt.calls < maxAIToolCalls {
		if rt.execute(toolCall{"read", "get_learner_profile", "{}"}) != "private-profile" {
			t.Fatal("valid read denied")
		}
	}
	if len(rt.definitions("chat")) != 0 || !strings.Contains(fmt.Sprint(rt.execute(toolCall{"over", "get_current_lesson", "{}"})), "error:") || slices.Contains(rt.Used, "get_current_lesson") {
		t.Fatal("tool budget bypassed")
	}
}

func TestAIRequiredToolsCannotBeBypassed(t *testing.T) {
	for _, disabled := range []bool{true, false} {
		t.Run(fmt.Sprint("disabled=", disabled), func(t *testing.T) {
			a := aiFixture(t)
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				chatJSON(w, "没有读取课文却尝试返回的解释")
			}))
			defer provider.Close()
			setProvider(a, provider.URL, "chat", false)
			if disabled {
				a.ai.settings.EnabledTools = []string{}
			}
			state := waitAIJob(t, a, jobFromResponse(t, aiRequest(t, a, "POST", "/api/ai/explanations", explainRequest{Book: 1, Lesson: 1, Target: aiTarget{Kind: "lesson"}})))
			if state.Status != "error" || !strings.Contains(state.Error, "当前课文") || (disabled && calls.Load() != 0) {
				t.Fatalf("missing required tool not enforced: %s", state.Error)
			}
			files, _ := filepath.Glob(filepath.Join(a.ai.root, "explanations", "*.json"))
			if len(files) != 0 {
				t.Fatal("unsupported explanation became cached")
			}
		})
	}
}

func TestAIDisabledAssessmentToolsPreserveAnswersAndCanResume(t *testing.T) {
	for _, protocol := range []string{"chat", "responses"} {
		for _, workflow := range []string{"assessment", "evaluation"} {
			t.Run(protocol+"/"+workflow, func(t *testing.T) {
				a := aiFixture(t)
				var calls atomic.Int32
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					var input map[string]any
					_ = json.NewDecoder(r.Body).Decode(&input)
					if mockRequiredAIToolRead(w, input) {
						encoded, _ := json.Marshal(input)
						for _, field := range []string{`"priorAnswers"`, `"audioCandidates"`, `"evidence"`, `"profile"`} {
							if strings.Contains(string(encoded), field) {
								t.Errorf("initial structured request injected %s", field)
							}
						}
						return
					}
					encoded, _ := json.Marshal(input)
					if !strings.Contains(string(encoded), "unknown") || !strings.Contains(string(encoded), "-2") {
						t.Error("required evidence tool did not return unknown-answer evidence")
					}
					text := `{"text":"选择正确答案","options":["this","these","those","them"],"answer":0,"explanation":"this 指代单数","difficulty":1,"audioIndex":-1}`
					if workflow == "evaluation" {
						text = `{"level":1,"abilities":{"vocabulary":1,"grammar":1,"reading":1,"listening":1},"weaknesses":["指示代词"],"reason":"根据实际答题记录"}`
					}
					if protocol == "chat" {
						chatJSON(w, text)
					} else {
						responseJSON(w, text)
					}
				}))
				defer provider.Close()
				setProvider(a, provider.URL, protocol, false)
				count := 1
				blockedTool := "get_assessment_context"
				if workflow == "evaluation" {
					count = 16
					blockedTool = "get_evaluation_evidence"
				}
				session := &assessmentSession{ID: "saved-session", Status: "active", Answers: []assessmentAnswer{}}
				for i := 0; i < count; i++ {
					session.Answers = append(session.Answers, assessmentAnswer{Question: assessmentQuestion{ID: fmt.Sprint(i), Dimension: dimensions[i%4]}, Choice: -2, Unknown: true})
				}
				a.ai.state.Assessments[session.ID] = session
				a.ai.settings.EnabledTools = slices.DeleteFunc(allAIToolIDs(), func(id string) bool { return id == blockedTool })
				before := copyValue(a.ai.state.Profile)
				state := waitAIJob(t, a, a.ai.advanceAssessment(session.ID))
				if state.Status != "error" || calls.Load() != 0 || !strings.Contains(state.Error, "系统配置") {
					t.Fatalf("disabled required tool was not rejected before model request: %s", state.Error)
				}
				if len(a.ai.state.Assessments[session.ID].Answers) != count || contentHash(a.ai.state.Profile) != contentHash(before) {
					t.Fatal("disabled tool changed saved answers or profile")
				}
				a.ai.mu.Lock()
				a.ai.settings.EnabledTools = allAIToolIDs()
				a.ai.mu.Unlock()
				state = waitAIJob(t, a, a.ai.advanceAssessment(session.ID))
				if state.Status != "done" || calls.Load() != 2 {
					t.Fatalf("re-enabled tool could not resume: %s", state.Error)
				}
				if workflow == "evaluation" && a.ai.state.Assessments[session.ID].Status != "done" {
					t.Fatal("assessment evaluation did not finish")
				}
			})
		}
	}
}
