package main

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type pushStore struct {
	pool          *pgxpool.Pool
	teamID        string
	lastDiscovery atomic.Int64
}

const workerAdvisoryLock int64 = 0x4d454d4f48505553 // "MEMOHPUS"

type deviceBinding struct {
	UserID      string
	Platform    string
	Token       string
	BundleID    string
	Environment string
}

type delivery struct {
	ID              string
	DeviceID        string
	Event           string
	SourceID        string
	SessionID       string
	ApprovalID      string
	RecipientUserID string
	BotName         string
	Token           string
	Environment     string
	Attempts        int
}

func newPushStore(ctx context.Context, databaseURL, teamID string) (*pushStore, error) {
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	poolConfig.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	store := &pushStore{pool: pool, teamID: teamID}
	if err := store.ensureSchema(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return store, nil
}

func (s *pushStore) close() {
	s.pool.Close()
}

func (s *pushStore) healthy(ctx context.Context, maxDiscoveryAge time.Duration) error {
	if err := s.pool.Ping(ctx); err != nil {
		return err
	}
	last := s.lastDiscovery.Load()
	if last == 0 || time.Since(time.Unix(last, 0)) > maxDiscoveryAge {
		return errors.New("event discovery is stale")
	}
	return nil
}

func (s *pushStore) acquireWorker(ctx context.Context) (func(), bool, error) {
	connection, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	var acquired bool
	if err := connection.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, workerAdvisoryLock).Scan(&acquired); err != nil {
		connection.Release()
		return nil, false, err
	}
	if !acquired {
		connection.Release()
		return func() {}, false, nil
	}
	release := func() { //nolint:contextcheck // Unlock must still run after the worker context is cancelled.
		unlockCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = connection.Exec(unlockCtx, `SELECT pg_advisory_unlock($1)`, workerAdvisoryLock)
		connection.Release()
	}
	return release, true, nil
}

func (s *pushStore) ensureSchema(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE SCHEMA IF NOT EXISTS ios_push;

CREATE TABLE IF NOT EXISTS ios_push.devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('ios')),
    token TEXT NOT NULL CHECK (token ~ '^[0-9a-f]+$'),
    bundle_id TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (platform, bundle_id, token)
);
CREATE INDEX IF NOT EXISTS ios_push_devices_user_id ON ios_push.devices(user_id);

CREATE TABLE IF NOT EXISTS ios_push.state (
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cursor_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (team_id, name)
);

CREATE TABLE IF NOT EXISTS ios_push.deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event TEXT NOT NULL CHECK (event IN ('approval_waiting', 'run_finished', 'run_failed')),
    source_id UUID NOT NULL,
    device_id UUID NOT NULL REFERENCES ios_push.devices(id) ON DELETE CASCADE,
    recipient_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL,
    approval_id UUID,
    bot_name TEXT NOT NULL,
    event_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event, source_id, device_id)
);
CREATE INDEX IF NOT EXISTS ios_push_deliveries_pending
    ON ios_push.deliveries(available_at, created_at)
    WHERE status = 'pending';

`)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
INSERT INTO ios_push.state(team_id, name, cursor_at)
VALUES ($1, 'memoh-events', now())
ON CONFLICT (team_id, name) DO NOTHING
`, s.teamID)
	return err
}

func (s *pushStore) upsertDevice(ctx context.Context, binding deviceBinding) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var deviceID string
	err = tx.QueryRow(ctx, `
INSERT INTO ios_push.devices(user_id, platform, token, bundle_id, environment)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (platform, bundle_id, token)
DO UPDATE SET user_id = EXCLUDED.user_id, environment = EXCLUDED.environment,
              updated_at = now(), last_seen_at = now()
RETURNING id::text
`, binding.UserID, binding.Platform, binding.Token, binding.BundleID, binding.Environment).Scan(&deviceID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
DELETE FROM ios_push.deliveries
WHERE device_id = $1 AND status = 'pending' AND recipient_user_id <> $2
`, deviceID, binding.UserID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *pushStore) deleteDevice(ctx context.Context, userID, token string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM ios_push.devices WHERE user_id = $1 AND token = $2`, userID, token)
	return err
}

func (s *pushStore) discover(ctx context.Context) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('memoh.team_id', $1, true)`, s.teamID); err != nil {
		return err
	}
	var cursor time.Time
	if err := tx.QueryRow(ctx, `
SELECT cursor_at FROM ios_push.state
WHERE team_id = $1 AND name = 'memoh-events'
FOR UPDATE
`, s.teamID).Scan(&cursor); err != nil {
		return err
	}
	cutoff := time.Now().UTC()
	windowStart := cursor.Add(-30 * time.Second)
	if _, err := tx.Exec(ctx, `
INSERT INTO ios_push.deliveries(
    event, source_id, device_id, recipient_user_id, session_id, approval_id, bot_name, event_at
)
SELECT
    'approval_waiting', approval.id, device.id,
    recipient.id,
    approval.session_id, approval.id,
    COALESCE(NULLIF(bot.display_name, ''), bot.name), approval.created_at
FROM public.tool_approval_requests approval
JOIN public.bot_sessions session ON session.id = approval.session_id
JOIN public.bots bot ON bot.id = approval.bot_id
LEFT JOIN public.bot_history_messages requested_message
  ON requested_message.id = approval.requested_message_id
LEFT JOIN LATERAL (
    SELECT binding.user_id
    FROM public.user_channel_identity_bindings binding
    WHERE binding.channel_identity_id = approval.requested_by_channel_identity_id
      AND binding.team_id = bot.team_id
    ORDER BY binding.updated_at DESC, binding.id
    LIMIT 1
) requested_binding ON true
CROSS JOIN LATERAL (
    SELECT COALESCE(
        requested_message.sender_account_user_id,
        requested_binding.user_id,
        session.created_by_user_id,
        bot.owner_user_id
    ) AS user_id
) target
JOIN public.users recipient
  ON recipient.id = target.user_id
 AND recipient.is_active
JOIN public.team_members membership
  ON membership.team_id = bot.team_id
 AND membership.user_id = recipient.id
 AND membership.is_active
JOIN ios_push.devices device
  ON device.user_id = recipient.id
WHERE approval.status = 'pending'
  AND approval.created_at >= $1
  AND approval.created_at <= $2
  AND bot.team_id = $3
  AND (
      membership.role = 'admin'
      OR recipient.id = bot.owner_user_id
      OR EXISTS (
          SELECT 1
          FROM public.bot_user_grants grant_row
          WHERE grant_row.team_id = bot.team_id
            AND grant_row.bot_id = bot.id
            AND (
                grant_row.subject_type = 'everyone'
                OR (grant_row.subject_type = 'user' AND grant_row.user_id = recipient.id)
            )
            AND grant_row.permissions ?| ARRAY['chat', 'workspace_exec', 'manage']
      )
  )
ON CONFLICT (event, source_id, device_id) DO NOTHING
`, windowStart, cutoff, s.teamID); err != nil {
		return fmt.Errorf("discover approvals: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO ios_push.deliveries(
    event, source_id, device_id, recipient_user_id, session_id, bot_name, event_at
)
SELECT
    CASE WHEN run.state = 'completed' THEN 'run_finished' ELSE 'run_failed' END,
    run.run_id, device.id,
    recipient.id,
    run.session_id,
    COALESCE(NULLIF(bot.display_name, ''), bot.name), run.updated_at
FROM public.session_runs run
JOIN public.bot_sessions session ON session.id = run.session_id
JOIN public.bots bot ON bot.id = run.bot_id
LEFT JOIN LATERAL (
    SELECT message.sender_account_user_id AS user_id
    FROM public.bot_history_messages message
    WHERE message.turn_id = run.turn_id
      AND message.role = 'user'
      AND message.sender_account_user_id IS NOT NULL
    ORDER BY message.turn_message_seq, message.created_at, message.id
    LIMIT 1
) actor ON true
CROSS JOIN LATERAL (
    SELECT COALESCE(actor.user_id, session.created_by_user_id, bot.owner_user_id) AS user_id
) target
JOIN public.users recipient
  ON recipient.id = target.user_id
 AND recipient.is_active
JOIN public.team_members membership
  ON membership.team_id = bot.team_id
 AND membership.user_id = recipient.id
 AND membership.is_active
JOIN ios_push.devices device
  ON device.user_id = recipient.id
WHERE run.state IN ('completed', 'failed', 'lost')
  AND run.updated_at >= $1
  AND run.updated_at <= $2
  AND bot.team_id = $3
  AND (
      membership.role = 'admin'
      OR recipient.id = bot.owner_user_id
      OR EXISTS (
          SELECT 1
          FROM public.bot_user_grants grant_row
          WHERE grant_row.team_id = bot.team_id
            AND grant_row.bot_id = bot.id
            AND (
                grant_row.subject_type = 'everyone'
                OR (grant_row.subject_type = 'user' AND grant_row.user_id = recipient.id)
            )
            AND grant_row.permissions ?| ARRAY['chat', 'workspace_exec', 'manage']
      )
  )
ON CONFLICT (event, source_id, device_id) DO NOTHING
`, windowStart, cutoff, s.teamID); err != nil {
		return fmt.Errorf("discover terminal runs: %w", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE ios_push.state SET cursor_at = $1
WHERE team_id = $2 AND name = 'memoh-events'
`, cutoff, s.teamID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.lastDiscovery.Store(time.Now().Unix())
	return nil
}

func (s *pushStore) nextDeliveries(ctx context.Context, limit int) ([]delivery, error) {
	rows, err := s.pool.Query(ctx, `
SELECT delivery.id::text, delivery.device_id::text, delivery.event, delivery.source_id::text,
       delivery.session_id::text, COALESCE(delivery.approval_id::text, ''),
       delivery.recipient_user_id::text, delivery.bot_name,
       device.token, device.environment, delivery.attempts
FROM ios_push.deliveries delivery
JOIN ios_push.devices device
  ON device.id = delivery.device_id AND device.user_id = delivery.recipient_user_id
WHERE delivery.status = 'pending' AND delivery.available_at <= now()
ORDER BY delivery.created_at
LIMIT $1
`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]delivery, 0, limit)
	for rows.Next() {
		var item delivery
		if err := rows.Scan(
			&item.ID, &item.DeviceID, &item.Event, &item.SourceID,
			&item.SessionID, &item.ApprovalID, &item.RecipientUserID,
			&item.BotName, &item.Token, &item.Environment, &item.Attempts,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *pushStore) markSent(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `
UPDATE ios_push.deliveries
SET status = 'sent', attempts = attempts + 1, sent_at = now(), updated_at = now(), last_error = ''
WHERE id = $1
`, id)
	return err
}

func (s *pushStore) markFailed(ctx context.Context, id, message string, retryAt time.Time, terminal bool) error {
	status := "pending"
	if terminal {
		status = "failed"
	}
	_, err := s.pool.Exec(ctx, `
UPDATE ios_push.deliveries
SET status = $2, attempts = attempts + 1, available_at = $3,
    last_error = left($4, 500), updated_at = now()
WHERE id = $1
`, id, status, retryAt, message)
	return err
}

func (s *pushStore) removeInvalidDevice(ctx context.Context, deviceID string) error {
	command, err := s.pool.Exec(ctx, `DELETE FROM ios_push.devices WHERE id = $1`, deviceID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return errors.New("invalid APNs device no longer exists")
	}
	return nil
}
