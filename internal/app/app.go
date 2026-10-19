package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Config struct {
	MediaRoot, ReadingRoot, TextbookRoot, DataRoot, WebRoot string
	RequireCIFS                                             bool
}
type Lesson struct {
	ID        string       `json:"id"`
	Order     int          `json:"order"`
	Label     string       `json:"label"`
	Title     string       `json:"title"`
	Duration  float64      `json:"duration"`
	Thumbnail bool         `json:"thumbnail"`
	Reading   *Reading     `json:"reading,omitempty"`
	Textbook  *TextbookRef `json:"textbook,omitempty"`
}
type entry struct {
	Lesson
	Relative string `json:"relative"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}
type Course struct {
	ID              string   `json:"id"`
	Title           string   `json:"title"`
	Teacher         string   `json:"teacher"`
	Description     string   `json:"description"`
	Lessons         []Lesson `json:"lessons"`
	Duration        float64  `json:"duration"`
	SourceAvailable bool     `json:"sourceAvailable"`
	Indexing        bool     `json:"indexing"`
}
type App struct {
	ai                  *aiService
	cfg                 Config
	mu                  sync.RWMutex
	entries             map[string]entry
	available, indexing bool
	scanMu              sync.Mutex
	readings            map[int]readingEntry
	readingsAvailable   bool
	clipMu              sync.Mutex
	clipJobs            map[string]*clipJob
	clipSlots           chan struct{}
}

var prefix = regexp.MustCompile(`^(\d+)\s*[-–—]\s*`)
var suffix = regexp.MustCompile(`\s*\[[^\]]+\]$`)
var lessonPattern = regexp.MustCompile(`(?i)^Lesson\s*0*(\d+)\s*&\s*0*(\d+)\s*`)
var spaces = regexp.MustCompile(`\s+`)

func parseName(relative string) Lesson {
	sum := sha256.Sum256([]byte(filepath.ToSlash(relative)))
	l := Lesson{ID: hex.EncodeToString(sum[:16]), Label: "课程"}
	name := strings.TrimSuffix(filepath.Base(relative), filepath.Ext(relative))
	name = suffix.ReplaceAllString(name, "")
	if match := prefix.FindStringSubmatch(name); match != nil {
		l.Order, _ = strconv.Atoi(match[1])
		name = prefix.ReplaceAllString(name, "")
	}
	if match := lessonPattern.FindStringSubmatch(name); match != nil {
		first, _ := strconv.Atoi(match[1])
		last, _ := strconv.Atoi(match[2])
		l.Label = fmt.Sprintf("Lesson %d & %d", first, last)
		name = lessonPattern.ReplaceAllString(name, "")
	} else if strings.Contains(name, "导学") {
		l.Label = "导学课"
	}
	l.Title = spaces.ReplaceAllString(strings.TrimSpace(name), " ")
	return l
}

func New(cfg Config) (*App, error) {
	if err := os.MkdirAll(filepath.Join(cfg.DataRoot, "thumbnails"), 0750); err != nil {
		return nil, err
	}
	a := &App{cfg: cfg, entries: make(map[string]entry), readings: make(map[int]readingEntry), indexing: true, clipJobs: make(map[string]*clipJob), clipSlots: make(chan struct{}, 2)}
	if data, err := os.ReadFile(filepath.Join(cfg.DataRoot, "readings", "catalog.json")); err == nil {
		_ = json.Unmarshal(data, &a.readings)
	}
	if data, err := os.ReadFile(filepath.Join(cfg.DataRoot, "catalog.json")); err == nil {
		_ = json.Unmarshal(data, &a.entries)
	}
	if a.entries == nil {
		a.entries = make(map[string]entry)
	}
	var err error
	a.ai, err = newAIService(a)
	if err != nil {
		return nil, err
	}
	return a, nil
}

func (a *App) mediaOK() bool { return a.sourceOK(a.cfg.MediaRoot) }

func (a *App) sourceOK(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return false
	}
	if a.cfg.RequireCIFS {
		var stat syscall.Statfs_t
		if syscall.Statfs(path, &stat) != nil || !readOnlySMB(&stat) {
			return false
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	_, err = file.Readdirnames(1)
	return err == nil // An empty mount is not a usable course source.
}

func readOnlySMB(stat *syscall.Statfs_t) bool {
	// Linux reports SMB2/3 mounts with SMB2_SUPER_MAGIC, distinct from legacy CIFS.
	typeID := uint64(stat.Type)
	return (typeID == 0xff534d42 || typeID == 0xfe534d42) && stat.Flags&syscall.MS_RDONLY != 0
}

func (a *App) Run(ctx context.Context) {
	go a.runReadings(ctx)
	a.scan(ctx)
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	health := time.NewTicker(15 * time.Second)
	defer health.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.scan(ctx)
		case <-health.C:
			ok := a.mediaOK()
			a.mu.Lock()
			recovered := ok && !a.available
			a.available = ok
			a.mu.Unlock()
			if recovered {
				a.scan(ctx)
			}
		}
	}
}

func (a *App) scan(ctx context.Context) {
	a.scanMu.Lock()
	defer a.scanMu.Unlock()
	if !a.mediaOK() {
		a.mu.Lock()
		a.available = false
		a.indexing = false
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	previous := a.entries
	a.indexing = true
	a.mu.Unlock()
	next := make(map[string]entry)
	err := filepath.WalkDir(a.cfg.MediaRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.Type()&os.ModeSymlink != 0 || d.IsDir() || strings.ToLower(filepath.Ext(path)) != ".mp4" {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(a.cfg.MediaRoot, path)
		if err != nil {
			return err
		}
		l := parseName(rel)
		e := entry{Lesson: l, Relative: rel, Size: info.Size(), Modified: info.ModTime().UnixNano()}
		if old, ok := previous[l.ID]; ok && old.Size == e.Size && old.Modified == e.Modified {
			e.Duration = old.Duration
			e.Thumbnail = old.Thumbnail
		}
		next[l.ID] = e
		return nil
	})
	if err != nil || len(next) == 0 {
		a.mu.Lock()
		a.available = false
		a.indexing = false
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	a.entries = next
	a.available = true
	a.mu.Unlock()
	// Publish the directory immediately; metadata work never holds the catalog lock.
	ids := make([]string, 0, len(next))
	for id := range next {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		a.mu.RLock()
		e := a.entries[id]
		a.mu.RUnlock()
		if e.Duration <= 0 {
			e.Duration = a.probe(ctx, e.Relative)
		}
		thumb := a.thumbnailPath(e)
		if _, err := os.Stat(thumb); err != nil {
			e.Thumbnail = a.makeThumbnail(ctx, e, thumb)
		} else {
			e.Thumbnail = true
		}
		a.mu.Lock()
		a.entries[id] = e
		a.mu.Unlock()
	}
	a.mu.Lock()
	a.indexing = false
	data, _ := json.Marshal(a.entries)
	a.mu.Unlock()
	path := filepath.Join(a.cfg.DataRoot, "catalog.json")
	if os.WriteFile(path+".tmp", data, 0600) == nil {
		_ = os.Rename(path+".tmp", path)
	}
	log.Printf("Course catalog refreshed: %d videos", len(next))
}

// OpenRoot restricts resolution to the configured media tree even if a path is replaced by a symlink.
func (a *App) openMedia(relative string) (*os.File, error) {
	root, err := os.OpenRoot(a.cfg.MediaRoot)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return root.Open(relative)
}

func (a *App) probe(ctx context.Context, relative string) float64 {
	file, err := a.openMedia(relative)
	if err != nil {
		return 0
	}
	defer file.Close()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "/proc/self/fd/3")
	cmd.ExtraFiles = []*os.File{file}
	output, err := cmd.Output()
	if err != nil {
		return 0
	}
	duration, _ := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	return duration
}

func (a *App) thumbnailPath(e entry) string {
	return filepath.Join(a.cfg.DataRoot, "thumbnails", fmt.Sprintf("%s-%d.jpg", e.ID, e.Modified))
}
func (a *App) makeThumbnail(ctx context.Context, e entry, destination string) bool {
	file, err := a.openMedia(e.Relative)
	if err != nil {
		return false
	}
	defer file.Close()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	tmp := destination + ".tmp.jpg"
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-ss", "15", "-i", "/proc/self/fd/3", "-frames:v", "1", "-vf", "scale=480:-2", "-threads", "1", "-q:v", "5", "-y", tmp)
	cmd.ExtraFiles = []*os.File{file}
	if cmd.Run() != nil {
		_ = os.Remove(tmp)
		return false
	}
	return os.Rename(tmp, destination) == nil
}

func (a *App) course() Course {
	a.mu.RLock()
	defer a.mu.RUnlock()
	c := Course{ID: "ncese01", Title: "新概念英语第一册", Teacher: "霍娜", Description: "从第一句问候开始，建立扎实的英语基础。跟随霍娜老师，在熟悉的生活情境中，循序渐进地学习词汇、语法与表达。", Lessons: []Lesson{}, SourceAvailable: a.available, Indexing: a.indexing}
	for _, e := range a.entries {
		lesson := e.Lesson
		lesson.Reading = a.readingFor(lesson)
		if n := textbookNumber(lesson); n > 0 && n <= 143 && n%2 == 1 && a.cfg.TextbookRoot != "" {
			lesson.Textbook = &TextbookRef{Book: 1, Lesson: n}
		}
		c.Lessons = append(c.Lessons, lesson)
		c.Duration += e.Duration
	}
	sort.Slice(c.Lessons, func(i, j int) bool {
		if c.Lessons[i].Order == c.Lessons[j].Order {
			return c.Lessons[i].Title < c.Lessons[j].Title
		}
		return c.Lessons[i].Order < c.Lessons[j].Order
	})
	return c
}

func jsonResponse(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
func failure(w http.ResponseWriter, status int, message string) {
	jsonResponse(w, status, map[string]string{"error": message})
}

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	a.ai.routes(mux)
	a.textbookRoutes(mux)
	mux.HandleFunc("GET /api/lessons/{id}/reading/video", a.readingVideo)
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, map[string]bool{"ok": true}) })
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		if !a.mediaOK() || len(a.course().Lessons) == 0 {
			failure(w, 503, "课程视频源暂时不可用")
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/courses", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, []Course{a.course()}) })
	mux.HandleFunc("GET /api/courses/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != "ncese01" {
			failure(w, 404, "课程不存在")
			return
		}
		jsonResponse(w, 200, a.course())
	})
	mux.HandleFunc("GET /api/lessons/{id}/video", func(w http.ResponseWriter, r *http.Request) {
		a.mu.RLock()
		e, ok := a.entries[r.PathValue("id")]
		a.mu.RUnlock()
		if !ok {
			failure(w, 404, "课节不存在")
			return
		}
		if !a.mediaOK() {
			failure(w, 503, "课程视频源暂时不可用，请稍后重试")
			return
		}
		file, err := a.openMedia(e.Relative)
		if err != nil {
			failure(w, 503, "视频暂时不可用，请稍后重试")
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			failure(w, 404, "视频不存在")
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
		w.Header().Set("ETag", fmt.Sprintf(`"%s-%x-%x"`, e.ID, info.Size(), info.ModTime().UnixNano()))
		http.ServeContent(w, r, "lesson.mp4", info.ModTime(), file)
	})
	mux.HandleFunc("GET /api/lessons/{id}/thumbnail", func(w http.ResponseWriter, r *http.Request) {
		a.mu.RLock()
		e, ok := a.entries[r.PathValue("id")]
		a.mu.RUnlock()
		if !ok || !e.Thumbnail {
			failure(w, 404, "缩略图尚未生成")
			return
		}
		file, err := os.Open(a.thumbnailPath(e))
		if err != nil {
			failure(w, 404, "缩略图尚未生成")
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			failure(w, 404, "缩略图尚未生成")
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		http.ServeContent(w, r, "thumbnail.jpg", info.ModTime(), file)
	})
	mux.HandleFunc("GET /api/", func(w http.ResponseWriter, r *http.Request) { failure(w, 404, "接口不存在") })
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		root, err := os.OpenRoot(a.cfg.WebRoot)
		if err != nil {
			http.Error(w, "页面暂时不可用", 503)
			return
		}
		defer root.Close()
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		file, err := root.Open(name)
		if err != nil {
			if strings.Contains(filepath.Base(name), ".") {
				http.NotFound(w, r)
				return
			}
			file, err = root.Open("index.html")
		}
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		http.ServeContent(w, r, info.Name(), info.ModTime(), file)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'")
		if r.Method != http.MethodGet && r.Method != http.MethodHead && strings.HasPrefix(r.URL.Path, "/api/") {
			origin := r.Header.Get("Origin")
			if origin != "" {
				parsed, err := url.Parse(origin)
				if err != nil || parsed.Host != r.Host {
					failure(w, http.StatusForbidden, "请从当前站点提交请求")
					return
				}
			}
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				failure(w, http.StatusForbidden, "请从当前站点提交请求")
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}
