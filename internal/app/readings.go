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
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"time"
)

type Reading struct {
	ID       string  `json:"id"`
	Number   int     `json:"number"`
	Duration float64 `json:"duration"`
	Status   string  `json:"status"`
}
type readingEntry struct {
	Reading
	Relative string `json:"relative"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

var readingPattern = regexp.MustCompile(`^新概念第一册美音版第(\d+)集\.mp4$`)

func readingNumber(name string) int {
	m := readingPattern.FindStringSubmatch(name)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	if n < 1 || n > 143 || n%2 == 0 {
		return 0
	}
	return n
}
func textbookNumber(l Lesson) int {
	m := lessonPattern.FindStringSubmatch(l.Label)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// Caller holds a.mu. Public metadata never contains a filesystem path.
func (a *App) readingFor(l Lesson) *Reading {
	n := textbookNumber(l)
	if n == 0 {
		return nil
	}
	r := Reading{ID: fmt.Sprintf("nce1-reading-%03d", n), Number: n, Status: "missing"}
	if e, ok := a.readings[n]; ok {
		r = e.Reading
	}
	if !a.readingsAvailable {
		r.Status = "unavailable"
	}
	return &r
}
func readingKey(e readingEntry) string {
	// Version changes invalidate previously encoded files.
	sum := sha256.Sum256([]byte(fmt.Sprintf("h264-v1:%s:%s:%d:%d", e.ID, e.Relative, e.Size, e.Modified)))
	return hex.EncodeToString(sum[:16]) + ".mp4"
}
func (a *App) runReadings(ctx context.Context) {
	if a.cfg.ReadingRoot == "" {
		return
	}
	a.scanReadings(ctx)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			ok := a.sourceOK(a.cfg.ReadingRoot)
			a.mu.Lock()
			recovered := ok && !a.readingsAvailable
			a.readingsAvailable = ok
			a.mu.Unlock()
			if recovered || time.Since(last) >= 5*time.Minute {
				a.scanReadings(ctx)
				last = time.Now()
			}
		}
	}
}
func (a *App) scanReadings(ctx context.Context) {
	if !a.sourceOK(a.cfg.ReadingRoot) {
		a.mu.Lock()
		a.readingsAvailable = false
		a.mu.Unlock()
		return
	}
	cacheRoot := filepath.Join(a.cfg.DataRoot, "readings")
	if os.MkdirAll(cacheRoot, 0750) != nil {
		return
	}
	previous := map[int]readingEntry{}
	if b, err := os.ReadFile(filepath.Join(cacheRoot, "catalog.json")); err == nil {
		_ = json.Unmarshal(b, &previous)
	}
	next := map[int]readingEntry{}
	err := filepath.WalkDir(a.cfg.ReadingRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.IsDir() || d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		n := readingNumber(d.Name())
		if n == 0 {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if old, ok := next[n]; ok {
			old.Status = "error"
			next[n] = old
			log.Printf("Duplicate reading number: %d", n)
			return nil
		}
		rel, err := filepath.Rel(a.cfg.ReadingRoot, path)
		if err != nil {
			return err
		}
		e := readingEntry{Reading: Reading{ID: fmt.Sprintf("nce1-reading-%03d", n), Number: n, Status: "processing"}, Relative: rel, Size: info.Size(), Modified: info.ModTime().UnixNano()}
		if old, ok := previous[n]; ok && readingKey(old) == readingKey(e) && old.Status == "ready" {
			if info, err := os.Lstat(filepath.Join(cacheRoot, readingKey(e))); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
				e.Duration = old.Duration
				e.Status = "ready"
			}
		}
		next[n] = e
		return nil
	})
	if err != nil {
		a.mu.Lock()
		a.readingsAvailable = false
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	a.readings = next
	a.readingsAvailable = true
	a.mu.Unlock()
	nums := make([]int, 0, len(next))
	for n := range next {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	for _, n := range nums {
		if ctx.Err() != nil {
			return
		}
		a.mu.RLock()
		e := a.readings[n]
		a.mu.RUnlock()
		if e.Status != "processing" {
			continue
		}
		if duration, err := a.encodeReading(ctx, e); err == nil {
			e.Duration = duration
			e.Status = "ready"
		} else {
			e.Status = "error"
			log.Printf("Reading conversion failed: lesson %d", n)
		}
		a.mu.Lock()
		a.readings[n] = e
		a.mu.Unlock()
		a.saveReadings(cacheRoot)
	}
	a.saveReadings(cacheRoot)
}
func (a *App) saveReadings(root string) {
	a.mu.RLock()
	b, err := json.Marshal(a.readings)
	a.mu.RUnlock()
	if err == nil && os.WriteFile(filepath.Join(root, "catalog.json.tmp"), b, 0600) == nil {
		_ = os.Rename(filepath.Join(root, "catalog.json.tmp"), filepath.Join(root, "catalog.json"))
	}
}
func openAt(rootPath, relative string) (*os.File, error) {
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return root.Open(relative)
}
func (a *App) encodeReading(ctx context.Context, e readingEntry) (float64, error) {
	file, err := openAt(a.cfg.ReadingRoot, e.Relative)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	target := filepath.Join(a.cfg.DataRoot, "readings", readingKey(e))
	tmp := target + ".tmp.mp4"
	defer os.Remove(tmp)
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-i", "/proc/self/fd/3", "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "1", "-c:a", "copy", "-movflags", "+faststart", "-y", tmp)
	cmd.ExtraFiles = []*os.File{file}
	if err = cmd.Run(); err != nil {
		return 0, err
	}
	output, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", tmp).Output()
	if err != nil {
		return 0, err
	}
	var duration float64
	if _, err = fmt.Sscan(string(output), &duration); err != nil || duration <= 0 {
		return 0, fmt.Errorf("invalid duration")
	}
	info, err := file.Stat()
	if err != nil || info.Size() != e.Size || info.ModTime().UnixNano() != e.Modified {
		return 0, fmt.Errorf("source changed")
	}
	return duration, os.Rename(tmp, target)
}
func (a *App) readingVideo(w http.ResponseWriter, r *http.Request) {
	a.mu.RLock()
	lesson, ok := a.entries[r.PathValue("id")]
	e, found := a.readings[textbookNumber(lesson.Lesson)]
	a.mu.RUnlock()
	if !ok || textbookNumber(lesson.Lesson) == 0 {
		failure(w, 404, "课节不存在")
		return
	}
	if !a.sourceOK(a.cfg.ReadingRoot) {
		failure(w, 503, "朗读视频源暂时不可用，请稍后重试")
		return
	}
	if !found {
		failure(w, 404, "朗读视频尚未添加")
		return
	}
	if e.Status != "ready" {
		failure(w, 503, "朗读视频正在准备或处理失败，请稍后重试")
		return
	}
	source, err := openAt(a.cfg.ReadingRoot, e.Relative)
	if err != nil {
		failure(w, 503, "朗读视频源暂时不可用")
		return
	}
	info, err := source.Stat()
	source.Close()
	if err != nil || !info.Mode().IsRegular() || info.Size() != e.Size || info.ModTime().UnixNano() != e.Modified {
		failure(w, 503, "朗读视频已变化，等待重新处理")
		return
	}
	file, err := openAt(filepath.Join(a.cfg.DataRoot, "readings"), readingKey(e))
	if err != nil {
		failure(w, 503, "朗读视频正在准备")
		return
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		failure(w, 503, "朗读视频暂时不可用")
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	w.Header().Set("ETag", fmt.Sprintf(`"%s"`, readingKey(e)))
	http.ServeContent(w, r, "reading.mp4", info.ModTime(), file)
}
