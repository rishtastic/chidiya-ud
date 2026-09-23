package leaderboard

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	apiPrefix          = "/chidiya-ud/api"
	maxNameRunes       = 24
	maxScore           = 250
	sessionLifetime    = 15 * time.Minute
	minimumPointMillis = 75
)

type score struct {
	Player    string `json:"player"`
	Score     int    `json:"score"`
	CreatedAt string `json:"createdAt"`
}

type sessionRequest struct {
	Player string `json:"player"`
}

type scoreRequest struct {
	SessionID  string `json:"sessionId"`
	Score      int    `json:"score"`
	DurationMS int64  `json:"durationMs"`
}

type scoreSubmission struct {
	Accepted       bool         `json:"accepted"`
	Rank           int          `json:"rank"`
	IsUniqueLeader bool         `json:"isUniqueLeader"`
	Above          *rankedScore `json:"above,omitempty"`
	AboveNext      *rankedScore `json:"aboveNext,omitempty"`
	Below          *rankedScore `json:"below,omitempty"`
	BelowNext      *rankedScore `json:"belowNext,omitempty"`
}

type rankedScore struct {
	Player string `json:"player"`
	Score  int    `json:"score"`
	Rank   int    `json:"rank"`
}

type rateLimiter struct {
	mu      sync.Mutex
	entries map[string][]time.Time
}

func (r *rateLimiter) allow(key string, limit int, period time.Duration) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-period)
	recent := r.entries[key][:0]
	for _, requestTime := range r.entries[key] {
		if requestTime.After(cutoff) {
			recent = append(recent, requestTime)
		}
	}
	if len(recent) >= limit {
		r.entries[key] = recent
		return false
	}
	r.entries[key] = append(recent, now)
	return true
}

type server struct {
	db      *sql.DB
	limiter rateLimiter
}

// NewHandler provides the same-origin leaderboard routes and health check.
func NewHandler(db *sql.DB) http.Handler {
	s := &server{db: db, limiter: rateLimiter{entries: make(map[string][]time.Time)}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+apiPrefix+"/scores", s.listScores)
	mux.HandleFunc("POST "+apiPrefix+"/sessions", s.createSession)
	mux.HandleFunc("POST "+apiPrefix+"/scores", s.createScore)
	mux.HandleFunc("GET /healthz", s.health)
	return securityHeaders(mux)
}

// Migrate initializes the SQLite schema used by the leaderboard.
func Migrate(db *sql.DB) error {
	_, err := db.Exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			player TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			consumed_at INTEGER
		);
		CREATE TABLE IF NOT EXISTS scores (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			player TEXT NOT NULL,
			score INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS scores_ranking ON scores(score DESC, created_at ASC);
	`)
	return err
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	if err := s.db.Ping(); err != nil {
		writeError(w, http.StatusServiceUnavailable, "Leaderboard is unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) listScores(w http.ResponseWriter, _ *http.Request) {
	rows, err := s.db.Query(`SELECT player, score, created_at FROM scores ORDER BY score DESC, created_at ASC LIMIT 10`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not load scores.")
		return
	}
	defer rows.Close()

	scores := make([]score, 0)
	for rows.Next() {
		var item score
		var createdAt int64
		if err := rows.Scan(&item.Player, &item.Score, &createdAt); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not load scores.")
			return
		}
		item.CreatedAt = time.UnixMilli(createdAt).UTC().Format(time.RFC3339)
		scores = append(scores, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not load scores.")
		return
	}
	writeJSON(w, http.StatusOK, map[string][]score{"scores": scores})
}

func (s *server) createSession(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow("session:"+clientIP(r), 15, time.Hour) {
		writeError(w, http.StatusTooManyRequests, "Please wait before starting another game.")
		return
	}
	var request sessionRequest
	if err := decodeJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "Enter a valid player name.")
		return
	}
	player, err := validPlayerName(request.Player)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sessionID, err := newSessionID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not start the game.")
		return
	}
	now := time.Now()
	_, err = s.db.Exec(`INSERT INTO sessions (id, player, created_at, expires_at) VALUES (?, ?, ?, ?)`, sessionID, player, now.UnixMilli(), now.Add(sessionLifetime).UnixMilli())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not start the game.")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"sessionId": sessionID})
}

func (s *server) createScore(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow("score:"+clientIP(r), 15, time.Hour) {
		writeError(w, http.StatusTooManyRequests, "Please wait before submitting another score.")
		return
	}
	var request scoreRequest
	if err := decodeJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "Could not submit that score.")
		return
	}
	if len(request.SessionID) < 32 || request.Score < 1 || request.Score > maxScore || request.DurationMS < int64(request.Score*minimumPointMillis) {
		writeError(w, http.StatusBadRequest, "That score could not be verified.")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not submit that score.")
		return
	}
	defer tx.Rollback()
	var player string
	var expiresAt int64
	var consumedAt sql.NullInt64
	err = tx.QueryRowContext(r.Context(), `SELECT player, expires_at, consumed_at FROM sessions WHERE id = ?`, request.SessionID).Scan(&player, &expiresAt, &consumedAt)
	if errors.Is(err, sql.ErrNoRows) || consumedAt.Valid || expiresAt < time.Now().UnixMilli() {
		writeError(w, http.StatusBadRequest, "That game session has expired.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not submit that score.")
		return
	}
	now := time.Now().UnixMilli()
	result, err := tx.ExecContext(r.Context(), `INSERT INTO scores (player, score, created_at) VALUES (?, ?, ?)`, player, request.Score, now)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not submit that score.")
		return
	}
	scoreID, err := result.LastInsertId()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not submit that score.")
		return
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE sessions SET consumed_at = ? WHERE id = ?`, now, request.SessionID); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not submit that score.")
		return
	}
	var higherScores int
	if err := tx.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM scores WHERE score > ?`, request.Score).Scan(&higherScores); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not calculate that rank.")
		return
	}
	rank := higherScores + 1
	var matchingScores int
	if err := tx.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM scores WHERE score = ?`, request.Score).Scan(&matchingScores); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not calculate that rank.")
		return
	}

	var position int
	if err := tx.QueryRowContext(r.Context(), `
		SELECT COUNT(*) FROM scores
		WHERE score > ?
			OR (score = ? AND created_at < ?)
			OR (score = ? AND created_at = ? AND id < ?)
	`, request.Score, request.Score, now, request.Score, now, scoreID).Scan(&position); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not calculate that rank.")
		return
	}
	above, err := scoreAtPosition(r.Context(), tx, position-1)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not calculate that rank.")
		return
	}
	aboveNext, err := scoreAtPosition(r.Context(), tx, position-2)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not calculate that rank.")
		return
	}
	below, err := scoreAtPosition(r.Context(), tx, position+1)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not calculate that rank.")
		return
	}
	belowNext, err := scoreAtPosition(r.Context(), tx, position+2)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not calculate that rank.")
		return
	}

	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not submit that score.")
		return
	}
	writeJSON(w, http.StatusCreated, scoreSubmission{
		Accepted:       true,
		Rank:           rank,
		IsUniqueLeader: rank == 1 && matchingScores == 1,
		Above:          above,
		AboveNext:      aboveNext,
		Below:          below,
		BelowNext:      belowNext,
	})
}

func scoreAtPosition(ctx context.Context, tx *sql.Tx, position int) (*rankedScore, error) {
	if position < 0 {
		return nil, nil
	}
	var item rankedScore
	err := tx.QueryRowContext(ctx, `
		SELECT player, score FROM scores
		ORDER BY score DESC, created_at ASC, id ASC
		LIMIT 1 OFFSET ?
	`, position).Scan(&item.Player, &item.Score)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM scores WHERE score > ?`, item.Score).Scan(&item.Rank); err != nil {
		return nil, err
	}
	item.Rank += 1
	return &item, nil
}

func decodeJSON(r *http.Request, destination any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return errors.New("expected JSON")
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2048))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("unexpected data")
	}
	return nil
}

func validPlayerName(value string) (string, error) {
	name := strings.TrimSpace(value)
	if name == "" || utf8.RuneCountInString(name) > maxNameRunes {
		return "", fmt.Errorf("Enter a name of up to %d characters.", maxNameRunes)
	}
	return name, nil
}

func newSessionID() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
