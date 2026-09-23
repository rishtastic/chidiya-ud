package main

import (
	"database/sql"
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/rishtastic/chidiya-ud/internal/leaderboard"
	_ "modernc.org/sqlite"
)

func main() {
	address := flag.String("addr", "127.0.0.1:8082", "HTTP listen address")
	databasePath := flag.String("db", "./data/chidiya-ud.db", "SQLite database path")
	flag.Parse()

	if err := os.MkdirAll(filepath.Dir(*databasePath), 0750); err != nil {
		log.Fatal(err)
	}
	db, err := sql.Open("sqlite", *databasePath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := leaderboard.Migrate(db); err != nil {
		log.Fatal(err)
	}

	httpServer := &http.Server{
		Addr:              *address,
		Handler:           leaderboard.NewHandler(db),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("Chidiya Ud leaderboard listening on %s", *address)
	log.Fatal(httpServer.ListenAndServe())
}
