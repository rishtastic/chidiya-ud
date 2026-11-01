package leaderboard

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

type gameItem struct {
	ID          int64  `json:"id"`
	Language    string `json:"language"`
	Name        string `json:"name"`
	Spoken      string `json:"spoken"`
	CanFly      bool   `json:"canFly"`
	Explanation string `json:"explanation"`
	Active      bool   `json:"active"`
}

type adminItem struct {
	gameItem
	Draft *gameItem `json:"draft,omitempty"`
}

type itemInput struct {
	Language    string `json:"language"`
	Name        string `json:"name"`
	Spoken      string `json:"spoken"`
	CanFly      bool   `json:"canFly"`
	Explanation string `json:"explanation"`
	Active      bool   `json:"active"`
}

func (input *itemInput) validate() error {
	input.Language = strings.TrimSpace(input.Language)
	input.Name = strings.TrimSpace(input.Name)
	input.Spoken = strings.TrimSpace(input.Spoken)
	input.Explanation = strings.TrimSpace(input.Explanation)
	if input.Language != "english" && input.Language != "hindi" {
		return errors.New("Choose English or Hindi.")
	}
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 80 {
		return errors.New("Item name must be 1-80 characters.")
	}
	if input.Spoken == "" || utf8.RuneCountInString(input.Spoken) > 160 {
		return errors.New("Spoken text must be 1-160 characters.")
	}
	if utf8.RuneCountInString(input.Explanation) > 1000 {
		return errors.New("Explanation must be under 1,000 characters.")
	}
	return nil
}

func (s *server) listPublishedItems(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT id, language, name, spoken, can_fly, explanation FROM items WHERE active = 1 ORDER BY sort_order, id`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not load items.")
		return
	}
	defer rows.Close()
	items := make([]gameItem, 0)
	for rows.Next() {
		var item gameItem
		if err := rows.Scan(&item.ID, &item.Language, &item.Name, &item.Spoken, &item.CanFly, &item.Explanation); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not load items.")
			return
		}
		item.Active = true
		items = append(items, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "Could not load items.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *server) adminListItems(w http.ResponseWriter, r *http.Request) {
	if s.requirePrincipal(w, r, "content") == nil {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT i.id, i.language, i.name, i.spoken, i.can_fly, i.explanation, i.active, d.language, d.name, d.spoken, d.can_fly, d.explanation, d.active FROM items i LEFT JOIN item_drafts d ON d.item_id = i.id ORDER BY i.sort_order, i.id`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not load items.")
		return
	}
	defer rows.Close()
	items := make([]adminItem, 0)
	for rows.Next() {
		var item adminItem
		var language, name, spoken, explanation sql.NullString
		var canFly, active sql.NullBool
		if err := rows.Scan(&item.ID, &item.Language, &item.Name, &item.Spoken, &item.CanFly, &item.Explanation, &item.Active, &language, &name, &spoken, &canFly, &explanation, &active); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not load items.")
			return
		}
		if language.Valid {
			item.Draft = &gameItem{ID: item.ID, Language: language.String, Name: name.String, Spoken: spoken.String, CanFly: canFly.Bool, Explanation: explanation.String, Active: active.Bool}
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusInternalServerError, "Could not load items.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *server) adminCreateItem(w http.ResponseWriter, r *http.Request) {
	p := s.requirePrincipal(w, r, "content")
	if p == nil {
		return
	}
	var input itemInput
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "Invalid item.")
		return
	}
	if err := input.validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create item.")
		return
	}
	defer tx.Rollback()
	var order int
	if err := tx.QueryRowContext(r.Context(), `SELECT COALESCE(MAX(sort_order), -1) + 1 FROM items`).Scan(&order); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create item.")
		return
	}
	now := time.Now().UnixMilli()
	result, err := tx.ExecContext(r.Context(), `INSERT INTO items(language, name, spoken, can_fly, explanation, active, sort_order, updated_at) VALUES(?, ?, ?, ?, '', 0, ?, ?)`, input.Language, input.Name, input.Spoken, input.CanFly, order, now)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create item.")
		return
	}
	id, err := result.LastInsertId()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create item.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO item_drafts(item_id, language, name, spoken, can_fly, explanation, active, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, id, input.Language, input.Name, input.Spoken, input.CanFly, input.Explanation, input.Active, now); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create item.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO item_audit(item_id, actor, action, created_at) VALUES(?, ?, 'create-draft', ?)`, id, p.Username, now); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create item.")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create item.")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int64{"id": id})
}

func (s *server) adminSaveItemDraft(w http.ResponseWriter, r *http.Request) {
	p := s.requirePrincipal(w, r, "content")
	if p == nil {
		return
	}
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid item.")
		return
	}
	var input itemInput
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "Invalid item.")
		return
	}
	if err := input.validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not save draft.")
		return
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRowContext(r.Context(), `SELECT 1 FROM items WHERE id = ?`, id).Scan(&exists); err != nil {
		writeError(w, http.StatusNotFound, "Item not found.")
		return
	}
	now := time.Now().UnixMilli()
	_, err = tx.ExecContext(r.Context(), `INSERT INTO item_drafts(item_id, language, name, spoken, can_fly, explanation, active, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET language=excluded.language, name=excluded.name, spoken=excluded.spoken, can_fly=excluded.can_fly, explanation=excluded.explanation, active=excluded.active, updated_at=excluded.updated_at`, id, input.Language, input.Name, input.Spoken, input.CanFly, input.Explanation, input.Active, now)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not save draft.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO item_audit(item_id, actor, action, created_at) VALUES(?, ?, 'save-draft', ?)`, id, p.Username, now); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not save draft.")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not save draft.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

func (s *server) adminPublishItem(w http.ResponseWriter, r *http.Request) {
	p := s.requirePrincipal(w, r, "content")
	if p == nil {
		return
	}
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid item.")
		return
	}
	var input struct {
		ConfirmAnswerChange bool `json:"confirmAnswerChange"`
	}
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "Invalid publish request.")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not publish item.")
		return
	}
	defer tx.Rollback()
	var draft itemInput
	err = tx.QueryRowContext(r.Context(), `SELECT language, name, spoken, can_fly, explanation, active FROM item_drafts WHERE item_id = ?`, id).Scan(&draft.Language, &draft.Name, &draft.Spoken, &draft.CanFly, &draft.Explanation, &draft.Active)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "No draft to publish.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not publish item.")
		return
	}
	var oldCanFly, oldActive bool
	if err := tx.QueryRowContext(r.Context(), `SELECT can_fly, active FROM items WHERE id = ?`, id).Scan(&oldCanFly, &oldActive); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not publish item.")
		return
	}
	if oldActive && oldCanFly != draft.CanFly && !input.ConfirmAnswerChange {
		writeError(w, http.StatusConflict, "Confirm the changed flying answer before publishing.")
		return
	}
	if draft.Active {
		var duplicate int
		if err := tx.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM items WHERE id <> ? AND active = 1 AND language = ? AND LOWER(name) = LOWER(?)`, id, draft.Language, draft.Name).Scan(&duplicate); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not publish item.")
			return
		}
		if duplicate != 0 {
			writeError(w, http.StatusConflict, "An active item already uses that name in this language.")
			return
		}
	}
	now := time.Now().UnixMilli()
	if _, err := tx.ExecContext(r.Context(), `UPDATE items SET language=?, name=?, spoken=?, can_fly=?, explanation=?, active=?, updated_at=? WHERE id=?`, draft.Language, draft.Name, draft.Spoken, draft.CanFly, draft.Explanation, draft.Active, now, id); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not publish item.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `DELETE FROM item_drafts WHERE item_id=?`, id); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not publish item.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO item_audit(item_id, actor, action, created_at) VALUES(?, ?, ?, ?)`, id, p.Username, map[bool]string{true: "publish", false: "archive"}[draft.Active], now); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not publish item.")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not publish item.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"published": draft.Active})
}
