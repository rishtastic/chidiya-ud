package main

import (
	"bytes"
	"fmt"
	"os"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/term"
)

func main() {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		fmt.Fprintln(os.Stderr, "Run this from a terminal so the password is not echoed.")
		os.Exit(1)
	}
	password := readPassword(fd, "Protected-name password: ")
	confirmation := readPassword(fd, "Confirm password: ")
	if len(password) == 0 || len(password) > 72 || !bytes.Equal(password, confirmation) {
		fmt.Fprintln(os.Stderr, "Passwords must match and contain 1-72 bytes.")
		os.Exit(1)
	}
	hash, err := bcrypt.GenerateFromPassword(password, bcrypt.DefaultCost)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("SUPER_ADMIN_PASSWORD_HASH=%s\n", hash)
}

func readPassword(fd int, prompt string) []byte {
	fmt.Fprint(os.Stderr, prompt)
	value, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return value
}
