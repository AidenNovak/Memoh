package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := loadConfig()
	if err != nil {
		logger.Error("load configuration", slog.Any("error", err))
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store, err := newPushStore(ctx, cfg.databaseURL, cfg.teamID)
	if err != nil {
		logger.Error("open push store", slog.Any("error", err))
		os.Exit(1)
	}
	defer store.close()
	apns, err := newAPNSClient(cfg)
	if err != nil {
		logger.Error("initialize APNs", slog.Any("error", err))
		os.Exit(1)
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
	go func() {
		logger.Info("iOS push gateway listening", slog.String("address", cfg.listenAddress))
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("serve iOS push gateway", slog.Any("error", err))
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("stop iOS push gateway", slog.Any("error", err))
	}
}
