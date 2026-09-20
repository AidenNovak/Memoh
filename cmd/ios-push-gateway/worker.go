package main

import (
	"context"
	"log/slog"
	"time"
)

type pushWorker struct {
	store    *pushStore
	apns     *apnsClient
	interval time.Duration
	logger   *slog.Logger
}

func (worker *pushWorker) run(ctx context.Context) {
	worker.tick(ctx)
	ticker := time.NewTicker(worker.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			worker.tick(ctx)
		}
	}
}

func (worker *pushWorker) tick(ctx context.Context) {
	release, acquired, err := worker.store.acquireWorker(ctx)
	if err != nil {
		worker.logger.Error("acquire push worker lease", slog.Any("error", err))
		return
	}
	if !acquired {
		return
	}
	defer release()
	if err := worker.store.discover(ctx); err != nil {
		worker.logger.Error("discover push events", slog.Any("error", err))
		return
	}
	deliveries, err := worker.store.nextDeliveries(ctx, 20)
	if err != nil {
		worker.logger.Error("load pending push deliveries", slog.Any("error", err))
		return
	}
	for _, item := range deliveries {
		if ctx.Err() != nil {
			return
		}
		worker.deliver(ctx, item)
	}
}

func (worker *pushWorker) deliver(ctx context.Context, item delivery) {
	result, err := worker.apns.send(ctx, apnsMessage{
		Token:           item.Token,
		Environment:     item.Environment,
		CollapseID:      item.SourceID,
		Event:           item.Event,
		SessionID:       item.SessionID,
		ApprovalID:      item.ApprovalID,
		RecipientUserID: item.RecipientUserID,
		BotName:         item.BotName,
	})
	if err == nil {
		if err := worker.store.markSent(ctx, item.ID); err != nil {
			worker.logger.Error("mark push delivery sent", slog.Any("error", err), slog.String("delivery_id", item.ID))
		}
		return
	}
	if result.InvalidToken {
		if removeErr := worker.store.removeInvalidDevice(ctx, item.DeviceID); removeErr != nil {
			worker.logger.Warn("remove invalid APNs device", slog.Any("error", removeErr), slog.String("device_id", item.DeviceID))
		}
		worker.logger.Info("removed invalid APNs device", slog.String("device_id", item.DeviceID))
		return
	}
	attempt := item.Attempts + 1
	terminal := attempt >= 5
	delay := time.Duration(1<<min(attempt, 5)) * 15 * time.Second
	if markErr := worker.store.markFailed(ctx, item.ID, err.Error(), time.Now().Add(delay), terminal); markErr != nil {
		worker.logger.Error("record push delivery failure", slog.Any("error", markErr), slog.String("delivery_id", item.ID))
		return
	}
	worker.logger.Warn("APNs delivery failed",
		slog.String("delivery_id", item.ID),
		slog.Int("attempt", attempt),
		slog.Bool("terminal", terminal),
		slog.String("error", err.Error()))
}
