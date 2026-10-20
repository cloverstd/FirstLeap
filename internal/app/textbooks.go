package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

type TextbookRef struct {
	Book   int `json:"book"`
	Lesson int `json:"lesson"`
}

type TextWord struct {
	ID     string   `json:"id"`
	Text   string   `json:"text"`
	Before string   `json:"before"`
	Start  *float64 `json:"start"`
	End    *float64 `json:"end"`
}
type TextSentence struct {
	ID            string     `json:"id"`
	Text          string     `json:"text"`
	TranslationZh string     `json:"translationZh,omitempty"`
	Start         *float64   `json:"start"`
	End           *float64   `json:"end"`
	Words         []TextWord `json:"words"`
}
type TextParagraph struct {
	ID        string         `json:"id"`
	Speaker   string         `json:"speaker,omitempty"`
	Note      string         `json:"note,omitempty"`
	Sentences []TextSentence `json:"sentences"`
}
type TextVocabulary struct {
	ID              string             `json:"id"`
	Word            string             `json:"word"`
	POS             string             `json:"pos"`
	Meaning         string             `json:"meaning"`
	PronunciationID string             `json:"pronunciationId"`
	Ready           bool               `json:"ready"`
	Dictionary      *dictionaryEntry   `json:"dictionary,omitempty"`
	Details         *vocabularyDetails `json:"details,omitempty"`
}
type TextLesson struct {
	Book            int              `json:"book"`
	Lesson          int              `json:"lesson"`
	Label           string           `json:"label"`
	TitleEn         string           `json:"titleEn"`
	TitleZh         string           `json:"titleZh"`
	Instruction     string           `json:"instruction"`
	InstructionZh   string           `json:"instructionZh"`
	Question        string           `json:"question"`
	Paragraphs      []TextParagraph  `json:"paragraphs"`
	Translation     []string         `json:"translation"`
	Vocabulary      []TextVocabulary `json:"vocabulary"`
	Duration        float64          `json:"duration"`
	Revision        string           `json:"revision"`
	Alignment       string           `json:"alignment"`
	LectureLessonID string           `json:"lectureLessonId,omitempty"`
}
type TextLessonSummary struct {
	Lesson          int     `json:"lesson"`
	Label           string  `json:"label"`
	TitleEn         string  `json:"titleEn"`
	TitleZh         string  `json:"titleZh"`
	Duration        float64 `json:"duration"`
	Alignment       string  `json:"alignment"`
	LectureLessonID string  `json:"lectureLessonId,omitempty"`
}
type TextBook struct {
	Book        int                 `json:"book"`
	Name        string              `json:"name"`
	SubtitleEn  string              `json:"subtitleEn"`
	Available   bool                `json:"available"`
	LessonCount int                 `json:"lessonCount"`
	Lessons     []TextLessonSummary `json:"lessons"`
	Downloads   []string            `json:"downloads"`
}
type clipJob struct {
	done chan struct{}
	err  error
}

var pronunciationID = regexp.MustCompile(`^[a-f0-9]{24}$`)
var bookNames = []string{"", "第一册_英语初阶", "第二册_实践与进步", "第三册_培养技能", "第四册_流利英语"}

func textbookNumber(l Lesson) int {
	m := lessonPattern.FindStringSubmatch(l.Label)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

func (a *App) libraryRoot() string { return filepath.Join(a.cfg.DataRoot, "textbooks", "library") }
func bookNumber(r *http.Request) int {
	n, _ := strconv.Atoi(r.PathValue("book"))
	if n < 1 || n > 4 {
		return 0
	}
	return n
}
func validTextLesson(book, n int) bool {
	if book == 1 {
		return n >= 1 && n <= 143 && n%2 == 1
	}
	limits := []int{0, 143, 96, 60, 48}
	return book >= 2 && book <= 4 && n >= 1 && n <= limits[book]
}
func audioRelative(book, n int) string {
	if book == 1 {
		return fmt.Sprintf("audio/book1/%03d-%03d.mp3", n, n+1)
	}
	return fmt.Sprintf("audio/book%d/%03d.mp3", book, n)
}
func (a *App) lectureFor(book, n int) string {
	// TODO: Associate book 2–4 lecture sources when those courses are imported.
	if book != 1 {
		return ""
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	for _, e := range a.entries {
		if textbookNumber(e.Lesson) == n {
			return e.ID
		}
	}
	return ""
}
func readRootJSON(root, name string, target any) error {
	f, err := openAt(root, name)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewDecoder(f).Decode(target)
}
func (a *App) textBook(n int) TextBook {
	b := TextBook{Book: n, Lessons: []TextLessonSummary{}, Downloads: []string{}}
	if a.cfg.TextbookRoot == "" {
		return b
	}
	if readRootJSON(a.libraryRoot(), fmt.Sprintf("book%d/index.json", n), &b) != nil {
		b.Available = false
		return b
	}
	b.Available = true
	for i := range b.Lessons {
		b.Lessons[i].LectureLessonID = a.lectureFor(n, b.Lessons[i].Lesson)
	}
	b.Downloads = []string{}
	for _, format := range []string{"epub", "pdf", "azw3", "mobi"} {
		f, err := openAt(a.cfg.TextbookRoot, "新概念英语"+bookNames[n]+"."+format)
		if err == nil {
			info, e := f.Stat()
			f.Close()
			if e == nil && info.Mode().IsRegular() {
				b.Downloads = append(b.Downloads, format)
			}
		}
	}
	return b
}
func (a *App) textLesson(book, n int) (TextLesson, error) {
	var l TextLesson
	if a.cfg.TextbookRoot == "" || !validTextLesson(book, n) {
		return l, fmt.Errorf("not found")
	}
	err := readRootJSON(a.libraryRoot(), fmt.Sprintf("book%d/%03d.json", book, n), &l)
	if err != nil || l.Book != book || l.Lesson != n {
		return l, fmt.Errorf("not found")
	}
	l.LectureLessonID = a.lectureFor(book, n)
	for i := range l.Vocabulary {
		l.Vocabulary[i].Dictionary = a.dictionary.lookup(l.Vocabulary[i].Word)
		l.Vocabulary[i].Details = a.ai.readVocabulary(l.Vocabulary[i])
		l.Vocabulary[i].Ready = false
		id := l.Vocabulary[i].PronunciationID
		if !pronunciationID.MatchString(id) {
			continue
		}
		f, e := openAt(a.libraryRoot(), "pronunciations/"+id+".mp3")
		if e == nil {
			info, se := f.Stat()
			f.Close()
			l.Vocabulary[i].Ready = se == nil && info.Mode().IsRegular() && info.Size() > 0
		}
	}
	return l, nil
}
func serveAudioFile(w http.ResponseWriter, r *http.Request, f *os.File, contentType, tag string) {
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		failure(w, 404, "音频不存在")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	w.Header().Set("ETag", fmt.Sprintf(`"%s-%x-%x"`, tag, info.Size(), info.ModTime().UnixNano()))
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
func (a *App) textbookRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/books", func(w http.ResponseWriter, r *http.Request) {
		books := []TextBook{}
		for n := 1; n <= 4; n++ {
			b := a.textBook(n)
			b.Lessons = []TextLessonSummary{}
			books = append(books, b)
		}
		jsonResponse(w, 200, books)
	})
	mux.HandleFunc("GET /api/books/{book}", func(w http.ResponseWriter, r *http.Request) {
		n := bookNumber(r)
		if n == 0 {
			failure(w, 404, "教材不存在")
			return
		}
		b := a.textBook(n)
		if !b.Available {
			failure(w, 503, "教材正在准备，请稍后重试")
			return
		}
		jsonResponse(w, 200, b)
	})
	mux.HandleFunc("GET /api/books/{book}/lessons/{lesson}", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.PathValue("lesson"))
		l, err := a.textLesson(bookNumber(r), n)
		if err != nil {
			failure(w, 404, "课文尚未准备好")
			return
		}
		jsonResponse(w, 200, l)
	})
	mux.HandleFunc("GET /api/books/{book}/lessons/{lesson}/audio", func(w http.ResponseWriter, r *http.Request) {
		book := bookNumber(r)
		n, _ := strconv.Atoi(r.PathValue("lesson"))
		if _, err := a.textLesson(book, n); err != nil {
			failure(w, 404, "课文不存在")
			return
		}
		f, err := openAt(a.cfg.TextbookRoot, audioRelative(book, n))
		if err != nil {
			failure(w, 503, "课文音频暂时不可用")
			return
		}
		serveAudioFile(w, r, f, "audio/mpeg", fmt.Sprintf("nce-%d-%d", book, n))
	})
	mux.HandleFunc("GET /api/pronunciations/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !pronunciationID.MatchString(id) {
			failure(w, 404, "词音不存在")
			return
		}
		f, err := openAt(a.libraryRoot(), "pronunciations/"+id+".mp3")
		if err != nil {
			failure(w, 404, "词音正在准备")
			return
		}
		serveAudioFile(w, r, f, "audio/mpeg", id)
	})
	mux.HandleFunc("GET /api/books/{book}/downloads/{format}", func(w http.ResponseWriter, r *http.Request) {
		n := bookNumber(r)
		format := r.PathValue("format")
		if n == 0 || (format != "epub" && format != "pdf" && format != "azw3" && format != "mobi") || a.cfg.TextbookRoot == "" {
			failure(w, 404, "课程不存在")
			return
		}
		name := "新概念英语" + bookNames[n] + "." + format
		f, err := openAt(a.cfg.TextbookRoot, name)
		if err != nil {
			failure(w, 404, "课程暂时不可用")
			return
		}
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"nce-book%d.%s\"", n, format))
		types := map[string]string{"epub": "application/epub+zip", "pdf": "application/pdf", "azw3": "application/vnd.amazon.mobi8-ebook", "mobi": "application/x-mobipocket-ebook"}
		serveAudioFile(w, r, f, types[format], fmt.Sprintf("book%d-%s", n, format))
	})
	mux.HandleFunc("GET /api/books/{book}/lessons/{lesson}/clips/{segmentId}", a.textClip)
}
func clipBounds(l TextLesson, id string) (float64, float64, bool) {
	for _, p := range l.Paragraphs {
		for _, s := range p.Sentences {
			if s.ID == id && validBounds(s.Start, s.End, l.Duration) {
				return *s.Start, *s.End, true
			}
			for index, word := range s.Words {
				if word.ID == id && validBounds(word.Start, word.End, l.Duration) {
					// Tiny margins protect consonants without crossing the containing sentence.
					lo, hi := math.Max(0, *word.Start-0.015), math.Min(l.Duration, *word.End+0.025)
					if index > 0 && s.Words[index-1].End != nil {
						lo = math.Max(lo, math.Min(*word.Start, *s.Words[index-1].End))
					}
					if index+1 < len(s.Words) && s.Words[index+1].Start != nil {
						hi = math.Min(hi, math.Max(*word.End, *s.Words[index+1].Start))
					}
					return lo, hi, true
				}
			}
		}
	}
	return 0, 0, false
}
func validBounds(start, end *float64, duration float64) bool {
	return start != nil && end != nil && !math.IsNaN(*start) && !math.IsNaN(*end) && *start >= 0 && *end > *start && *end <= duration
}
func (a *App) textClip(w http.ResponseWriter, r *http.Request) {
	book := bookNumber(r)
	n, _ := strconv.Atoi(r.PathValue("lesson"))
	l, err := a.textLesson(book, n)
	if err != nil {
		failure(w, 404, "课文不存在")
		return
	}
	start, end, ok := clipBounds(l, r.PathValue("segmentId"))
	if !ok {
		failure(w, 404, "此片段尚无原音定位")
		return
	}
	f, err := openAt(a.cfg.TextbookRoot, audioRelative(book, n))
	if err != nil {
		failure(w, 503, "课文音频暂时不可用")
		return
	}
	info, err := f.Stat()
	f.Close()
	if err != nil || !info.Mode().IsRegular() {
		failure(w, 503, "课文音频暂时不可用")
		return
	}
	keyBytes := sha256.Sum256([]byte(fmt.Sprintf("pcm-v1:%d:%d:%s:%f:%f:%d:%d", book, n, l.Revision, start, end, info.Size(), info.ModTime().UnixNano())))
	key := hex.EncodeToString(keyBytes[:])
	root := filepath.Join(a.cfg.DataRoot, "textbooks", "clips")
	if err = os.MkdirAll(root, 0750); err != nil {
		failure(w, 503, "音频缓存暂时不可用")
		return
	}
	if clip, e := openAt(root, key+".wav"); e == nil {
		serveAudioFile(w, r, clip, "audio/wav", key)
		return
	}
	a.clipMu.Lock()
	// A previous job can publish between the first cache check and this lock.
	if cached, e := openAt(root, key+".wav"); e == nil {
		a.clipMu.Unlock()
		serveAudioFile(w, r, cached, "audio/wav", key)
		return
	}
	job, exists := a.clipJobs[key]
	if !exists {
		if len(a.clipJobs) >= 16 {
			a.clipMu.Unlock()
			w.Header().Set("Retry-After", "2")
			failure(w, 503, "正在准备其他片段，请重试")
			return
		}
		job = &clipJob{done: make(chan struct{})}
		a.clipJobs[key] = job
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			select {
			case a.clipSlots <- struct{}{}:
				job.err = a.encodeClip(ctx, root, key, book, n, start, end, info)
				<-a.clipSlots
			case <-ctx.Done():
				job.err = ctx.Err()
			}
			a.clipMu.Lock()
			delete(a.clipJobs, key)
			close(job.done)
			a.clipMu.Unlock()
		}()
	}
	a.clipMu.Unlock()
	select {
	case <-r.Context().Done():
		return
	case <-job.done:
	}
	if job.err != nil {
		failure(w, 503, "片段准备失败，请重试")
		return
	}
	clip, err := openAt(root, key+".wav")
	if err != nil {
		failure(w, 503, "片段暂时不可用")
		return
	}
	serveAudioFile(w, r, clip, "audio/wav", key)
}
func (a *App) encodeClip(ctx context.Context, root, key string, book, n int, start, end float64, original os.FileInfo) error {
	f, err := openAt(a.cfg.TextbookRoot, audioRelative(book, n))
	if err != nil {
		return err
	}
	defer f.Close()
	tmp, err := os.CreateTemp(root, ".clip-*.wav")
	if err != nil {
		return err
	}
	name := tmp.Name()
	tmp.Close()
	defer os.Remove(name)
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", fmt.Sprintf("%.6f", start), "-i", "/proc/self/fd/3", "-t", fmt.Sprintf("%.6f", end-start), "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-y", name)
	cmd.ExtraFiles = []*os.File{f}
	if err = cmd.Run(); err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil || info.Size() != original.Size() || info.ModTime() != original.ModTime() {
		return fmt.Errorf("source changed")
	}
	return os.Rename(name, filepath.Join(root, key+".wav"))
}
