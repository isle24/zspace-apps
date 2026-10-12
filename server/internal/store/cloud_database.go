package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Only cloud tables use this connector. NAS/controller state continues to use
// the existing private SQLite database and never requires PostgreSQL.
type cloudDB struct {
	db       *sql.DB
	postgres bool
}
type cloudTx struct {
	tx       *sql.Tx
	postgres bool
}

func cloudBind(query string, postgres bool) string {
	if !postgres {
		return query
	}
	var b strings.Builder
	n := 0
	// SQL strings passed here are fixed source literals; parameters are always
	// separate arguments. No caller-controlled SQL enters this function.
	for _, r := range query {
		if r == '?' {
			n++
			fmt.Fprintf(&b, "$%d", n)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}
func (d *cloudDB) Exec(query string, args ...any) (sql.Result, error) {
	return d.db.Exec(cloudBind(query, d.postgres), args...)
}
func (d *cloudDB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return d.db.ExecContext(ctx, cloudBind(query, d.postgres), args...)
}
func (d *cloudDB) Query(query string, args ...any) (*sql.Rows, error) {
	return d.db.Query(cloudBind(query, d.postgres), args...)
}
func (d *cloudDB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return d.db.QueryContext(ctx, cloudBind(query, d.postgres), args...)
}
func (d *cloudDB) QueryRow(query string, args ...any) *sql.Row {
	return d.db.QueryRow(cloudBind(query, d.postgres), args...)
}
func (d *cloudDB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return d.db.QueryRowContext(ctx, cloudBind(query, d.postgres), args...)
}
func (d *cloudDB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*cloudTx, error) {
	tx, err := d.db.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &cloudTx{tx: tx, postgres: d.postgres}, nil
}
func (t *cloudTx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return t.tx.ExecContext(ctx, cloudBind(query, t.postgres), args...)
}
func (t *cloudTx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return t.tx.QueryContext(ctx, cloudBind(query, t.postgres), args...)
}
func (t *cloudTx) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return t.tx.QueryRowContext(ctx, cloudBind(query, t.postgres), args...)
}
func (t *cloudTx) Commit() error   { return t.tx.Commit() }
func (t *cloudTx) Rollback() error { return t.tx.Rollback() }

func openCloudDB(s *Service) (*cloudDB, error) {
	if s.opts.CloudDatabaseURL == "" {
		return &cloudDB{db: s.db}, nil
	}
	db, err := sql.Open("pgx", s.opts.CloudDatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("cloud database connector unavailable")
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxIdleTime(5 * time.Minute)
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("cloud PostgreSQL database unavailable")
	}
	s.wg.Add(1)
	go func() { defer s.wg.Done(); <-s.ctx.Done(); db.Close() }()
	return &cloudDB{db: db, postgres: true}, nil
}

func (c *cloudService) importLegacyAdmin(ctx context.Context) error {
	var n int
	if err := c.db.QueryRowContext(ctx, `SELECT count(*) FROM cloud_admin WHERE id=1`).Scan(&n); err != nil {
		return err
	}
	if n != 0 {
		return nil
	}
	var username, hash string
	err := c.s.db.QueryRowContext(ctx, `SELECT username,password_hash FROM admin WHERE id=1`).Scan(&username, &hash)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = c.db.ExecContext(ctx, `INSERT INTO cloud_admin(id,username,username_key,password_hash,role) VALUES(1,?,?,?,'admin') ON CONFLICT(id) DO NOTHING`, username, strings.ToLower(username), hash)
	return err
}
