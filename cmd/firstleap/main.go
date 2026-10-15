package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cloverstd/FirstLeap/internal/app"
)

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		client := http.Client{Timeout: 4 * time.Second}
		resp, err := client.Get("http://127.0.0.1:" + env("PORT", "8000") + "/health/live")
		if err != nil {
			os.Exit(1)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	a, err := app.New(app.Config{MediaRoot: env("MEDIA_ROOT", "/media"), DataRoot: env("DATA_ROOT", "/data"), WebRoot: env("WEB_ROOT", "web/dist"), RequireCIFS: os.Getenv("REQUIRE_CIFS") == "true"})
	if err != nil {
		log.Fatal("Unable to initialize application storage")
	}
	go a.Run(ctx)
	server := &http.Server{Addr: ":" + env("PORT", "8000"), Handler: a.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(c)
	}()
	log.Print("FirstLeap is listening")
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal("HTTP server stopped unexpectedly")
	}
}
