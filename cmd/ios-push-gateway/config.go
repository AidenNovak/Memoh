package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type config struct {
	listenAddress string
	databaseURL   string
	memohBaseURL  string
	teamID        string
	apnsKeyPath   string
	apnsKeyID     string
	apnsTeamID    string
	bundleID      string
	pollInterval  time.Duration
}

func loadConfig() (config, error) {
	pollSeconds, err := positiveIntEnv("PUSH_POLL_SECONDS", 3)
	if err != nil {
		return config{}, err
	}
	cfg := config{
		listenAddress: envOr("PUSH_LISTEN_ADDRESS", ":8083"),
		databaseURL:   strings.TrimSpace(os.Getenv("DATABASE_URL")),
		memohBaseURL:  strings.TrimRight(strings.TrimSpace(os.Getenv("MEMOH_BASE_URL")), "/"),
		teamID:        strings.TrimSpace(os.Getenv("MEMOH_TEAM_ID")),
		apnsKeyPath:   strings.TrimSpace(os.Getenv("APNS_KEY_PATH")),
		apnsKeyID:     strings.TrimSpace(os.Getenv("APNS_KEY_ID")),
		apnsTeamID:    strings.TrimSpace(os.Getenv("APNS_TEAM_ID")),
		bundleID:      strings.TrimSpace(os.Getenv("APNS_BUNDLE_ID")),
		pollInterval:  time.Duration(pollSeconds) * time.Second,
	}
	missing := make([]string, 0, 7)
	for name, value := range map[string]string{
		"DATABASE_URL":   cfg.databaseURL,
		"MEMOH_BASE_URL": cfg.memohBaseURL,
		"MEMOH_TEAM_ID":  cfg.teamID,
		"APNS_KEY_PATH":  cfg.apnsKeyPath,
		"APNS_KEY_ID":    cfg.apnsKeyID,
		"APNS_TEAM_ID":   cfg.apnsTeamID,
		"APNS_BUNDLE_ID": cfg.bundleID,
	} {
		if value == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return config{}, fmt.Errorf("missing required environment: %s", strings.Join(missing, ", "))
	}
	if !strings.HasPrefix(cfg.memohBaseURL, "http://") && !strings.HasPrefix(cfg.memohBaseURL, "https://") {
		return config{}, errors.New("MEMOH_BASE_URL must be an HTTP(S) URL")
	}
	return cfg, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func positiveIntEnv(name string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}
