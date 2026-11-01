package leaderboard_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rishtastic/chidiya-ud/internal/leaderboard"
	"golang.org/x/crypto/bcrypt"
)

const testPassword = "a sufficiently long passphrase"

func siteRequest(t *testing.T, handler http.Handler, method, path string, body any, cookies []*http.Cookie, csrf string) *httptest.ResponseRecorder {
	t.Helper()
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(payload))
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func decodeSite[T any](t *testing.T, response *httptest.ResponseRecorder, want int) T {
	t.Helper()
	if response.Code != want {
		t.Fatalf("status = %d, want %d: %s", response.Code, want, response.Body.String())
	}
	var value T
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestPublishedItemsAreSeededWithoutChangingAnswers(t *testing.T) {
	handler, db := newTestServerWithDB(t)
	response := siteRequest(t, handler, http.MethodGet, apiPrefix+"/items", nil, nil, "")
	result := decodeSite[seededItems](t, response, http.StatusOK)
	if len(result.Items) != 200 {
		t.Fatalf("seeded item count = %d, want 200", len(result.Items))
	}
	for _, item := range result.Items {
		if item.Language == "english" && item.Name == "umbrella" && !item.CanFly {
			t.Fatal("umbrella answer changed")
		}
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM items`).Scan(&count); err != nil || count != 200 {
		t.Fatalf("item count = %d, err = %v", count, err)
	}
	if err := leaderboard.Migrate(db); err != nil {
		t.Fatalf("second migration: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM items`).Scan(&count); err != nil || count != 200 {
		t.Fatalf("items duplicated by migration: %d, %v", count, err)
	}
}

type seededItems struct {
	Items []struct {
		Language string `json:"language"`
		Name     string `json:"name"`
		CanFly   bool   `json:"canFly"`
	} `json:"items"`
}

func TestMigrationPreservesExistingScores(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`
		CREATE TABLE sessions (id TEXT PRIMARY KEY, player TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
		CREATE TABLE scores (id INTEGER PRIMARY KEY AUTOINCREMENT, player TEXT NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL);
		INSERT INTO scores(player, score, created_at) VALUES('Legacy', 12, 1);
	`)
	if err != nil {
		t.Fatal(err)
	}
	if err := leaderboard.Migrate(db); err != nil {
		t.Fatalf("migrate legacy database: %v", err)
	}
	var score, items int
	if err := db.QueryRow(`SELECT score FROM scores WHERE player='Legacy'`).Scan(&score); err != nil || score != 12 {
		t.Fatalf("legacy score = %d, err = %v", score, err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM items`).Scan(&items); err != nil || items != 200 {
		t.Fatalf("seeded items = %d, err = %v", items, err)
	}
}

func TestGuestClaimsOnlyCurrentSessionScores(t *testing.T) {
	handler, db := newTestServerWithDB(t)
	if _, err := db.Exec(`INSERT INTO scores(player, score, created_at) VALUES('Mira', 80, 1)`); err != nil {
		t.Fatal(err)
	}
	var guest []*http.Cookie
	for _, points := range []int{3, 4} {
		started := siteRequest(t, handler, http.MethodPost, apiPrefix+"/sessions", map[string]string{"player": "Mira"}, guest, "")
		var session struct {
			SessionID string `json:"sessionId"`
		}
		session = decodeSite[struct {
			SessionID string `json:"sessionId"`
		}](t, started, http.StatusCreated)
		if len(guest) == 0 {
			guest = started.Result().Cookies()
		}
		finished := siteRequest(t, handler, http.MethodPost, apiPrefix+"/scores", map[string]any{"sessionId": session.SessionID, "score": points, "durationMs": points * 75}, guest, "")
		decodeSite[map[string]any](t, finished, http.StatusCreated)
	}
	registered := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/register", map[string]string{"username": "Mira", "password": testPassword}, guest, "")
	var account struct {
		RecoveryCode string `json:"recoveryCode"`
	}
	account = decodeSite[struct {
		RecoveryCode string `json:"recoveryCode"`
	}](t, registered, http.StatusCreated)
	if account.RecoveryCode == "" {
		t.Fatal("missing recovery code")
	}
	var claimed, old int
	if err := db.QueryRow(`SELECT COUNT(*) FROM scores WHERE player = 'Mira' AND account_id IS NOT NULL`).Scan(&claimed); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM scores WHERE player = 'Mira' AND score = 80 AND account_id IS NULL`).Scan(&old); err != nil {
		t.Fatal(err)
	}
	if claimed != 2 || old != 1 {
		t.Fatalf("claimed = %d, older unclaimed = %d; want 2 and 1", claimed, old)
	}
	blocked := siteRequest(t, handler, http.MethodPost, apiPrefix+"/sessions", map[string]string{"player": "Mira"}, nil, "")
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("claimed name guest status = %d", blocked.Code)
	}
	allowed := siteRequest(t, handler, http.MethodPost, apiPrefix+"/sessions", map[string]string{"player": "Mira"}, registered.Result().Cookies(), "")
	if allowed.Code != http.StatusCreated {
		t.Fatalf("claimed name owner status = %d: %s", allowed.Code, allowed.Body.String())
	}
}

func TestAdminRolesItemsAndScoreVisibility(t *testing.T) {
	t.Setenv("SUPER_ADMIN_USERNAME", "Keeper")
	hash, err := bcrypt.GenerateFromPassword([]byte("keeper-test-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SUPER_ADMIN_PASSWORD_HASH", string(hash))
	handler, db := newTestServerWithDB(t)
	for _, name := range []string{"Editor", "Moderator"} {
		response := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/register", map[string]string{"username": name, "password": testPassword}, nil, "")
		decodeSite[map[string]any](t, response, http.StatusCreated)
	}
	admin := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/login", map[string]string{"username": "Keeper", "password": "keeper-test-password"}, nil, "")
	var keeper struct {
		CSRF string `json:"csrf"`
	}
	keeper = decodeSite[struct {
		CSRF string `json:"csrf"`
	}](t, admin, http.StatusOK)
	adminCookies := admin.Result().Cookies()
	var editorID, moderatorID int64
	if err := db.QueryRow(`SELECT id FROM accounts WHERE username_key = 'editor'`).Scan(&editorID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT id FROM accounts WHERE username_key = 'moderator'`).Scan(&moderatorID); err != nil {
		t.Fatal(err)
	}
	for _, grant := range []struct {
		id            int64
		editor, users bool
	}{{editorID, true, false}, {moderatorID, false, true}} {
		response := siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/users/"+idString(grant.id)+"/roles", map[string]bool{"contentEditor": grant.editor, "userAdmin": grant.users}, adminCookies, keeper.CSRF)
		decodeSite[map[string]any](t, response, http.StatusOK)
	}
	loginRole := func(name string) ([]*http.Cookie, string) {
		response := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/login", map[string]string{"username": name, "password": testPassword}, nil, "")
		var result struct {
			CSRF string `json:"csrf"`
		}
		result = decodeSite[struct {
			CSRF string `json:"csrf"`
		}](t, response, http.StatusOK)
		return response.Result().Cookies(), result.CSRF
	}
	editorCookies, editorCSRF := loginRole("Editor")
	userCookies, userCSRF := loginRole("Moderator")
	item := siteRequest(t, handler, http.MethodGet, apiPrefix+"/admin/items", nil, editorCookies, "")
	if item.Code != http.StatusOK {
		t.Fatalf("editor items = %d", item.Code)
	}
	forbidden := siteRequest(t, handler, http.MethodGet, apiPrefix+"/admin/users", nil, editorCookies, "")
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("editor users = %d", forbidden.Code)
	}
	forbidden = siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/users/"+idString(editorID)+"/roles", map[string]bool{"userAdmin": true}, userCookies, userCSRF)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("user-admin role change = %d", forbidden.Code)
	}
	forbidden = siteRequest(t, handler, http.MethodGet, apiPrefix+"/admin/items", nil, userCookies, "")
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("user-admin items = %d", forbidden.Code)
	}

	newItem := map[string]any{"language": "english", "name": "test glider", "spoken": "टेस्ट ग्लाइडर", "canFly": true, "explanation": "It catches air.", "active": true}
	created := siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/items", newItem, editorCookies, editorCSRF)
	var createdItem struct {
		ID int64 `json:"id"`
	}
	createdItem = decodeSite[struct {
		ID int64 `json:"id"`
	}](t, created, http.StatusCreated)
	public := siteRequest(t, handler, http.MethodGet, apiPrefix+"/items", nil, nil, "")
	if bytes.Contains(public.Body.Bytes(), []byte("test glider")) {
		t.Fatal("unpublished draft leaked to public")
	}
	published := siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/items/"+idString(createdItem.ID)+"/publish", map[string]bool{"confirmAnswerChange": false}, editorCookies, editorCSRF)
	decodeSite[map[string]any](t, published, http.StatusOK)
	public = siteRequest(t, handler, http.MethodGet, apiPrefix+"/items", nil, nil, "")
	if !bytes.Contains(public.Body.Bytes(), []byte("test glider")) {
		t.Fatal("published item missing")
	}
	newItem["canFly"] = false
	updated := siteRequest(t, handler, http.MethodPut, apiPrefix+"/admin/items/"+idString(createdItem.ID)+"/draft", newItem, editorCookies, editorCSRF)
	decodeSite[map[string]any](t, updated, http.StatusOK)
	blocked := siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/items/"+idString(createdItem.ID)+"/publish", map[string]bool{"confirmAnswerChange": false}, editorCookies, editorCSRF)
	if blocked.Code != http.StatusConflict {
		t.Fatalf("answer change without confirmation = %d", blocked.Code)
	}
	approved := siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/items/"+idString(createdItem.ID)+"/publish", map[string]bool{"confirmAnswerChange": true}, editorCookies, editorCSRF)
	decodeSite[map[string]any](t, approved, http.StatusOK)
	newItem["explanation"] = strings.Repeat("उ", 1000)
	longDraft := siteRequest(t, handler, http.MethodPut, apiPrefix+"/admin/items/"+idString(createdItem.ID)+"/draft", newItem, editorCookies, editorCSRF)
	decodeSite[map[string]any](t, longDraft, http.StatusOK)
	public = siteRequest(t, handler, http.MethodGet, apiPrefix+"/items", nil, nil, "")
	if !bytes.Contains(public.Body.Bytes(), []byte(`"name":"test glider","spoken":"टेस्ट ग्लाइडर","canFly":false,"explanation":"It catches air."`)) {
		t.Fatalf("published item answer or explanation missing: %s", public.Body.String())
	}
	newItem["active"] = false
	decodeSite[map[string]any](t, siteRequest(t, handler, http.MethodPut, apiPrefix+"/admin/items/"+idString(createdItem.ID)+"/draft", newItem, editorCookies, editorCSRF), http.StatusOK)
	decodeSite[map[string]any](t, siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/items/"+idString(createdItem.ID)+"/publish", map[string]bool{"confirmAnswerChange": false}, editorCookies, editorCSRF), http.StatusOK)
	public = siteRequest(t, handler, http.MethodGet, apiPrefix+"/items", nil, nil, "")
	if bytes.Contains(public.Body.Bytes(), []byte("test glider")) {
		t.Fatal("not-live item remained in the game")
	}

	if _, err := db.Exec(`INSERT INTO scores(player, score, created_at) VALUES('Keeper', 99, 1), ('Mira', 8, 2)`); err != nil {
		t.Fatal(err)
	}
	publicBoard := siteRequest(t, handler, http.MethodGet, apiPrefix+"/scores/all", nil, nil, "")
	if bytes.Contains(publicBoard.Body.Bytes(), []byte(`"player":"Keeper"`)) {
		t.Fatal("Keeper leaked to public board")
	}
	adminBoard := siteRequest(t, handler, http.MethodGet, apiPrefix+"/admin/scores?includePrivate=true", nil, userCookies, "")
	if !bytes.Contains(adminBoard.Body.Bytes(), []byte(`"player":"Keeper"`)) {
		t.Fatal("user-admin could not see toggled Keeper scores")
	}
	defaultBoard := siteRequest(t, handler, http.MethodGet, apiPrefix+"/admin/scores", nil, adminCookies, "")
	if bytes.Contains(defaultBoard.Body.Bytes(), []byte(`"player":"Keeper"`)) {
		t.Fatal("Keeper appeared by default")
	}
}

func TestAdminClaimAndResetAreScoped(t *testing.T) {
	t.Setenv("SUPER_ADMIN_USERNAME", "Keeper")
	hash, err := bcrypt.GenerateFromPassword([]byte("keeper-test-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SUPER_ADMIN_PASSWORD_HASH", string(hash))
	handler, db := newTestServerWithDB(t)
	for _, name := range []string{"Mira", "Moderator", "Editor"} {
		response := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/register", map[string]string{"username": name, "password": testPassword}, nil, "")
		decodeSite[map[string]any](t, response, http.StatusCreated)
	}
	var miraID, moderatorID, editorID int64
	for _, row := range []struct {
		name string
		id   *int64
	}{{"mira", &miraID}, {"moderator", &moderatorID}, {"editor", &editorID}} {
		if err := db.QueryRow(`SELECT id FROM accounts WHERE username_key = ?`, row.name).Scan(row.id); err != nil {
			t.Fatal(err)
		}
	}
	adminLogin := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/login", map[string]string{"username": "Keeper", "password": "keeper-test-password"}, nil, "")
	var keeper struct {
		CSRF string `json:"csrf"`
	}
	keeper = decodeSite[struct {
		CSRF string `json:"csrf"`
	}](t, adminLogin, http.StatusOK)
	for _, grant := range []struct {
		id            int64
		editor, users bool
	}{{moderatorID, false, true}, {editorID, true, false}} {
		response := siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/users/"+idString(grant.id)+"/roles", map[string]bool{"contentEditor": grant.editor, "userAdmin": grant.users}, adminLogin.Result().Cookies(), keeper.CSRF)
		decodeSite[map[string]any](t, response, http.StatusOK)
	}
	moderatorLogin := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/login", map[string]string{"username": "Moderator", "password": testPassword}, nil, "")
	var moderator struct {
		CSRF string `json:"csrf"`
	}
	moderator = decodeSite[struct {
		CSRF string `json:"csrf"`
	}](t, moderatorLogin, http.StatusOK)
	cookies := moderatorLogin.Result().Cookies()
	if _, err := db.Exec(`INSERT INTO scores(player, score, created_at) VALUES('Mira', 10, 1), ('Mira', 9, 2), ('Keeper', 90, 3)`); err != nil {
		t.Fatal(err)
	}
	var firstID, secondID, adminScoreID int64
	for _, row := range []struct {
		player string
		score  int
		id     *int64
	}{{"Mira", 10, &firstID}, {"Mira", 9, &secondID}, {"Keeper", 90, &adminScoreID}} {
		if err := db.QueryRow(`SELECT id FROM scores WHERE player = ? AND score = ?`, row.player, row.score).Scan(row.id); err != nil {
			t.Fatal(err)
		}
	}
	claim := siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/scores/"+idString(firstID)+"/claim", map[string]any{"accountId": miraID}, cookies, moderator.CSRF)
	decodeSite[map[string]any](t, claim, http.StatusOK)
	var firstClaimed, secondClaimed int
	if err := db.QueryRow(`SELECT account_id IS NOT NULL FROM scores WHERE id = ?`, firstID).Scan(&firstClaimed); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT account_id IS NOT NULL FROM scores WHERE id = ?`, secondID).Scan(&secondClaimed); err != nil {
		t.Fatal(err)
	}
	if firstClaimed != 1 || secondClaimed != 0 {
		t.Fatalf("first/second claim = %d/%d, want 1/0", firstClaimed, secondClaimed)
	}
	forbidden := siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/scores/"+idString(adminScoreID)+"/claim", map[string]any{"accountId": miraID}, cookies, moderator.CSRF)
	if forbidden.Code != http.StatusConflict {
		t.Fatalf("Keeper score claim status = %d", forbidden.Code)
	}
	forbidden = siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/users/"+idString(editorID)+"/reset", map[string]string{"verificationNote": "Spoke with player directly"}, cookies, moderator.CSRF)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("admin reset by user-admin = %d", forbidden.Code)
	}
	oldLogin := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/login", map[string]string{"username": "Mira", "password": testPassword}, nil, "")
	decodeSite[map[string]any](t, oldLogin, http.StatusOK)
	reset := siteRequest(t, handler, http.MethodPost, apiPrefix+"/admin/users/"+idString(miraID)+"/reset", map[string]string{"verificationNote": "Spoke with player directly"}, cookies, moderator.CSRF)
	var resetResult struct {
		ResetCode string `json:"resetCode"`
	}
	resetResult = decodeSite[struct {
		ResetCode string `json:"resetCode"`
	}](t, reset, http.StatusOK)
	if resetResult.ResetCode == "" {
		t.Fatal("reset code missing")
	}
	me := siteRequest(t, handler, http.MethodGet, apiPrefix+"/auth/me", nil, oldLogin.Result().Cookies(), "")
	if me.Code != http.StatusUnauthorized {
		t.Fatalf("old session after reset = %d", me.Code)
	}
	newPassword := "another sufficiently long phrase"
	used := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/reset", map[string]string{"username": "Mira", "token": resetResult.ResetCode, "password": newPassword}, nil, "")
	decodeSite[map[string]any](t, used, http.StatusOK)
	reused := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/reset", map[string]string{"username": "Mira", "token": resetResult.ResetCode, "password": testPassword}, nil, "")
	if reused.Code != http.StatusForbidden {
		t.Fatalf("reused reset code status = %d", reused.Code)
	}
	loginNew := siteRequest(t, handler, http.MethodPost, apiPrefix+"/auth/login", map[string]string{"username": "Mira", "password": newPassword}, nil, "")
	if loginNew.Code != http.StatusOK {
		t.Fatalf("new password login status = %d", loginNew.Code)
	}
}

func idString(id int64) string { return fmt.Sprint(id) }
