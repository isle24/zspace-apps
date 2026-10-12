package main

import (
	"errors"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/compose-spec/compose-go/v2/dotenv"
	"github.com/compose-spec/compose-go/v2/template"
	"github.com/sirupsen/logrus"
	"gopkg.in/yaml.v3"
)

// The upstream dotenv parser logs unresolved identifiers from .env values via
// logrus. Project diagnostics must never echo private configuration. This
// adapter otherwise uses Go's standard logger; suppress only the library logger.
func init() { logrus.SetOutput(io.Discard) }

// Compose's maintained dotenv/template implementations resolve values only
// against this submitted file. No process environment or client-selected path
// participates in interpolation, and values are edited as YAML nodes so a
// newline cannot introduce a new privileged field.
func interpolateCompose(source, envSource string) (string, map[string]string, error) {
	bad := errors.New("invalid compose environment")
	if len(envSource) > 100000 || !utf8.ValidString(source) || !utf8.ValidString(envSource) || strings.ContainsRune(envSource, '\x00') {
		return "", nil, bad
	}
	envValues, err := dotenv.ParseWithLookup(strings.NewReader(envSource), func(string) (string, bool) { return "", false })
	if err != nil || len(envValues) > 200 {
		return "", nil, bad
	}
	for key, value := range envValues {
		if !envName.MatchString(key) || strings.HasPrefix(key, "COMPOSE_") || strings.HasPrefix(key, "DOCKER_") || len(value) > 4096 || strings.ContainsAny(value, "\x00\r\n") {
			return "", nil, bad
		}
	}
	// Validate the submitted keys before altering any scalar. Unknown fields and
	// duplicate YAML keys remain rejected by the same restricted schema.
	var shape composeDocument
	strict := yaml.NewDecoder(strings.NewReader(source))
	strict.KnownFields(true)
	if strict.Decode(&shape) != nil || strict.Decode(&struct{}{}) != io.EOF {
		return "", nil, bad
	}
	var root yaml.Node
	if yaml.Unmarshal([]byte(source), &root) != nil {
		return "", nil, bad
	}
	lookup := func(key string) (string, bool) { value, ok := envValues[key]; return value, ok }
	seen := map[*yaml.Node]bool{}
	var visit func(*yaml.Node, int) error
	visit = func(node *yaml.Node, depth int) error {
		if node == nil || depth > 32 {
			return bad
		}
		if seen[node] {
			return nil
		}
		seen[node] = true
		if node.Kind == yaml.AliasNode {
			return visit(node.Alias, depth+1)
		}
		if node.Kind == yaml.ScalarNode && node.Tag == "!!str" {
			value, e := template.SubstituteWithOptions(node.Value, lookup, template.WithoutLogging)
			if e != nil {
				return bad
			}
			node.Value = value
			return nil
		}
		for i, child := range node.Content {
			if node.Kind == yaml.MappingNode && i%2 == 0 {
				continue
			}
			if e := visit(child, depth+1); e != nil {
				return e
			}
		}
		return nil
	}
	if visit(&root, 0) != nil {
		return "", nil, bad
	}
	data, err := yaml.Marshal(&root)
	if err != nil || len(data) > 100000 {
		return "", nil, bad
	}
	return string(data), envValues, nil
}
