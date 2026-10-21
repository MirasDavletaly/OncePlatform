package db

import (
	"strings"
	"unicode"
)

// SearchTerms splits a free-text query into lowercase word terms (letters and
// digits only, Unicode-aware so Kazakh and Russian letters are preserved).
func SearchTerms(q string) []string {
	fields := strings.FieldsFunc(strings.ToLower(q), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	out := make([]string, 0, len(fields))
	seen := map[string]bool{}
	for _, f := range fields {
		if f == "" || seen[f] {
			continue
		}
		seen[f] = true
		out = append(out, f)
		if len(out) == 12 {
			break
		}
	}
	return out
}

// PrefixTSQuery builds a to_tsquery('simple', ...) expression string where
// every term is a prefix match ("term:*") and all terms must match. Prefix
// matching works well for Kazakh and Russian, where suffixes vary a lot and
// the 'simple' configuration performs no stemming. Returns "" when the query
// has no usable terms.
func PrefixTSQuery(q string) string {
	terms := SearchTerms(q)
	if len(terms) == 0 {
		return ""
	}
	parts := make([]string, len(terms))
	for i, t := range terms {
		parts[i] = t + ":*"
	}
	return strings.Join(parts, " & ")
}

// LikePattern returns an ILIKE pattern that matches q as a substring, with
// LIKE metacharacters escaped (default escape character is backslash).
func LikePattern(q string) string {
	q = strings.TrimSpace(q)
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(q) + "%"
}
