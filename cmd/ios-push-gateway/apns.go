package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	apnsProductionURL = "https://api.push.apple.com"
	apnsSandboxURL    = "https://api.sandbox.push.apple.com"
)

type apnsClient struct {
	key      *ecdsa.PrivateKey
	keyID    string
	teamID   string
	bundleID string
	http     *http.Client

	mu        sync.Mutex
	jwt       string
	jwtIssued time.Time
}

type apnsMessage struct {
	Token           string
	Environment     string
	CollapseID      string
	Event           string
	SessionID       string
	ApprovalID      string
	RecipientUserID string
	BotName         string
}

type apnsResult struct {
	InvalidToken bool
}

func newAPNSClient(cfg config) (*apnsClient, error) {
	raw, err := os.ReadFile(cfg.apnsKeyPath)
	if err != nil {
		return nil, fmt.Errorf("read APNs key: %w", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("APNs key is not PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse APNs key: %w", err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || key.Curve != elliptic.P256() {
		return nil, errors.New("APNs key must use the P-256 curve")
	}
	return &apnsClient{
		key:      key,
		keyID:    cfg.apnsKeyID,
		teamID:   cfg.apnsTeamID,
		bundleID: cfg.bundleID,
		http: &http.Client{
			Timeout: 15 * time.Second,
			Transport: &http.Transport{
				ForceAttemptHTTP2: true,
				MaxIdleConns:      8,
				IdleConnTimeout:   90 * time.Second,
			},
		},
	}, nil
}

func (c *apnsClient) send(ctx context.Context, message apnsMessage) (apnsResult, error) {
	payload, err := notificationPayload(message)
	if err != nil {
		return apnsResult{}, err
	}
	token, err := c.authorizationToken(time.Now())
	if err != nil {
		return apnsResult{}, err
	}
	baseURL := apnsProductionURL
	if message.Environment == "sandbox" {
		baseURL = apnsSandboxURL
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/3/device/"+message.Token, strings.NewReader(string(payload)))
	if err != nil {
		return apnsResult{}, err
	}
	request.Header.Set("authorization", "bearer "+token)
	request.Header.Set("apns-topic", c.bundleID)
	request.Header.Set("apns-push-type", "alert")
	request.Header.Set("apns-priority", "10")
	request.Header.Set("apns-collapse-id", message.CollapseID)
	request.Header.Set("content-type", "application/json")

	response, err := c.http.Do(request)
	if err != nil {
		return apnsResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusOK {
		return apnsResult{}, nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	var failure struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(body, &failure)
	if failure.Reason == "ExpiredProviderToken" || failure.Reason == "InvalidProviderToken" {
		c.invalidateAuthorizationToken()
	}
	invalid := response.StatusCode == http.StatusGone || failure.Reason == "BadDeviceToken" || failure.Reason == "DeviceTokenNotForTopic"
	return apnsResult{InvalidToken: invalid}, fmt.Errorf("APNs status %d: %s", response.StatusCode, strings.TrimSpace(failure.Reason))
}

func (c *apnsClient) invalidateAuthorizationToken() {
	c.mu.Lock()
	c.jwt = ""
	c.jwtIssued = time.Time{}
	c.mu.Unlock()
}

func (c *apnsClient) authorizationToken(now time.Time) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.jwt != "" && now.Sub(c.jwtIssued) < 50*time.Minute {
		return c.jwt, nil
	}
	header, err := json.Marshal(map[string]string{"alg": "ES256", "kid": c.keyID})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]any{"iss": c.teamID, "iat": now.Unix()})
	if err != nil {
		return "", err
	}
	unsigned := encodeJWTPart(header) + "." + encodeJWTPart(claims)
	digest := sha256.Sum256([]byte(unsigned))
	r, s, err := ecdsa.Sign(rand.Reader, c.key, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign APNs token: %w", err)
	}
	signature := append(fixedWidth(r, 32), fixedWidth(s, 32)...)
	c.jwt = unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
	c.jwtIssued = now
	return c.jwt, nil
}

func encodeJWTPart(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func fixedWidth(value *big.Int, size int) []byte {
	raw := value.Bytes()
	result := make([]byte, size)
	copy(result[size-len(raw):], raw)
	return result
}

func notificationPayload(message apnsMessage) ([]byte, error) {
	titleKey := "notification.finished.title"
	bodyKey := "notification.finished.body.system"
	category := "run"
	interruptionLevel := "active"
	if message.Event == "approval_waiting" {
		titleKey = "notification.approval.title"
		bodyKey = "notification.approval.body.system"
		category = "approval"
		interruptionLevel = "time-sensitive"
	} else if message.Event == "run_failed" {
		titleKey = "notification.failed.title"
		bodyKey = "notification.failed.body.system"
	}
	payload := map[string]any{
		"aps": map[string]any{
			"alert": map[string]any{
				"title-loc-key": titleKey,
				"loc-key":       bodyKey,
				"loc-args":      []string{message.BotName},
			},
			"sound":              "default",
			"category":           category,
			"thread-id":          "session:" + message.SessionID,
			"interruption-level": interruptionLevel,
		},
		"sessionId":       message.SessionID,
		"event":           message.Event,
		"recipientUserId": message.RecipientUserID,
	}
	if message.ApprovalID != "" {
		payload["approvalId"] = message.ApprovalID
	}
	return json.Marshal(payload)
}
