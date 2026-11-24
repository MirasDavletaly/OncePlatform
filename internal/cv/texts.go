package cv

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/workflow"
)

// Translations. The portal has no translator: Claude translates the texts of a
// profile through MCP (anonymised: names and contacts are not among them) into
// English and Russian, and the interface shows the language it is set to. A
// translation belongs to the texts it was made from: after a new parse or an
// edit it is outdated and hidden until Claude translates the CV again.

// TranslationLangs are the languages of the interface.
var TranslationLangs = []string{"en", "ru"}

const maxTranslatedText = 5000

type textProfile struct {
	Basics struct {
		Label   string `json:"label"`
		Summary string `json:"summary"`
	} `json:"basics"`
	Work []struct {
		Position string `json:"position"`
		Name     string `json:"name"`
		Summary  string `json:"summary"`
	} `json:"work"`
	Projects []struct {
		Name     string `json:"name"`
		Role     string `json:"role"`
		Customer string `json:"customer"`
		Summary  string `json:"summary"`
	} `json:"projects"`
	Education []struct {
		Institution string `json:"institution"`
		Area        string `json:"area"`
	} `json:"education"`
	Certificates []struct {
		Name string `json:"name"`
	} `json:"certificates"`
	Skills []struct {
		Name string `json:"name"`
	} `json:"skills"`
	Meta struct {
		Positions []struct {
			Title string `json:"title"`
		} `json:"positions"`
	} `json:"meta"`
}

// ProfileTexts are the translatable texts of a profile by path, e.g.
// "work.0.position" (empty texts are left out).
func ProfileTexts(raw json.RawMessage) map[string]string {
	out := map[string]string{}
	var p textProfile
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return out
	}
	put := func(k, v string) {
		if v = strings.TrimSpace(v); v != "" {
			out[k] = v
		}
	}
	at := func(list string, i int, field string) string { return list + "." + strconv.Itoa(i) + "." + field }
	put("basics.label", p.Basics.Label)
	put("basics.summary", p.Basics.Summary)
	for i, w := range p.Work {
		put(at("work", i, "position"), w.Position)
		put(at("work", i, "name"), w.Name)
		put(at("work", i, "summary"), w.Summary)
	}
	for i, x := range p.Projects {
		put(at("projects", i, "name"), x.Name)
		put(at("projects", i, "role"), x.Role)
		put(at("projects", i, "customer"), x.Customer)
		put(at("projects", i, "summary"), x.Summary)
	}
	for i, e := range p.Education {
		put(at("education", i, "institution"), e.Institution)
		put(at("education", i, "area"), e.Area)
	}
	for i, c := range p.Certificates {
		put(at("certificates", i, "name"), c.Name)
	}
	for i, s := range p.Skills {
		put(at("skills", i, "name"), s.Name)
	}
	for i, x := range p.Meta.Positions {
		put(at("meta.positions", i, "title"), x.Title)
	}
	return out
}

func textsHash(t map[string]string) string {
	keys := make([]string, 0, len(t))
	for k := range t {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := sha256.New()
	for _, k := range keys {
		fmt.Fprintf(h, "%s\x00%s\n", k, t[k])
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

type translation struct {
	Source string            `json:"source"`
	Texts  map[string]string `json:"texts"`
	At     time.Time         `json:"at"`
}

func parseTranslations(raw []byte) map[string]translation {
	m := map[string]translation{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &m)
	}
	return m
}

// translationState tells, per interface language, the translation made from
// the profile's current texts ("ok", with its texts), an outdated one or none.
func translationState(raw []byte, profile json.RawMessage) (map[string]map[string]string, map[string]string) {
	current := textsHash(ProfileTexts(profile))
	valid := map[string]map[string]string{}
	status := map[string]string{}
	saved := parseTranslations(raw)
	for _, lang := range TranslationLangs {
		t, ok := saved[lang]
		switch {
		case !ok:
			status[lang] = "missing"
		case t.Source != current:
			status[lang] = "outdated"
		default:
			status[lang] = "ok"
			valid[lang] = t.Texts
		}
	}
	return valid, status
}

// applyTexts writes translated texts over the profile (the Word export in the
// other language).
func applyTexts(profile json.RawMessage, texts map[string]string) json.RawMessage {
	if len(texts) == 0 {
		return profile
	}
	var root any
	if json.Unmarshal(profile, &root) != nil {
		return profile
	}
	for path, value := range texts {
		parts := strings.Split(path, ".")
		node := root
		for i, part := range parts {
			last := i == len(parts)-1
			switch n := node.(type) {
			case map[string]any:
				if last {
					if _, isText := n[part].(string); isText {
						n[part] = value
					}
				} else {
					node = n[part]
				}
			case []any:
				j, err := strconv.Atoi(part)
				if err != nil || j < 0 || j >= len(n) || last {
					node = nil
				} else {
					node = n[j]
				}
			default:
				node = nil
			}
		}
	}
	out, err := json.Marshal(root)
	if err != nil {
		return profile
	}
	return out
}

// SaveTranslation stores Claude's translation of a CV's texts into one
// interface language; texts are keyed like ProfileTexts (texts left out stay
// in the original language).
func (s *Service) SaveTranslation(ctx context.Context, actor workflow.Actor, ref, lang string, texts map[string]string) (*Candidate, int, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, 0, err
	}
	if !slices.Contains(TranslationLangs, lang) {
		return nil, 0, apperr.Validation("language must be en or ru")
	}
	c, err := s.GetByRef(ctx, actor, ref)
	if err != nil {
		return nil, 0, err
	}
	// the translation belongs to the real texts (Claude saw them anonymised: names masked)
	real, err := s.get(ctx, s.pool, c.ID)
	if err != nil {
		return nil, 0, err
	}
	source := ProfileTexts(real.Profile)
	if len(source) == 0 {
		return nil, 0, apperr.Validation(c.Code + " has no parsed profile to translate")
	}
	clean := map[string]string{}
	var unknown []string
	for k, v := range texts {
		if _, ok := source[k]; !ok {
			unknown = append(unknown, k)
			continue
		}
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if utf8.RuneCountInString(v) > maxTranslatedText {
			return nil, 0, apperr.Validation(fmt.Sprintf("%s is longer than %d characters", k, maxTranslatedText))
		}
		clean[k] = v
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, 0, apperr.Validation(fmt.Sprintf("Unknown text keys (take the keys from get_candidate): %s", strings.Join(unknown[:min(len(unknown), 10)], ", ")))
	}
	if len(clean) == 0 {
		return nil, 0, apperr.Validation("No translated texts were sent")
	}
	t, _ := json.Marshal(translation{Source: textsHash(source), Texts: clean, At: time.Now().UTC()})
	if _, err := s.pool.Exec(ctx, `UPDATE candidates SET translations = jsonb_set(coalesce(translations, '{}'), ARRAY[$2::text], $3::jsonb)
		WHERE id = $1`, c.ID, lang, t); err != nil {
		return nil, 0, err
	}
	if err := audit.Write(ctx, s.pool, audit.FromActor(actor, "candidate.translate", "candidate", c.ID,
		map[string]any{"code": c.Code, "lang": lang, "texts": len(clean), "of": len(source)})); err != nil {
		return nil, 0, err
	}
	c, err = s.GetByRef(ctx, actor, c.ID)
	return c, len(source), err
}
