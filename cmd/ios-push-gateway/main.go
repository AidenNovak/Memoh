package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("run iOS push gateway", slog.Any("error", err))
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := loadConfig()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store, err := newPushStore(ctx, cfg.databaseURL, cfg.teamID)
	if err != nil {
		return fmt.Errorf("open push store: %w", err)
	}
	defer store.close()
	apns, err := newAPNSClient(cfg)
	if err != nil {
		return fmt.Errorf("initialize APNs: %w", err)
	}

	worker := &pushWorker{store: store, apns: apns, interval: cfg.pollInterval, logger: logger}
	go worker.run(ctx)

	server := &http.Server{
		Addr:              cfg.listenAddress,
		Handler:           newGatewayHandler(store, cfg).routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() {
		logger.Info("iOS push gateway listening", slog.String("address", cfg.listenAddress))
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- fmt.Errorf("serve iOS push gateway: %w", err)
			return
		}
		serveErr <- nil
	}()

	select {
	case <-ctx.Done():
	case err := <-serveErr:
		if err != nil {
			return err
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("stop iOS push gateway: %w", err)
	}
	return nil
}
