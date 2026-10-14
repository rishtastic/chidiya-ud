package leaderboard_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rishtastic/chidiya-ud/internal/leaderboard"
	_ "modernc.org/sqlite"
)

func TestNameProtection(t *testing.T) {
	t.Setenv("SUPER_ADMIN_USERNAME", "Keeper")
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := leaderboard.NewHandler(db)

	for _, test := range []struct {
		name     string
		player   string
		required bool
	}{
		{name: "protected", player: " keeper ", required: true},
		{name: "ordinary", player: "Mira", required: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/chidiya-ud/api/name-protection", strings.NewReader(`{"player":"`+test.player+`"}`))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
			}
			var body struct {
				RequiresPassword bool `json:"requiresPassword"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.RequiresPassword != test.required {
				t.Fatalf("requiresPassword = %t, want %t", body.RequiresPassword, test.required)
			}
		})
	}
}
