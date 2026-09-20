package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type gatewayHandler struct {
	store        *pushStore
	memohBaseURL string
	bundleID     string
	http         *http.Client
	healthWindow time.Duration
}

type registerDeviceRequest struct {
	Platform    string `json:"platform"`
	Token       string `json:"token"`
	BundleID    string `json:"bundle_id"`
	Environment string `json:"environment"`
	UserID      string `json:"user_id"`
}

type unregisterDeviceRequest struct {
	Token  string `json:"token"`
	UserID string `json:"user_id"`
}

type currentUser struct {
	ID                 string `json:"id"`
	PrincipalIsActive  bool   `json:"principal_is_active"`
	MembershipIsActive bool   `json:"membership_is_active"`
}

func newGatewayHandler(store *pushStore, cfg config) *gatewayHandler {
	return &gatewayHandler{
		store:        store,
		memohBaseURL: cfg.memohBaseURL,
		bundleID:     cfg.bundleID,
		http:         &http.Client{Timeout: 10 * time.Second},
		healthWindow: max(time.Minute, 3*cfg.pollInterval+5*time.Second),
	}
}

func (h *gatewayHandler) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(writer http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		if err := h.store.healthy(ctx, h.healthWindow); err != nil {
			writeProblem(writer, http.StatusServiceUnavailable, "push worker unavailable")
			return
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(writer, `{"status":"ok"}`)
	})
	mux.HandleFunc("POST /devices", h.register)
	mux.HandleFunc("DELETE /devices", h.unregister)
	return mux
}

func (h *gatewayHandler) register(writer http.ResponseWriter, request *http.Request) {
	user, err := h.authenticate(request.Context(), request.Header.Get("authorization"))
	if err != nil {
		writeAuthError(writer, err)
		return
	}
	var body registerDeviceRequest
	if err := decodeBody(request, &body); err != nil {
		writeProblem(writer, http.StatusBadRequest, err.Error())
		return
	}
	body.Token = strings.ToLower(strings.TrimSpace(body.Token))
	body.UserID = strings.TrimSpace(body.UserID)
	body.BundleID = strings.TrimSpace(body.BundleID)
	body.Platform = strings.ToLower(strings.TrimSpace(body.Platform))
	body.Environment = strings.ToLower(strings.TrimSpace(body.Environment))
	if body.UserID != user.ID {
		writeProblem(writer, http.StatusBadRequest, "user_id does not match the authenticated user")
		return
	}
	if body.Platform != "ios" {
		writeProblem(writer, http.StatusBadRequest, "platform must be ios")
		return
	}
	if body.BundleID != h.bundleID {
		writeProblem(writer, http.StatusBadRequest, "bundle_id is not registered")
		return
	}
	if body.Environment != "sandbox" && body.Environment != "production" {
		writeProblem(writer, http.StatusBadRequest, "environment must be sandbox or production")
		return
	}
	if !validDeviceToken(body.Token) {
		writeProblem(writer, http.StatusBadRequest, "token must be an even-length hexadecimal value")
		return
	}
	if err := h.store.upsertDevice(request.Context(), deviceBinding{
		UserID:      user.ID,
		Platform:    body.Platform,
		Token:       body.Token,
		BundleID:    body.BundleID,
		Environment: body.Environment,
	}); err != nil {
		writeProblem(writer, http.StatusInternalServerError, "device registration failed")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (h *gatewayHandler) unregister(writer http.ResponseWriter, request *http.Request) {
	user, err := h.authenticate(request.Context(), request.Header.Get("authorization"))
	if err != nil {
		writeAuthError(writer, err)
		return
	}
	var body unregisterDeviceRequest
	if err := decodeBody(request, &body); err != nil {
		writeProblem(writer, http.StatusBadRequest, err.Error())
		return
	}
	body.Token = strings.ToLower(strings.TrimSpace(body.Token))
	body.UserID = strings.TrimSpace(body.UserID)
	if body.UserID != user.ID {
		writeProblem(writer, http.StatusBadRequest, "user_id does not match the authenticated user")
		return
	}
	if !validDeviceToken(body.Token) {
		writeProblem(writer, http.StatusBadRequest, "token must be an even-length hexadecimal value")
		return
	}
	if err := h.store.deleteDevice(request.Context(), user.ID, body.Token); err != nil {
		writeProblem(writer, http.StatusInternalServerError, "device removal failed")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

var (
	errMissingAuthorization = errors.New("authorization required")
	errInvalidAuthorization = errors.New("authorization rejected")
	errAuthUnavailable      = errors.New("authentication service unavailable")
)

func (h *gatewayHandler) authenticate(ctx context.Context, authorization string) (currentUser, error) {
	authorization = strings.TrimSpace(authorization)
	if !strings.HasPrefix(strings.ToLower(authorization), "bearer ") {
		return currentUser{}, errMissingAuthorization
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, h.memohBaseURL+"/users/me", nil)
	if err != nil {
		return currentUser{}, errAuthUnavailable
	}
	request.Header.Set("authorization", authorization)
	response, err := h.http.Do(request) //nolint:gosec // The Memoh base URL is operator configuration, not request input.
	if err != nil {
		return currentUser{}, errAuthUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return currentUser{}, errInvalidAuthorization
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return currentUser{}, errAuthUnavailable
	}
	var user currentUser
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&user); err != nil {
		return currentUser{}, errAuthUnavailable
	}
	if strings.TrimSpace(user.ID) == "" || !user.PrincipalIsActive || !user.MembershipIsActive {
		return currentUser{}, errInvalidAuthorization
	}
	return user, nil
}

func decodeBody(request *http.Request, target any) error {
	defer func() { _ = request.Body.Close() }()
	decoder := json.NewDecoder(io.LimitReader(request.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("JSON body must contain one object")
	}
	return nil
}

func validDeviceToken(token string) bool {
	// Apple treats device tokens as opaque variable-length data. Keep only a
	// generous transport bound; never bake the current 32-byte size into the contract.
	if len(token) < 32 || len(token) > 256 || len(token)%2 != 0 {
		return false
	}
	_, err := hex.DecodeString(token)
	return err == nil
}

func writeAuthError(writer http.ResponseWriter, err error) {
	if errors.Is(err, errAuthUnavailable) {
		writeProblem(writer, http.StatusBadGateway, "authentication service unavailable")
		return
	}
	writeProblem(writer, http.StatusUnauthorized, "authorization required")
}

func writeProblem(writer http.ResponseWriter, status int, detail string) {
	writer.Header().Set("content-type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]string{"error": detail})
}
