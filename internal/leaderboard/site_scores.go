package leaderboard

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type boardRow struct {
	ID          int64  `json:"id,omitempty"`
	Rank        int    `json:"rank"`
	Player      string `json:"player"`
	Score       int    `json:"score"`
	CreatedAt   string `json:"createdAt,omitempty"`
	AccountID   *int64 `json:"accountId,omitempty"`
	AccountName string `json:"accountName,omitempty"`
	IsPrivate   bool   `json:"isPrivate,omitempty"`
}

func boardQuery(r *http.Request) (string, int, bool) {
	search := strings.TrimSpace(r.URL.Query().Get("search"))
	if len(search) > 80 {
		search = search[:80]
	}
	page, err := strconv.Atoi(r.URL.Query().Get("page"))
	if err != nil || page < 1 {
		page = 1
	}
	if page > 100000 {
		page = 100000
	}
	return search, page, r.URL.Query().Get("includePrivate") == "true"
}

func (s *server) listAllScores(w http.ResponseWriter, r *http.Request) {
	s.listBoard(w, r, false, false)
}

func (s *server) adminListScores(w http.ResponseWriter, r *http.Request) {
	if s.requirePrincipal(w, r, "users") == nil {
		return
	}
	s.listBoard(w, r, true, true)
}

func (s *server) listBoard(w http.ResponseWriter, r *http.Request, admin, allowPrivate bool) {
	search, page, includePrivate := boardQuery(r)
	includePrivate = allowPrivate && includePrivate
	const pageSize = 50
	var total int
	err := s.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM scores WHERE (? OR LOWER(TRIM(player)) <> LOWER(?)) AND INSTR(LOWER(player), LOWER(?)) > 0`, includePrivate, s.adminName, search).Scan(&total)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not load leaderboard.")
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		WITH ranked AS (
			SELECT id, player, score, created_at, account_id,
			RANK() OVER (ORDER BY score DESC) AS rank
			FROM scores WHERE (? OR LOWER(TRIM(player)) <> LOWER(?))
		)
		SELECT ranked.id, ranked.rank, ranked.player, ranked.score, ranked.created_at, ranked.account_id, COALESCE(accounts.username, '')
		FROM ranked LEFT JOIN accounts ON accounts.id = ranked.account_id
		WHERE INSTR(LOWER(ranked.player), LOWER(?)) > 0
		ORDER BY ranked.score DESC, ranked.created_at ASC, ranked.id ASC
		LIMIT ? OFFSET ?
	`, includePrivate, s.adminName, search, pageSize, (page-1)*pageSize)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not load leaderboard.")
		return
	}
	defer rows.Close()
	result := make([]boardRow, 0)
	for rows.Next() {
		var row boardRow
		var createdAt int64
		var accountID sql.NullInt64
		if err := rows.Scan(&row.ID, &row.Rank, &row.Player, &row.Score, &createdAt, &accountID, &row.AccountName); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not load leaderboard.")
			return
		}
		if admin {
			row.IsPrivate = s.isAdmin(row.Player)
			row.CreatedAt = time.UnixMilli(createdAt).UTC().Format(time.RFC3339)
			if accountID.Valid {
				row.AccountID = &accountID.Int64
			}
		} else {
			row.ID = 0
			row.AccountName = ""
		}
		result = append(result, row)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "Could not load leaderboard.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scores": result, "page": page, "pageSize": pageSize, "total": total, "includePrivate": includePrivate})
}

func (s *server) adminListUsers(w http.ResponseWriter, r *http.Request) {
	if s.requirePrincipal(w, r, "users") == nil {
		return
	}
	search, page, _ := boardQuery(r)
	rows, err := s.db.QueryContext(r.Context(), `SELECT a.id, a.username, a.role_content_editor, a.role_user_admin, COUNT(s.id) FROM accounts a LEFT JOIN scores s ON s.account_id = a.id WHERE INSTR(LOWER(a.username), LOWER(?)) > 0 GROUP BY a.id ORDER BY a.username_key LIMIT 50 OFFSET ?`, search, (page-1)*50)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not load users.")
		return
	}
	defer rows.Close()
	users := make([]map[string]any, 0)
	for rows.Next() {
		var id, scoreCount int64
		var username string
		var contentEditor, userAdmin bool
		if err := rows.Scan(&id, &username, &contentEditor, &userAdmin, &scoreCount); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not load users.")
			return
		}
		users = append(users, map[string]any{"id": id, "username": username, "contentEditor": contentEditor, "userAdmin": userAdmin, "scoreCount": scoreCount})
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "Could not load users.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users, "page": page})
}

func (s *server) adminLookupUser(w http.ResponseWriter, r *http.Request) {
	if s.requirePrincipal(w, r, "users") == nil {
		return
	}
	key := usernameKey(r.URL.Query().Get("username"))
	if key == "" || s.isAdmin(key) {
		writeError(w, http.StatusNotFound, "Account not found.")
		return
	}
	var id int64
	var username string
	err := s.db.QueryRowContext(r.Context(), `SELECT id, username FROM accounts WHERE username_key = ?`, key).Scan(&id, &username)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Account not found.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not find account.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "username": username})
}

func (s *server) adminClaimScore(w http.ResponseWriter, r *http.Request) {
	p := s.requirePrincipal(w, r, "users")
	if p == nil {
		return
	}
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid score.")
		return
	}
	var input struct {
		AccountID int64 `json:"accountId"`
	}
	if decodeJSON(r, &input) != nil || input.AccountID < 1 {
		writeError(w, http.StatusBadRequest, "Choose an account.")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not claim score.")
		return
	}
	defer tx.Rollback()
	var player, accountKey string
	var existing sql.NullInt64
	err = tx.QueryRowContext(r.Context(), `SELECT player, account_id FROM scores WHERE id = ?`, id).Scan(&player, &existing)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Score not found.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not claim score.")
		return
	}
	if s.isAdmin(player) || existing.Valid {
		writeError(w, http.StatusConflict, "This score cannot be claimed.")
		return
	}
	if err := tx.QueryRowContext(r.Context(), `SELECT username_key FROM accounts WHERE id = ?`, input.AccountID).Scan(&accountKey); err != nil {
		writeError(w, http.StatusNotFound, "Account not found.")
		return
	}
	if usernameKey(player) != accountKey {
		writeError(w, http.StatusConflict, "Score name does not match that account.")
		return
	}
	now := time.Now().UnixMilli()
	updated, err := tx.ExecContext(r.Context(), `UPDATE scores SET account_id = ? WHERE id = ? AND account_id IS NULL`, input.AccountID, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not claim score.")
		return
	}
	if changed, err := updated.RowsAffected(); err != nil || changed != 1 {
		writeError(w, http.StatusConflict, "This score has already been claimed.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO score_claim_audit(score_id, account_id, actor, action, created_at) VALUES(?, ?, ?, 'claim', ?)`, id, input.AccountID, p.Username, now); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not claim score.")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not claim score.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"claimed": true})
}

func (s *server) adminUnclaimScore(w http.ResponseWriter, r *http.Request) {
	p := s.requirePrincipal(w, r, "users")
	if p == nil {
		return
	}
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid score.")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not reverse claim.")
		return
	}
	defer tx.Rollback()
	var accountID sql.NullInt64
	var player string
	err = tx.QueryRowContext(r.Context(), `SELECT player, account_id FROM scores WHERE id = ?`, id).Scan(&player, &accountID)
	if err != nil || !accountID.Valid || s.isAdmin(player) {
		writeError(w, http.StatusConflict, "This claim cannot be reversed.")
		return
	}
	now := time.Now().UnixMilli()
	if _, err := tx.ExecContext(r.Context(), `UPDATE scores SET account_id = NULL WHERE id = ?`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not reverse claim.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO score_claim_audit(score_id, account_id, actor, action, created_at) VALUES(?, ?, ?, 'unclaim', ?)`, id, accountID.Int64, p.Username, now); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not reverse claim.")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not reverse claim.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"unclaimed": true})
}

func (s *server) adminResetUser(w http.ResponseWriter, r *http.Request) {
	p := s.requirePrincipal(w, r, "users")
	if p == nil {
		return
	}
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid account.")
		return
	}
	var input struct {
		VerificationNote string `json:"verificationNote"`
		RecoveryCode     string `json:"recoveryCode"`
	}
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "Invalid reset request.")
		return
	}
	input.VerificationNote = strings.TrimSpace(input.VerificationNote)
	if len(input.VerificationNote) < 10 || len(input.VerificationNote) > 500 {
		writeError(w, http.StatusBadRequest, "Record how the request was verified (10-500 characters). ")
		return
	}
	var username, recoveryHash string
	var contentEditor, userAdmin bool
	err = s.db.QueryRowContext(r.Context(), `SELECT username, recovery_hash, role_content_editor, role_user_admin FROM accounts WHERE id = ?`, id).Scan(&username, &recoveryHash, &contentEditor, &userAdmin)
	if err != nil {
		writeError(w, http.StatusNotFound, "Account not found.")
		return
	}
	if !p.SuperAdmin && (contentEditor || userAdmin) {
		writeError(w, http.StatusForbidden, "Only the super admin can reset an admin account.")
		return
	}
	if input.RecoveryCode != "" && tokenHash(input.RecoveryCode) != recoveryHash {
		writeError(w, http.StatusForbidden, "Recovery code does not match.")
		return
	}
	code, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create reset code.")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create reset code.")
		return
	}
	defer tx.Rollback()
	now := time.Now().UnixMilli()
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO password_resets(token_hash, account_id, expires_at, created_by) VALUES(?, ?, ?, ?)`, tokenHash(code), id, time.Now().Add(resetLifetime).UnixMilli(), p.Username); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create reset code.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE auth_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`, now, id); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create reset code.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO admin_audit(actor, action, target, detail, created_at) VALUES(?, 'password-reset', ?, ?, ?)`, p.Username, username, input.VerificationNote, now); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create reset code.")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create reset code.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"resetCode": code, "username": username})
}

func (s *server) adminSetRoles(w http.ResponseWriter, r *http.Request) {
	p := s.requirePrincipal(w, r, "super")
	if p == nil {
		return
	}
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid account.")
		return
	}
	var input struct {
		ContentEditor bool `json:"contentEditor"`
		UserAdmin     bool `json:"userAdmin"`
	}
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "Invalid roles.")
		return
	}
	var username string
	if err := s.db.QueryRowContext(r.Context(), `SELECT username FROM accounts WHERE id = ?`, id).Scan(&username); err != nil {
		writeError(w, http.StatusNotFound, "Account not found.")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update roles.")
		return
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(), `UPDATE accounts SET role_content_editor = ?, role_user_admin = ? WHERE id = ?`, input.ContentEditor, input.UserAdmin, id); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update roles.")
		return
	}
	detail := "content-editor=" + strconv.FormatBool(input.ContentEditor) + ", user-admin=" + strconv.FormatBool(input.UserAdmin)
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO admin_audit(actor, action, target, detail, created_at) VALUES(?, 'roles', ?, ?, ?)`, p.Username, username, detail, time.Now().UnixMilli()); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update roles.")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update roles.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"updated": true})
}
