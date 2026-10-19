package app

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

func number(v float64) *float64 { return &v }
func textbookFixture(t *testing.T) (*App, TextLesson) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	a, _, _ := testApp(t)
	a.cfg.TextbookRoot = t.TempDir()
	root := filepath.Join(a.cfg.TextbookRoot, "audio/book1")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", `aevalsrc=sin(2*PI*if(lt(t\,2)\,440\,880)*t):s=24000:d=6`, "-c:a", "libmp3lame", "-y", filepath.Join(root, "001-002.mp3")).CombinedOutput()
	if err != nil {
		t.Fatalf("audio fixture: %s %v", output, err)
	}
	l := TextLesson{Book: 1, Lesson: 1, Label: "Lesson 1 & 2", TitleEn: "Repeated sentence", Duration: 6, Revision: "fixture-v1", Alignment: "ready", Translation: []string{"译文"}, Vocabulary: []TextVocabulary{{ID: "v0", Word: "test", PronunciationID: "0123456789abcdef01234567"}}, Paragraphs: []TextParagraph{{ID: "p0", Sentences: []TextSentence{
		{ID: "s0", Text: "The same sentence.", TranslationZh: "同一个句子。", Start: number(0.2), End: number(1.5), Words: []TextWord{{ID: "s0-w0", Text: "same", Start: number(0.5), End: number(1)}}},
		{ID: "s1", Text: "The same sentence.", Start: number(2.2), End: number(3.5), Words: []TextWord{{ID: "s1-w0", Text: "same", Start: number(2.5), End: number(3)}}},
	}}}}
	dir := filepath.Join(a.libraryRoot(), "book1")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(l)
	if err := os.WriteFile(filepath.Join(dir, "001.json"), b, 0644); err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(TextBook{Book: 1, Name: "Book 1", LessonCount: 1, Lessons: []TextLessonSummary{{Lesson: 1, Label: l.Label}}})
	if err := os.WriteFile(filepath.Join(dir, "index.json"), b, 0644); err != nil {
		t.Fatal(err)
	}
	return a, l
}
func TestTextbooksIndependentCatalogAndAccess(t *testing.T) {
	a, _ := textbookFixture(t)
	a.cfg.MediaRoot = "/nonexistent-video-source"
	for _, path := range []string{"/api/books", "/api/books/1", "/api/books/1/lessons/1"} {
		w := request(a, "GET", path, nil)
		if w.Code != 200 {
			t.Fatalf("%s: %d", path, w.Code)
		}
		if bytes.Contains(w.Body.Bytes(), []byte(a.cfg.TextbookRoot)) || bytes.Contains(w.Body.Bytes(), []byte(a.cfg.DataRoot)) {
			t.Fatal("private path exposed")
		}
	}
	var detail TextLesson
	response := request(a, "GET", "/api/books/1/lessons/1", nil)
	if err := json.Unmarshal(response.Body.Bytes(), &detail); err != nil || detail.Paragraphs[0].Sentences[0].TranslationZh != "同一个句子。" {
		t.Fatal("sentence translation lost in textbook API")
	}
	for _, path := range []string{"/api/books/0", "/api/books/5", "/api/books/1/lessons/2", "/api/books/1/lessons/1/clips/unknown", "/api/books/1/lessons/1/clips/..%2Fsecret", "/api/pronunciations/invalid", "/api/books/1/downloads/txt"} {
		if w := request(a, "GET", path, nil); w.Code != 404 {
			t.Fatalf("invalid route %s: %d", path, w.Code)
		}
	}
	w := request(a, "GET", "/api/books/1/lessons/1/audio", map[string]string{"Range": "bytes=5-20"})
	if w.Code != 206 || w.Body.Len() != 16 {
		t.Fatal("audio range failed")
	}
	h := request(a, "HEAD", "/api/books/1/lessons/1/audio", nil)
	if h.Code != 200 || h.Body.Len() != 0 {
		t.Fatal("HEAD failed")
	}
	if request(a, "GET", "/api/books/1/lessons/1/audio", map[string]string{"If-None-Match": h.Header().Get("ETag")}).Code != 304 {
		t.Fatal("ETag not respected")
	}
	if request(a, "GET", "/api/books/1/lessons/1/audio", map[string]string{"Range": "bytes=99999999-"}).Code != 416 {
		t.Fatal("invalid range not rejected")
	}
	name := filepath.Join(a.cfg.TextbookRoot, "新概念英语第一册_英语初阶.epub")
	if err := os.WriteFile(name, []byte("test epub"), 0644); err != nil {
		t.Fatal(err)
	}
	if request(a, "GET", "/api/books/1/downloads/epub", nil).Code != 200 {
		t.Fatal("ebook download failed")
	}
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(t.TempDir(), "secret.epub")
	if err := os.WriteFile(secret, []byte("outside source root"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, name); err != nil {
		t.Fatal(err)
	}
	if request(a, "GET", "/api/books/1/downloads/epub", nil).Code != 404 {
		t.Fatal("symlink escaped source root")
	}
}
func wavSamples(t *testing.T, b []byte) []int16 {
	t.Helper()
	if len(b) < 12 || string(b[:4]) != "RIFF" {
		t.Fatal("not WAV")
	}
	for p := 12; p+8 <= len(b); {
		size := int(binary.LittleEndian.Uint32(b[p+4 : p+8]))
		if p+8+size > len(b) {
			t.Fatal("truncated WAV")
		}
		if string(b[p:p+4]) == "data" {
			samples := make([]int16, size/2)
			for i := range samples {
				samples[i] = int16(binary.LittleEndian.Uint16(b[p+8+2*i:]))
			}
			return samples
		}
		p += 8 + size + (size % 2)
	}
	t.Fatal("no samples")
	return nil
}
func toneEnergy(samples []int16, hz float64) float64 {
	var real, imag float64
	for i, s := range samples {
		phase := 2 * math.Pi * hz * float64(i) / 24000
		real += float64(s) * math.Cos(phase)
		imag += float64(s) * math.Sin(phase)
	}
	return real*real + imag*imag
}
func TestTextClipUsesOccurrenceAndExactEnd(t *testing.T) {
	a, _ := textbookFixture(t)
	for i := 0; i < 2; i++ {
		path := fmt.Sprintf("/api/books/1/lessons/1/clips/s%d-w0", i)
		w := request(a, "GET", path, nil)
		if w.Code != 200 {
			t.Fatalf("clip %d: %d %s", i, w.Code, w.Body.String())
		}
		samples := wavSamples(t, w.Body.Bytes())
		duration := float64(len(samples)) / 24000
		if math.Abs(duration-0.54) > 0.002 {
			t.Fatalf("clip includes adjacent audio: duration %f", duration)
		}
		expected, other := 440.0, 880.0
		if i == 1 {
			expected, other = other, expected
		}
		if toneEnergy(samples, expected) < toneEnergy(samples, other)*100 {
			t.Fatal("repeated word used wrong occurrence")
		}
		h := request(a, "HEAD", path, nil)
		if h.Code != 200 || h.Body.Len() != 0 {
			t.Fatal("clip HEAD failed")
		}
		if request(a, "GET", path, map[string]string{"If-None-Match": h.Header().Get("ETag")}).Code != 304 {
			t.Fatal("clip conditional cache failed")
		}
	}
	old := request(a, "HEAD", "/api/books/1/lessons/1/clips/s0-w0", nil).Header().Get("ETag")
	path := filepath.Join(a.cfg.TextbookRoot, "audio/book1/001-002.mp3")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("ID3"))
	f.Close()
	next := request(a, "HEAD", "/api/books/1/lessons/1/clips/s0-w0", nil)
	if next.Code != 200 || next.Header().Get("ETag") == old {
		t.Fatal("source changes reused stale clip")
	}
}
func TestConcurrentTextClipBuildAndMissingSource(t *testing.T) {
	a, _ := textbookFixture(t)
	var wg sync.WaitGroup
	codes := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); codes <- request(a, "GET", "/api/books/1/lessons/1/clips/s0", nil).Code }()
	}
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != 200 {
			t.Fatalf("concurrent clip: %d", code)
		}
	}
	files, _ := filepath.Glob(filepath.Join(a.cfg.DataRoot, "textbooks/clips/*.wav"))
	if len(files) != 1 {
		t.Fatalf("expected shared clip, got %d", len(files))
	}
	if err := os.Rename(a.cfg.TextbookRoot, a.cfg.TextbookRoot+"-offline"); err != nil {
		t.Fatal(err)
	}
	if request(a, "GET", "/api/books/1/lessons/1", nil).Code != 200 {
		t.Fatal("source outage hid readable text")
	}
	if request(a, "GET", "/api/books/1/lessons/1/audio", nil).Code != 503 {
		t.Fatal("source outage not reported")
	}
}
