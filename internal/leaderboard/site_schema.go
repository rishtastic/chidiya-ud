package leaderboard

import (
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
)

//go:embed item_seed.json
var itemSeedFS embed.FS

type seedItem struct {
	Language string `json:"language"`
	Name     string `json:"name"`
	Spoken   string `json:"spoken"`
	CanFly   bool   `json:"canFly"`
}

func migrateSite(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS accounts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL,
			username_key TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			recovery_hash TEXT NOT NULL,
			role_content_editor INTEGER NOT NULL DEFAULT 0,
			role_user_admin INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS auth_sessions (
			token_hash TEXT PRIMARY KEY,
			account_id INTEGER REFERENCES accounts(id),
			is_super_admin INTEGER NOT NULL DEFAULT 0,
			admin_username TEXT NOT NULL DEFAULT '',
			csrf_token TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			revoked_at INTEGER
		);
		CREATE TABLE IF NOT EXISTS guest_sessions (
			token_hash TEXT PRIMARY KEY,
			player_key TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			ended_at INTEGER
		);
		CREATE TABLE IF NOT EXISTS password_resets (
			token_hash TEXT PRIMARY KEY,
			account_id INTEGER NOT NULL REFERENCES accounts(id),
			expires_at INTEGER NOT NULL,
			used_at INTEGER,
			created_by TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS items (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			language TEXT NOT NULL,
			name TEXT NOT NULL,
			spoken TEXT NOT NULL,
			can_fly INTEGER NOT NULL,
			explanation TEXT NOT NULL DEFAULT '',
			active INTEGER NOT NULL DEFAULT 1,
			sort_order INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS item_drafts (
			item_id INTEGER PRIMARY KEY REFERENCES items(id),
			language TEXT NOT NULL,
			name TEXT NOT NULL,
			spoken TEXT NOT NULL,
			can_fly INTEGER NOT NULL,
			explanation TEXT NOT NULL,
			active INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS item_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			item_id INTEGER NOT NULL,
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS score_claim_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			score_id INTEGER NOT NULL,
			account_id INTEGER NOT NULL,
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS admin_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			target TEXT NOT NULL,
			detail TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS guest_sessions_player ON guest_sessions(player_key);
	`)
	if err != nil {
		return err
	}
	for _, column := range []struct{ table, name, definition string }{
		{"auth_sessions", "is_super_admin", "INTEGER NOT NULL DEFAULT 0"},
		{"auth_sessions", "admin_username", "TEXT NOT NULL DEFAULT ''"},
		{"sessions", "account_id", "INTEGER REFERENCES accounts(id)"},
		{"sessions", "guest_session_hash", "TEXT REFERENCES guest_sessions(token_hash)"},
		{"scores", "account_id", "INTEGER REFERENCES accounts(id)"},
		{"scores", "guest_session_hash", "TEXT REFERENCES guest_sessions(token_hash)"},
	} {
		if err := addColumnIfMissing(db, column.table, column.name, column.definition); err != nil {
			return err
		}
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS scores_account ON scores(account_id); CREATE INDEX IF NOT EXISTS scores_guest ON scores(guest_session_hash)`); err != nil {
		return err
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM items`).Scan(&count); err != nil || count != 0 {
		return err
	}
	data, err := itemSeedFS.ReadFile("item_seed.json")
	if err != nil {
		return err
	}
	var seed []seedItem
	if err := json.Unmarshal(data, &seed); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for index, item := range seed {
		if _, err := tx.Exec(`INSERT INTO items(language, name, spoken, can_fly, sort_order, updated_at) VALUES(?, ?, ?, ?, ?, 0)`, item.Language, item.Name, item.Spoken, item.CanFly, index); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func addColumnIfMissing(db *sql.DB, table, name, definition string) error {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primary int
		var columnName, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &columnName, &columnType, &notNull, &defaultValue, &primary); err != nil {
			return err
		}
		if columnName == name {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, name, definition))
	return err
}
