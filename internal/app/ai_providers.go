package app

import (
	"fmt"
	"regexp"
	"strings"
)

// Providers own all connection and generation options. The top-level configs
// remain an effective projection for jobs, legacy clients and image rollback.
type aiProvider[T any] struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Config T      `json:"config"`
}
type providerDefaults struct {
	Text  string `json:"text"`
	Image string `json:"image"`
	TTS   string `json:"tts"`
}
type aiProviders struct {
	Text     []aiProvider[textConfig]  `json:"text"`
	Image    []aiProvider[imageConfig] `json:"image"`
	TTS      []aiProvider[ttsConfig]   `json:"tts"`
	Defaults providerDefaults          `json:"defaults"`
}

// Legacy settings are migrated in memory on read and persisted on the next save.
// Stable IDs let the first save and draft previews reuse precisely the old key.
func (c *aiSettings) ensureProviders() {
	if c.Providers != nil {
		return
	}
	c.Providers = &aiProviders{
		Text:     []aiProvider[textConfig]{{"legacy-text", "原文字服务", c.Text}},
		Image:    []aiProvider[imageConfig]{{"legacy-image", "原生图服务", c.Image}},
		TTS:      []aiProvider[ttsConfig]{{"legacy-tts", "原语音服务", c.TTS}},
		Defaults: providerDefaults{"legacy-text", "legacy-image", "legacy-tts"},
	}
}

func (c *aiSettings) resolveProviders() {
	if c.Providers == nil {
		return
	}
	p := c.Providers
	for _, v := range p.Text {
		if v.ID == p.Defaults.Text {
			c.Text = v.Config
		}
	}
	for _, v := range p.Image {
		if v.ID == p.Defaults.Image {
			enabled := c.Image.Enabled
			c.Image = v.Config
			c.Image.Enabled = enabled
		}
	}
	for _, v := range p.TTS {
		if v.ID == p.Defaults.TTS {
			enabled := c.TTS.Enabled
			c.TTS = v.Config
			c.TTS.Enabled = enabled
		}
	}
}

func redactModel(c *modelConfig) {
	c.KeySet = c.APIKey != ""
	c.APIKey = ""
	c.ClearKey = false
}
func (c *aiSettings) redactKeys() {
	redactModel(&c.Text.modelConfig)
	redactModel(&c.Image.modelConfig)
	redactModel(&c.TTS.modelConfig)
	if c.Providers == nil {
		return
	}
	for i := range c.Providers.Text {
		redactModel(&c.Providers.Text[i].Config.modelConfig)
	}
	for i := range c.Providers.Image {
		redactModel(&c.Providers.Image[i].Config.modelConfig)
	}
	for i := range c.Providers.TTS {
		redactModel(&c.Providers.TTS[i].Config.modelConfig)
	}
}

func (p *aiProviders) savedModel(group, id string) modelConfig {
	switch group {
	case "text":
		for _, v := range p.Text {
			if v.ID == id {
				return v.Config.modelConfig
			}
		}
	case "image":
		for _, v := range p.Image {
			if v.ID == id {
				return v.Config.modelConfig
			}
		}
	case "tts":
		for _, v := range p.TTS {
			if v.ID == id {
				return v.Config.modelConfig
			}
		}
	}
	return modelConfig{}
}

func prepareModel(c *modelConfig, saved modelConfig) error {
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if !validModelFields(*c) {
		return fmt.Errorf("请检查接口地址、模型和 API Key")
	}
	if c.ClearKey {
		c.APIKey = ""
	} else if c.APIKey == "" && saved.APIKey != "" {
		if c.BaseURL != strings.TrimRight(strings.TrimSpace(saved.BaseURL), "/") {
			return fmt.Errorf("服务地址已更改，请重新填写 API Key，或勾选清除 Key")
		}
		c.APIKey = saved.APIKey
	}
	c.ClearKey, c.KeySet = false, false
	return nil
}
func validateText(c textConfig) error {
	if (c.Protocol != "chat" && c.Protocol != "responses") || c.Timeout < 5 || c.Timeout > 600 || c.MaxTokens < 64 || c.MaxTokens > 131072 || (c.TokenField != "max_tokens" && c.TokenField != "max_completion_tokens") || (c.Temperature != nil && (*c.Temperature < 0 || *c.Temperature > 2)) {
		return fmt.Errorf("请检查文字协议、超时和生成参数")
	}
	return nil
}
func validateImage(c imageConfig) error {
	if c.Timeout < 5 || c.Timeout > 600 || c.MaxCalls < 0 || c.MaxCalls > 6 || len(c.Size) > 30 || len(c.Quality) > 30 {
		return fmt.Errorf("请检查生图超时和生成参数")
	}
	return nil
}

var providerIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

func prepareProviderList[T any](items []aiProvider[T], defaultID string, prepare func(string, *T) error) error {
	if len(items) == 0 || len(items) > 32 {
		return fmt.Errorf("每类需要保留 1–32 个 Provider")
	}
	seen := map[string]bool{}
	for i := range items {
		p := &items[i]
		p.Name = strings.TrimSpace(p.Name)
		if !providerIDPattern.MatchString(p.ID) || seen[p.ID] || p.Name == "" || len([]rune(p.Name)) > 100 {
			return fmt.Errorf("Provider 标识重复或无效，名称须为 1–100 个字符")
		}
		seen[p.ID] = true
		if err := prepare(p.ID, &p.Config); err != nil {
			return fmt.Errorf("Provider「%s」：%w", p.Name, err)
		}
	}
	if !seen[defaultID] {
		return fmt.Errorf("请选择列表中的默认 Provider")
	}
	return nil
}

func (c *aiSettings) prepareProviders(saved aiSettings) error {
	saved = copyValue(saved)
	saved.resolveProviders()
	if c.Providers == nil {
		// An old client can still update active providers without deleting others.
		if err := prepareModel(&c.Text.modelConfig, saved.Text.modelConfig); err != nil {
			return err
		}
		if err := prepareModel(&c.Image.modelConfig, saved.Image.modelConfig); err != nil {
			return err
		}
		if err := prepareModel(&c.TTS.modelConfig, saved.TTS.modelConfig); err != nil {
			return err
		}
		if saved.Providers != nil {
			c.Providers = saved.Providers
			for i := range c.Providers.Text {
				if c.Providers.Text[i].ID == c.Providers.Defaults.Text {
					c.Providers.Text[i].Config = c.Text
				}
			}
			for i := range c.Providers.Image {
				if c.Providers.Image[i].ID == c.Providers.Defaults.Image {
					c.Providers.Image[i].Config = c.Image
				}
			}
			for i := range c.Providers.TTS {
				if c.Providers.TTS[i].ID == c.Providers.Defaults.TTS {
					c.Providers.TTS[i].Config = c.TTS
				}
			}
		}
	} else {
		saved.ensureProviders()
		p := c.Providers
		if err := prepareProviderList(p.Text, p.Defaults.Text, func(id string, v *textConfig) error {
			if err := prepareModel(&v.modelConfig, saved.Providers.savedModel("text", id)); err != nil {
				return err
			}
			return validateText(*v)
		}); err != nil {
			return err
		}
		if err := prepareProviderList(p.Image, p.Defaults.Image, func(id string, v *imageConfig) error {
			if err := prepareModel(&v.modelConfig, saved.Providers.savedModel("image", id)); err != nil {
				return err
			}
			v.Enabled = false // Feature switches are shared across providers.
			return validateImage(*v)
		}); err != nil {
			return err
		}
		if err := prepareProviderList(p.TTS, p.Defaults.TTS, func(id string, v *ttsConfig) error {
			if err := prepareModel(&v.modelConfig, saved.Providers.savedModel("tts", id)); err != nil {
				return err
			}
			v.Enabled = false
			return validateTTS(*v)
		}); err != nil {
			return err
		}
		c.resolveProviders()
	}
	if err := validateText(c.Text); err != nil {
		return err
	}
	if err := validateImage(c.Image); err != nil {
		return err
	}
	return validateTTS(c.TTS)
}
