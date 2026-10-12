package storemanifest

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dlclark/regexp2"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

const MaxDocumentBytes = 1 << 20
const MaxDepth = 64
const MaxNumberBytes = 4096
const MaxNumberExponent = 4096

//go:embed schemas/app-manifest.schema.json
var schemaBytes []byte
var schemaOnce sync.Once
var trustedSchema *jsonschema.Schema
var schemaError error
var errInvalid = errors.New("invalid JSON")
var errDuplicate = errors.New("duplicate JSON key")
var errLimit = errors.New("JSON resource limit")

type embeddedOnlyLoader struct{}

func (embeddedOnlyLoader) Load(string) (any, error) {
	return nil, errors.New("external schemas disabled")
}

type schemaRegexp struct{ re *regexp2.Regexp }

func (r schemaRegexp) String() string { return r.re.String() }
func (r schemaRegexp) MatchString(s string) bool {
	matched, e := r.re.MatchString(s)
	return e == nil && matched
}
func compileSchemaRegexp(pattern string) (jsonschema.Regexp, error) {
	re, e := regexp2.Compile(pattern, regexp2.ECMAScript)
	if e != nil {
		return nil, e
	}
	re.MatchTimeout = 50 * time.Millisecond
	return schemaRegexp{re}, nil
}
func loadSchema() {
	var value any
	value, schemaError = jsonschema.UnmarshalJSON(bytes.NewReader(schemaBytes))
	if schemaError != nil {
		return
	}
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	c.UseLoader(embeddedOnlyLoader{})
	c.UseRegexpEngine(compileSchemaRegexp)
	const id = "https://embedded.invalid/store/app-manifest.schema.json"
	schemaError = c.AddResource(id, value)
	if schemaError == nil {
		trustedSchema, schemaError = c.Compile(id)
	}
}

// Parse accepts a single bounded UTF-8 JSON document, validating its structure
// before decoding DTOs. Raw and Manifest own their storage independently of raw.
// Callers must treat the exported Document value as immutable after validation.
func Parse(raw []byte) (*Document, []Issue) {
	if len(raw) > MaxDocumentBytes {
		return nil, []Issue{issue("", "JSON_LIMIT")}
	}
	if !utf8.Valid(raw) || !validUnicodeEscapes(raw) {
		return nil, []Issue{issue("", "JSON_INVALID")}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	value, e := readValue(d, 0)
	if e == nil {
		_, e = d.Token()
		if e == io.EOF {
			e = nil
		} else if e == nil {
			e = errInvalid
		}
	}
	if e != nil {
		code := "JSON_INVALID"
		if errors.Is(e, errDuplicate) {
			code = "JSON_DUPLICATE_KEY"
		}
		if errors.Is(e, errLimit) {
			code = "JSON_LIMIT"
		}
		return nil, []Issue{issue("", code)}
	}
	schemaOnce.Do(loadSchema)
	if schemaError != nil || trustedSchema == nil {
		return nil, []Issue{issue("", "SCHEMA_UNAVAILABLE")}
	}
	if e = trustedSchema.Validate(value); e != nil {
		var ve *jsonschema.ValidationError
		if !errors.As(e, &ve) {
			return nil, []Issue{issue("", "SCHEMA_INVALID")}
		}
		var issues []Issue
		var walk func(*jsonschema.ValidationError)
		walk = func(v *jsonschema.ValidationError) {
			if len(v.Causes) == 0 {
				issues = append(issues, issue(safeSchemaPath(v.InstanceLocation, value), "SCHEMA_INVALID"))
			}
			for _, cause := range v.Causes {
				walk(cause)
			}
		}
		walk(ve)
		if len(issues) == 0 {
			issues = append(issues, issue("", "SCHEMA_INVALID"))
		}
		return nil, finishIssues(issues)
	}
	// Schema permits mathematically integral exponent notation. Normalize only
	// decoded numbers for typed integers; raw bytes remain the published identity.
	normalized := normalizeNumbers(value)
	encoded, e := json.Marshal(normalized)
	if e != nil {
		return nil, []Issue{issue("", "JSON_INVALID")}
	}
	var m Manifest
	if json.Unmarshal(encoded, &m) != nil {
		return nil, []Issue{issue("", "SCHEMA_INVALID")}
	}
	order, issues := semantic(m)
	if len(issues) > 0 {
		return nil, issues
	}
	sum := sha256.Sum256(raw)
	return &Document{Manifest: m, Raw: append([]byte(nil), raw...), SHA256: hex.EncodeToString(sum[:]), StartupOrder: order}, nil
}
func readValue(d *json.Decoder, depth int) (any, error) {
	token, e := d.Token()
	if e != nil {
		return nil, errInvalid
	}
	switch t := token.(type) {
	case json.Delim:
		depth++
		if depth > MaxDepth {
			return nil, errLimit
		}
		switch t {
		case '{':
			m := map[string]any{}
			for d.More() {
				key, e := d.Token()
				if e != nil {
					return nil, errInvalid
				}
				k, ok := key.(string)
				if !ok {
					return nil, errInvalid
				}
				if _, ok := m[k]; ok {
					return nil, errDuplicate
				}
				v, e := readValue(d, depth)
				if e != nil {
					return nil, e
				}
				m[k] = v
			}
			end, e := d.Token()
			if e != nil || end != json.Delim('}') {
				return nil, errInvalid
			}
			return m, nil
		case '[':
			a := []any{}
			for d.More() {
				v, e := readValue(d, depth)
				if e != nil {
					return nil, e
				}
				a = append(a, v)
			}
			end, e := d.Token()
			if e != nil || end != json.Delim(']') {
				return nil, errInvalid
			}
			return a, nil
		}
		return nil, errInvalid
	case json.Number:
		if !boundedNumber(t.String()) {
			return nil, errLimit
		}
		return t, nil
	default:
		return token, nil
	}
}
func boundedNumber(s string) bool {
	if len(s) > MaxNumberBytes {
		return false
	}
	if i := strings.IndexAny(s, "eE"); i >= 0 {
		n, e := strconv.Atoi(s[i+1:])
		if e != nil || n > MaxNumberExponent || n < -MaxNumberExponent {
			return false
		}
	}
	_, ok := new(big.Rat).SetString(s)
	return ok
}
func jsonInteger(s string) (*big.Rat, bool) {
	r, ok := new(big.Rat).SetString(s)
	return r, ok && r.IsInt()
}
func numberRat(n json.Number) *big.Rat { r, _ := new(big.Rat).SetString(n.String()); return r }
func normalizeNumbers(v any) any {
	switch t := v.(type) {
	case json.Number:
		if n, ok := jsonInteger(t.String()); ok {
			return json.Number(n.Num().String())
		}
	case map[string]any:
		for k, v := range t {
			t[k] = normalizeNumbers(v)
		}
	case []any:
		for i, v := range t {
			t[i] = normalizeNumbers(v)
		}
	}
	return v
}

// Go's JSON decoder replaces unpaired escaped surrogates. Reject them before
// token parsing rather than silently changing an identifier or literal.
func validUnicodeEscapes(raw []byte) bool {
	inString := false
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return false
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return false
		}
		n, e := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if e != nil {
			return false
		}
		i += 4
		if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
		if n >= 0xd800 && n <= 0xdbff {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return false
			}
			lo, e := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if e != nil || lo < 0xdc00 || lo > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}

// Only contract field names and actual array indexes appear in diagnostic paths.
// User map keys and unknown fields are deliberately represented by their parent.
var safeFields = map[string]bool{}

func init() {
	var schema map[string]any
	if json.Unmarshal(schemaBytes, &schema) != nil {
		return
	}
	var walk func(any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			if props, ok := t["properties"].(map[string]any); ok {
				for k := range props {
					safeFields[k] = true
				}
			}
			for _, v := range t {
				walk(v)
			}
		case []any:
			for _, v := range t {
				walk(v)
			}
		}
	}
	walk(schema)
}
func safeSchemaPath(segments []string, value any) string {
	out := ""
	for _, s := range segments {
		switch t := value.(type) {
		case map[string]any:
			if strings.HasSuffix(out, "/parameters") || strings.HasSuffix(out, "/environment") || !safeFields[s] {
				return out
			}
			value = t[s]
			out += "/" + s
		case []any:
			i, e := strconv.Atoi(s)
			if e != nil || i < 0 || i >= len(t) {
				return out
			}
			value = t[i]
			out += "/" + strconv.Itoa(i)
		default:
			return out
		}
	}
	return out
}
