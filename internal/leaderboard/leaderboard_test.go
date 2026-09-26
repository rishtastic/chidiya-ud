package leaderboard_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/rishtastic/chidiya-ud/internal/leaderboard"
	_ "modernc.org/sqlite"
)

const apiPrefix = "/chidiya-ud/api"

func newTestServer(t *testing.T) http.Handler {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "leaderboard.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := leaderboard.Migrate(db); err != nil {
		t.Fatal(err)
	}
	return leaderboard.NewHandler(db)
}

func requestJSON(t *testing.T, handler http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestScoreRequiresSingleUseSession(t *testing.T) {
	handler := newTestServer(t)
	sessionResponse := requestJSON(t, handler, http.MethodPost, apiPrefix+"/sessions", map[string]string{"player": "Ananya"})
	if sessionResponse.Code != http.StatusCreated {
		t.Fatalf("session status = %d, want %d", sessionResponse.Code, http.StatusCreated)
	}

	var sessionData sessionResponseBody
	if err := json.Unmarshal(sessionResponse.Body.Bytes(), &sessionData); err != nil {
		t.Fatal(err)
	}
	if sessionData.SessionID == "" {
		t.Fatal("session ID was empty")
	}

	scoreBody := map[string]any{"sessionId": sessionData.SessionID, "score": 4, "durationMs": 300}
	accepted := requestJSON(t, handler, http.MethodPost, apiPrefix+"/scores", scoreBody)
	if accepted.Code != http.StatusCreated {
		t.Fatalf("score status = %d, want %d", accepted.Code, http.StatusCreated)
	}
	var firstScore scoreSubmissionResponse
	if err := json.Unmarshal(accepted.Body.Bytes(), &firstScore); err != nil {
		t.Fatal(err)
	}
	if firstScore.Rank != 1 || !firstScore.IsUniqueLeader || firstScore.Above != nil || firstScore.Below != nil || firstScore.BelowNext != nil {
		t.Fatalf("first score result = %#v, want rank 1 with no neighbours", firstScore)
	}

	replayed := requestJSON(t, handler, http.MethodPost, apiPrefix+"/scores", scoreBody)
	if replayed.Code != http.StatusBadRequest {
		t.Fatalf("replayed score status = %d, want %d", replayed.Code, http.StatusBadRequest)
	}

	listed := httptest.NewRecorder()
	handler.ServeHTTP(listed, httptest.NewRequest(http.MethodGet, apiPrefix+"/scores", nil))
	if listed.Code != http.StatusOK {
		t.Fatalf("list status = %d, want %d", listed.Code, http.StatusOK)
	}
	var scores scoresResponse
	if err := json.Unmarshal(listed.Body.Bytes(), &scores); err != nil {
		t.Fatal(err)
	}
	if len(scores.Scores) != 1 || scores.Scores[0].Player != "Ananya" || scores.Scores[0].Score != 4 {
		t.Fatalf("scores = %#v, want one score for Ananya", scores.Scores)
	}
}

func TestScoreReturnsAdjacentRanks(t *testing.T) {
	handler := newTestServer(t)
	submit := func(player string, score int) scoreSubmissionResponse {
		t.Helper()
		sessionResponse := requestJSON(t, handler, http.MethodPost, apiPrefix+"/sessions", map[string]string{"player": player})
		var sessionData sessionResponseBody
		if err := json.Unmarshal(sessionResponse.Body.Bytes(), &sessionData); err != nil {
			t.Fatal(err)
		}
		response := requestJSON(t, handler, http.MethodPost, apiPrefix+"/scores", map[string]any{"sessionId": sessionData.SessionID, "score": score, "durationMs": score * 75})
		if response.Code != http.StatusCreated {
			t.Fatalf("score status = %d, want %d", response.Code, http.StatusCreated)
		}
		var submission scoreSubmissionResponse
		if err := json.Unmarshal(response.Body.Bytes(), &submission); err != nil {
			t.Fatal(err)
		}
		return submission
	}

	submit("Ananya", 4)
	submit("Kabir", 6)
	middle := submit("Mira", 5)
	if middle.Rank != 2 || middle.Above == nil || middle.Above.Player != "Kabir" || middle.Above.Score != 6 || middle.Below == nil || middle.Below.Player != "Ananya" || middle.Below.Score != 4 {
		t.Fatalf("middle score result = %#v, want Kabir above and Ananya below", middle)
	}
}

func TestTiedScoresShareACompetitionRank(t *testing.T) {
	handler := newTestServer(t)
	submit := func(player string, score int) scoreSubmissionResponse {
		t.Helper()
		sessionResponse := requestJSON(t, handler, http.MethodPost, apiPrefix+"/sessions", map[string]string{"player": player})
		var sessionData sessionResponseBody
		if err := json.Unmarshal(sessionResponse.Body.Bytes(), &sessionData); err != nil {
			t.Fatal(err)
		}
		response := requestJSON(t, handler, http.MethodPost, apiPrefix+"/scores", map[string]any{"sessionId": sessionData.SessionID, "score": score, "durationMs": score * 75})
		var submission scoreSubmissionResponse
		if err := json.Unmarshal(response.Body.Bytes(), &submission); err != nil {
			t.Fatal(err)
		}
		return submission
	}

	first := submit("Ananya", 10)
	second := submit("Kabir", 10)
	third := submit("Mira", 8)
	if first.Rank != 1 || second.Rank != 1 || third.Rank != 3 || second.IsUniqueLeader {
		t.Fatalf("ranks = %d, %d, %d; want 1, 1, 3", first.Rank, second.Rank, third.Rank)
	}
	if third.Above == nil || third.Above.Score != 10 || third.Below != nil || third.BelowNext != nil {
		t.Fatalf("third result = %#v, want a 10 above and no score below", third)
	}
}

func TestUniqueLeaderReturnsTwoScoresBelow(t *testing.T) {
	handler := newTestServer(t)
	submit := func(player string, score int) scoreSubmissionResponse {
		t.Helper()
		sessionResponse := requestJSON(t, handler, http.MethodPost, apiPrefix+"/sessions", map[string]string{"player": player})
		var sessionData sessionResponseBody
		if err := json.Unmarshal(sessionResponse.Body.Bytes(), &sessionData); err != nil {
			t.Fatal(err)
		}
		response := requestJSON(t, handler, http.MethodPost, apiPrefix+"/scores", map[string]any{"sessionId": sessionData.SessionID, "score": score, "durationMs": score * 75})
		var submission scoreSubmissionResponse
		if err := json.Unmarshal(response.Body.Bytes(), &submission); err != nil {
			t.Fatal(err)
		}
		return submission
	}

	submit("Ananya", 12)
	submit("Mira", 10)
	leader := submit("Kabir", 15)
	if !leader.IsUniqueLeader || leader.Rank != 1 || leader.Below == nil || leader.Below.Score != 12 || leader.BelowNext == nil || leader.BelowNext.Score != 10 {
		t.Fatalf("leader result = %#v, want #1 followed by 12 and 10", leader)
	}
}

func TestLowestScoreReturnsTwoScoresAbove(t *testing.T) {
	handler := newTestServer(t)
	submit := func(player string, score int) scoreSubmissionResponse {
		t.Helper()
		sessionResponse := requestJSON(t, handler, http.MethodPost, apiPrefix+"/sessions", map[string]string{"player": player})
		var sessionData sessionResponseBody
		if err := json.Unmarshal(sessionResponse.Body.Bytes(), &sessionData); err != nil {
			t.Fatal(err)
		}
		response := requestJSON(t, handler, http.MethodPost, apiPrefix+"/scores", map[string]any{"sessionId": sessionData.SessionID, "score": score, "durationMs": score * 75})
		var submission scoreSubmissionResponse
		if err := json.Unmarshal(response.Body.Bytes(), &submission); err != nil {
			t.Fatal(err)
		}
		return submission
	}

	submit("Ananya", 15)
	submit("Mira", 12)
	lowest := submit("Kabir", 10)
	if lowest.Below != nil || lowest.Above == nil || lowest.Above.Score != 12 || lowest.AboveNext == nil || lowest.AboveNext.Score != 15 {
		t.Fatalf("lowest result = %#v, want 15 and 12 above with no score below", lowest)
	}
}

func TestScoreRejectsImpossibleDuration(t *testing.T) {
	handler := newTestServer(t)
	sessionResponse := requestJSON(t, handler, http.MethodPost, apiPrefix+"/sessions", map[string]string{"player": "Kabir"})
	var sessionData sessionResponseBody
	if err := json.Unmarshal(sessionResponse.Body.Bytes(), &sessionData); err != nil {
		t.Fatal(err)
	}

	rejected := requestJSON(t, handler, http.MethodPost, apiPrefix+"/scores", map[string]any{"sessionId": sessionData.SessionID, "score": 3, "durationMs": 10})
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("score status = %d, want %d", rejected.Code, http.StatusBadRequest)
	}
}

func TestRateLimitsAllowRepeatGamesAndEnforceCap(t *testing.T) {
	handler := newTestServer(t)
	for i := 0; i < 120; i++ {
		response := requestJSON(t, handler, http.MethodPost, apiPrefix+"/sessions", map[string]string{"player": "Ananya"})
		if response.Code != http.StatusCreated {
			t.Fatalf("session %d status = %d, want %d", i+1, response.Code, http.StatusCreated)
		}
		var session sessionResponseBody
		if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil {
			t.Fatal(err)
		}
		response = requestJSON(t, handler, http.MethodPost, apiPrefix+"/scores", map[string]any{"sessionId": session.SessionID, "score": 1, "durationMs": 75})
		if response.Code != http.StatusCreated {
			t.Fatalf("score %d status = %d, want %d", i+1, response.Code, http.StatusCreated)
		}
	}
	for _, path := range []string{"/sessions", "/scores"} {
		response := requestJSON(t, handler, http.MethodPost, apiPrefix+path, map[string]string{})
		if response.Code != http.StatusTooManyRequests {
			t.Fatalf("%s status = %d, want %d", path, response.Code, http.StatusTooManyRequests)
		}
	}
}

type sessionResponseBody struct {
	SessionID string `json:"sessionId"`
}

type scoresResponse struct {
	Scores []struct {
		Player string `json:"player"`
		Score  int    `json:"score"`
	} `json:"scores"`
}

type scoreSubmissionResponse struct {
	Rank           int  `json:"rank"`
	IsUniqueLeader bool `json:"isUniqueLeader"`
	Above          *struct {
		Player string `json:"player"`
		Score  int    `json:"score"`
	} `json:"above"`
	AboveNext *struct {
		Player string `json:"player"`
		Score  int    `json:"score"`
	} `json:"aboveNext"`
	Below *struct {
		Player string `json:"player"`
		Score  int    `json:"score"`
	} `json:"below"`
	BelowNext *struct {
		Player string `json:"player"`
		Score  int    `json:"score"`
	} `json:"belowNext"`
}
