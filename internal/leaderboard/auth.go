package leaderboard

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/bcrypt"
)

const (
	authCookieName  = "chidiya_auth"
	guestCookieName = "chidiya_guest"
	authLifetime    = 7 * 24 * time.Hour
	guestLifetime   = 24 * time.Hour
	resetLifetime   = 15 * time.Minute
	passwordMemory  = 19 * 1024
	passwordTime    = 2
)

type principal struct {
	ID            int64  `json:"-"`
	Username      string `json:"username"`
	ContentEditor bool   `json:"contentEditor"`
	UserAdmin     bool   `json:"userAdmin"`
	SuperAdmin    bool   `json:"superAdmin"`
	CSRF          string `json:"csrf"`
	TokenHash     string `json:"-"`
}

func usernameKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func randomToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func tokenHash(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}

func validPassword(password, username string) error {
	if utf8.RuneCountInString(password) < 15 || len(password) > 256 {
		return errors.New("Use a password of at least 15 characters (up to 256 bytes).")
	}
	lower := strings.ToLower(password)
	if lower == usernameKey(username) || strings.Contains(lower, "password123") || strings.Contains(lower, "123456789") {
		return errors.New("Choose a less common password.")
	}
	return nil
}

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, passwordTime, passwordMemory, 1, 32)
	return fmt.Sprintf("argon2id$v=19$m=%d,t=%d,p=1$%s$%s", passwordMemory, passwordTime, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 5 || parts[0] != "argon2id" || parts[1] != "v=19" {
		return false
	}
	var memory, iterations, parallelism uint32
	if _, err := fmt.Sscanf(parts[2], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil || memory != passwordMemory || iterations != passwordTime || parallelism != 1 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil || len(salt) != 16 {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(want) != 32 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, uint8(parallelism), uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func secureRequest(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, name, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/chidiya-ud/", Secure: secureRequest(r), HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}

func (s *server) newAuthSession(w http.ResponseWriter, r *http.Request, accountID int64, isSuperAdmin bool) (string, error) {
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	csrf, err := randomToken()
	if err != nil {
		return "", err
	}
	adminName := ""
	if isSuperAdmin {
		adminName = s.adminName
	}
	_, err = s.db.ExecContext(r.Context(), `INSERT INTO auth_sessions(token_hash, account_id, is_super_admin, admin_username, csrf_token, expires_at) VALUES(?, ?, ?, ?, ?, ?)`, tokenHash(token), nullableAccountID(accountID), isSuperAdmin, adminName, csrf, time.Now().Add(authLifetime).UnixMilli())
	if err != nil {
		return "", err
	}
	setSessionCookie(w, r, authCookieName, token, int(authLifetime.Seconds()))
	return csrf, nil
}

func nullableAccountID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

func (s *server) currentPrincipal(r *http.Request) (*principal, error) {
	cookie, err := r.Cookie(authCookieName)
	if err != nil {
		return nil, nil
	}
	var p principal
	var id sql.NullInt64
	var isSuperAdmin int
	var adminName string
	err = s.db.QueryRowContext(r.Context(), `SELECT account_id, is_super_admin, admin_username, csrf_token FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`, tokenHash(cookie.Value), time.Now().UnixMilli()).Scan(&id, &isSuperAdmin, &adminName, &p.CSRF)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.TokenHash = tokenHash(cookie.Value)
	if isSuperAdmin != 0 {
		if !s.isAdmin(adminName) || len(s.adminPasswordHash) == 0 {
			return nil, nil
		}
		p.SuperAdmin, p.ContentEditor, p.UserAdmin, p.Username = true, true, true, s.adminName
		return &p, nil
	}
	if !id.Valid {
		return nil, nil
	}
	p.ID = id.Int64
	err = s.db.QueryRowContext(r.Context(), `SELECT username, role_content_editor, role_user_admin FROM accounts WHERE id = ?`, p.ID).Scan(&p.Username, &p.ContentEditor, &p.UserAdmin)
	if s.isAdmin(p.Username) {
		return nil, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &p, err
}

func (s *server) requirePrincipal(w http.ResponseWriter, r *http.Request, role string) *principal {
	p, err := s.currentPrincipal(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not verify your session.")
		return nil
	}
	if p == nil || (role == "content" && !p.ContentEditor) || (role == "users" && !p.UserAdmin) || (role == "super" && !p.SuperAdmin) {
		writeError(w, http.StatusForbidden, "You do not have access to this action.")
		return nil
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if r.Header.Get("X-CSRF-Token") != p.CSRF || !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "Session verification failed.")
			return nil
		}
	}
	return p
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	scheme := "http"
	if secureRequest(r) {
		scheme = "https"
	}
	return origin == scheme+"://"+r.Host
}

func (s *server) authMe(w http.ResponseWriter, r *http.Request) {
	p, err := s.currentPrincipal(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not load account.")
		return
	}
	if p == nil {
		writeError(w, http.StatusUnauthorized, "Not signed in.")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *server) authLogin(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "Request not allowed.")
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "Enter a name and password.")
		return
	}
	key := usernameKey(input.Username)
	if _, err := validPlayerName(input.Username); err != nil || len(input.Password) == 0 || len(input.Password) > 256 {
		writeError(w, http.StatusForbidden, "Name or password is incorrect.")
		return
	}
	if !s.limiter.allow("login-ip:"+clientIP(r), 40, 15*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "Please try again later.")
		return
	}
	if !s.limiter.allow("login:"+clientIP(r)+":"+key, 8, 15*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "Please try again later.")
		return
	}
	var accountID int64
	valid := false
	if s.isAdmin(input.Username) {
		valid = len(s.adminPasswordHash) > 0 && len(input.Password) <= 72 && bcrypt.CompareHashAndPassword(s.adminPasswordHash, []byte(input.Password)) == nil
	} else {
		var hash string
		err := s.db.QueryRowContext(r.Context(), `SELECT id, password_hash FROM accounts WHERE username_key = ?`, key).Scan(&accountID, &hash)
		if err == nil {
			valid = verifyPassword(hash, input.Password)
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "Could not sign in.")
			return
		}
	}
	if !valid {
		writeError(w, http.StatusForbidden, "Name or password is incorrect.")
		return
	}
	csrf, err := s.newAuthSession(w, r, accountID, s.isAdmin(input.Username))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not sign in.")
		return
	}
	p := principal{ID: accountID, Username: strings.TrimSpace(input.Username), CSRF: csrf}
	if s.isAdmin(input.Username) {
		p.Username, p.SuperAdmin, p.ContentEditor, p.UserAdmin = s.adminName, true, true, true
	}
	if accountID != 0 {
		_ = s.db.QueryRowContext(r.Context(), `SELECT username, role_content_editor, role_user_admin FROM accounts WHERE id = ?`, accountID).Scan(&p.Username, &p.ContentEditor, &p.UserAdmin)
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *server) authLogout(w http.ResponseWriter, r *http.Request) {
	p := s.requirePrincipal(w, r, "")
	if p == nil {
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?`, time.Now().UnixMilli(), p.TokenHash); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not sign out.")
		return
	}
	setSessionCookie(w, r, authCookieName, "", -1)
	writeJSON(w, http.StatusOK, map[string]bool{"signedOut": true})
}

func (s *server) authRegister(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "Request not allowed.")
		return
	}
	if !s.limiter.allow("register:"+clientIP(r), 5, time.Hour) {
		writeError(w, http.StatusTooManyRequests, "Please try again later.")
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "Enter a name and password.")
		return
	}
	username, err := validPlayerName(input.Username)
	if err != nil || s.isAdmin(username) {
		writeError(w, http.StatusBadRequest, "Choose a different name.")
		return
	}
	if err := validPassword(input.Password, username); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := hashPassword(input.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create account.")
		return
	}
	recovery, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create account.")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create account.")
		return
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(r.Context(), `INSERT INTO accounts(username, username_key, password_hash, recovery_hash, created_at) VALUES(?, ?, ?, ?, ?)`, username, usernameKey(username), hash, tokenHash(recovery), time.Now().UnixMilli())
	if err != nil {
		writeError(w, http.StatusConflict, "That name is already claimed.")
		return
	}
	id, err := result.LastInsertId()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create account.")
		return
	}
	if cookie, err := r.Cookie(guestCookieName); err == nil {
		guestHash := tokenHash(cookie.Value)
		var guestKey string
		if tx.QueryRowContext(r.Context(), `SELECT player_key FROM guest_sessions WHERE token_hash = ? AND ended_at IS NULL AND expires_at > ?`, guestHash, time.Now().UnixMilli()).Scan(&guestKey) == nil && guestKey == usernameKey(username) {
			if _, err := tx.ExecContext(r.Context(), `INSERT INTO score_claim_audit(score_id, account_id, actor, action, created_at) SELECT id, ?, ?, 'guest-claim', ? FROM scores WHERE guest_session_hash = ? AND account_id IS NULL`, id, username, time.Now().UnixMilli(), guestHash); err != nil {
				writeError(w, http.StatusInternalServerError, "Could not claim session scores.")
				return
			}
			if _, err := tx.ExecContext(r.Context(), `UPDATE scores SET account_id = ? WHERE guest_session_hash = ? AND account_id IS NULL`, id, guestHash); err != nil {
				writeError(w, http.StatusInternalServerError, "Could not claim session scores.")
				return
			}
			if _, err := tx.ExecContext(r.Context(), `UPDATE guest_sessions SET ended_at = ? WHERE token_hash = ?`, time.Now().UnixMilli(), guestHash); err != nil {
				writeError(w, http.StatusInternalServerError, "Could not create account.")
				return
			}
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create account.")
		return
	}
	setSessionCookie(w, r, guestCookieName, "", -1)
	if _, err := s.newAuthSession(w, r, id, false); err != nil {
		writeError(w, http.StatusInternalServerError, "Account created. Sign in to continue.")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"username": username, "recoveryCode": recovery})
}

func (s *server) authReset(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "Request not allowed.")
		return
	}
	var input struct {
		Username string `json:"username"`
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "Invalid reset request.")
		return
	}
	if err := validPassword(input.Password, input.Username); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !s.limiter.allow("reset:"+clientIP(r), 8, 15*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "Please try again later.")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not reset password.")
		return
	}
	defer tx.Rollback()
	var id int64
	err = tx.QueryRowContext(r.Context(), `SELECT a.id FROM password_resets p JOIN accounts a ON a.id = p.account_id WHERE p.token_hash = ? AND a.username_key = ? AND p.used_at IS NULL AND p.expires_at > ?`, tokenHash(input.Token), usernameKey(input.Username), time.Now().UnixMilli()).Scan(&id)
	if err != nil {
		writeError(w, http.StatusForbidden, "Reset code is invalid or expired.")
		return
	}
	hash, err := hashPassword(input.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not reset password.")
		return
	}
	now := time.Now().UnixMilli()
	if _, err := tx.ExecContext(r.Context(), `UPDATE accounts SET password_hash = ? WHERE id = ?`, hash, id); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not reset password.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE password_resets SET used_at = ? WHERE account_id = ? AND used_at IS NULL`, now, id); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not reset password.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE auth_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`, now, id); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not reset password.")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not reset password.")
		return
	}
	setSessionCookie(w, r, authCookieName, "", -1)
	writeJSON(w, http.StatusOK, map[string]bool{"reset": true})
}

func (s *server) endGuest(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "Request not allowed.")
		return
	}
	if cookie, err := r.Cookie(guestCookieName); err == nil {
		_, _ = s.db.ExecContext(r.Context(), `UPDATE guest_sessions SET ended_at = ? WHERE token_hash = ? AND ended_at IS NULL`, time.Now().UnixMilli(), tokenHash(cookie.Value))
	}
	setSessionCookie(w, r, guestCookieName, "", -1)
	writeJSON(w, http.StatusOK, map[string]bool{"ended": true})
}

func (s *server) ensureGuest(w http.ResponseWriter, r *http.Request, player string) (string, error) {
	key := usernameKey(player)
	if cookie, err := r.Cookie(guestCookieName); err == nil {
		hash := tokenHash(cookie.Value)
		var storedKey string
		if s.db.QueryRowContext(r.Context(), `SELECT player_key FROM guest_sessions WHERE token_hash = ? AND ended_at IS NULL AND expires_at > ?`, hash, time.Now().UnixMilli()).Scan(&storedKey) == nil && storedKey == key {
			return hash, nil
		}
		_, _ = s.db.ExecContext(r.Context(), `UPDATE guest_sessions SET ended_at = ? WHERE token_hash = ? AND ended_at IS NULL`, time.Now().UnixMilli(), hash)
	}
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	hash := tokenHash(token)
	now := time.Now()
	_, err = s.db.ExecContext(r.Context(), `INSERT INTO guest_sessions(token_hash, player_key, created_at, expires_at) VALUES(?, ?, ?, ?)`, hash, key, now.UnixMilli(), now.Add(guestLifetime).UnixMilli())
	if err != nil {
		return "", err
	}
	setSessionCookie(w, r, guestCookieName, token, 0)
	return hash, nil
}

func parseID(value string) (int64, error) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id < 1 {
		return 0, errors.New("invalid id")
	}
	return id, nil
}
