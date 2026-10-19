package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode"
)

type providerSettingsRequest struct {
	Group  string      `json:"group"`
	Config modelConfig `json:"config"`
}

// Preview the draft without saving it or returning stored credentials to the browser.
func (s *aiService) providerPreview(req providerSettingsRequest) (modelConfig, error) {
	settings := s.settingsSnapshot()
	var saved modelConfig
	switch req.Group {
	case "text":
		saved = settings.Text.modelConfig
	case "image":
		saved = settings.Image.modelConfig
	default:
		return modelConfig{}, fmt.Errorf("请选择文字模型或生图模型")
	}
	c := req.Config
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if c.BaseURL == "" || !validModelFields(c) {
		return modelConfig{}, fmt.Errorf("请填写有效的 Base URL")
	}
	if c.ClearKey {
		c.APIKey = ""
	} else if c.APIKey == "" && saved.APIKey != "" {
		if c.BaseURL != strings.TrimRight(strings.TrimSpace(saved.BaseURL), "/") {
			return modelConfig{}, fmt.Errorf("服务地址已更改，请重新填写 API Key，或勾选清除 Key 使用免 Key 服务")
		}
		c.APIKey = saved.APIKey
	}
	return c, nil
}

func (s *aiService) providerModels(ctx context.Context, c modelConfig) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/models", nil)
	if err != nil {
		return nil, fmt.Errorf("模型列表接口地址无效")
	}
	req.Header.Set("Accept", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	client := *s.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接服务商或请求超时，请检查 Base URL 和网络")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		switch resp.StatusCode {
		case 401, 403:
			return nil, fmt.Errorf("服务商认证失败，请检查 API Key 和模型列表权限")
		case 404, 405, 501:
			return nil, fmt.Errorf("模型列表接口不可用，请检查 Base URL 的 API 前缀，以及服务商是否支持 /models")
		case 429:
			return nil, fmt.Errorf("服务商请求频率或额度已达上限，请稍后重试")
		default:
			return nil, fmt.Errorf("模型列表接口返回 HTTP %d，请检查服务商状态与 Base URL", resp.StatusCode)
		}
	}
	const maxBytes = 4 << 20
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil || len(body) > maxBytes {
		return nil, fmt.Errorf("模型列表响应过大或连接中断，请稍后重试")
	}
	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &result) != nil || result.Data == nil {
		return nil, fmt.Errorf("服务商未返回有效的模型列表，请检查 Base URL 是否指向兼容 API")
	}
	models := []string{}
	seen := map[string]bool{}
	for _, item := range result.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" || len(id) > 256 || strings.IndexFunc(id, unicode.IsControl) >= 0 || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, id)
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("服务商没有返回可用模型，请检查 API Key 的模型权限")
	}
	sort.Strings(models)
	return models, nil
}

func (s *aiService) providerSettingsRoutes(mux *http.ServeMux) {
	for _, action := range []string{"models", "test"} {
		mux.HandleFunc("POST /api/settings/ai/"+action, func(w http.ResponseWriter, r *http.Request) {
			var req providerSettingsRequest
			if !decodeBody(w, r, &req) {
				return
			}
			config, err := s.providerPreview(req)
			if err != nil {
				failure(w, 400, err.Error())
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			defer cancel()
			started := time.Now()
			models, err := s.providerModels(ctx, config)
			if err != nil {
				failure(w, 502, err.Error())
				return
			}
			message := fmt.Sprintf("已获取 %d 个服务商模型，请从列表中选择。", len(models))
			if action == "test" {
				message = fmt.Sprintf("连接成功，认证通过，可读取 %d 个模型（%d ms）。", len(models), time.Since(started).Milliseconds())
			}
			available := config.Model == "" || slices.Contains(models, config.Model)
			if !available {
				message += " 当前模型未在列表中，请重新选择。"
			}
			jsonResponse(w, 200, map[string]any{"models": models, "elapsedMs": time.Since(started).Milliseconds(), "message": message, "modelAvailable": available})
		})
	}
}
