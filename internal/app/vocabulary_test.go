package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func vocabularyFixture() vocabularyDetails {
	return vocabularyDetails{
		PhoneticUK: "/ɪkˈspɪəriəns/", PhoneticUS: "/ɪkˈspɪriəns/",
		Senses: []vocabularySense{
			{POS: "n.", Meaning: "经验", Explanation: "指积累的知识和技能时不可数。", Countability: "uncountable", CountableExpressions: []vocabularyExpression{{Expression: "a year of experience", Meaning: "一年的经验"}}, Examples: []vocabularyExample{{English: "She has teaching experience.", Chinese: "她有教学经验。"}}},
			{POS: "n.", Meaning: "经历", Explanation: "指一次具体的经历时可数。", Countability: "countable", Plural: []string{"experiences"}, Examples: []vocabularyExample{{English: "It was a wonderful experience.", Chinese: "那是一次美好的经历。"}}},
			{POS: "v.", Meaning: "经历；感受", Explanation: "及物动词，后接经历的事件或感受。", Examples: []vocabularyExample{{English: "We experienced heavy rain.", Chinese: "我们遭遇了大雨。"}}},
		},
		Verbs:      []vocabularyVerb{{Base: "experience", ThirdPerson: []string{"experiences"}, PresentParticiple: []string{"experiencing"}, Past: []string{"experienced"}, PastParticiple: []string{"experienced"}}},
		Extensions: []vocabularyExpression{{Expression: "experienced", Meaning: "有经验的（形容词）"}}, Notes: "注意按义项区别可数性。",
	}
}

func TestVocabularyGenerationCacheAndProtocols(t *testing.T) {
	for _, protocol := range []string{"chat", "responses"} {
		t.Run(protocol, func(t *testing.T) {
			a := aiFixture(t)
			l, _ := a.textLesson(1, 1)
			l.Vocabulary[0] = TextVocabulary{ID: "v0", Word: "experience", POS: "n. & v.", Meaning: "经验；经历"}
			if err := writeJSONAtomic(filepath.Join(a.libraryRoot(), "book1", "001.json"), l); err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			release := make(chan struct{})
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["stream"] != false || body["tools"] != nil {
					t.Error("dictionary generation must be structured and independent of learner tools")
				}
				<-release
				b, _ := json.Marshal(vocabularyFixture())
				if protocol == "chat" {
					chatJSON(w, "```json\n"+string(b)+"\n```")
				} else {
					responseJSON(w, string(b))
				}
			}))
			defer provider.Close()
			setProvider(a, provider.URL, protocol, true)
			path := "/api/books/1/lessons/1/vocabulary/v0/details"
			first := jobFromResponse(t, aiRequest(t, a, "POST", path, nil))
			second := jobFromResponse(t, aiRequest(t, a, "POST", path, nil))
			close(release)
			if first != second {
				t.Fatal("concurrent requests did not share a job")
			}
			if state := waitAIJob(t, a, first); state.Status != "done" {
				t.Fatal(state.Error)
			}
			if calls.Load() != 1 {
				t.Fatal("duplicate provider requests")
			}
			// A subsequent lesson response already carries the complete entry.
			response := aiRequest(t, a, "GET", "/api/books/1/lessons/1", nil)
			var loaded TextLesson
			_ = json.Unmarshal(response.Body.Bytes(), &loaded)
			d := loaded.Vocabulary[0].Details
			if d == nil || len(d.Senses) != 3 || d.Senses[0].Countability != "uncountable" || d.Senses[1].Plural[0] != "experiences" || d.Verbs[0].PastParticiple[0] != "experienced" {
				t.Fatalf("entry lost: %s", response.Body.String())
			}
			if strings.Contains(response.Body.String(), "text-secret") {
				t.Fatal("key leaked")
			}
			info, err := os.Stat(a.ai.vocabularyPath(l.Vocabulary[0]))
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("dictionary cache must be private")
			}
			// Persisted dictionary entries remain available after restart without a model.
			restarted, err := New(a.cfg)
			if err != nil {
				t.Fatal(err)
			}
			cached := aiRequest(t, restarted, "POST", path, nil)
			if cached.Code != 200 || !strings.Contains(cached.Body.String(), `"cached":true`) {
				t.Fatal(cached.Body.String())
			}
			l.Lesson = 3
			_ = writeJSONAtomic(filepath.Join(a.libraryRoot(), "book1", "003.json"), l)
			if other := aiRequest(t, restarted, "POST", "/api/books/1/lessons/3/vocabulary/v0/details", nil); other.Code != 200 {
				t.Fatal("same word across lessons must reuse cache")
			}
			l.Vocabulary[0].Meaning = "不同的教材义项"
			_ = writeJSONAtomic(filepath.Join(a.libraryRoot(), "book1", "003.json"), l)
			if different := aiRequest(t, restarted, "POST", "/api/books/1/lessons/3/vocabulary/v0/details", nil); different.Code != 409 {
				t.Fatal("changed textbook gloss reused unrelated cache")
			}
		})
	}
}

func TestVocabularyIncompleteResultCanRetry(t *testing.T) {
	a := aiFixture(t)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d := vocabularyFixture()
		if calls.Add(1) == 1 {
			d.Senses[1].Examples = nil
		}
		b, _ := json.Marshal(d)
		chatJSON(w, string(b))
	}))
	defer provider.Close()
	setProvider(a, provider.URL, "chat", false)
	path := "/api/books/1/lessons/1/vocabulary/v0/details"
	id := jobFromResponse(t, aiRequest(t, a, "POST", path, nil))
	if state := waitAIJob(t, a, id); state.Status != "error" {
		t.Fatal("incomplete entry accepted")
	}
	l, _ := a.textLesson(1, 1)
	if l.Vocabulary[0].Details != nil {
		t.Fatal("incomplete entry persisted")
	}
	id = jobFromResponse(t, aiRequest(t, a, "POST", path, nil))
	if state := waitAIJob(t, a, id); state.Status != "done" {
		t.Fatal(state.Error)
	}
	for _, path := range []string{"/api/books/1/lessons/1/vocabulary/missing/details", "/api/books/1/lessons/2/vocabulary/v0/details", "/api/books/5/lessons/1/vocabulary/v0/details"} {
		if got := aiRequest(t, a, "POST", path, nil); got.Code != 404 {
			t.Fatalf("invalid target: %d", got.Code)
		}
	}
}

func TestVocabularyRejectsIncompleteGrammar(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*vocabularyDetails)
	}{
		{"missing IPA", func(d *vocabularyDetails) { d.PhoneticUS = "" }},
		{"missing plural", func(d *vocabularyDetails) { d.Senses[1].Plural = nil }},
		{"missing countability", func(d *vocabularyDetails) { d.Senses[0].Countability = "" }},
		{"missing verb forms", func(d *vocabularyDetails) { d.Verbs = nil }},
		{"missing participle", func(d *vocabularyDetails) { d.Verbs[0].PastParticiple = nil }},
		{"missing translation", func(d *vocabularyDetails) { d.Senses[0].Examples[0].Chinese = "" }},
		{"unrecognized POS", func(d *vocabularyDetails) { d.Senses[0].POS = "noun" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			d := vocabularyFixture()
			test.change(&d)
			if validVocabulary(&d) {
				t.Fatal("accepted incomplete entry")
			}
		})
	}
	d := vocabularyDetails{PhoneticUK: "/mʌst/", PhoneticUS: "/mʌst/", Senses: []vocabularySense{{POS: "modal", Meaning: "必须", Explanation: "情态动词", Examples: []vocabularyExample{{English: "You must go.", Chinese: "你必须走。"}}}}, Verbs: []vocabularyVerb{{Base: "must", Note: "没有过去分词、现在分词等词形；过去的义务常用 had to 表达。"}}}
	if !validVocabulary(&d) {
		t.Fatal("defective modal must not require invented conjugations")
	}
}
