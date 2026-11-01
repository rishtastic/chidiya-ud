package leaderboard_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rishtastic/chidiya-ud/internal/leaderboard"
	"golang.org/x/crypto/bcrypt"
)

func TestConfiguredAdminAccessAndSessionProtection(t *testing.T) {
	t.Setenv("SUPER_ADMIN_USERNAME", "Operator")
	hash, err := bcrypt.GenerateFromPassword([]byte("existing-test-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SUPER_ADMIN_PASSWORD_HASH", string(hash))
	handler, db := newTestServerWithDB(t)
	loggedIn := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/login", map[string]string{"username": " operator ", "password": "existing-test-password"}, nil, "")
	account := decodeSite[struct {
		Username   string `json:"username"`
		SuperAdmin bool   `json:"superAdmin"`
		CSRF       string `json:"csrf"`
	}](t, loggedIn, http.StatusOK)
	if !account.SuperAdmin || account.Username != "Operator" || account.CSRF == "" {
		t.Fatalf("configured login did not preserve super-admin access: %#v", account)
	}
	if bytes.Contains(loggedIn.Body.Bytes(), hash) {
		t.Fatal("password hash leaked in account response")
	}
	cookies := loggedIn.Result().Cookies()
	decodeSite[map[string]any](t, siteRequest(t, handler, http.MethodGet, apiPrefix+"/auth/me", nil, cookies, ""), http.StatusOK)
	protection := decodeSite[struct {
		RequiresPassword bool `json:"requiresPassword"`
	}](t, siteRequest(t, handler, http.MethodPost, apiPrefix+"/name-protection", map[string]string{"player": "Operator"}, cookies, ""), http.StatusOK)
	if protection.RequiresPassword {
		t.Fatal("signed-in owner was asked for a second password")
	}
	blocked := siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/items", map[string]any{}, cookies, "wrong-token")
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("invalid CSRF token status = %d", blocked.Code)
	}
	request := httptest.NewRequest(http.MethodPost, apiPrefix+"/admin/items", bytes.NewReader([]byte(`{}`)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://untrusted.example")
	request.Header.Set("X-CSRF-Token", account.CSRF)
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin admin write status = %d", response.Code)
	}
	reserved := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/register", map[string]string{"username": "Operator", "password": testPassword}, nil, "")
	if reserved.Code != http.StatusBadRequest {
		t.Fatalf("configured name could be registered: %d", reserved.Code)
	}
	t.Setenv("SUPER_ADMIN_USERNAME", "AnotherOperator")
	reconfigured := leaderboard.NewHandler(db)
	if result := siteRequest(t, reconfigured, http.MethodGet, apiPrefix+"/auth/me", nil, cookies, ""); result.Code != http.StatusUnauthorized {
		t.Fatalf("old super-admin session survived identity change: %d", result.Code)
	}
}
