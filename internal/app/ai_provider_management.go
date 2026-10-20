package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
)

type providerMutation struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Config     json.RawMessage `json:"config"`
	ProviderID string          `json:"providerId"`
}

func decodeProviderConfig[T any](raw json.RawMessage, defaults T) (T, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if len(raw) == 0 || string(raw) == "null" {
		return defaults, fmt.Errorf("请填写 Provider 配置")
	}
	if err := decoder.Decode(&defaults); err != nil {
		return defaults, fmt.Errorf("Provider 配置内容无效")
	}
	return defaults, nil
}
func mutateProviders[T any](items *[]aiProvider[T], defaultID *string, request providerMutation, action, id string, defaults T) (int, error) {
	index := -1
	for i, p := range *items {
		if p.ID == id {
			index = i
			break
		}
	}
	if action == "default" {
		for _, p := range *items {
			if p.ID == request.ProviderID {
				*defaultID = p.ID
				return 200, nil
			}
		}
		return 404, fmt.Errorf("Provider 不存在，请刷新后重试")
	}
	if action == "POST" {
		id = request.ID
		if !providerIDPattern.MatchString(id) || id == "default" {
			return 400, fmt.Errorf("Provider 标识无效")
		}
		for _, p := range *items {
			if p.ID == id {
				return 409, fmt.Errorf("Provider 已存在，请刷新后重试")
			}
		}
		if len(*items) >= 32 {
			return 400, fmt.Errorf("每类最多保存 32 个 Provider")
		}
	} else if index < 0 {
		return 404, fmt.Errorf("Provider 不存在，请刷新后重试")
	}
	if action == "DELETE" {
		if id == *defaultID || len(*items) <= 1 {
			return 409, fmt.Errorf("请先设置其他默认 Provider，再删除此服务")
		}
		*items = append((*items)[:index], (*items)[index+1:]...)
		return 200, nil
	}
	config, err := decodeProviderConfig(request.Config, defaults)
	if err != nil {
		return 400, err
	}
	provider := aiProvider[T]{id, request.Name, config}
	if action == "POST" {
		*items = append(*items, provider)
	} else {
		(*items)[index] = provider
	}
	return 200, nil
}
func validateAICommon(c aiSettings) error {
	for _, id := range c.EnabledTools {
		if _, ok := findAITool(id); !ok {
			return fmt.Errorf("包含不支持的 AI 工具")
		}
	}
	for _, v := range []string{c.Prompts.System, c.Prompts.Lesson, c.Prompts.Sentence, c.Prompts.Word, c.Prompts.Image, c.Prompts.Assessment, c.Prompts.Evaluation, c.Prompts.Speech} {
		if len(v) > 32000 {
			return fmt.Errorf("提示词过长")
		}
	}
	return nil
}

// Caller holds s.mu. All mutations merge with the latest settings and persist once.
func (s *aiService) persistSettings(w http.ResponseWriter, c aiSettings) {
	if err := validateAICommon(c); err != nil {
		failure(w, 400, err.Error())
		return
	}
	c.EnabledTools = normalizedAITools(c.EnabledTools)
	if err := c.prepareProviders(s.settings); err != nil {
		failure(w, 400, err.Error())
		return
	}
	if err := writeJSONAtomic(filepath.Join(s.root, "settings.json"), c); err != nil {
		failure(w, 500, "配置保存失败")
		return
	}
	s.settings = c
	c = copyValue(c)
	c.ensureProviders()
	c.redactKeys()
	jsonResponse(w, 200, map[string]any{"settings": c})
}
func (s *aiService) providerManagementRoutes(mux *http.ServeMux) {
	handle := func(w http.ResponseWriter, r *http.Request) {
		action := r.Method
		if r.Pattern == "PUT /api/settings/ai/providers/{group}/default" {
			action = "default"
		}
		var request providerMutation
		if action != "DELETE" && !decodeBody(w, r, &request) {
			return
		}
		id := r.PathValue("id")
		// Older bulk-settings clients may already have used this reserved ID.
		// A config object distinguishes editing that provider from selecting a default.
		if action == "default" && len(request.Config) > 0 {
			action, id = http.MethodPut, "default"
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		c := copyValue(s.settings)
		c.ensureProviders()
		defaults := defaultAISettings()
		var status int
		var err error
		switch r.PathValue("group") {
		case "text":
			status, err = mutateProviders(&c.Providers.Text, &c.Providers.Defaults.Text, request, action, id, defaults.Text)
		case "image":
			status, err = mutateProviders(&c.Providers.Image, &c.Providers.Defaults.Image, request, action, id, defaults.Image)
		case "tts":
			status, err = mutateProviders(&c.Providers.TTS, &c.Providers.Defaults.TTS, request, action, id, defaults.TTS)
		default:
			failure(w, 400, "不支持的 Provider 类别")
			return
		}
		if err != nil {
			failure(w, status, err.Error())
			return
		}
		s.persistSettings(w, c)
	}
	mux.HandleFunc("POST /api/settings/ai/providers/{group}", handle)
	mux.HandleFunc("PUT /api/settings/ai/providers/{group}/{id}", handle)
	mux.HandleFunc("DELETE /api/settings/ai/providers/{group}/{id}", handle)
	mux.HandleFunc("PUT /api/settings/ai/providers/{group}/default", handle)
	mux.HandleFunc("PATCH /api/settings/ai", func(w http.ResponseWriter, r *http.Request) {
		var patch struct {
			EnabledTools  *[]string         `json:"enabledTools"`
			Prompts       map[string]string `json:"prompts"`
			ImageEnabled  *bool             `json:"imageEnabled"`
			SpeechEnabled *bool             `json:"speechEnabled"`
		}
		if !decodeBody(w, r, &patch) {
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		c := copyValue(s.settings)
		c.ensureProviders()
		if patch.EnabledTools != nil {
			c.EnabledTools = *patch.EnabledTools
		}
		if patch.ImageEnabled != nil {
			c.Image.Enabled = *patch.ImageEnabled
		}
		if patch.SpeechEnabled != nil {
			c.TTS.Enabled = *patch.SpeechEnabled
		}
		prompts := map[string]*string{"system": &c.Prompts.System, "lesson": &c.Prompts.Lesson, "sentence": &c.Prompts.Sentence, "word": &c.Prompts.Word, "image": &c.Prompts.Image, "assessment": &c.Prompts.Assessment, "evaluation": &c.Prompts.Evaluation, "speech": &c.Prompts.Speech}
		for key, value := range patch.Prompts {
			target, ok := prompts[key]
			if !ok {
				failure(w, 400, "不支持的提示词类型")
				return
			}
			*target = value
		}
		s.persistSettings(w, c)
	})
}
